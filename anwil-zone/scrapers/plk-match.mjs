#!/usr/bin/env node
/**
 * Scraper szczegółów meczu z plk.pl (strona /mecz/{id}/{slug}).
 *
 * Strona jest w Next.js (App Router) — dane meczu są osadzone w strumieniu
 * "flight" (self.__next_f.push([1,"..."])). Po sklejeniu i odescapowaniu
 * chunków dostajemy JSON zawierający:
 *   - dwa obiekty drużyn: {"id":..,"name":..,"coaches":[..],"players":[{pełny boxscore}]}
 *   - "actionsAndShots": [{name:"Kwarta N", resultHome, resultAway,
 *        playByPlay:[{no,time,actionNumber,pointsHome,pointsGuest,teamId,playerId,element:{akcja,...}}],
 *        shots:[{actionNumber,side,time,x,y,teamId,playerId}]}]   (x,y w 0-100)
 *   - "referees", "hall" itd.
 * Celność rzutu ustalamy łącząc shot.actionNumber z wpisem play-by-play
 * tej samej kwarty ("celny"/"niecelny" w opisie akcji).
 *
 * Użycie:
 *   node plk-match.mjs https://plk.pl/mecz/222605/anwil-wloclawek-vs-mks-dabrowa-gornicza
 *   node plk-match.mjs 222605          # id z plk-schedule-anwil.json (albo goły /mecz/{id}/x)
 *   node plk-match.mjs --all           # wszystkie mecze z plk-schedule-anwil.json
 *   node plk-match.mjs --all --force   # nadpisz już pobrane
 *
 * Wyjście: ../data/matches/{matchId}.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://plk.pl";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const ALL = args.includes("--all");
const FORCE = args.includes("--force");
const DELAY = Math.max(0, parseInt(opt("delay", "600"), 10) || 0);
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dir, opt("out-dir", "../data/matches"));
const SCHEDULE = resolve(__dir, "../data/plk-schedule-anwil.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "pl" },
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return res.text();
}

/* ------- dekodowanie strumienia Next.js flight ------- */
function decodeFlight(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/gs)]
    .map((m) => JSON.parse('"' + m[1] + '"'));
  return chunks.join("");
}

/* zbalansowane wycięcie JSON-a ({..} albo [..]) od pozycji start */
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
  throw new Error("niezbalansowany JSON @" + start);
}

/* ------- parsowanie meczu ------- */
function parseMatch(stream, matchId, url) {
  // dwie drużyny (rostery): obiekt zaczynający się od {"id": tuż przed "players":[
  const teams = [];
  let idx = -1;
  while ((idx = stream.indexOf('"players":[', idx + 1)) >= 0 && teams.length < 2) {
    const objStart = stream.lastIndexOf('{"id":', idx);
    if (objStart < 0) continue;
    teams.push(JSON.parse(balanced(stream, objStart)));
  }
  if (teams.length < 2) throw new Error("nie znaleziono drużyn z players[]");
  const [home, away] = teams; // kolejność w strumieniu: gospodarz, gość

  // statystyki graczy: osobne obiekty {"playerId":..,"isStart5":..,...,"eval":..}
  // (występują 2x — render mobile/desktop — dedupe po playerId)
  const statsById = {};
  let si = -1;
  while ((si = stream.indexOf('{"playerId":', si + 1)) >= 0) {
    if (stream.slice(si, si + 40).includes('"isStart5"')) {
      try {
        const st = JSON.parse(balanced(stream, si));
        if (st.playerId && !(st.playerId in statsById)) statsById[st.playerId] = st;
      } catch { /* pomijamy uszkodzone */ }
    }
  }
  // scal statystyki z rosterami
  for (const t of teams) {
    t.players = (t.players ?? []).map((p) => ({ ...p, stats: statsById[p.id] ?? null }));
  }

  // kwarty + play-by-play + rzuty
  const iA = stream.indexOf('"actionsAndShots":');
  if (iA < 0) throw new Error("brak actionsAndShots");
  const quartersRaw = JSON.parse(balanced(stream, stream.indexOf("[", iA)));

  // sędziowie (tablica stringów) + hala + data (w sekcji szczegółów meczu)
  let referees = null, venue = null, date = null;
  const iR = stream.indexOf('"referees":');
  if (iR >= 0) { try { referees = JSON.parse(balanced(stream, stream.indexOf("[", iR))); } catch { /* nieistotne */ } }
  const iV = stream.indexOf('"venue":');
  if (iV >= 0) { try { const v = JSON.parse(balanced(stream, stream.indexOf("{", iV))); venue = v.name ?? null; } catch { /* nieistotne */ } }
  const iP = stream.indexOf('"hasPDFReport"');
  if (iP >= 0) {
    const around = stream.slice(Math.max(0, iP - 4000), iP + 4000);
    date = around.match(/"dateLocal":"(20[\d\- :]+)"/)?.[1] ?? around.match(/"date":"(20[^"]+)"/)?.[1] ?? null;
  }

  // mapa playerId -> "N. Nazwisko"
  const playerName = {};
  for (const t of teams) for (const p of t.players ?? [])
    playerName[p.id] = `${(p.firstName ?? "").slice(0, 1)}. ${p.lastName ?? ""}`.trim();

  const quarters = [];
  const playByPlay = [];
  const shots = [];
  for (const q of quartersRaw) {
    const qn = q.quarterNumber;
    quarters.push({ number: qn, name: q.name, home: q.resultHome, away: q.resultAway });

    const byAction = {};
    for (const p of q.playByPlay ?? []) {
      byAction[p.actionNumber] = p;
      playByPlay.push({
        q: qn, no: p.no, time: p.time?.slice(0, 5) ?? "",
        akcja: p.element?.akcja ?? p.actionType ?? "",
        ph: p.pointsHome, pa: p.pointsGuest,
        teamId: +p.teamId || null, playerId: +p.playerId || null,
        scoring: !!p.isPointsChanged,
      });
    }
    for (const sh of q.shots ?? []) {
      const act = byAction[sh.actionNumber];
      const akcja = act?.element?.akcja ?? "";
      shots.push({
        q: qn, x: sh.x, y: sh.y, side: sh.side, time: sh.time?.slice(0, 5) ?? "",
        teamId: sh.teamId, playerId: sh.playerId,
        player: playerName[sh.playerId] ?? "",
        made: akcja ? !/niecelny/i.test(akcja) : null,
        pts: /za 3/i.test(akcja) ? 3 : 2,
        akcja,
      });
    }
  }

  const th = quarters.reduce((a, q) => a + (q.home ?? 0), 0);
  const ta = quarters.reduce((a, q) => a + (q.away ?? 0), 0);

  return {
    matchId, url, scrapedAt: new Date().toISOString(),
    homeScore: th, awayScore: ta,
    date, venue, referees,
    home, away, // roster + stats per zawodnik
    quarters, playByPlay, shots,
  };
}

async function scrapeOne(url, matchId) {
  const html = await get(url);
  const stream = decodeFlight(html);
  const data = parseMatch(stream, matchId, url);
  mkdirSync(OUT_DIR, { recursive: true });
  const out = resolve(OUT_DIR, `${matchId}.json`);
  writeFileSync(out, JSON.stringify(data, null, 1), "utf8");
  const shotsOk = data.shots.filter((s) => s.made !== null).length;
  console.log(`  ${matchId}: ${data.home.name} ${data.homeScore}:${data.awayScore} ${data.away.name} | kwarty=${data.quarters.length} pbp=${data.playByPlay.length} rzuty=${data.shots.length} (dopasowane: ${shotsOk})`);
  return data;
}

async function main() {
  let targets = [];
  if (ALL) {
    const s = JSON.parse(readFileSync(SCHEDULE, "utf8"));
    targets = s.matches.filter((m) => m.played && m.matchId).map((m) => ({ id: m.matchId, url: m.url }));
  } else {
    const arg = args.find((a) => !a.startsWith("--"));
    if (!arg) { console.error("Podaj URL/id meczu albo --all"); process.exit(1); }
    const m = arg.match(/mecz\/(\d+)/);
    const id = m ? +m[1] : +arg;
    const url = arg.startsWith("http") ? arg : `${BASE}/mecz/${id}/x`;
    targets = [{ id, url }];
  }

  let n = 0;
  for (const t of targets) {
    n++;
    const out = resolve(OUT_DIR, `${t.id}.json`);
    if (!FORCE && existsSync(out)) { console.log(`  ${t.id}: już pobrany (--force aby nadpisać)`); continue; }
    process.stderr.write(`Mecz ${n}/${targets.length}: ${t.url}\n`);
    try { await scrapeOne(t.url, t.id); }
    catch (e) { console.error(`  ${t.id}: BŁĄD - ${e.message}`); }
    if (n < targets.length) await sleep(DELAY);
  }
}

main().catch((e) => { console.error("Błąd scrapera:", e.message); process.exit(1); });
