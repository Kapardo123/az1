#!/usr/bin/env node
/**
 * Scraper terminarza PLK z https://plk.pl/terminarz (Orlen Basket Liga).
 *
 * Strona jest w Next.js, ale terminarz renderuje się serwerowo: każda kolejka
 * to <h4>N kolejka</h4> + tabela z kolumnami Gospodarz | Gość | Data | TV | Wynik.
 * Wiersz zawiera linki /druzyny/{id}/{slug} (gospodarz, gość), datę "dd.mm / HH:MM",
 * opcjonalne logo stacji TV (img alt) i — dla rozegranych — link /mecz/{id}/{slug}
 * z wynikiem "NN : NN".
 *
 * Sezon można wskazać przez ?sezon= (np. 2026/2027). Uwaga: jeśli plk.pl nie ma
 * jeszcze meczów danego sezonu w bazie, strona pokazuje sezon domyślny — dlatego
 * zapisujemy też, ile meczów ma wynik, a season bierzemy z nagłówka strony.
 *
 * Użycie:
 *   node plk-schedule.mjs                          # aktualny sezon, wszystkie mecze
 *   node plk-schedule.mjs --team anwil-wloclawek   # tylko mecze Anwilu
 *   node plk-schedule.mjs --sezon 2026/2027
 *   node plk-schedule.mjs --out PATH
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://plk.pl";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const TEAM = opt("team", null);
const SEZON = opt("sezon", null);
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, opt("out", "../data/plk-schedule.json"));

async function get(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "pl" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return res.text();
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');

/** "dd.mm" + "HH:MM" + sezon "2025/2026" -> ISO; sezon PLK trwa od sierpnia do lipca */
function toIso(day, time, season) {
  const [dd, mm] = day.split(".").map(Number);
  if (!dd || !mm) return null;
  let year = null;
  if (season) {
    const [y1, y2] = season.split("/").map(Number);
    year = mm >= 8 ? y1 : y2;
  }
  if (!year) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T${time || "00:00"}:00`;
}

function parseRow(row, season) {
  const teams = [...row.matchAll(
    /href="\/druzyny\/(\d+)\/([a-z0-9-]+)"[\s\S]*?<span class="[^"]*font-bold[^"]*">([^<]+)<\/span>/g
  )].map((m) => ({ teamId: +m[1], slug: m[2], name: decode(m[3].trim()) }));
  if (teams.length < 2) return null;

  const dm = row.match(/<span class="font-bold">([\d.]+)<\/span>\/[\s\S]{0,40}?<span class="font-bold">([\d:]+)<\/span>/);
  const day = dm?.[1] ?? null;
  const time = dm?.[2] ?? null;

  // TV: logo stacji w komórce TV (pomijamy loga drużyn, które mają szerokość 64)
  const tv = row.match(/<img alt="([^"]+)"[^>]*width="48"/)?.[1] ?? null;

  const mecz = row.match(/href="\/mecz\/(\d+)\/([a-z0-9-]+)"/);
  const score = row.match(/>(\d+)<!-- --> <span[^>]*>:<\/span> <!-- -->(\d+)</);

  return {
    matchId: mecz ? +mecz[1] : null,
    url: mecz ? `${BASE}/mecz/${mecz[1]}/${mecz[2]}` : null,
    date: day && time ? toIso(day, time, season) : null,
    dateRaw: day ? `${day} ${time ?? ""}`.trim() : null,
    home: teams[0],
    away: teams[1],
    homeScore: score ? +score[1] : null,
    awayScore: score ? +score[2] : null,
    played: !!score,
    tv,
  };
}

async function main() {
  const url = BASE + "/terminarz" + (SEZON ? `?sezon=${encodeURIComponent(SEZON)}` : "");
  process.stderr.write(`Pobieram ${url} ...\n`);
  const html = await get(url);

  const season = html.match(/20\d{2}\/20\d{2}/)?.[0] ?? null;

  // kolejki: <h4 ...>N kolejka</h4><div ...><table ...>...</table>
  const parts = html.split(/>(\d+) kolejka<\/h4>/);
  const matches = [];
  for (let p = 1; p < parts.length; p += 2) {
    const round = +parts[p];
    const segment = parts[p + 1].slice(0, parts[p + 1].indexOf("</table>"));
    for (const row of segment.split(/<tr>/).slice(1)) {
      const m = parseRow(row, season);
      if (m) matches.push({ round, ...m });
    }
  }
  if (!matches.length) throw new Error("Sparsowano 0 meczów — zmienił się szablon plk.pl?");

  let out = matches;
  if (TEAM) out = matches.filter((m) => m.home.slug === TEAM || m.away.slug === TEAM);

  const played = out.filter((m) => m.played).length;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      source: url, scrapedAt: new Date().toISOString(), season,
      team: TEAM, count: out.length, played, upcoming: out.length - played,
      matches: out,
    }, null, 2),
    "utf8"
  );
  console.log(`Zapisano terminarz ${season ?? "?"}: ${out.length} meczów (rozegrane: ${played}) do ${OUT}`);
  if (SEZON && season && SEZON !== season.replace(/\s/g, ""))
    console.warn(`Uwaga: prosiłeś o sezon ${SEZON}, ale strona zwróciła ${season} (nowy sezon pewnie jeszcze nie jest w bazie plk.pl).`);
}

main().catch((e) => {
  console.error("Błąd scrapera:", e.message);
  process.exit(1);
});
