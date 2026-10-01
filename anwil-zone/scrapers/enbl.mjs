#!/usr/bin/env node
/**
 * Scraper ENBL (European North Basketball League) dla Anwilu.
 *
 * Skąd dane:
 *  1) LOGA DRUŻYN — https://www.enbleague.eu/ (Wix). Na stronie głównej jest
 *     pasek drużyn; grafiki siedzą w danych Wix jako media-id (static.wixstatic.com).
 *     W HTML są escape'owane (`&quot;`); pobieramy je w wersji zmniejszonej
 *     (w_180) do ../data/logos/enbl/.
 *  2) STATYSTYKI / TABELA — ENBL osadza widgety **Genius Sports**
 *     (hosted.dcd.shared.geniussports.com). Ich dane są dostępne jako JSON pod
 *     /embednf/ENBL/en/<strona> (pole `html` z gotowym fragmentem). Bierzemy:
 *       - standings → tabela ligi
 *       - leaders   → średnie zawodników (PPG, APG, zbiórki, bloki, przechwyty, …)
 *
 * Użycie:
 *   node enbl.mjs                    # -> ../data/enbl.json + ../data/logos/enbl/
 *   node enbl.mjs --no-logos         # tylko statystyki
 *
 * Uwaga: widget Genius pokazuje AKTUALNĄ fazę rozgrywek; na starcie sezonu
 * może to być jeszcze poprzedni sezon, dopóki ENBL nie wgra nowych danych.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIX = "https://www.enbleague.eu/";
const WIX_MEDIA = "https://static.wixstatic.com/media/";
const GENIUS = "https://hosted.dcd.shared.geniussports.com";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const NO_LOGOS = args.includes("--no-logos");
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, "../data/enbl.json");
const LOGO_DIR = resolve(__dir, "../data/logos/enbl");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, accept = "text/html") {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: accept, Referer: WIX },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
      return await res.text();
    } catch (e) { lastErr = e; await sleep(900); }
  }
  throw lastErr;
}

const strip = (h) => h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
const text = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const slugify = (s) => s.toLowerCase()
  .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e").replace(/ł/g, "l").replace(/ń/g, "n")
  .replace(/ó/g, "o").replace(/ś/g, "s").replace(/ź/g, "z").replace(/ż/g, "z")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---------------- Genius Sports ---------------- */
async function genius(page) {
  const raw = await getText(`${GENIUS}/embednf/ENBL/en/${page}`, "application/json");
  const j = JSON.parse(raw);
  return strip(j.html || "");
}

/* Najnowszy sezon ENBL w Genius. Strona /standings ma chooser z listą
   "ENBL 20xx/20xx" -> competition/{id}/standings. Bierzemy najpóźniejszy rok,
   dzięki czemu nowy sezon (np. 2026/2027 → 50063) działa bez zmiany kodu. */
async function currentCompetition() {
  try {
    const html = await getText(`${GENIUS}/ENBL/en/standings`);
    const opts = [...html.matchAll(/competition\/(\d+)\/standings"[^>]*>\s*ENBL\s+(\d{4})\s*\/\s*(\d{4})/gi)]
      .map((m) => ({ id: +m[1], season: `${m[2]}/${m[3]}` }));
    if (!opts.length) return null;
    opts.sort((a, b) => a.season.localeCompare(b.season));
    return opts[opts.length - 1];
  } catch { return null; }
}

function parseStandings(html) {
  const rows = [];
  for (const r of html.split(/<tr[^>]*>/).slice(1)) {
    const cells = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1]);
    if (cells.length < 11) continue;
    const teamCell = cells[2];
    const teamLink = teamCell.match(/href\s*=\s*"([^"]+)"/);
    const teamId = (r.match(/standings_team_(\d+)/) || [])[1] || null;
    const num = (i) => { const n = parseInt(text(cells[i]).replace(/[^\d-]/g, ""), 10); return Number.isFinite(n) ? n : null; };
    /* nazwa bez 3-literowego kodu (osobny <span class="team-name-code">) */
    const full = (teamCell.match(/class=["']team-name-full["'][^>]*>([\s\S]*?)<\/span>/) || [])[1];
    let team = (full ? text(full) : text(teamCell).replace(/\s+[A-Z0-9]{2,4}\s*$/, "")).trim();
    if (NAME_FIX[team.toLowerCase()]) team = NAME_FIX[team.toLowerCase()];
    if (!team || /^team$/i.test(team)) continue;
    rows.push({
      pos: num(0), team, teamId: teamId ? +teamId : null,
      url: teamLink ? teamLink[1].replace(/\?.*$/, "") : null,
      form: text(cells[3]).split(/\s+/).filter((x) => /^[WL]$/.test(x)),
      gp: num(4), w: num(5), l: num(6), scored: num(7), conceded: num(8), diff: num(9), pts: num(10),
    });
  }
  return rows;
}

/* ---- tabela GRUPY, w której gra Anwil (np. Grupa B) ----
   Widget /standings pokazuje tylko jedną grupę i w sezonie 2026/27 jest to grupa,
   w której Anwil NIE gra. Tabela grupy jest dostępna na stronie drużyny:
   /competition/{id}/team/{teamId} → <table class="team-standings-table">.
   Kolumny: Position | (logo) | Team | GP | L5 | W | L | Pts            */
async function anwilTeamId(compId) {
  const raw = await getText(`${GENIUS}/embednf/ENBL/en/competition/${compId}/teams`, "application/json");
  const html = strip(JSON.parse(raw).html || "");
  const m = html.match(/team\/(\d+)\?">\s*<img[^>]*?\balt\s*=\s*"Anwil/i)
    || html.match(/\balt\s*=\s*"Anwil[^"]*"[\s\S]{0,240}?team\/(\d+)/i);
  return m ? +m[1] : null;
}

function parseGroupStandings(html, compId) {
  const tbl = html.match(/<table[^>]*team-standings-table[\s\S]*?<\/table>/i)?.[0];
  if (!tbl) return [];
  const rows = [];
  for (const r of tbl.split(/<tr[^>]*>/).slice(1)) {
    const tds = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
    if (tds.length < 8) continue;
    const link = (r.match(/href\s*=\s*"([^"]*competition\/\d+\/team\/\d+)/) || [])[1] || null;
    const teamId = (link ? (link.match(/team\/(\d+)/) || [])[1] : (r.match(/team\/(\d+)\?/) || [])[1]) || null;
    /* logo drużyny prosto z Geniusa — ratuje drużyny, których nie ma na enbleague.eu */
    const logoUrl = (r.match(/class="team-logo"[\s\S]{0,240}?<img[^>]*src="([^"]+)"/) || [])[1]
      || (r.match(/<img[^>]*src="(https:\/\/images\.statsengine[^"]+)"/) || [])[1] || null;
    const team = tds[2];
    if (!team || /^team$/i.test(team)) continue;
    const num = (i) => { const n = parseInt(tds[i], 10); return Number.isFinite(n) ? n : null; };
    let teamName = team;
    if (NAME_FIX[teamName.toLowerCase()]) teamName = NAME_FIX[teamName.toLowerCase()];
    rows.push({
      pos: num(0), team: teamName, teamId: teamId ? +teamId : null, logoUrl,
      form: tds[4].split(/\s+/).filter((x) => /^[WL]$/.test(x)),
      gp: num(3), w: num(5), l: num(6), pts: num(7),
      /* koszy/różnica nie są w tej tabeli — null, aplikacja ich nie używa */
      scored: null, conceded: null, diff: null,
      url: link ? link.replace(/\?.*$/, "") : null,
    });
  }
  return rows;
}

/* ---- brakujące loga: dociągamy z Geniusa dla drużyn z tabeli grupy ----
   Zestaw z enbleague.eu bywa niekompletny (np. Alkar Sinj), a Genius ma logo
   każdej drużyny w tabeli. Dociągamy tylko to, czego naprawdę brakuje. */
/* Loga wszystkich drużyn turnieju: /competition/{id}/teams ma <a href=…/team/{id}>
   z <img src="…statsengine…" alt="Nazwa">. Tabela grupy nie zawiera log, więc
   bierzemy je stąd (mapowanie teamId -> URL). */
async function competitionTeamLogos(compId) {
  const map = new Map();
  try {
    const raw = await getText(`${GENIUS}/embednf/ENBL/en/competition/${compId}/teams`, "application/json");
    const html = strip(JSON.parse(raw).html || "");
    /* uwaga: w tym HTML atrybuty mają spacje wokół `=` (src = "…") */
    for (const m of html.matchAll(/team\/(\d+)\?">\s*<img[^>]*?\bsrc\s*=\s*"([^"]+)"[^>]*?\balt\s*=\s*"([^"]*)"/gi)) {
      map.set(+m[1], { logoUrl: m[2], name: text(m[3]) });
    }
    /* alternatywny układ atrybutów: src po alt */
    for (const m of html.matchAll(/team\/(\d+)\?">\s*<img[^>]*?\balt\s*=\s*"([^"]*)"[^>]*?\bsrc\s*=\s*"([^"]+)"/gi)) {
      if (!map.has(+m[1])) map.set(+m[1], { logoUrl: m[3], name: text(m[2]) });
    }
  } catch (e) { process.stderr.write(`teamLogos: ${e.message}\n`); }
  return map;
}

async function ensureStandingsLogos(standings, logos) {
  const toks = (l) => (l.tokens?.length ? l.tokens : tokensOf(l.name));
  for (const r of standings) {
    if (!r.logoUrl) continue;
    const want = tokensOf(r.team);
    if (logos.some((l) => want.some((t) => toks(l).includes(t)))) continue; /* już mamy */
    const slug = slugify(r.team);
    const localLogo = `logos/enbl/${slug}.png`;
    const file = resolve(__dir, "../data", localLogo);
    mkdirSync(LOGO_DIR, { recursive: true });
    let ok = existsSync(file);
    if (!ok) {
      try {
        const res = await fetch(r.logoUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 300) throw new Error("podejrzanie mały plik");
        writeFileSync(file, buf);
        ok = true;
      } catch (e) { process.stderr.write(`Logo (Genius) pominięte: ${r.team} — ${e.message}\n`); }
    }
    if (ok) {
      logos.push({ name: r.team, slug, localLogo, logoUrl: r.logoUrl, tokens: want });
      process.stderr.write(`Logo (Genius): ${r.team}\n`);
    }
    await sleep(120);
  }
}

function parseLeaders(html) {
  const blocks = [];
  for (const part of html.split(/id\s*=\s*"BLOCK_LEADER/i).slice(1)) {
    const title = text((part.match(/class\s*=\s*"leader-header">([\s\S]*?)<\/div>/) || [])[1] || "");
    const unit = text((part.match(/class\s*=\s*"ld-statname">([\s\S]*?)<\/div>/) || [])[1] || "");
    const rows = [];
    for (const r of part.split(/<tr[^>]*>/).slice(1)) {
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]));
      const picked = cells.slice(-3);
      if (picked.length < 3) continue;
      const [player, team, value] = picked;
      if (!player || /^player$/i.test(player)) continue;
      const v = value.replace(/,/g, ".");
      if (!/\d/.test(v)) continue;
      rows.push({ player, team, value: v });
    }
    if (title && rows.length) blocks.push({ title, unit, rows });
  }
  return blocks;
}

/* ---------------- loga z Wix ---------------- */
const SKIP = /enbl|ewbl|vplab|mrg|fiziocentrs|myfitness|artboard|untitled|^img|logo|partner|sponsor|pdf|frame|copyright|^copy$|croati|federation|^\d+$/i;
/* aliasy wyrównują pisownię logo ↔ nazwę drużyny z terminarza/tabeli */
const ALIASES = {
  zrinski: ["zrinjski", "mostar"],
  ael: ["ael", "tria", "eka"],
  ciu: ["ciu"],
};
/* loga, których nie ma w zestawie na enbleague.eu (dokładamy ręcznie) */
const EXTRA_LOGOS = [
  { name: "BC Hipocredit", ext: "png", url: "https://bcjonavahipocredit.lt/assets/images/logo.png", tokens: ["hipocredit", "jonava"] },
];
/* pełne nazwy drużyn, gdy skrót ENBL/Genius jest zbyt krótki */
const NAME_FIX = { "bc hipocredit": "BC Jonava Hipocredit" };

function parseWixLogos(raw) {
  const h = raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\\\//g, "/").replace(/&#39;/g, "'");
  const out = [];
  const seen = new Set();
  const re = /\{"uri":"([^"]+?)","width":\d+,"height":\d+,"alt":"([^"]*)","name":"([^"]*)"/g;
  let m;
  while ((m = re.exec(h))) {
    const id = m[1];
    const name = (m[3] || m[2] || "").trim();
    if (!id || !name) continue;
    const extm = name.match(/\.(png|jpe?g|webp)$/i);
    const ext = extm ? (extm[1].toLowerCase() === "jpeg" ? "jpg" : extm[1].toLowerCase()) : "png";
    const clean = name.replace(/\.[a-z0-9]+$/i, "").replace(/^copy of\s+/i, "").trim();
    if (!clean || clean.length > 40 || SKIP.test(clean)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name: clean, ext, id });
  }
  return out;
}

function tokensOf(name) {
  return [...new Set(slugify(name).split("-").filter((t) => t.length >= 3 && !["basketball", "basket", "club", "team", "the", "and"].includes(t)))];
}

async function downloadLogos(logos) {
  mkdirSync(LOGO_DIR, { recursive: true });
  for (const l of logos) {
    const slug = slugify(l.name);
    const file = resolve(LOGO_DIR, `${slug}.${l.ext}`);
    l.localLogo = `logos/enbl/${slug}.${l.ext}`;
    l.logoUrl = l.url || `${WIX_MEDIA}${l.id}/v1/fill/w_180,h_180,al_c,q_85/${slug}.${l.ext}`;
    l.tokens = [...new Set([...(l.tokens || []), ...tokensOf(l.name), ...(ALIASES[slugify(l.name)] || []).filter(Boolean)])];
    if (existsSync(file)) continue;
    try {
      let buf = null;
      for (let i = 0; i < 3 && !buf; i++) {
        try {
          const res = await fetch(l.logoUrl, { headers: { "User-Agent": UA, Referer: WIX }, signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new Error("HTTP " + res.status);
          buf = Buffer.from(await res.arrayBuffer());
        } catch (e) { if (i === 2) throw e; await sleep(900); }
      }
      if (buf.length < 300) throw new Error("podejrzanie mały plik");
      writeFileSync(file, buf);
      process.stderr.write(`Logo ENBL: ${l.name} (${Math.round(buf.length / 1024)} KB)\n`);
    } catch (e) {
      process.stderr.write(`Logo ENBL pominięte (${l.name}): ${e.message}\n`);
      l.localLogo = null;
    }
    await sleep(120);
  }
}

async function main() {
  process.stderr.write("Genius: wybór sezonu (standings/leaders)...\n");
  const comp = await currentCompetition();
  const prefix = comp ? `competition/${comp.id}/` : "";
  if (comp) process.stderr.write(`  sezon ${comp.season} (competition ${comp.id})\n`);

  /* Tabela GRUPY z Anwilem (np. Grupa B) — widget /standings pokazuje inną grupę,
     więc bierzemy ją ze strony drużyny. Gdy nie ma drużyny/id, spadamy na /standings. */
  let standings = [], groupOf = null;
  if (comp) {
    const teamId = await anwilTeamId(comp.id).catch(() => null);
    if (teamId) {
      const teamHtml = await genius(`competition/${comp.id}/team/${teamId}`).catch((e) => { process.stderr.write(`strona drużyny: ${e.message}\n`); return ""; });
      const group = parseGroupStandings(teamHtml, comp.id);
      /* bierzemy tylko, jeśli to faktycznie grupa z Anwilem */
      if (group.length && group.some((r) => /anwil/i.test(r.team))) {
        standings = group;
        groupOf = "anwil";
        process.stderr.write(`  tabela grupy Anwila (Grupa B): ${standings.length} drużyn\n`);
      }
    }
  }
  if (!standings.length) {
    const sHtml = await genius(prefix + "standings").catch((e) => { process.stderr.write(`standings: ${e.message}\n`); return ""; });
    standings = parseStandings(sHtml);
    process.stderr.write(`  tabela (fallback /standings): ${standings.length} drużyn\n`);
  }

  const lHtml = await genius(prefix + "leaders").catch((e) => { process.stderr.write(`leaders: ${e.message}\n`); return ""; });
  const leaders = parseLeaders(lHtml);

  let logos = [];
  if (!NO_LOGOS) {
    process.stderr.write("Loga z enbleague.eu...\n");
    logos = [...parseWixLogos(await getText(WIX)), ...EXTRA_LOGOS];
    await downloadLogos(logos);
  }
  /* brakujące loga drużyn z tabeli grupy (np. Alkar Sinj) — dociągamy z Geniusa */
  if (comp) {
    const tmap = await competitionTeamLogos(comp.id);
    for (const r of standings) {
      if (!r.logoUrl && r.teamId && tmap.has(r.teamId)) r.logoUrl = tmap.get(r.teamId).logoUrl;
    }
  }
  await ensureStandingsLogos(standings, logos);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    source: { wix: WIX, genius: comp ? `${GENIUS}/ENBL/en/competition/${comp.id}/` : `${GENIUS}/ENBL/en/` },
    scrapedAt: new Date().toISOString(),
    competition: "ENBL",
    season: comp?.season ?? null,
    group: groupOf, /* tabela grupy, w której gra Anwil (Grupa B) */
    groupLabel: groupOf ? "Grupa B" : null,
    standings,
    leaders,
    logos: logos.filter((l) => l.localLogo).map(({ name, slug, tokens, localLogo, logoUrl }) => ({ name, slug: slug || slugify(name), tokens, localLogo, logoUrl })),
  }, null, 2), "utf8");

  console.log(`Zapisano ENBL ${comp?.season ?? ""}: ${standings.length} w tabeli, ${leaders.length} kategorii statystyk, ${logos.filter((l) => l.localLogo).length} log do ${OUT}`);
}

main().catch((e) => { console.error("Błąd scrapera:", e.message); process.exit(1); });
