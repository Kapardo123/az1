#!/usr/bin/env node
/**
 * Buduje prototyp aplikacji (prototype.html) z szablonu + danych scrapera.
 *
 * Bierze najnowsze newsy z ../data/news.json (pełna treść, autor, link),
 * zmniejsza miniatury do 640 px (przez PowerShell/System.Drawing, z cache),
 * osadza je jako data-URI i wstrzykuje wszystko w template.html.
 *
 * Użycie:
 *   node build.mjs                 # 8 najnowszych newsów
 *   node build.mjs --count 12
 *   node build.mjs --no-images     # bez grafik (mniejszy plik)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const COUNT = Math.max(1, parseInt(opt("count", "8"), 10) || 8);
const NO_IMAGES = args.includes("--no-images");

const TEMPLATE = resolve(dir, "template.html");
const DATA = resolve(dir, "../data/news.json");
const TABLE_DATA = resolve(dir, "../data/plk-table.json");
const SCHEDULE_DATA = resolve(dir, "../data/plk-schedule-anwil.json");
const KKW_SCHEDULE = resolve(dir, "../data/kkw-schedule.json");
const ENBL_DATA = resolve(dir, "../data/enbl.json");
const ENBL_LOGO_DIR = resolve(dir, "../data/logos/enbl");
const MATCHES_DIR = resolve(dir, "../data/matches");
const ENBL_MATCHES = resolve(dir, "../data/enbl-matches.json");
const OUT = resolve(dir, "prototype.html");
const DETAIL_N = Math.max(0, parseInt(opt("detail", "8"), 10) || 8);

/* krótkie nazwy drużyn (bez sponsorów tytularnych) do ciasnych widoków */
const SHORT_NAMES = {
  "anwil-wloclawek": "Anwil",
  "legia-warszawa": "Legia",
  "king-szczecin": "King Szczecin",
  "wks-slask-wroclaw": "Śląsk Wrocław",
  "energa-trefl-sopot": "Trefl Sopot",
  "dziki-warszawa": "Dziki Warszawa",
  "amw-arka-gdynia": "Arka Gdynia",
  "orlen-zastal-zielona-gora": "Zastal",
  "mks-dabrowa-gornicza": "MKS Dąbrowa",
  "tasomix-rosiek-stal-ostrow-wielkopolski": "Stal Ostrów",
  "gornik-zamek-ksiaz-walbrzych": "Górnik Wałbrzych",
  "arriva-lotto-twarde-pierniki-torun": "Twarde Pierniki",
  "pge-start-lublin": "Start Lublin",
  "energa-czarni-slupsk": "Czarni Słupsk",
  "tauron-gtk-gliwice": "GTK Gliwice",
  "miasto-szkla-krosno": "Miasto Szkła",
};
const shortName = (t) => SHORT_NAMES[t.slug] ?? t.name;

/* normalizacja nazw do dopasowania drużyn między źródłami (kkw ↔ plk ↔ enbl) */
const slugify = (s) => (s ?? "").toLowerCase()
  .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e").replace(/ł/g, "l").replace(/ń/g, "n")
  .replace(/ó/g, "o").replace(/ś/g, "s").replace(/ź/g, "z").replace(/ż/g, "z")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const normName = (s) => slugify(s).replace(/-/g, " ");
const tokensOf = (s) => [...new Set(normName(s).split(" ").filter((t) => t.length >= 4 && !["basket", "basketball", "club", "team"].includes(t)))];

/* krótka nazwa drużyny ENBL do ciasnych widoków (np. "Donar Groningen" -> "Donar") */
function enblShort(name) {
  const parts = (name || "").replace(/[\/]/g, " ").replace(/\b(BC|BK|KK|Basket|Basketball|Club|Lions|Team)\b/gi, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!parts.length) return name || "";
  return /^[A-Z0-9]{2,4}$/.test(parts[0]) && parts[1] ? parts.slice(1).join(" ") : parts[0];
}

/* ---- ENBL: tabela + statystyki zawodników (Genius) + loga drużyn (enbleague.eu) ---- */
function buildEnbl() {
  if (!existsSync(ENBL_DATA)) return null;
  let d;
  try { d = JSON.parse(readFileSync(ENBL_DATA, "utf8")); } catch { return null; }
  const data = {
    scrapedAt: d.scrapedAt ?? null,
    season: d.season ?? null,
    group: d.group ?? null,
    groupLabel: d.groupLabel ?? null,
    standings: d.standings ?? [],
    leaders: d.leaders ?? [],
  };
  /* loga: token -> data-URI; posłużą też do logo rywali ENBL w terminarzu */
  const logos = {};
  const byToken = new Map();
  for (const l of d.logos ?? []) {
    if (!l.localLogo) continue;
    const abs = resolve(dir, "../data", l.localLogo);
    if (!existsSync(abs)) continue;
    const norm = normLogo(abs, 160) || abs;
    const uri = "data:image/png;base64," + readFileSync(norm).toString("base64");
    logos[l.slug || slugify(l.name)] = uri;
    for (const t of l.tokens ?? enblTokensOf(l.name)) byToken.set(t, uri);
  }
  /* loga także przy wierszach tabeli (jak w PLK) */
  data.standings = (d.standings ?? []).map((r) => ({ ...r, logo: enblLogoFor(r.team, byToken) }));
  return { data, logos, byToken };
}
const enblTokensOf = (s) => [...new Set(normName(s).split(" ").filter((t) => t.length >= 3))];
const enblLogoFor = (name, byToken) => {
  for (const t of enblTokensOf(name)) { const hit = byToken.get(t); if (hit) return hit; }
  return "";
};

/* kategoria na podstawie tytułu/leadu */
function inferTag(it) {
  const t = (it.title + " " + (it.lead ?? "")).toLowerCase();
  if (/transfer|koszykarzem anwilu|podpisa|kontrakt|wzmocnien/.test(t)) return "Transfer";
  if (/terminarz|tabela|plk |liga|enbl|kolejk/.test(t)) return "Liga";
  if (/wygra|przegra|pokona|mecz|kwart|play|półfinał|ćwierćfinał|relacj/.test(t)) return "Mecz";
  if (/trener|sztab|prezes|dyrektor|zarząd/.test(t)) return "Klub";
  return "Klub";
}

/* miniatura JPEG o zadanej szerokości przez PowerShell + System.Drawing, cache obok oryginału */
function thumbJpg(absImagePath, width) {
  const out = absImagePath.replace(/\.(jpe?g|png|webp)$/i, "") + `_${width}.jpg`;
  if (!existsSync(out)) {
    const ps = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${absImagePath}')
$w=${width};$h=[int]($img.Height*$w/$img.Width)
$bmp=New-Object System.Drawing.Bitmap($w,$h)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img,0,0,$w,$h)
$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}
$p=New-Object System.Drawing.Imaging.EncoderParameters(1)
$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]70)
$bmp.Save('${out}',$enc,$p)
$g.Dispose();$bmp.Dispose();$img.Dispose()`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) {
      process.stderr.write(`  resize nieudany dla ${absImagePath}: ${r.stderr?.slice(0, 200)}\n`);
      return null;
    }
  }
  return out;
}

/* logo w zadanym rozmiarze, PNG z przezroczystością, przez PowerShell; cache obok oryginału */
function logoPng(absPngPath, size) {
  const out = absPngPath.replace(/\.png$/i, "") + `_${size}.png`;
  if (!existsSync(out)) {
    const ps = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${absPngPath}')
$s=${size}
$bmp=New-Object System.Drawing.Bitmap($s,$s,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img,0,0,$s,$s)
$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose();$img.Dispose()`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) {
      process.stderr.write(`  resize logo nieudany: ${absPngPath}\n`);
      return null;
    }
  }
  return out;
}
const logo64 = (p) => logoPng(p, 64);

/* Logo znormalizowane: przycięte do zawartości (bbox po alfie) + równy margines,
   zawsze kwadrat. Wyrównuje wielkość herbów PLK (duże wypełnienie) i ENBL
   (dużo przezroczystego tła na brzegach), żeby w liście meczów wyglądały tak samo. */
function normLogo(absPngPath, size) {
  const out = absPngPath.replace(/\.png$/i, "") + `_n${size}.png`;
  if (!existsSync(out)) {
    const ps = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${absPngPath}')
$bmp=New-Object System.Drawing.Bitmap($img)
$w=$bmp.Width;$h=$bmp.Height
$minX=$w;$minY=$h;$maxX=-1;$maxY=-1
for($y=0;$y -lt $h;$y+=2){ for($x=0;$x -lt $w;$x+=2){ if($bmp.GetPixel($x,$y).A -gt 16){ if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x}; if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y} } } }
if($maxX -lt 0){ $minX=0;$minY=0;$maxX=$w-1;$maxY=$h-1 }
$minX=[Math]::Max(0,$minX-1);$minY=[Math]::Max(0,$minY-1);$maxX=[Math]::Min($w-1,$maxX+1);$maxY=[Math]::Min($h-1,$maxY+1)
$cw=$maxX-$minX+1;$ch=$maxY-$minY+1
$side=[int]([Math]::Max($cw,$ch)*1.16)
$pad=New-Object System.Drawing.Bitmap($side,$side,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g=[System.Drawing.Graphics]::FromImage($pad)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$dx=[int](($side-$cw)/2);$dy=[int](($side-$ch)/2)
$g.DrawImage($bmp,(New-Object System.Drawing.Rectangle($dx,$dy,$cw,$ch)),(New-Object System.Drawing.Rectangle($minX,$minY,$cw,$ch)),[System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$fin=New-Object System.Drawing.Bitmap(${size},${size},[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2=[System.Drawing.Graphics]::FromImage($fin)
$g2.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g2.DrawImage($pad,0,0,${size},${size})
$fin.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png)
$g2.Dispose();$fin.Dispose();$pad.Dispose();$bmp.Dispose();$img.Dispose()`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) {
      process.stderr.write(`  normalizacja logo nieudana: ${absPngPath}\n`);
      return null;
    }
  }
  return out;
}

/* grafika w zadanej szerokości, PNG z przezroczystością (proporcje zachowane) */
function artPng(absPngPath, width) {
  const out = absPngPath.replace(/\.png$/i, "") + `_${width}.png`;
  if (!existsSync(out)) {
    const ps = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${absPngPath}')
$w=${width};$h=[int]($img.Height*$w/$img.Width)
$bmp=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bmp.SetResolution(96,96)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.DrawImage($img,0,0,$w,$h)
$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose();$img.Dispose()`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) {
      process.stderr.write(`  resize grafiki nieudany: ${absPngPath}\n`);
      return null;
    }
  }
  return out;
}

/* ilustracja komentatora do karty „Radio Anwil” (data/logos/radio-announcer.png) */
function buildRadioAnnouncer() {
  const src = resolve(dir, "../data/logos/radio-announcer.png");
  if (!existsSync(src)) return "";
  const small = artPng(src, 480);
  if (!small) return "";
  return "data:image/png;base64," + readFileSync(small).toString("base64");
}

/* Tło karty „Najbliższy mecz”: wzór klienta (data/logos/hero-plate.*).
   Preferujemy zdjęcie (png/jpg/webp), zapasowo generowany SVG. */
function platePng(absPath, width = 640) {
  const out = absPath.replace(/\.(jpe?g|png|webp)$/i, "") + `_plate${width}.png`;
  if (!existsSync(out)) {
    const ps = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${absPath}')
$w=${width};$h=[int]($img.Height*$w/$img.Width)
$bmp=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img,0,0,$w,$h)
$g.Dispose()
for($y=0;$y -lt $h;$y++){ for($x=0;$x -lt $w;$x++){ $c=$bmp.GetPixel($x,$y); $mn=[Math]::Min($c.R,[Math]::Min($c.G,$c.B)); $a=255-$mn; if($a -lt 10){$a=0}; $bmp.SetPixel($x,$y,[System.Drawing.Color]::FromArgb($a,$c.R,$c.G,$c.B)) } }
$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose();$img.Dispose()`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) { process.stderr.write(`  tło hero: nie udało się wyciąć tła z ${absPath}\n`); return null; }
  }
  return out;
}
function buildHeroPlate() {
  const raster = ["hero-plate.png", "hero-plate.jpg", "hero-plate.jpeg", "hero-plate.webp"]
    .map((f) => resolve(dir, "../data/logos", f)).find(existsSync);
  if (raster) {
    const plate = platePng(raster, 640);
    if (plate) return "data:image/png;base64," + readFileSync(plate).toString("base64");
    const small = thumbJpg(raster, 900);
    if (small) return "data:image/jpeg;base64," + readFileSync(small).toString("base64");
  }
  const svg = resolve(dir, "../data/logos/hero-plate.svg");
  if (existsSync(svg)) return "data:image/svg+xml;base64," + readFileSync(svg).toString("base64");
  return "";
}

/* herb Anwilu wycięty z góry grafiki klienta (pobrane.svg) — maska do paska */
function buildHeaderCrest() {
  const src = resolve(dir, "../data/logos/header-crest.png");
  if (!existsSync(src)) return "";
  const small = artPng(src, 288);
  if (!small) return "";
  return "data:image/png;base64," + readFileSync(small).toString("base64");
}

/* ---- skład drużyny ze scrapera plk-roster.mjs ---- */
const ROSTER_DATA = resolve(dir, "../data/roster.json");
/* domyślnie osadzamy komplet meczów — aplikacja pozwala rozwinąć pełny log */
const gamelogOpt = opt("gamelog", "all");
const GAMELOG_N = gamelogOpt === "all" ? Infinity : Math.max(0, parseInt(gamelogOpt, 10) || 0);
function buildRoster() {
  if (!existsSync(ROSTER_DATA)) return null;
  const r = JSON.parse(readFileSync(ROSTER_DATA, "utf8"));
  if (!r.players?.length) return null;
  const players = r.players.map((p) => {
    let photo = "";
    if (p.localPhoto) {
      const abs = resolve(dirname(ROSTER_DATA), p.localPhoto);
      if (existsSync(abs)) {
        const small = thumbJpg(abs, 320);
        if (small) photo = "data:image/jpeg;base64," + readFileSync(small).toString("base64");
      }
    }
    const s = p.season;
    return {
      id: p.id, name: p.name, first: p.firstName, last: p.lastName,
      no: p.number, pos: p.position, h: p.height, age: p.age,
      country: p.country, url: p.url, photo,
      season: s && {
        g: s.games, s5: s.start5, min: s.minAvg,
        pts: s.ptsAvg, reb: s.rebAvg, ast: s.astAvg, stl: s.stlAvg,
        blk: s.blkAvg, to: s.toAvg, ev: s.evalAvg, pm: s.pmAvg,
        p2: s.pct2, p3: s.pct3, p1: s.pct1, pfg: s.pctFg,
        /* trafione/oddane — do szczegółów pod wskaźnikami skuteczności */
        m2: s.m2, a2: s.a2, m3: s.m3, a3: s.a3, m1: s.m1, a1: s.a1,
        tot: { pts: s.pts, reb: s.reb, ast: s.ast },
        best: s.best,
      },
      /* mecze — indeksy:
         0 matchId | 1 data | 2 rywalId | 3 dom | 4 wygrana | 5 wynik | 6 min | 7 pkt
         8 zb | 9 as | 10 eval | 11 +/- | 12 m2 | 13 a2 | 14 m3 | 15 a3 | 16 m1 | 17 a1
         18 zbAtak | 19 zbObrona | 20 przechwyty | 21 bloki | 22 straty | 23 faule | 24 pierwsza5 */
      games: (p.games ?? []).slice(0, GAMELOG_N === Infinity ? undefined : GAMELOG_N).map((g) => [
        g.matchId, (g.date ?? "").slice(0, 10), g.opponentId, g.home ? 1 : 0, g.win ? 1 : 0,
        g.score, Math.round((g.sec ?? 0) / 60), g.pts, g.reb, g.ast, g.eval, g.pm,
        g.m2, g.a2, g.m3, g.a3, g.m1, g.a1,
        g.rebO, g.rebD, g.stl, g.blk, g.to, g.fouls, g.start5 ? 1 : 0,
      ]),
    };
  });
  // najpierw ci z największą liczbą minut w sezonie
  players.sort((a, b) => (b.season?.g ?? 0) * (b.season?.min ?? 0) - (a.season?.g ?? 0) * (a.season?.min ?? 0));
  return { season: r.season, team: r.team, players };
}

/* ---- aktualny skład + sztab z kkwloclawek.pl/sklad (kkw-roster.mjs) ---- */
const ROSTER_KKW_DATA = resolve(dir, "../data/roster-kkw.json");
function buildRosterKkw() {
  if (!existsSync(ROSTER_KKW_DATA)) return null;
  let r;
  try { r = JSON.parse(readFileSync(ROSTER_KKW_DATA, "utf8")); } catch { return null; }
  if (!r.players?.length) return null;

  /* indeksy zawodników w składzie PLK (statystyki sezonu) — dopasowanie po nazwisku */
  const plk = buildRoster();
  const norm = (s) => slugify(s).replace(/-/g, "");
  const plkIndex = (name) => {
    if (!plk) return null;
    const n = norm(name);
    const i = plk.players.findIndex((p) => {
      const pn = norm(p.name);
      return pn === n || pn.endsWith(n) || n.endsWith(pn);
    });
    return i >= 0 ? i : null;
  };
  const photo = (rel, w) => {
    if (!rel) return "";
    const abs = resolve(dir, "../data", rel);
    if (!existsSync(abs)) return "";
    const small = thumbJpg(abs, w);
    return small ? "data:image/jpeg;base64," + readFileSync(small).toString("base64") : "";
  };
  return {
    season: r.season,
    players: r.players.map((p) => ({
      name: p.name, no: p.number, pos: p.position, h: p.height, country: p.country,
      birthDate: p.birthDate, contract: p.contract, url: p.url, instagram: p.instagram,
      photo: photo(p.localPhoto, 400), plk: plkIndex(p.name),
    })),
    staff: (r.staff ?? []).map((s) => ({ name: s.name, role: s.role, url: s.url, photo: photo(s.localPhoto, 360) })),
  };
}

/* ---- statystyki zawodników sumowane z zapisanych meczów (PLK + ENBL).
   Liczymy średnie/percentyle z boxscore'ów, żeby panel gracza mógł przełączać
   PLK ↔ ENBL bez osobnych scraperów rosterowych. Bierzemy tylko mecze, które są
   na liście aplikacji (league + played + matchId) — dla PLK 2026/27 pojawią się
   automatycznie, gdy tylko będą rozegrane i pobrane. ---- */
function buildLeagueRoster(matches, league, season) {
  if (!matches || !season) return null;
  const played = matches.filter((m) => m.league === league && m.played && m.matchId != null);
  if (!played.length) return null;
  const details = loadMatchDetails();
  const byPid = new Map();
  for (const m of played) {
    const raw = details[m.matchId];
    if (!raw) continue;
    const team = raw.home.id === 33 ? raw.home : raw.away;
    const home = m.anwilHome ? 1 : 0;
    const win = m.anwilWin ? 1 : 0;
    const score = `${m.hs}:${m.as}`;
    const oppId = m.anwilHome ? m.away.teamId : m.home.teamId;
    const date = (m.date ?? "").slice(0, 10);
    for (const p of team.players ?? []) {
      const st = p.stats;
      if (!st || !(st.playTimeSeconds > 0)) continue;
      let e = byPid.get(p.id);
      if (!e) { e = { name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(), games: [] }; byPid.set(p.id, e); }
      e.games.push({
        matchId: m.matchId, date, oppId, home, win, score,
        sec: st.playTimeSeconds, min: Math.round((st.playTimeSeconds ?? 0) / 60),
        pts: st.points, reb: st.reboundsTotal, ast: st.assists, ev: st.eval, pm: st.plusMinus,
        m2: st.madeTwoPts, a2: st.attemptTwoPts, m3: st.madeThreePts, a3: st.attemptThreePts,
        m1: st.madeFreeThrowPts, a1: st.attemptFreeThrowPts,
        rebO: st.reboundsOffensive, rebD: st.reboundsDefensive,
        stl: st.steals, blk: st.blocks, to: st.turnovers, fouls: st.fouls ?? st.foulsPersonal, s5: st.isStart5 ? 1 : 0,
      });
    }
  }
  if (!byPid.size) return null;
  const sum = (arr, k) => arr.reduce((a, g) => a + (g[k] ?? 0), 0);
  const avg1 = (arr, k) => arr.length ? Math.round((sum(arr, k) / arr.length) * 10) / 10 : 0;
  const pctOf = (arr, mk, ak) => { const a = sum(arr, ak); return a ? Math.round((sum(arr, mk) / a) * 1000) / 10 : 0; };
  const players = [...byPid.values()].map((e) => {
    const gs = e.games.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    const g = gs.length;
    return {
      name: e.name,
      season: {
        g, s5: sum(gs, "s5"), min: Math.round((sum(gs, "sec") / g / 60) * 10) / 10,
        pts: avg1(gs, "pts"), reb: avg1(gs, "reb"), ast: avg1(gs, "ast"), stl: avg1(gs, "stl"),
        blk: avg1(gs, "blk"), to: avg1(gs, "to"), ev: avg1(gs, "ev"), pm: avg1(gs, "pm"),
        p2: pctOf(gs, "m2", "a2"), p3: pctOf(gs, "m3", "a3"), p1: pctOf(gs, "m1", "a1"),
        m2: sum(gs, "m2"), a2: sum(gs, "a2"), m3: sum(gs, "m3"), a3: sum(gs, "a3"), m1: sum(gs, "m1"), a1: sum(gs, "a1"),
        tot: { pts: sum(gs, "pts"), reb: sum(gs, "reb"), ast: sum(gs, "ast") },
        best: {
          pts: Math.max(...gs.map((x) => x.pts ?? 0)), reb: Math.max(...gs.map((x) => x.reb ?? 0)),
          ast: Math.max(...gs.map((x) => x.ast ?? 0)), eval: Math.max(...gs.map((x) => x.ev ?? 0)),
        },
      },
      games: gs.map((x) => [x.matchId, x.date, x.oppId, x.home, x.win, x.score, x.min, x.pts, x.reb, x.ast, x.ev, x.pm,
        x.m2, x.a2, x.m3, x.a3, x.m1, x.a1, x.rebO, x.rebD, x.stl, x.blk, x.to, x.fouls, x.s5]),
    };
  });
  players.sort((a, b) => b.season.ev - a.season.ev);
  return { season, players };
}
const readSeason = (file) => { try { return JSON.parse(readFileSync(file, "utf8")).season ?? null; } catch { return null; } };
const buildPlkRoster = (matches) => buildLeagueRoster(matches, "PLK", readSeason(TABLE_DATA));
const buildEnblRoster = (matches) => buildLeagueRoster(matches, "ENBL", readSeason(ENBL_DATA));

/* ---- sklep: produkty z WooCommerce Store API (sklep-products.mjs) ---- */
const SHOP_DATA = resolve(dir, "../data/shop.json");
const shopOpt = opt("shop", "all");
const SHOP_N = shopOpt === "all" ? Infinity : Math.max(0, parseInt(shopOpt, 10) || 0);
/* Kategorie ze sklepu, pogrupowane tematycznie — wszystkie widoczne naraz.
   Trzeci element = lista kategorii do dopasowania (produkt pasuje, gdy ma
   którąkolwiek z nich). "Cała odzież" musi być sumą podkategorii, bo część
   ubrań jest przypisana tylko do Męskiej/Damskiej/Dziecięcej, bez "Odzież". */
const CLOTHES = ["Odzież", "Męska", "Damska", "Dziecięca"];
const SHOP_GROUPS = [
  { label: "Marki", items: [["RottWear", "RottWear"], ["Kappa", "Kappa"], ["4F", "4F"]] },
  { label: "Odzież", items: [["Cała odzież", "Odzież", CLOTHES], ["Męska", "Męska"], ["Damska", "Damska"], ["Dziecięca", "Dziecięca"]] },
  { label: "Pozostałe", items: [["Gadżety", "Gadżety"], ["Promocje", "Promocje"]] },
];
function buildShop() {
  if (!existsSync(SHOP_DATA) || !SHOP_N) return null;
  const s = JSON.parse(readFileSync(SHOP_DATA, "utf8"));
  if (!s.products?.length) return null;
  // dostępne najpierw, w kolejności sklepu; do limitu
  const pick = [...s.products].sort((a, b) => (b.inStock ? 1 : 0) - (a.inStock ? 1 : 0)).slice(0, SHOP_N === Infinity ? undefined : SHOP_N);
  const products = [];
  let n = 0;
  for (const p of pick) {
    let img = "";
    if (p.localImage) {
      const abs = resolve(dirname(SHOP_DATA), p.localImage);
      if (existsSync(abs)) {
        const small = thumbJpg(abs, 320);
        if (small) {
          img = "data:image/jpeg;base64," + readFileSync(small).toString("base64");
          process.stderr.write(`Produkt ${++n}/${pick.length}: ${p.name}\n`);
        }
      }
    }
    products.push({
      id: p.id, name: p.name, url: p.url,
      price: p.price, regularPrice: p.regularPrice, onSale: p.onSale,
      inStock: p.inStock, sizes: p.sizes, cats: p.categories, img,
      /* rozmiar/kolor -> ID wariantu (tylko dostępne w magazynie); służy do
         przeniesienia koszyka do sklepu przez ?add-to-cart=<id>&variation_id=<vid> */
      variants: p.variants ?? {},
      /* atrybuty wariantu (np. [{name:"Rozmiar",terms:[...]}]); puste = produkt prosty */
      options: p.options ?? [],
    });
  }
  const count = (names) => products.filter((p) => names.some((n) => p.cats.includes(n))).length;
  const groups = SHOP_GROUPS
    .map((g) => ({
      label: g.label,
      items: g.items
        .map(([label, name, names]) => {
          const match = names ?? [name];
          return { label, name, names: match, count: count(match) };
        })
        .filter((c) => c.count > 0),
    }))
    .filter((g) => g.items.length);
  return { shopUrl: "https://sklep.kkwloclawek.pl", groups, products };
}

/* logo Anwilu wysokiej jakości do splasha (zachowuje proporcje, max 440px) */
/* Logo Anwilu w zadanej szerokości (proporcje zachowane).
   Osobne rozmiary dla splasha i paska górnego: znak jest bardzo drobiazgowy
   (napisy w łuku, gwiazdki), a skalowanie 440->44 px w przeglądarce zamienia
   cienkie litery w szarą mgłę. Dajemy plik bliski docelowemu rozmiarowi
   (×3 z zapasem na ekrany o dużej gęstości) przeskalowany dobrym filtrem
   z wygładzaniem krawędzi i wysoką jakością składania. */
function buildAnwilLogo(maxPx = 440, tag = "splash") {
  let src = resolve(dir, "../data/logos/anwil-org.png");
  if (!existsSync(src)) src = resolve(dir, "../data/logos/33-anwil-wloclawek.png");
  if (!existsSync(src)) return "";
  const out = src.replace(/\.png$/i, "") + `_${tag}.png`;
  if (!existsSync(out)) {
    const ps = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${src}')
$max=${maxPx}
$ratio=[Math]::Min($max/$img.Width,$max/$img.Height)
$w=[int]($img.Width*$ratio);$h=[int]($img.Height*$ratio)
$bmp=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bmp.SetResolution(96,96)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.DrawImage($img,(New-Object System.Drawing.Rectangle(0,0,$w,$h)),0,0,$img.Width,$img.Height,[System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose();$img.Dispose()`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) {
      process.stderr.write(`  resize loga (${tag}) nieudany\n`);
      return "";
    }
  }
  return "data:image/png;base64," + readFileSync(out).toString("base64");
}

/* Maska ekranu startowego: biały rysunek na przezroczystym tle
   (data/logos/splash-mask.png, wyodrębniony z dostarczonego SVG). CSS
   używa jej jako mask-image, dzięki czemu gradient niebieski-biały-zielony
   wypełnia sam rysunek. */
function buildSplashMask() {
  const src = resolve(dir, "../data/logos/splash-mask.png");
  if (!existsSync(src)) return "";
  return "data:image/png;base64," + readFileSync(src).toString("base64");
}

/* tabela: top 5 + Anwil (jeśli poza top 5), loga jako data-URI */
/* forma drużyn: ostatnie 5 rozegranych meczów z pełnego terminarza (240 spotkań) */
function buildFormMap(season) {
  const SCHED = resolve(dir, "../data/plk-schedule.json");
  if (!existsSync(SCHED)) return {};
  const s = JSON.parse(readFileSync(SCHED, "utf8"));
  /* zakres sezonu z tabeli (PLK trwa VIII–VII); forma bieżącego sezonu,
     więc po awansie do nowego sezonu jest czysta, dopóki nie ma meczów */
  let from = null, to = null;
  const y = parseInt(String(season ?? "").match(/(20\d{2})/)?.[1] ?? "", 10);
  if (Number.isFinite(y)) { from = `${y}-08-01`; to = `${y + 1}-07-31`; }
  const byTeam = {};
  for (const m of s.matches ?? []) {
    if (!m.played) continue;
    if (from && m.date && (m.date < from || m.date > to)) continue;
    for (const [t, opp, win] of [
      [m.home, m.away, m.homeScore > m.awayScore],
      [m.away, m.home, m.awayScore > m.homeScore],
    ]) {
      (byTeam[t.teamId] ??= []).push({
        date: m.date ?? "", win, opp: opp.name,
        score: `${m.homeScore}:${m.awayScore}`,
        home: t.teamId === m.home.teamId,
      });
    }
  }
  const out = {};
  for (const [id, list] of Object.entries(byTeam)) {
    list.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    // [wygrana, rywal, wynik, dom] — najstarszy pierwszy, żeby czytać od lewej
    out[id] = list.slice(0, 5).reverse().map((g) => [g.win ? 1 : 0, g.opp, g.score, g.home ? 1 : 0]);
  }
  return out;
}

function buildTable() {
  if (!existsSync(TABLE_DATA)) return null;
  const t = JSON.parse(readFileSync(TABLE_DATA, "utf8"));
  if (!t.teams?.length) return null;
  const form = buildFormMap(t.season);
  const logoOf = (r) => {
    if (!r.localLogo) return "";
    const abs = resolve(dirname(TABLE_DATA), r.localLogo);
    if (!existsSync(abs)) return "";
    const small = logo64(abs);
    return small ? "data:image/png;base64," + readFileSync(small).toString("base64") : "";
  };
  const wl = (s) => { // "12-3" -> {w:12,l:3}
    const m = String(s ?? "").match(/(\d+)\s*-\s*(\d+)/);
    return m ? { w: +m[1], l: +m[2] } : { w: 0, l: 0 };
  };
  const full = t.teams.map((r) => {
    const h = wl(r.home), a = wl(r.away);
    return {
      pos: r.pos, name: r.name, short: shortName(r), slug: r.slug, teamId: r.teamId,
      games: r.games, wins: r.wins, losses: r.losses, points: r.points,
      hw: h.w, hl: h.l, aw: a.w, al: a.l,
      scored: r.scored, conceded: r.conceded, diff: r.diff,
      /* średnie na mecz — porównywalne między drużynami */
      psAvg: r.games ? Math.round((r.scored / r.games) * 10) / 10 : 0,
      pcAvg: r.games ? Math.round((r.conceded / r.games) * 10) / 10 : 0,
      winPct: r.games ? Math.round((r.wins / r.games) * 100) : 0,
      form: form[r.teamId] ?? [],
      logo: logoOf(r),
      me: r.slug === "anwil-wloclawek",
    };
  });
  // skrót na Home: top 4 + Anwil, jeśli poza pierwszą piątką
  const anwil = full.find((x) => x.me);
  let rows = full.slice(0, 5);
  if (anwil && anwil.pos > 5) rows = [...full.slice(0, 4), anwil];
  return {
    season: (t.season ?? "").replace(/\/20(\d{2})/, "/$1"), // 2025/2026 -> 2025/26
    updated: t.scrapedAt ?? null,
    rows,   // skrót (Home)
    full,   // pełna tabela (widok Tabela)
  };
}

/* mapa teamId -> logo (data-URI) w zadanym rozmiarze; 64px do chipów, 160px do teł "ghost" jak w NBA */
function buildLogosMap(size) {
  if (!existsSync(TABLE_DATA)) return null;
  const t = JSON.parse(readFileSync(TABLE_DATA, "utf8"));
  const map = {};
  const addLogo = (teamId, abs) => {
    if (!teamId || map[teamId] || !existsSync(abs)) return;
    const small = normLogo(abs, size);
    if (small) map[teamId] = "data:image/png;base64," + readFileSync(small).toString("base64");
  };
  for (const team of t.teams ?? []) {
    if (!team.localLogo) continue;
    addLogo(team.teamId, resolve(dirname(TABLE_DATA), team.localLogo));
  }
  /* drużyny z terminarza, których nie ma w tabeli (np. Astoria Bydgoszcz):
     szukamy pliku data/logos/<teamId>-<slug>.png */
  if (existsSync(SCHEDULE_DATA)) {
    const s = JSON.parse(readFileSync(SCHEDULE_DATA, "utf8"));
    const seen = new Set();
    for (const m of s.matches ?? []) {
      for (const side of [m.home, m.away]) {
        if (!side?.teamId || seen.has(side.teamId)) continue;
        seen.add(side.teamId);
        addLogo(side.teamId, resolve(dir, `../data/logos/${side.teamId}-${side.slug}.png`));
      }
    }
  }
  return Object.keys(map).length ? map : null;
}

/* mecze Anwilu: terminarz z kkwloclawek.pl (PLK + ENBL).
   Gdy brak kkw-schedule, awaryjnie stary terminarz plk.pl. */
const matchEnblLogos = {}; /* teamId -> data-URI (rywale ENBL) — dokładane do map log */
function buildMatches(enbl) {
  const details = loadMatchDetails();
  const list = [];

  const plkTeams = existsSync(TABLE_DATA) ? (JSON.parse(readFileSync(TABLE_DATA, "utf8")).teams ?? []) : [];
  const byNorm = new Map(plkTeams.map((t) => [normName(t.name), t]));
  const resolveTeam = (name, league) => {
    const t = league === "PLK" ? byNorm.get(normName(name)) : null;
    if (t) return { teamId: t.teamId, slug: t.slug, name: t.name, short: shortName(t) };
    const teamId = "enbl-" + slugify(name);
    const logo = enbl ? enblLogoFor(name, enbl.byToken) : "";
    if (logo) matchEnblLogos[teamId] = logo;
    return { teamId, slug: slugify(name), name, short: enblShort(name) };
  };

  if (existsSync(KKW_SCHEDULE)) {
    const s = JSON.parse(readFileSync(KKW_SCHEDULE, "utf8"));
    /* numeracja kolejek PLK wg kolejności w terminarzu (kkw nie podaje rund) */
    let plkNo = 0;
    for (const m of s.matches ?? []) {
      const league = m.league || "PLK";
      const round = league === "PLK" ? ++plkNo : null;
      const anwilHome = /anwil/i.test(m.home);
      const label = league === "ENBL" ? "ENBL" : league === "PLK" ? `Kolejka ${round}` : (m.label || league);
      list.push({
        matchId: null, round, label, league,
        date: m.date, dateStr: m.date ? `${fmtDate(m.date)} · ${m.date.slice(11, 16)}` : (m.dateRaw ?? ""),
        home: resolveTeam(m.home, league), away: resolveTeam(m.away, league),
        hs: m.homeScore, as: m.awayScore, played: !!m.played,
        anwilHome,
        anwilWin: m.played ? (anwilHome ? m.homeScore > m.awayScore : m.awayScore > m.homeScore) : null,
        tv: null, url: null,
      });
    }
  } else if (existsSync(SCHEDULE_DATA)) {
    const s = JSON.parse(readFileSync(SCHEDULE_DATA, "utf8"));
    const anwilSlug = "anwil-wloclawek";
    for (const m of s.matches ?? []) {
      const anwilHome = m.home.slug === anwilSlug;
      list.push({
        matchId: m.matchId, round: m.round, label: `Kolejka ${m.round}`, league: "PLK",
        date: m.date, dateStr: m.date ? `${fmtDate(m.date)} · ${m.date.slice(11, 16)}` : m.dateRaw ?? "",
        home: { teamId: m.home.teamId, name: m.home.name, short: shortName(m.home) },
        away: { teamId: m.away.teamId, name: m.away.name, short: shortName(m.away) },
        hs: m.homeScore, as: m.awayScore, played: m.played,
        anwilHome,
        anwilWin: m.played ? (anwilHome ? m.homeScore > m.awayScore : m.awayScore > m.homeScore) : null,
        tv: m.tv, url: m.url,
      });
    }
  } else {
    return null;
  }
  if (!list.length) return null;

  /* ENBL: powiąż mecze z terminarza z pobranymi szczegółami z Genius
     (data/enbl-matches.json z enbl-match.mjs) — ustawia matchId, wynik, status.
     Dzięki temu Match Center dla ENBL wygląda tak samo jak dla PLK. */
  if (existsSync(ENBL_MATCHES)) {
    try {
      const idx = JSON.parse(readFileSync(ENBL_MATCHES, "utf8")).matches ?? [];
      const day = (s) => String(s ?? "").slice(0, 10);
      const sameTeam = (a, b) => {
        const ta = tokensOf(a), tb = tokensOf(b);
        return ta.length > 0 && tb.length > 0 && ta.some((t) => tb.includes(t));
      };
      for (const e of idx) {
        if (!e.matchId) continue;
        const d = day(e.matchTime);
        const opp = e.anwilHome ? e.away : e.home;
        const f = list.find((m) => m.league === "ENBL" && !m.matchId &&
          (!d || day(m.date) === d) && (sameTeam(m.home.name, opp) || sameTeam(m.away.name, opp)));
        if (!f) continue;
        f.matchId = e.matchId;
        if (e.url) f.url = e.url;
        if (e.completed) {
          f.hs = e.homeScore; f.as = e.awayScore;
          if (f.anwilHome !== !!e.anwilHome) { f.hs = e.awayScore; f.as = e.homeScore; }
          f.played = true;
          f.anwilWin = f.hs > f.as;
        }
      }
    } catch (err) { process.stderr.write(`  ENBL: nie udało się powiązać meczów (${err.message})\n`); }
  }

  list.sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || (a.date ?? "").localeCompare(b.date ?? ""));
  // nierozegrane na górze, rozegrane na sam dół (w obrębie grup wg kolejki)
  list.sort((a, b) => (a.played ? 1 : 0) - (b.played ? 1 : 0));

  // szczegóły (boxscore, mapa rzutów...) dla N najnowszych rozegranych
  let attached = 0;
  for (const m of list) {
    if (attached >= DETAIL_N) break;
    if (!m.played || !details[m.matchId]) continue;
    try { m.detail = compactDetail(details[m.matchId]); attached++; }
    catch (e) { process.stderr.write(`  detail ${m.matchId} pominięty: ${e.message}\n`); }
  }
  process.stderr.write(`Szczegóły meczów osadzone: ${attached}\n`);
  return list;
}

/* ---- kompaktowanie szczegółów meczu (boxscore, mapa rzutów, momentum) ---- */
function timeToMin(t) { // "07:31" -> minuty (pozostałe w kwarcie)
  const [m, s] = (t ?? "0:0").split(":").map(Number);
  return (m ?? 0) + (s ?? 0) / 60;
}
function compactDetail(raw) {
  const homeId = raw.home.id;
  const box = {};
  for (const [key, team] of [["h", raw.home], ["a", raw.away]]) {
    box[key] = (team.players ?? [])
      .filter((p) => p.stats && (p.stats.playTimeSeconds > 0))
      .map((p) => ({
        pid: p.id,
        n: p.shirtNumber ?? "", nm: `${(p.firstName ?? "").slice(0, 1)}. ${p.lastName ?? ""}`.trim(),
        min: Math.round((p.stats.playTimeSeconds ?? 0) / 60),
        pts: p.stats.points, reb: p.stats.reboundsTotal, ast: p.stats.assists,
        stl: p.stats.steals, blk: p.stats.blocks, to: p.stats.turnovers,
        pm: p.stats.plusMinus, ev: p.stats.eval,
        m2: p.stats.madeTwoPts, a2: p.stats.attemptTwoPts,
        m3: p.stats.madeThreePts, a3: p.stats.attemptThreePts,
        m1: p.stats.madeFreeThrowPts, a1: p.stats.attemptFreeThrowPts,
        s5: p.stats.isStart5 ? 1 : 0,
      }))
      .sort((x, y) => y.ev - x.ev);
  }
  const sum = (arr, k) => arr.reduce((a, p) => a + (p[k] ?? 0), 0);
  const ts = {};
  for (const key of ["h", "a"]) {
    ts[key] = {
      m2: sum(box[key], "m2"), a2: sum(box[key], "a2"),
      m3: sum(box[key], "m3"), a3: sum(box[key], "a3"),
      m1: sum(box[key], "m1"), a1: sum(box[key], "a1"),
      reb: sum(box[key], "reb"), ast: sum(box[key], "ast"), to: sum(box[key], "to"),
      stl: sum(box[key], "stl"), blk: sum(box[key], "blk"),
    };
  }
  // momentum: różnica punktowa po każdej akcji punktowej, oś czasu w minutach meczu
  const mom = [[0, 0]];
  const pbp = [];
  for (const e of raw.playByPlay) {
    if (!e.scoring) continue;
    const t = (e.q - 1) * 10 + (10 - timeToMin(e.time));
    mom.push([Math.round(t * 100) / 100, e.ph - e.pa]);
    pbp.push([e.q, e.time, e.teamId === homeId ? 0 : 1, e.akcja, e.ph, e.pa]);
  }
  mom.push([40, raw.homeScore - raw.awayScore]);
  // rzuty: [q, x, y, made, pts, teamFlag, gracz]
  const shots = raw.shots.map((s) => [s.q, s.x, s.y, s.made ? 1 : 0, s.pts, s.teamId === homeId ? 0 : 1, s.player]);
  // MVP Anwilu: najwyższy eval wśród zawodników Anwilu (nie całego meczu)
  const anwilKey = raw.home.id === 33 ? "h" : "a";
  const mvp = box[anwilKey][0] // box jest posortowany malejąco po eval
    ? { ...box[anwilKey][0], t: anwilKey === "a" ? 1 : 0 }
    : null;
  return {
    q: raw.quarters.map((x) => [x.home, x.away]),
    venue: raw.venue, referees: raw.referees,
    mvp: mvp ? {
      pid: mvp.pid, nm: mvp.nm, t: mvp.t, n: mvp.n,
      pts: mvp.pts, reb: mvp.reb, ast: mvp.ast, ev: mvp.ev,
      line: `${mvp.pts} PKT · ${mvp.reb} ZB · ${mvp.ast} AS · EVAL ${mvp.ev}`,
    } : null,
    ts, box, mom, pbp, shots,
  };
}

/* wczytaj pobrane szczegóły meczów: matchId -> raw json */
function loadMatchDetails() {
  if (!existsSync(MATCHES_DIR)) return {};
  const out = {};
  for (const f of readdirSync(MATCHES_DIR)) {
    if (!f.endsWith(".json")) continue;
    try { const j = JSON.parse(readFileSync(resolve(MATCHES_DIR, f), "utf8")); out[j.matchId] = j; }
    catch { /* pomijamy */ }
  }
  return out;
}

function fmtDate(iso) {
  if (!iso) return "";
  const [d] = iso.split("T");
  const [y, m, dd] = d.split("-");
  return `${dd}.${m}.${y}`;
}

/* ---- panel admina: lista scraperów + realny status z plików danych ---- */
function buildAdmin() {
  const meta = (file) => {
    const p = resolve(dir, "../data", file);
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
  };
  const news = meta("news.json"), table = meta("plk-table.json");
  const sched = meta("kkw-schedule.json"), enbl = meta("enbl.json"), rosterKkw = meta("roster-kkw.json"), shop = meta("shop.json");
  const enblMatch = meta("enbl-matches.json");
  const matchFiles = existsSync(MATCHES_DIR)
    ? readdirSync(MATCHES_DIR).filter((f) => f.endsWith(".json")) : [];
  const matchesN = matchFiles.length;
  // czas ostatniego pobrania meczu = najnowszy scrapedAt z data/matches/
  let matchAt = null;
  for (const f of matchFiles) {
    try {
      const at = JSON.parse(readFileSync(resolve(MATCHES_DIR, f), "utf8")).scrapedAt;
      if (at && (!matchAt || at > matchAt)) matchAt = at;
    } catch { /* pomijamy */ }
  }
  const q = (v) => v ?? "?";
  return {
    scrapers: [
      { id: "news", icon: "📰", name: "Aktualności", desc: "Newsy klubowe z kkwloclawek.pl — pełna treść i grafiki",
        cmd: "node scrapers/kkwloclawek-news.mjs --pages 2 --full --images",
        at: news.scrapedAt ?? null, info: news.count != null ? `${news.count} newsów w bazie` : "brak danych",
        log: ["GET kkwloclawek.pl/aktualnosci/1 … 10 artykułów", "GET kkwloclawek.pl/aktualnosci/2 … 10 artykułów",
              "Pobieranie pełnej treści i grafik…", `✔ Zapisano ${q(news.count)} newsów → data/news.json`] },
      { id: "table", icon: "📊", name: "Tabela PLK + loga", desc: "Tabela Orlen Basket Ligi i loga wszystkich drużyn",
        cmd: "node scrapers/plk-table.mjs --logos",
        at: table.scrapedAt ?? null, info: table.count != null ? `${table.count} drużyn · sezon ${table.season ?? "?"}` : "brak danych",
        log: ["GET plk.pl/tabele …", "Loga drużyn: 16/16 pobranych",
              `✔ Tabela ${table.season ?? ""} (${q(table.count)} drużyn) → data/plk-table.json`] },
      { id: "schedule", icon: "📅", name: "Terminarz Anwilu (PLK + ENBL)", desc: "Cały terminarz z kkwloclawek.pl/terminarz — liga i europejski puchar ENBL",
        cmd: "node scrapers/kkw-schedule.mjs",
        at: sched.scrapedAt ?? null, info: sched.count != null ? `${sched.count} meczów · rozegrane ${sched.played ?? 0}` : "brak danych",
        log: ["GET kkwloclawek.pl/terminarz …", "Tabela .table-terminarz: PLK + European North BL",
              `✔ ${q(sched.count)} meczów (ENBL ${q((sched.byLeague ?? {}).ENBL)}, PLK ${q((sched.byLeague ?? {}).PLK)}) → data/kkw-schedule.json`] },
      { id: "enbl", icon: "🌍", name: "ENBL + loga drużyn", desc: "Tabela i statystyki zawodników (Genius Sports) + loga z enbleague.eu",
        cmd: "node scrapers/enbl.mjs",
        at: enbl.scrapedAt ?? null, info: enbl.standings ? `${enbl.standings.length} drużyn · ${(enbl.leaders ?? []).length} kategorii stat.` : "brak danych",
        log: ["GET enbleague.eu … loga drużyn", "Genius Sports: standings + leaders",
              `✔ ENBL: ${q((enbl.standings ?? []).length)} drużyn, ${q((enbl.leaders ?? []).length)} stat. → data/enbl.json`] },
      { id: "roster", icon: "🧑‍🏫", name: "Skład + sztab", desc: "Aktualna kadra i sztab szkoleniowy z kkwloclawek.pl/sklad",
        cmd: "node scrapers/kkw-roster.mjs",
        at: rosterKkw.scrapedAt ?? null, info: rosterKkw.count != null ? `${rosterKkw.count} zawodników + ${rosterKkw.staffCount ?? 0} sztabu` : "brak danych",
        log: ["GET kkwloclawek.pl/sklad …", "Profile zawodników (pozycja, wzrost, kraj, kontrakt)",
              `✔ Sezon ${rosterKkw.season ?? "?"}: ${q(rosterKkw.count)} zawodników + ${q(rosterKkw.staffCount)} sztabu → data/roster-kkw.json`] },
      { id: "match", icon: "🏀", name: "Szczegóły meczów", desc: "Boxscore, przebieg i mapa rzutów każdego meczu",
        cmd: "node scrapers/plk-match.mjs --all",
        at: matchAt, info: `${matchesN} meczów w data/matches/`,
        log: ["Mecz 1/31 … boxscore + 190 rzutów", "Mecz 2/31 … boxscore + 167 rzutów", "…",
              `✔ ${matchesN} meczów → data/matches/`] },
      { id: "enbl-match", icon: "🌐", name: "Szczegóły meczów ENBL", desc: "Boxscore, przebieg i mapa rzutów meczów ENBL (Genius Sports / fibalivestats)",
        cmd: "node scrapers/enbl-match.mjs",
        at: enblMatch.scrapedAt ?? null,
        info: (enblMatch.matches ?? []).length ? `${enblMatch.matches.length} meczów · ${(enblMatch.matches ?? []).filter((m) => m.completed).length} rozegranych` : "brak danych",
        log: ["GET fibalivestats.com/data/competition/{id}.json …", "Genius Sports: data/{matchId}/data.json (boxscore, pbp, rzuty)",
              `✔ ENBL ${enblMatch.season ?? ""}: ${q((enblMatch.matches ?? []).length)} meczów → data/matches/ + data/enbl-matches.json`] },
      { id: "shop", icon: "🛍️", name: "Sklep klubowy", desc: "Produkty z WooCommerce Store API wraz ze zdjęciami",
        cmd: "node scrapers/sklep-products.mjs --images",
        at: shop.scrapedAt ?? null, info: shop.count != null ? `${shop.count} produktów w katalogu` : "brak danych",
        log: ["GET /wp-json/wc/store/v1/products/categories …", "Produkty, strona 1 … 100 szt.", "Produkty, strona 2 … 3 szt.",
              `✔ Zapisano ${q(shop.count)} produktów → data/shop.json`] },
      { id: "build", icon: "⚙️", name: "Przebuduj aplikację", desc: "Osadza świeże dane i grafiki w aplikacji",
        cmd: "node app/build.mjs",
        at: new Date().toISOString(), info: "generuje prototype.html",
        log: ["Osadzam newsy, tabelę, mecze i sklep…", "Miniatury i loga → data-URI", "✔ prototype.html gotowy"] },
    ],
  };
}

/* ---------------- build ---------------- */
const data = JSON.parse(readFileSync(DATA, "utf8"));
const items = data.items
  .filter((it) => it.title && it.content) // pełna treść wymagana (uruchom scraper z --full)
  .slice(0, COUNT);

if (!items.length) {
  console.error("Brak newsów z pełną treścią w data/news.json — uruchom scraper z --full.");
  process.exit(1);
}

const GRADS = [
  "radial-gradient(70% 90% at 30% 20%,rgba(0,91,255,.55),transparent 60%),linear-gradient(160deg,#0B2A63,#050D24)",
  "radial-gradient(70% 90% at 70% 25%,rgba(47,209,128,.35),transparent 60%),linear-gradient(160deg,#0B2A63,#050D24)",
  "radial-gradient(70% 90% at 50% 15%,rgba(77,134,255,.4),transparent 60%),linear-gradient(160deg,#0B2A63,#050D24)",
  "radial-gradient(70% 90% at 30% 80%,rgba(47,209,128,.3),transparent 60%),linear-gradient(160deg,#0B2A63,#050D24)",
];

const news = items.map((it, i) => {
  let img = null;
  if (!NO_IMAGES && it.localImage) {
    const abs = resolve(dirname(DATA), it.localImage);
    if (existsSync(abs)) {
      const small = thumbJpg(abs, 640);
      if (small) {
        img = "data:image/jpeg;base64," + readFileSync(small).toString("base64");
        process.stderr.write(`Grafika ${i + 1}/${items.length}: ${it.id}\n`);
      }
    }
  }
  return {
    tag: inferTag(it),
    time: fmtDate(it.date),
    title: it.title,
    lead: it.lead ?? "",
    body: it.content,          // pełna treść artykułu ze scrapera
    author: it.author ?? null,
    url: it.url,
    img,
    art: GRADS[i % GRADS.length],
  };
});

let html = readFileSync(TEMPLATE, "utf8");
if (!html.includes("__NEWS_DATA__")) {
  console.error("Brak tokena __NEWS_DATA__ w template.html");
  process.exit(1);
}
// < zamiast <, żeby treść nie mogła przypadkiem zamknąć <script>
const enc = (v) => JSON.stringify(v, null, 0).replace(/</g, "\\u003c");
html = html.replace("__NEWS_DATA__", enc(news));

const table = buildTable();
if (html.includes("__TABLE_DATA__")) {
  html = html.replace("__TABLE_DATA__", enc(table)); // null => fallback na statyczne wiersze
} else {
  process.stderr.write("Uwaga: brak tokena __TABLE_DATA__ w szablonie\n");
}

const enbl = buildEnbl();
const matches = buildMatches(enbl);

/* zdjęcia MVP: strony meczów podają photoUrl każdego zawodnika — dociągamy
   brakujące portrety (cache w data/players/) i osadzamy 160px data-URI.
   Offline: pobranie się nie uda -> aplikacja pokaże inicjały. */
async function attachMvpPhotos(list) {
  if (!list) return;
  const details = loadMatchDetails();
  const pDir = resolve(dir, "../data/players");
  mkdirSync(pDir, { recursive: true });
  for (const m of list) {
    const mvp = m.detail?.mvp;
    if (!mvp?.pid) continue;
    const file = resolve(pDir, `${mvp.pid}.jpg`);
    if (!existsSync(file)) {
      const raw = details[m.matchId];
      const pl = raw && [...(raw.home.players ?? []), ...(raw.away.players ?? [])].find((p) => p.id === mvp.pid);
      if (!pl?.photoUrl) continue;
      try {
        const res = await fetch(pl.photoUrl, {
          headers: { "User-Agent": "AnwilZoneScraper/1.0 (prototyp aplikacji kibica)" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 500) throw new Error("podejrzanie mały plik");
        writeFileSync(file, buf);
        process.stderr.write(`Zdjęcie MVP: ${mvp.nm} (${Math.round(buf.length / 1024)} KB)\n`);
      } catch (e) {
        process.stderr.write(`Zdjęcie MVP pominięte (${mvp.nm}): ${e.message}\n`);
        continue;
      }
    }
    const small = thumbJpg(file, 160);
    if (small) mvp.photo = "data:image/jpeg;base64," + readFileSync(small).toString("base64");
  }
}
await attachMvpPhotos(matches);

const logos = buildLogosMap(96) || {};
const logosBig = buildLogosMap(160) || {};
/* loga rywali ENBL (z enbleague.eu) — pod wspólnymi kluczami teamId */
for (const [id, uri] of Object.entries(matchEnblLogos)) { if (!logos[id]) logos[id] = uri; if (!logosBig[id]) logosBig[id] = uri; }
const shop = buildShop();
const roster = buildRoster();
const rosterKkw = buildRosterKkw();
const enblRoster = buildEnblRoster(matches);
const plkRoster = buildPlkRoster(matches);
for (const [token, val] of [["__MATCHES_DATA__", matches], ["__LOGOS_DATA__", Object.keys(logos).length ? logos : null], ["__LOGOSBIG_DATA__", Object.keys(logosBig).length ? logosBig : null], ["__ENBL_DATA__", enbl ? enbl.data : null], ["__ENBL_ROSTER__", enblRoster], ["__PLK_ROSTER__", plkRoster], ["__SHOP_DATA__", shop], ["__ROSTER_DATA__", roster], ["__ROSTER_KKW__", rosterKkw], ["__ADMIN_DATA__", buildAdmin()]]) {
  if (html.includes(token)) html = html.replace(token, enc(val)); // null => fallback na mocki
  else process.stderr.write(`Uwaga: brak tokena ${token} w szablonie\n`);
}

const anwilLogo = buildAnwilLogo(440, "splash");        // ekran startowy
/* pasek górny: 72 px w interfejsie × 4 = 288 px pliku (zapas na ekrany 2×/3×),
   dzięki czemu przeglądarka tylko zmniejsza i logo jest ostrzejsze */
const anwilLogoSm = buildAnwilLogo(288, "bar288") || anwilLogo;
/* brak maski splash → awaryjnie logo klubowe (też z przezroczystością) */
const splashMask = buildSplashMask() || anwilLogo;
html = html.replaceAll("__SPLASH_MASK__", splashMask);
/* herb w pasku górnym (maska); awaryjnie logo klubowe */
html = html.replaceAll("__HEADER_CREST__", buildHeaderCrest() || anwilLogoSm);
/* tło najbliższego meczu; brak grafiki = przezroczysty 1x1 GIF */
html = html.replaceAll("__HERO_PLATE__", buildHeroPlate() || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
/* ilustracja komentatora w karcie radia; awaryjnie logo klubowe */
html = html.replaceAll("__RADIO_ANN__", buildRadioAnnouncer() || anwilLogo);
html = html.replaceAll("__ANWIL_LOGO_SM__", anwilLogoSm);
html = html.replaceAll("__ANWIL_LOGO__", anwilLogo);

writeFileSync(OUT, html);
console.log(
  `prototype.html zbudowany: ${news.length} newsów, tabela: ${table ? table.season + " (" + table.rows.length + " wierszy)" : "brak danych"}, mecze: ${matches ? matches.length : "brak danych"}, loga: ${logos ? Object.keys(logos).length : 0}, sklep: ${shop ? shop.products.length : 0} prod., skład: ${roster ? roster.players.length : 0} zaw., ${Math.round(html.length / 1024)} KB`
);
