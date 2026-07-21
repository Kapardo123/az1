#!/usr/bin/env node
/**
 * Scraper tabeli ligowej + log drużyn z plk.pl (Orlen Basket Liga).
 *
 * Strona plk.pl to Next.js, ale tabela jest renderowana serwerowo jako
 * <table id="stats-table">. Wiersz: pozycja, link /druzyny/{id}/{slug},
 * <img alt="Nazwa"> z logiem z CDN esor.pzkosz.pl (....../kluby/sNN/150-150/{id}.png).
 * Kolumny: Pkt | Mecze | Zw-Por | Dom | Wyjazd | Zdob-Str | Różnica | Stosunek.
 *
 * Użycie:
 *   node plk-table.mjs                 # tabela -> ../data/plk-table.json
 *   node plk-table.mjs --logos         # + pobiera loga PNG do ../data/logos/
 *   node plk-table.mjs --out PATH --delay 500
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL_TABLE = "https://plk.pl/tabele";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const LOGOS = args.includes("--logos");
const DELAY = Math.max(0, parseInt(opt("delay", "500"), 10) || 0);
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, opt("out", "../data/plk-table.json"));
const LOGO_DIR = resolve(dirname(OUT), "logos");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asBuffer = false) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "pl" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();

function parseTable(html) {
  const start = html.indexOf('id="stats-table"');
  if (start < 0) throw new Error("Nie znaleziono #stats-table — zmienił się szablon plk.pl?");
  const table = html.slice(start, html.indexOf("</table>", start));
  const tbody = table.slice(table.indexOf("<tbody"));

  // sezon: pierwsze wystąpienie wzorca 20xx/20xx na stronie to aktualnie wybrany
  const season = html.match(/20\d{2}\/20\d{2}/)?.[0] ?? null;

  const rows = tbody.split(/<tr[\s>]/).slice(1);
  const teams = [];
  for (const row of rows) {
    const href = row.match(/href="\/druzyny\/(\d+)\/([a-z0-9-]+)"/);
    if (!href) continue;
    const name = row.match(/<img alt="([^"]+)"/)?.[1] ?? null;
    // srcSet: /_next/image?url=<zakodowany URL esor>&w=... -> dekodujemy oryginał
    const enc = row.match(/url=(https?%3A[^&"]+)/)?.[1] ?? null;
    const logoUrl = enc ? decodeURIComponent(enc) : null;
    const pos = parseInt(row.match(/<span class="w-4">(\d+)<\/span>/)?.[1] ?? "0", 10);
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    if (tds.length < 8) continue;
    const [wins, losses] = tds[2].split("-").map((s) => parseInt(s.trim(), 10));
    const [scored, conceded] = tds[5].split("-").map((s) => parseInt(s.trim(), 10));
    teams.push({
      pos,
      teamId: +href[1],
      slug: href[2],
      name: name ? name.replace(/&amp;/g, "&") : href[2],
      url: `https://plk.pl/druzyny/${href[1]}/${href[2]}`,
      points: +tds[0],
      games: +tds[1],
      wins, losses,
      home: tds[3].replace(/\s/g, ""),
      away: tds[4].replace(/\s/g, ""),
      scored, conceded,
      diff: +tds[6].replace("+", ""),
      ratio: +tds[7],
      logoUrl,
    });
  }
  teams.sort((a, b) => a.pos - b.pos);
  return { season, teams };
}

async function downloadLogos(teams) {
  mkdirSync(LOGO_DIR, { recursive: true });
  for (const t of teams) {
    if (!t.logoUrl) continue;
    const file = resolve(LOGO_DIR, `${t.teamId}-${t.slug}.png`);
    const rel = `logos/${t.teamId}-${t.slug}.png`;
    if (existsSync(file)) { t.localLogo = rel; continue; }
    await sleep(DELAY);
    // próbujemy większej wersji 300-300, potem oryginalnej z tabeli (150-150)
    const candidates = [t.logoUrl.replace("150-150", "300-300"), t.logoUrl];
    for (const u of candidates) {
      try {
        const buf = await get(u, true);
        if (buf.length < 200) throw new Error("podejrzanie mały plik");
        writeFileSync(file, buf);
        t.localLogo = rel;
        process.stderr.write(`Logo: ${t.name} (${Math.round(buf.length / 1024)} KB)\n`);
        break;
      } catch (e) {
        if (u === candidates[candidates.length - 1])
          process.stderr.write(`Logo pominięte: ${t.name} (${e.message})\n`);
      }
    }
  }
}

async function main() {
  process.stderr.write(`Pobieram ${URL_TABLE} ...\n`);
  const html = await get(URL_TABLE);
  const { season, teams } = parseTable(html);
  if (!teams.length) throw new Error("Tabela sparsowana, ale 0 drużyn — sprawdź selektory.");
  if (LOGOS) await downloadLogos(teams);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ source: URL_TABLE, scrapedAt: new Date().toISOString(), season, count: teams.length, teams }, null, 2),
    "utf8"
  );
  console.log(`Zapisano tabelę (${season ?? "sezon?"}, ${teams.length} drużyn) do ${OUT}`);
}

main().catch((e) => {
  console.error("Błąd scrapera:", e.message);
  process.exit(1);
});
