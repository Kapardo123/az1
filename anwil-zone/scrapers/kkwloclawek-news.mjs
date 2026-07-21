#!/usr/bin/env node
/**
 * Scraper aktualności z oficjalnej strony Anwilu Włocławek (https://kkwloclawek.pl).
 *
 * Strona nie ma publicznego API — listing i artykuły są renderowane serwerowo,
 * więc parsujemy HTML. Struktura (stan: lipiec 2026):
 *   listing:  https://kkwloclawek.pl/aktualnosci/{strona}
 *             https://kkwloclawek.pl/aktualnosci/{kategoria}/{strona}
 *             bloki .article-item: obrazek, .time "dd.mm.yyyy - HH:MM",
 *             h3.article-item-header > a (tytuł + URL), .lead
 *   artykuł:  h1.header-single-article, h6.time "Dzień, D Miesiąca YYYY, HH:MM, Autor",
 *             pierwszy <div class="content"> = treść, meta og:image
 *
 * Użycie:
 *   node kkwloclawek-news.mjs                    # 1 strona listingu, bez treści
 *   node kkwloclawek-news.mjs --pages 3 --full   # 3 strony + pełna treść artykułów
 *   node kkwloclawek-news.mjs --category transfery --pages 2
 *   node kkwloclawek-news.mjs --out ../data/news.json --fresh
 *
 * Opcje:
 *   --pages N       liczba stron listingu (domyślnie 1)
 *   --category X    zapowiedzi | relacje | transfery | wywiady | podcasty | wideo | inne | archiwum
 *   --full          dociąga pełną treść każdego artykułu (wolniej, +1 request/artykuł)
 *   --images        pobiera grafiki (miniaturę, og:image, zdjęcia z treści) do ../data/images/
 *   --out PATH      plik wyjściowy JSON (domyślnie ../data/news.json względem skryptu)
 *   --fresh         nadpisz plik zamiast dołączać do istniejących wpisów
 *   --refresh       pobierz ponownie także artykuły, które już są w bazie
 *   --delay MS      przerwa między requestami (domyślnie 500 ms — bądźmy uprzejmi)
 *
 * Domyślnie scraper jest przyrostowy: artykuły, które już mamy komplet
 * (treść, a przy --images także grafiki), są pomijane — pobierane są tylko
 * nowe wpisy. Pełne odświeżenie: --refresh.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://kkwloclawek.pl";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

/* ---------------- CLI ---------------- */
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes("--" + name);

const PAGES = Math.max(1, parseInt(opt("pages", "1"), 10) || 1);
const CATEGORY = opt("category", null);
const FULL = flag("full");
const IMAGES = flag("images");
const FRESH = flag("fresh");
const REFRESH = flag("refresh");
const DELAY = Math.max(0, parseInt(opt("delay", "500"), 10) || 0);
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, opt("out", "../data/news.json"));
const IMG_DIR = resolve(dirname(OUT), "images");

/* ---------------- helpers ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "pl" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return res.text();
}

/** Pobiera grafikę do data/images/<articleId>/<nazwa>. Zwraca ścieżkę względem
 *  pliku wyjściowego JSON (np. "images/2026.../foto.jpg") albo null. */
async function downloadImage(url, articleId) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "img.jpg")
      .replace(/[^\w.\-]/g, "_");
    const dir = resolve(IMG_DIR, articleId);
    const file = resolve(dir, name);
    const rel = `images/${articleId}/${name}`;
    if (existsSync(file)) return rel; // już pobrane
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Referer: BASE + "/" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) throw new Error("podejrzanie mały plik");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, buf);
    return rel;
  } catch (e) {
    process.stderr.write(`  grafika pominięta ${url} (${e.message})\n`);
    return null;
  }
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  oacute: "ó", Oacute: "Ó", eacute: "é", aacute: "á",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
  bdquo: "„", rdquo: "”", lsquo: "‘", rsquo: "’", sbquo: "‚",
};
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Zwraca zawartość pierwszego <div class="..."> pasującego do selektora klasy,
 *  z poprawnym balansowaniem zagnieżdżonych divów. */
function firstDivByClass(html, className, from = 0) {
  const openRe = new RegExp(`<div[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`, "i");
  const m = openRe.exec(html.slice(from));
  if (!m) return null;
  const start = from + m.index + m[0].length;
  let depth = 1;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let t;
  while ((t = tagRe.exec(html))) {
    depth += t[0][1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return null;
}

/* ---------------- parsowanie listingu ---------------- */
function parseListing(html) {
  const items = [];
  // każdy news to blok <div class="row article-item"> ... </div> zakończony <hr>
  const blocks = html.split(/class="row article-item"/).slice(1);
  for (const block of blocks) {
    const url = block.match(/href="(https:\/\/kkwloclawek\.pl\/czytaj,aktualnosci,[^"]+)"/)?.[1];
    if (!url) continue;
    const title = decodeEntities(
      block.match(/article-item-header"><a[^>]*>([\s\S]*?)<\/a>/)?.[1]?.trim() ?? ""
    );
    const image = block.match(/<img src="([^"]+)"/)?.[1] ?? null;
    const timeRaw = block.match(/class="time">[\s\S]*?([\d.]{10}\s*-\s*[\d:]{4,5})/)?.[1] ?? null;
    const lead = htmlToText(block.match(/class="lead">([\s\S]*?)<\/div>/)?.[1] ?? "");

    // "10.07.2026 - 10:54" -> ISO
    let date = null;
    if (timeRaw) {
      const dm = timeRaw.match(/(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{1,2}):(\d{2})/);
      if (dm) date = `${dm[3]}-${dm[2]}-${dm[1]}T${dm[4].padStart(2, "0")}:${dm[5]}:00`;
    }

    // id + kategoria daty z samego URL: czytaj,aktualnosci,20260710,slug
    const um = url.match(/czytaj,aktualnosci,(\d{8}),(.+)$/);
    items.push({
      id: um ? `${um[1]}-${um[2]}` : url,
      url,
      title,
      date,
      image,
      lead,
    });
  }
  return items;
}

/* ---------------- parsowanie artykułu ---------------- */
const PL_MONTHS = {
  stycznia: "01", lutego: "02", marca: "03", kwietnia: "04", maja: "05", czerwca: "06",
  lipca: "07", sierpnia: "08", września: "09", października: "10", listopada: "11", grudnia: "12",
};
function parseArticle(html) {
  const title = decodeEntities(
    html.match(/header-single-article">([\s\S]*?)<\/h1>/)?.[1]?.trim() ?? ""
  );
  // "Piątek, 10 Lipca 2026, 10:54, Damian Puchalski"
  const timeLine = decodeEntities(html.match(/<h6 class="time">([\s\S]*?)<\/h6>/)?.[1]?.trim() ?? "");
  let author = null;
  const parts = timeLine.split(",").map((s) => s.trim());
  if (parts.length >= 4) author = parts.slice(3).join(", ");

  const ogImage = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1] ?? null;
  // szukamy od h1 artykułu, żeby nie złapać zewnętrznego <div class="... content single-article">
  const contentHtml = firstDivByClass(html, "content", html.indexOf("header-single-article")) ?? "";
  // zdjęcia osadzone w treści artykułu (galerie, infografiki)
  const contentImages = [...contentHtml.matchAll(/<img[^>]+src="([^"]+)"/gi)]
    .map((m) => new URL(m[1], BASE).href)
    .filter((u) => u.startsWith(BASE)) // pomijamy obce domeny (np. emoji z osadzonych postów FB)
    .filter((u, i, a) => a.indexOf(u) === i);
  return { title, author, ogImage, contentImages, content: htmlToText(contentHtml) };
}

/* ---------------- main ---------------- */
async function main() {
  const listingBase = CATEGORY ? `${BASE}/aktualnosci/${CATEGORY}` : `${BASE}/aktualnosci`;
  const collected = new Map();

  /* co już mamy w bazie — żeby nie pobierać tego drugi raz */
  let known = new Map();
  if (existsSync(OUT) && !FRESH) {
    try {
      const prev = JSON.parse(readFileSync(OUT, "utf8"));
      known = new Map((prev.items ?? []).map((i) => [i.id, i]));
    } catch { /* uszkodzony plik — traktujemy jak pustą bazę */ }
  }

  for (let p = 1; p <= PAGES; p++) {
    const url = `${listingBase}/${p}`;
    process.stderr.write(`Listing ${url} ... `);
    const html = await get(url);
    const items = parseListing(html);
    process.stderr.write(`${items.length} artykułów\n`);
    for (const it of items) if (!collected.has(it.id)) collected.set(it.id, it);
    if (items.length === 0) break; // koniec paginacji
    if (p < PAGES) await sleep(DELAY);
  }

  /* przyrostowo: bierzemy tylko to, czego jeszcze nie mamy w komplecie */
  const isComplete = (it) => {
    const k = known.get(it.id);
    if (!k) return false;
    if (FULL && !k.content) return false;
    if (IMAGES && !k.localImage) return false;
    return true;
  };
  const todo = [...collected.values()].filter((it) => REFRESH || !isComplete(it));
  const skipped = collected.size - todo.length;
  if (skipped) process.stderr.write(`Pomijam ${skipped} artykułów, które już są w bazie\n`);
  if (!todo.length) process.stderr.write("Brak nowych artykułów — wszystko aktualne.\n");

  if (FULL) {
    let n = 0;
    for (const it of todo) {
      await sleep(DELAY);
      process.stderr.write(`Artykuł ${++n}/${todo.length}: ${it.id}\n`);
      try {
        const art = parseArticle(await get(it.url));
        it.author = art.author;
        it.content = art.content;
        if (art.ogImage) it.imageFull = art.ogImage;
        if (art.contentImages.length) it.contentImages = art.contentImages;
        if (!it.title && art.title) it.title = art.title;
      } catch (e) {
        process.stderr.write(`  pominięto (${e.message})\n`);
      }
    }
  }

  if (IMAGES) {
    let n = 0;
    for (const it of todo) {
      n++;
      const urls = [it.image, it.imageFull, ...(it.contentImages ?? [])]
        .filter(Boolean)
        .filter((u, i, a) => a.indexOf(u) === i);
      if (!urls.length) continue;
      process.stderr.write(`Grafiki ${n}/${todo.length}: ${it.id} (${urls.length})\n`);
      const local = [];
      for (const u of urls) {
        await sleep(DELAY);
        const rel = await downloadImage(u, it.id);
        if (rel) local.push(rel);
      }
      if (local.length) {
        it.localImages = local;
        it.localImage = local[0]; // miniatura z listingu jako główna
      }
    }
  }

  // scal z istniejącym plikiem (chyba że --fresh); nowsze wpisy nadpisują starsze
  let out = [...collected.values()];
  const added = out.filter((it) => !known.has(it.id)).length;
  if (!FRESH && known.size) {
    const merged = new Map(known);
    for (const it of out) merged.set(it.id, { ...merged.get(it.id), ...it });
    out = [...merged.values()];
  }
  out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ source: BASE, scrapedAt: new Date().toISOString(), count: out.length, items: out }, null, 2),
    "utf8"
  );
  console.log(
    `Zapisano ${out.length} newsów do ${OUT}` +
    ` (nowych: ${added}, pominiętych jako znane: ${skipped})` +
    (added ? " — uruchom build, aby zobaczyć je w aplikacji" : "")
  );
}

main().catch((e) => {
  console.error("Błąd scrapera:", e.message);
  process.exit(1);
});
