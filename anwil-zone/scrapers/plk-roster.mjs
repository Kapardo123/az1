#!/usr/bin/env node
/**
 * Scraper składu drużyny z plk.pl — kadra + statystyki sezonu + mecz po meczu.
 *
 * Źródła (Next.js, dane renderowane serwerowo):
 *   /druzyny/{id}/{slug}/sklad              -> lista zawodników w strumieniu flight
 *        "players":[{id,firstName,lastName,slug,photoUrl,height,passport,
 *                    positions:[],shirtNumber,birthDate}]
 *   /zawodnicy/{id}/{slug}/mecz-po-meczu    -> tabele z każdym meczem sezonu
 *        (osobna tabela na fazę: play-off/play-in i sezon zasadniczy)
 *   /zawodnicy/{id}/{slug}/statystyki       -> historia sezonów (kariera)
 *
 * Statystyki sezonu liczymy SAMI z logu mecz-po-meczu — tabela zbiorcza na
 * plk.pl ma scalone nagłówki i niejednoznaczne kolumny, a suma z logu jest
 * weryfikowalna (zgadza się z boxscore'ami z plk-match.mjs).
 *
 * Użycie:
 *   node plk-roster.mjs                  # skład + statystyki + mecz po meczu
 *   node plk-roster.mjs --photos         # + zdjęcia zawodników (350x350)
 *   node plk-roster.mjs --no-games       # sam skład, bez logu meczowego
 *   node plk-roster.mjs --team 33 --slug anwil-wloclawek
 *
 * Wyjście: ../data/roster.json (+ ../data/players/{id}.jpg z --photos)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://plk.pl";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const TEAM_ID = opt("team", "33");
const TEAM_SLUG = opt("slug", "anwil-wloclawek");
const PHOTOS = args.includes("--photos");
const NO_GAMES = args.includes("no-games") || args.includes("--no-games");
const DELAY = Math.max(0, parseInt(opt("delay", "500"), 10) || 0);
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, opt("out", "../data/roster.json"));
const PHOTO_DIR = resolve(dirname(OUT), "players");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asBuffer = false) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "pl" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/* ---- strumień Next.js flight + zbalansowane wycięcie JSON-a ---- */
function decodeFlight(html) {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/gs)]
    .map((m) => JSON.parse('"' + m[1] + '"')).join("");
}
function balanced(s, start) {
  const open = s[start], close = open === "[" ? "]" : "}";
  let d = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === open) d++;
    else if (ch === close) { d--; if (d === 0) return s.slice(start, i + 1); }
  }
  throw new Error("niezbalansowany JSON");
}

/* ---- pomocnicze do tabel HTML ---- */
const clean = (h) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/\s+/g, " ").trim();
const tables = (html) => [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
function bodyRows(table) {
  const i = table.indexOf("<tbody");
  if (i < 0) return [];
  return [...table.slice(i).matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => m[0]);
}
const rawCells = (row) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1]);
const cells = (row) => rawCells(row).map(clean);
const num = (v) => {
  if (v == null) return null;
  const t = String(v).replace(",", ".").replace("+", "").trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const madeAtt = (v) => { // "3 / 5" -> {m:3,a:5}
  const m = String(v ?? "").match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { m: +m[1], a: +m[2] } : { m: null, a: null };
};
const minToSec = (v) => { // "30:35" -> 1835
  const m = String(v ?? "").match(/(\d+):(\d+)/);
  return m ? +m[1] * 60 + +m[2] : null;
};

/* ---- kolumny tabeli "mecz po meczu" (weryfikowane na danych z boxscore) ----
   0 logo | 1 rywal | 2 d/w | 3 Z/P | 4 wynik | 5 data | 6 S5 | 7 PKT | 8 min
   9 za2 | 10 za2% | 11 za3 | 12 za3% | 13 zGry | 14 zGry% | 15 wolne | 16 wolne%
   17 zbA | 18 zbO | 19 zbSuma | 20 AS | 21 F | 22 FW | 23 straty | 24 przechwyty
   25 bloki | 26 blokiOtrz | 27 Eval | 28 +/-                                   */
function parseGameRow(row) {
  const c = cells(row);
  if (c.length < 28) return null;
  // kolumna S5 to ikona gwiazdki (SVG), nie tekst — sprawdzamy surową komórkę
  const start5 = /<svg/i.test(rawCells(row)[6] ?? "");
  const matchUrl = row.match(/href="(\/mecz\/\d+\/[^"]+)"/)?.[1] ?? null;
  const oppUrl = row.match(/href="\/archiwum\/\d+\/druzyny\/(\d+)\/([a-z0-9-]+)"/);
  const p2 = madeAtt(c[9]), p3 = madeAtt(c[11]), fg = madeAtt(c[13]), ft = madeAtt(c[15]);
  return {
    matchId: matchUrl ? +matchUrl.match(/\/mecz\/(\d+)/)[1] : null,
    url: matchUrl ? BASE + matchUrl : null,
    date: c[5] || null,
    opponent: c[1] || null,
    opponentId: oppUrl ? +oppUrl[1] : null,
    opponentSlug: oppUrl ? oppUrl[2] : null,
    home: c[2] === "d",
    win: c[3] === "Z",
    score: c[4] || null,
    start5,
    sec: minToSec(c[8]),
    pts: num(c[7]),
    m2: p2.m, a2: p2.a, m3: p3.m, a3: p3.a,
    mfg: fg.m, afg: fg.a, m1: ft.m, a1: ft.a,
    rebO: num(c[17]), rebD: num(c[18]), reb: num(c[19]),
    ast: num(c[20]), fouls: num(c[21]), foulsOn: num(c[22]),
    to: num(c[23]), stl: num(c[24]), blk: num(c[25]), blkAgainst: num(c[26]),
    eval: num(c[27]), pm: num(c[28]),
  };
}

/* suma + średnie z logu meczowego */
function aggregate(games) {
  if (!games.length) return null;
  const S = (k) => games.reduce((a, g) => a + (g[k] ?? 0), 0);
  const n = games.length;
  const sec = S("sec"), pts = S("pts"), reb = S("reb"), ast = S("ast");
  const m2 = S("m2"), a2 = S("a2"), m3 = S("m3"), a3 = S("a3"), m1 = S("m1"), a1 = S("a1");
  const pct = (m, a) => (a ? Math.round((m / a) * 1000) / 10 : null);
  const avg = (v) => Math.round((v / n) * 10) / 10;
  return {
    games: n, start5: games.filter((g) => g.start5).length,
    wins: games.filter((g) => g.win).length,
    minAvg: Math.round((sec / n / 60) * 10) / 10,
    pts, reb, ast, stl: S("stl"), blk: S("blk"), to: S("to"), eval: S("eval"),
    ptsAvg: avg(pts), rebAvg: avg(reb), astAvg: avg(ast),
    stlAvg: avg(S("stl")), blkAvg: avg(S("blk")), toAvg: avg(S("to")),
    evalAvg: avg(S("eval")), pmAvg: avg(S("pm")),
    m2, a2, pct2: pct(m2, a2), m3, a3, pct3: pct(m3, a3),
    m1, a1, pct1: pct(m1, a1), pctFg: pct(S("mfg"), S("afg")),
    rebOAvg: avg(S("rebO")), rebDAvg: avg(S("rebD")),
    best: {
      pts: Math.max(...games.map((g) => g.pts ?? 0)),
      reb: Math.max(...games.map((g) => g.reb ?? 0)),
      ast: Math.max(...games.map((g) => g.ast ?? 0)),
      eval: Math.max(...games.map((g) => g.eval ?? 0)),
    },
  };
}

/* historia sezonów — bierzemy tylko jednoznaczne kolumny: sezon, klub, mecze, pkt, min */
function parseCareer(html) {
  const t = tables(html)[0];
  if (!t) return [];
  return bodyRows(t).map((r) => {
    const c = cells(r);
    if (c.length < 6 || !/^\d{4}\/\d{2}/.test(c[0])) return null;
    return { season: c[0], team: c[1], games: num(c[2]), ptsAvg: num(c[4]), min: c[5] || null };
  }).filter(Boolean);
}

async function main() {
  const rosterUrl = `${BASE}/druzyny/${TEAM_ID}/${TEAM_SLUG}/sklad`;
  process.stderr.write(`Skład: ${rosterUrl}\n`);
  const stream = decodeFlight(await get(rosterUrl));
  const i = stream.indexOf('"players":[');
  if (i < 0) throw new Error("nie znaleziono listy zawodników — zmienił się szablon plk.pl?");
  const raw = JSON.parse(balanced(stream, stream.indexOf("[", i)));

  const teamName = stream.match(/"name":"([^"]*Anwil[^"]*)"/)?.[1] ?? TEAM_SLUG;
  // strona zawiera też archiwum sezonów — bierzemy najnowszy
  const season = [...stream.matchAll(/"name":"(20\d{2}\/20\d{2})"/g)]
    .map((m) => m[1]).sort().pop() ?? null;

  const players = raw.map((p) => {
    const birth = p.birthDate ?? null;
    let age = null;
    if (birth) {
      const b = new Date(birth), now = new Date();
      age = now.getFullYear() - b.getFullYear() - (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
    }
    const tidy = (s) => (s ?? "").replace(/\s+/g, " ").trim(); // w danych trafiają się podwójne spacje
    return {
      id: p.id, firstName: tidy(p.firstName), lastName: tidy(p.lastName), slug: p.slug,
      name: tidy(`${p.firstName} ${p.lastName}`),
      number: p.shirtNumber ?? null,
      height: p.height ?? null,
      position: (p.positions ?? [])[0] ?? null,
      positions: p.positions ?? [],
      birthDate: birth, age,
      country: p.passport ?? null,
      photoUrl: p.photoUrl ?? null,
      url: `${BASE}/zawodnicy/${p.id}/${p.slug}`,
    };
  }).sort((a, b) => (+a.number || 999) - (+b.number || 999));

  process.stderr.write(`Zawodników: ${players.length}\n`);

  if (!NO_GAMES) {
    let n = 0;
    for (const p of players) {
      await sleep(DELAY);
      process.stderr.write(`Statystyki ${++n}/${players.length}: ${p.name} … `);
      try {
        const html = await get(`${p.url}/mecz-po-meczu`);
        const games = tables(html).flatMap((t) => bodyRows(t).map(parseGameRow)).filter(Boolean);
        games.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
        p.games = games;
        p.season = aggregate(games);
        process.stderr.write(`${games.length} meczów, ${p.season?.ptsAvg ?? 0} pkt/mecz\n`);
      } catch (e) {
        process.stderr.write(`pominięto (${e.message})\n`);
        p.games = []; p.season = null;
      }
      await sleep(DELAY);
      try { p.career = parseCareer(await get(`${p.url}/statystyki`)); }
      catch { p.career = []; }
    }
  }

  if (PHOTOS) {
    mkdirSync(PHOTO_DIR, { recursive: true });
    for (const p of players) {
      if (!p.photoUrl) continue;
      const file = resolve(PHOTO_DIR, `${p.id}.jpg`);
      const rel = `players/${p.id}.jpg`;
      if (existsSync(file)) { p.localPhoto = rel; continue; }
      await sleep(DELAY);
      try {
        const buf = await get(p.photoUrl, true);
        if (buf.length < 500) throw new Error("podejrzanie mały plik");
        writeFileSync(file, buf);
        p.localPhoto = rel;
        process.stderr.write(`Zdjęcie: ${p.name} (${Math.round(buf.length / 1024)} KB)\n`);
      } catch (e) {
        process.stderr.write(`Zdjęcie pominięte (${p.name}): ${e.message}\n`);
      }
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    source: rosterUrl, scrapedAt: new Date().toISOString(),
    team: teamName, teamId: +TEAM_ID, season,
    count: players.length, players,
  }, null, 2), "utf8");

  const withStats = players.filter((p) => p.season).length;
  console.log(`Zapisano skład: ${players.length} zawodników (ze statystykami: ${withStats}) do ${OUT}`);
}

main().catch((e) => { console.error("Błąd scrapera:", e.message); process.exit(1); });
