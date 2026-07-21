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
const MATCHES_DIR = resolve(dir, "../data/matches");
const OUT = resolve(dir, "prototype.html");
const DETAIL_N = Math.max(0, parseInt(opt("detail", "8"), 10) || 8);

/* mecze spoza terminarza sezonu zasadniczego (faza posezonowa) */
const PHASE_LABELS = { 222605: "Play-in" };
const PHASE_DATES = { 222605: "2026-05-10T17:30:00" }; /* strona meczu nie podaje daty wprost */

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
function buildAnwilLogo() {
  let src = resolve(dir, "../data/logos/anwil-org.png");
  if (!existsSync(src)) src = resolve(dir, "../data/logos/33-anwil-wloclawek.png");
  if (!existsSync(src)) return "";
  const out = src.replace(/\.png$/i, "") + "_splash.png";
  if (!existsSync(out)) {
    const ps = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${src}')
$max=440
$ratio=[Math]::Min($max/$img.Width,$max/$img.Height)
$w=[int]($img.Width*$ratio);$h=[int]($img.Height*$ratio)
$bmp=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img,0,0,$w,$h)
$bmp.Save('${out}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose();$img.Dispose()`;
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(out)) {
      process.stderr.write("  resize loga splash nieudany\n");
      return "";
    }
  }
  return "data:image/png;base64," + readFileSync(out).toString("base64");
}

/* tabela: top 5 + Anwil (jeśli poza top 5), loga jako data-URI */
function buildTable() {
  if (!existsSync(TABLE_DATA)) return null;
  const t = JSON.parse(readFileSync(TABLE_DATA, "utf8"));
  if (!t.teams?.length) return null;
  const anwil = t.teams.find((x) => x.slug === "anwil-wloclawek");
  let rows = t.teams.slice(0, 5);
  if (anwil && anwil.pos > 5) rows = [...t.teams.slice(0, 4), anwil];
  return {
    season: (t.season ?? "").replace(/\/20(\d{2})/, "/$1"), // 2025/2026 -> 2025/26
    rows: rows.map((r) => {
      let logo = "";
      if (r.localLogo) {
        const abs = resolve(dirname(TABLE_DATA), r.localLogo);
        if (existsSync(abs)) {
          const small = logo64(abs);
          if (small) logo = "data:image/png;base64," + readFileSync(small).toString("base64");
        }
      }
      return {
        pos: r.pos, name: r.name, games: r.games, wins: r.wins,
        losses: r.losses, points: r.points, logo,
        me: r.slug === "anwil-wloclawek",
      };
    }),
  };
}

/* mapa teamId -> logo (data-URI) w zadanym rozmiarze; 64px do chipów, 160px do teł "ghost" jak w NBA */
function buildLogosMap(size) {
  if (!existsSync(TABLE_DATA)) return null;
  const t = JSON.parse(readFileSync(TABLE_DATA, "utf8"));
  const map = {};
  for (const team of t.teams ?? []) {
    if (!team.localLogo) continue;
    const abs = resolve(dirname(TABLE_DATA), team.localLogo);
    if (!existsSync(abs)) continue;
    const small = logoPng(abs, size);
    if (small) map[team.teamId] = "data:image/png;base64," + readFileSync(small).toString("base64");
  }
  return Object.keys(map).length ? map : null;
}

/* mecze Anwilu z terminarza plk.pl + faza posezonowa z data/matches, najnowsze najpierw */
function buildMatches() {
  if (!existsSync(SCHEDULE_DATA)) return null;
  const s = JSON.parse(readFileSync(SCHEDULE_DATA, "utf8"));
  if (!s.matches?.length) return null;
  const anwilSlug = "anwil-wloclawek";
  const details = loadMatchDetails();
  const knownIds = new Set(s.matches.map((m) => m.matchId));

  const list = s.matches.map((m) => {
    const anwilHome = m.home.slug === anwilSlug;
    return {
      matchId: m.matchId,
      label: `Kolejka ${m.round}`,
      date: m.date,
      dateStr: m.date ? `${fmtDate(m.date)} · ${m.date.slice(11, 16)}` : m.dateRaw ?? "",
      home: { teamId: m.home.teamId, name: m.home.name, short: shortName(m.home) },
      away: { teamId: m.away.teamId, name: m.away.name, short: shortName(m.away) },
      hs: m.homeScore, as: m.awayScore,
      played: m.played,
      anwilHome,
      anwilWin: m.played ? (anwilHome ? m.homeScore > m.awayScore : m.awayScore > m.homeScore) : null,
      tv: m.tv, url: m.url,
    };
  });

  // mecze posezonowe: pobrane szczegóły, których nie ma w terminarzu sezonu zasadniczego
  // (strona meczu nie podaje sluga drużyny — bierzemy go z tabeli po teamId)
  const slugById = {};
  if (existsSync(TABLE_DATA)) {
    for (const t of JSON.parse(readFileSync(TABLE_DATA, "utf8")).teams ?? []) slugById[t.teamId] = t.slug;
  }
  for (const [id, raw] of Object.entries(details)) {
    if (knownIds.has(+id)) continue;
    const anwilHome = raw.home.id === 33;
    const date = raw.date ?? PHASE_DATES[id] ?? null;
    list.push({
      matchId: +id,
      label: PHASE_LABELS[id] ?? "Play-off",
      date,
      dateStr: date ? `${fmtDate(date)}` : "faza posezonowa",
      home: { teamId: raw.home.id, name: raw.home.name, short: shortName({ slug: slugById[raw.home.id], name: raw.home.name }) },
      away: { teamId: raw.away.id, name: raw.away.name, short: shortName({ slug: slugById[raw.away.id], name: raw.away.name }) },
      hs: raw.homeScore, as: raw.awayScore,
      played: true,
      anwilHome,
      anwilWin: anwilHome ? raw.homeScore > raw.awayScore : raw.awayScore > raw.homeScore,
      tv: null, url: raw.url,
    });
  }

  list.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

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
  const sched = meta("plk-schedule-anwil.json"), shop = meta("shop.json");
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
      { id: "schedule", icon: "📅", name: "Terminarz Anwilu", desc: "Mecze, wyniki i transmisje z plk.pl/terminarz",
        cmd: "node scrapers/plk-schedule.mjs --team anwil-wloclawek",
        at: sched.scrapedAt ?? null, info: sched.count != null ? `${sched.count} meczów · rozegrane ${sched.played ?? 0}` : "brak danych",
        log: ["GET plk.pl/terminarz … 30 kolejek", `✔ Terminarz ${sched.season ?? ""}: ${q(sched.count)} meczów Anwilu`] },
      { id: "match", icon: "🏀", name: "Szczegóły meczów", desc: "Boxscore, przebieg i mapa rzutów każdego meczu",
        cmd: "node scrapers/plk-match.mjs --all",
        at: matchAt, info: `${matchesN} meczów w data/matches/`,
        log: ["Mecz 1/31 … boxscore + 190 rzutów", "Mecz 2/31 … boxscore + 167 rzutów", "…",
              `✔ ${matchesN} meczów → data/matches/`] },
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
  "radial-gradient(70% 90% at 70% 25%,rgba(255,193,7,.35),transparent 60%),linear-gradient(160deg,#0B2A63,#050D24)",
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

const matches = buildMatches();

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

const logos = buildLogosMap(64);
const logosBig = buildLogosMap(160);
const shop = buildShop();
const roster = buildRoster();
for (const [token, val] of [["__MATCHES_DATA__", matches], ["__LOGOS_DATA__", logos], ["__LOGOSBIG_DATA__", logosBig], ["__SHOP_DATA__", shop], ["__ROSTER_DATA__", roster], ["__ADMIN_DATA__", buildAdmin()]]) {
  if (html.includes(token)) html = html.replace(token, enc(val)); // null => fallback na mocki
  else process.stderr.write(`Uwaga: brak tokena ${token} w szablonie\n`);
}

const anwilLogo = buildAnwilLogo();
html = html.replaceAll("__ANWIL_LOGO__", anwilLogo);

writeFileSync(OUT, html);
console.log(
  `prototype.html zbudowany: ${news.length} newsów, tabela: ${table ? table.season + " (" + table.rows.length + " wierszy)" : "brak danych"}, mecze: ${matches ? matches.length : "brak danych"}, loga: ${logos ? Object.keys(logos).length : 0}, sklep: ${shop ? shop.products.length : 0} prod., skład: ${roster ? roster.players.length : 0} zaw., ${Math.round(html.length / 1024)} KB`
);
