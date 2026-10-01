#!/usr/bin/env node
/**
 * Scraper szczegółów meczu ENBL (European North Basketball League).
 *
 * Skąd dane:
 *  - LISTA MECZÓW: Genius Sports udostępnia cały terminarz turnieju jako JSON
 *    pod /data/competition/{id}.json (to samo źródło, które zasila widgety na
 *    enbleague.eu i fibalivestats). Filtrujemy mecze z Anwilem.
 *  - SZCZEGÓŁY: strona meczu to https://fibalivestats.../u/ENBL/{matchId}/,
 *    a wszystkie dane (boxscore, play-by-play, rzuty, kwarty, sędziowie) są w
 *    /data/{matchId}/data.json. Format jest inny niż w PLK, więc tłumaczymy go
 *    na ten sam kształt, którego oczekuje aplikacja (patrz plk-match.mjs), żeby
 *    Match Center wyglądał identycznie: quarters, playByPlay, shots, home/away
 *    z players[].stats, homeScore/awayScore, venue, referees.
 *
 * Użycie:
 *   node enbl-match.mjs                      # wszystkie rozegrane mecze Anwilu
 *   node enbl-match.mjs 2910551              # pojedynczy matchId
 *   node enbl-match.mjs --comp 50063         # wskaż turniej ręcznie
 *   node enbl-match.mjs --force              # nadpisz już pobrane
 *   node enbl-match.mjs --team Donar         # inny filtr drużyny (domyślnie Anwil)
 *
 * Wyjście: ../data/matches/{matchId}.json + ../data/enbl-matches.json (indeks).
 * Identyfikatory meczów ENBL (7 cyfr) nie kolidują z PLK (6 cyfr).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIBALIVE = "https://fibalivestats.dcd.shared.geniussports.com";
const GENIUS = "https://hosted.dcd.shared.geniussports.com";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const FORCE = args.includes("--force");
const NO_VENUE = args.includes("--no-venue");
const DELAY = Math.max(0, parseInt(opt("delay", "700"), 10) || 0);
const TEAM = opt("team", "Anwil");
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dir, opt("out-dir", "../data/matches"));
const INDEX = resolve(__dir, "../data/enbl-matches.json");
const ENBL_DATA = resolve(__dir, "../data/enbl.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAnwil = (s) => new RegExp(TEAM.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(s || "");

async function get(url, accept = "application/json") {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: accept, Referer: "https://www.enbleague.eu/" },
        signal: AbortSignal.timeout(45_000),
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
      return res;
    } catch (e) { lastErr = e; await sleep(900); }
  }
  throw lastErr;
}

/* ---------- wykrywanie aktualnego turnieju ENBL ---------- */
async function currentCompetition() {
  const forced = opt("comp", null);
  if (forced) return { id: +forced, season: null };
  /* 1) z ostatniego uruchomienia enbl.mjs (source.genius = .../competition/{id}/) */
  try {
    const j = JSON.parse(readFileSync(ENBL_DATA, "utf8"));
    const m = String(j.source?.genius ?? "").match(/competition\/(\d+)/);
    if (m) return { id: +m[1], season: j.season ?? null };
  } catch { /* brak pliku — próbujemy dalej */ }
  /* 2) chooser na stronie standings (ENBL 20xx/20xx -> competition/{id}/standings) */
  try {
    const html = await (await get(`${GENIUS}/ENBL/en/standings`, "text/html")).text();
    const opts = [...html.matchAll(/competition\/(\d+)\/standings"[^>]*>\s*ENBL\s+(\d{4})\s*\/\s*(\d{4})/gi)]
      .map((m) => ({ id: +m[1], season: `${m[2]}/${m[3]}` }));
    if (opts.length) {
      opts.sort((a, b) => a.season.localeCompare(b.season));
      return opts[opts.length - 1];
    }
  } catch { /* nieistotne */ }
  return null;
}

async function listCompetition(compId) {
  const j = await (await get(`${FIBALIVE}/data/competition/${compId}.json`)).json();
  return Array.isArray(j) ? j : [];
}

/* ---------- tłumaczenie akcji na czytelny opis (PL) ---------- */
const ACTION_PL = {
  rebound: "Zbiórka", assist: "Asysta", steal: "Przechwyt", turnover: "Strata",
  foul: "Faul", foulon: "Faul wymuszony", block: "Blok", substitution: "Zmiana",
  timeout: "Timeout", jumpball: "Piłka sędziowska", period: "Koniec kwarty",
  game: "Koniec meczu",
};
function describe(e, shot) {
  const who = e.player || "";
  if (e.actionType === "2pt" || e.actionType === "3pt") {
    const made = shot ? shot.r === 1 : null;
    const pts = e.actionType === "3pt" ? 3 : 2;
    return `${who} — ${made === null ? "" : made ? "celny" : "niecelny"} za ${pts}`.trim();
  }
  if (e.actionType === "freethrow") return `${who} — rzut wolny`.trim();
  return [ACTION_PL[e.actionType] ?? e.actionType, e.subType, who].filter(Boolean).join(" ").trim();
}

/* stabilny identyfikator zawodnika (funkcja nazwy) — pozwala cache'ować zdjęcia
   MVP między meczami i unika kolizji z numerami zawodników PLK */
function pidOf(p) {
  const name = `${p.internationalFirstName || p.firstName || ""} ${p.internationalFamilyName || p.familyName || ""}`.trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 10000000000 + (h >>> 0);
}
const secs = (v) => { const m = String(v ?? "").match(/(\d+):(\d+)/); return m ? (+m[1] * 60 + +m[2]) : 0; };
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

/* konwersja data.json Genius -> format meczu jak z plk.pl */
function parseMatch(d, meta, url) {
  const home = d.tm["1"], away = d.tm["2"];
  if (!home || !away) throw new Error("brak drużyn w data.json");

  const teams = { 1: home, 2: away };
  const homeIsAnwil = isAnwil(home.name);
  const anwilNo = homeIsAnwil ? 1 : isAnwil(away.name) ? 2 : 0;
  /* Anwil zawsze z id=33 — compactDetail rozpoznaje po nim MVP Anwilu */
  const teamIdOf = (no) => (no === anwilNo ? 33 : num(meta?.[no === 1 ? "hometeamId" : "awayteamId"]) || (no === 1 ? 1001 : 1002));

  const players = (no) => Object.entries(teams[no].pl ?? {}).map(([key, p]) => ({
    id: pidOf(p), shirtNumber: p.shirtNumber, firstName: p.internationalFirstName || p.firstName,
    lastName: p.internationalFamilyName || p.familyName, position: p.playingPosition,
    photoUrl: p.photoS || p.photoT || null,
    stats: {
      playTimeSeconds: secs(p.sMinutes), points: num(p.sPoints), reboundsTotal: num(p.sReboundsTotal),
      assists: num(p.sAssists), steals: num(p.sSteals), blocks: num(p.sBlocks), turnovers: num(p.sTurnovers),
      plusMinus: num(p.sPlusMinusPoints), eval: num(p.eff_1),
      madeTwoPts: num(p.sTwoPointersMade), attemptTwoPts: num(p.sTwoPointersAttempted),
      madeThreePts: num(p.sThreePointersMade), attemptThreePts: num(p.sThreePointersAttempted),
      madeFreeThrowPts: num(p.sFreeThrowsMade), attemptFreeThrowPts: num(p.sFreeThrowsAttempted),
      reboundsOffensive: num(p.sReboundsOffensive), reboundsDefensive: num(p.sReboundsDefensive),
      fouls: num(p.sFoulsPersonal),
      isStart5: p.starter ? 1 : 0,
    },
    _key: key,
  }));

  const team = (no) => ({
    id: teamIdOf(no),
    name: teams[no].name,
    players: players(no),
  });

  const periodsMax = Math.max(4, num(d.periodsMax) || 4);
  const quarters = [];
  for (let n = 1; n <= periodsMax; n++) {
    quarters.push({ number: n, name: `Q${n}`, home: num(home[`p${n}_score`]), away: num(away[`p${n}_score`]) });
  }

  /* play-by-play: surowe dane są od końca; sortujemy po actionNumber (chronologia)
     i wyznaczamy akcje punktowe po zmianie wyniku bieżącego (pole `scoring`
     Genius bywa prawdziwe także dla niecelnych rzutów). */
  const ordered = [...(d.pbp ?? [])].sort((a, b) => num(a.actionNumber) - num(b.actionNumber));
  const shotByAct = {};
  for (const no of [1, 2]) for (const s of teams[no].shot ?? []) shotByAct[s.actionNumber] = s;

  const playByPlay = [];
  let prevSum = null;
  for (const e of ordered) {
    const sum = num(e.s1) + num(e.s2);
    const scoring = prevSum !== null && sum > prevSum;
    prevSum = sum;
    if (!scoring) continue;
    playByPlay.push({
      q: num(e.period), no: num(e.pno), time: String(e.gt ?? "").slice(0, 5),
      akcja: describe(e, shotByAct[e.actionNumber]),
      ph: num(e.s1), pa: num(e.s2),
      teamId: teamIdOf(num(e.tno)),
      scoring: true,
    });
  }

  const shots = [];
  for (const no of [1, 2]) {
    for (const s of teams[no].shot ?? []) {
      shots.push({
        q: num(s.per), x: s.x, y: s.y, made: s.r === 1,
        pts: s.actionType === "3pt" ? 3 : 2,
        teamId: teamIdOf(no), player: s.player ?? "",
      });
    }
  }

  const referees = Object.values(d.officials ?? {}).map((o) => o.name).filter(Boolean);

  return {
    matchId: meta?.matchId ?? null, league: "ENBL", url, scrapedAt: new Date().toISOString(),
    date: meta?.matchTime ? String(meta.matchTime).replace(" ", "T") : null,
    venue: meta?.venue ?? null, referees: referees.length ? referees : null,
    homeScore: num(home.score), awayScore: num(away.score),
    home: team(1), away: team(2),
    quarters, playByPlay, shots,
  };
}

/* hala i sędziowie z sekcji "matchDetails" strony fibalivestats */
function pageDetails(html) {
  const venue = html.match(/Venue[\s\S]{0,90}?<\/h6>\s*<p>([^<]+)<\/p>/i)?.[1]?.trim() ?? null;
  return { venue: venue || null };
}

async function scrapeOne(matchId, meta) {
  const url = `${FIBALIVE}/u/ENBL/${matchId}/`;
  const d = await (await get(`${FIBALIVE}/data/${matchId}/data.json`)).json();
  let details = {};
  if (!NO_VENUE) {
    try { details = pageDetails(await (await get(url, "text/html")).text()); }
    catch { /* hala opcjonalna */ }
  }
  const data = parseMatch(d, { ...meta, ...details, matchId }, url);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `${matchId}.json`), JSON.stringify(data, null, 1), "utf8");
  const made = data.shots.filter((s) => s.made).length;
  console.log(`  ${matchId}: ${data.home.name} ${data.homeScore}:${data.awayScore} ${data.away.name} | kwarty=${data.quarters.length} pbp=${data.playByPlay.length} rzuty=${data.shots.length} (celne: ${made})`);
  return data;
}

function writeIndex(rows, comp) {
  /* scal z poprzednim indeksem (pojedyncze uruchomienia nie gubią reszty) */
  let prev = [];
  try { prev = JSON.parse(readFileSync(INDEX, "utf8")).matches ?? []; } catch { /* brak */ }
  const byId = new Map(prev.map((m) => [m.matchId, m]));
  for (const r of rows) byId.set(r.matchId, r);
  const matches = [...byId.values()].sort((a, b) => String(a.matchTime).localeCompare(String(b.matchTime)));
  mkdirSync(dirname(INDEX), { recursive: true });
  writeFileSync(INDEX, JSON.stringify({
    source: `${FIBALIVE}/data/competition/${comp?.id ?? "?"}.json`,
    scrapedAt: new Date().toISOString(),
    competition: "ENBL", season: comp?.season ?? null,
    matches,
  }, null, 2), "utf8");
}

async function main() {
  const arg = args.find((a) => !a.startsWith("--"));
  let comp = await currentCompetition();

  let targets = [];
  if (arg && /^\d+$/.test(arg)) {
    const id = +arg;
    let meta = null;
    if (comp) {
      try { meta = (await listCompetition(comp.id)).find((m) => m.matchId === id) ?? null; } catch { /* brak turnieju */ }
    }
    targets = [{ id, meta }];
  } else {
    if (!comp) { console.error("Nie udało się ustalić turnieju ENBL — podaj --comp <id>."); process.exit(1); }
    const all = await listCompetition(comp.id);
    const anwil = all.filter((m) => isAnwil(m.homename) || isAnwil(m.awayname));
    process.stderr.write(`Turniej ENBL ${comp.season ?? comp.id}: ${all.length} meczów, z ${TEAM}: ${anwil.length}\n`);
    targets = anwil.map((m) => ({ id: m.matchId, meta: m }));
  }

  /* indeks uzupełniamy metadanymi wszystkich meczów Anwilu (także nierozegranych),
     a szczegóły pobieramy tylko dla zakończonych z wynikiem */
  if (!arg && targets.length) {
    writeIndex(targets.map((t) => ({
      matchId: t.meta.matchId, status: t.meta.matchStatus, matchTime: t.meta.matchTime,
      home: t.meta.homename, away: t.meta.awayname,
      homeScore: num(t.meta.homescore), awayScore: num(t.meta.awayscore),
      anwilHome: isAnwil(t.meta.homename),
      homeTeamId: num(t.meta.hometeamId), awayTeamId: num(t.meta.awayteamId),
      homeLogo: t.meta.homelogo ?? null, awayLogo: t.meta.awaylogo ?? null,
      url: `${FIBALIVE}/u/ENBL/${t.meta.matchId}/`,
      completed: t.meta.matchStatus === "COMPLETE",
    })), comp);
  }

  let n = 0;
  for (const t of targets) {
    const done = t.meta?.matchStatus === "COMPLETE" || (arg && !t.meta);
    if (!done) { process.stderr.write(`  ${t.id}: nierozegrany (${t.meta?.matchStatus ?? "?"}) — pomijam\n`); continue; }
    n++;
    const out = resolve(OUT_DIR, `${t.id}.json`);
    if (!FORCE && existsSync(out)) { console.log(`  ${t.id}: już pobrany (--force aby nadpisać)`); continue; }
    process.stderr.write(`Mecz ${n}: ${FIBALIVE}/u/ENBL/${t.id}/\n`);
    try { await scrapeOne(t.id, t.meta); }
    catch (e) { console.error(`  ${t.id}: BŁĄD - ${e.message}`); }
    await sleep(DELAY);
  }
  if (!n) console.log("Brak nowych rozegranych meczów Anwilu w ENBL.");
  else console.log(`Zapisano szczegóły do ${OUT_DIR}`);
}

main().catch((e) => { console.error("Błąd scrapera:", e.message); process.exit(1); });
