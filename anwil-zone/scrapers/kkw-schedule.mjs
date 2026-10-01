#!/usr/bin/env node
/**
 * Scraper terminarza Anwilu z https://kkwloclawek.pl/terminarz.
 *
 * Klubowa strona trzyma CAŁY terminarz w jednej tabeli `.table-terminarz`
 * (renderowanej serwerowo) i — w odróżnieniu od plk.pl — zawiera także mecze
 * europejskiego pucharu **ENBL** ("European North BL"). To jedyne miejsce,
 * gdzie terminarz PLK i ENBL Anwilu jest w jednym zestawieniu.
 *
 * Kolumny: DATA | ROZGRYWKI | MECZ | WYNIK | WIDEO | GALERIA | RELACJA
 *   DATA      "24-09-2026, 18:30" (godzina "0" = jeszcze nieustalona)
 *   ROZGRYWKI "Runda zasadnicza" (PLK) albo "European North BL" (ENBL)
 *   MECZ      "Gospodarz - Gość"
 *   WYNIK     "0:0" dla nierozegranych, wynik dla rozegranych
 *
 * Użycie:
 *   node kkw-schedule.mjs                          # -> ../data/kkw-schedule.json
 *   node kkw-schedule.mjs --out ../data/inny.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://kkwloclawek.pl";
const URL = BASE + "/terminarz";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, opt("out", "../data/kkw-schedule.json"));

const decode = (s) => (s ?? "")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'");

/* rozgrywki -> krótka etykieta i liga */
function classify(comp) {
  const c = (comp || "").toLowerCase();
  if (/enbl|european north/.test(c)) return { league: "ENBL", label: "ENBL" };
  if (/runda zasadnicza|play.?off|play.?in|puchar|plk|basket liga/.test(c)) return { league: "PLK", label: comp.trim() || "PLK" };
  return { league: "INNE", label: comp.trim() || "Inne" };
}

/* "24-09-2026, 18:30" lub "30-10-2026, 0" (godzina nieustalona) -> ISO + flaga */
function toIso(cell) {
  const m = cell.match(/(\d{2})-(\d{2})-(\d{4})(?:\s*,\s*(\d{1,2})(?::(\d{2}))?)?/);
  if (!m) return { iso: null, dateRaw: cell, timeTbd: true };
  const [, dd, mm, yyyy, hh, min] = m;
  const timeTbd = hh == null || +hh === 0;
  const h = hh && +hh !== 0 ? +hh : 0;
  const mi = min ? +min : 0;
  const iso = `${yyyy}-${mm}-${dd}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`;
  return { iso, dateRaw: cell, timeTbd };
}

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "pl" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return res.text();
}

function parse(html) {
  const start = html.indexOf("table-terminarz");
  if (start < 0) throw new Error("Nie znaleziono tabeli .table-terminarz — zmienił się szablon kkwloclawek.pl?");
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end);

  const matches = [];
  for (const row of table.split(/<tr[^>]*>/).slice(1)) {
    const cells = [...row.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/g)]
      .map((m) => decode(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()));
    if (cells.length < 4) continue;

    const [dataCell, comp, mecz, wynik] = cells;
    const dash = mecz.split(/\s+[-–—]\s+/);
    if (dash.length < 2) continue;
    const home = dash[0].trim();
    const away = dash.slice(1).join(" - ").trim();
    if (!home || !away) continue;

    const { iso, dateRaw, timeTbd } = toIso(dataCell);
    const sm = wynik.match(/(\d+)\s*:\s*(\d+)/);
    const hs = sm ? +sm[1] : null;
    const as = sm ? +sm[2] : null;
    const played = !!sm && !(hs === 0 && as === 0);
    const { league, label } = classify(comp);

    matches.push({
      date: iso, dateRaw, timeTbd,
      competition: comp.trim(), league, label,
      home, away,
      homeScore: played ? hs : null,
      awayScore: played ? as : null,
      played,
      anwilHome: /anwil/i.test(home),
      video: cells[4] && cells[4] !== "-" ? cells[4] : null,
      gallery: cells[5] && cells[5] !== "-" ? cells[5] : null,
      report: cells[6] && cells[6] !== "-" ? cells[6] : null,
    });
  }
  return matches;
}

async function main() {
  process.stderr.write(`Pobieram ${URL} ...\n`);
  const html = await get(URL);
  const matches = parse(html);
  if (!matches.length) throw new Error("Sparsowano 0 meczów.");

  matches.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  const seasons = [...new Set(matches.map((m) => (m.date || "").slice(0, 4)))].sort();
  const byLeague = {};
  for (const m of matches) byLeague[m.league] = (byLeague[m.league] || 0) + 1;
  const played = matches.filter((m) => m.played).length;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({
      source: URL,
      scrapedAt: new Date().toISOString(),
      seasons,
      count: matches.length,
      played,
      upcoming: matches.length - played,
      byLeague,
      matches,
    }, null, 2),
    "utf8"
  );
  console.log(`Zapisano terminarz Anwilu: ${matches.length} meczów (rozegrane: ${played}) ${JSON.stringify(byLeague)} -> ${OUT}`);
}

main().catch((e) => { console.error("Błąd scrapera:", e.message); process.exit(1); });
