#!/usr/bin/env node
/**
 * Scraper aktualnego składu i sztabu szkoleniowego z https://kkwloclawek.pl/sklad.
 *
 * Strona jest renderowana serwerowo i grupuje zawodników w dwóch miejscach:
 *   - .player-item  → pierwsza piątka/skład na grafice boiska
 *   - .reserve-item → rezerwowi (dolna sekcja „ławka”)
 * Dlatego NIE można polegać na klasie kontenera — bierzemy każde ogniwo
 * <a href="…/strona,zawodnik,ID"> … <div class="title"> Imię Nazwisko #NUMER </div>.
 * Sztab: <a href="…/strona,trener,ID"> z <div class="title title-other-font"> … #Rola </div>
 *
 * Dodatkowo (o ile nie --no-details) wchodzi na profil każdego zawodnika i czyta:
 *   paszport (kraj), wzrost, data urodzenia, pozycja, kontrakt, link Instagram.
 *
 * Użycie:
 *   node kkw-roster.mjs                 # -> ../data/roster-kkw.json + zdjęcia
 *   node kkw-roster.mjs --no-photos     # bez pobierania zdjęć
 *   node kkw-roster.mjs --no-details    # bez profili zawodników (szybko)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://kkwloclawek.pl";
const URL = BASE + "/sklad";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const NO_PHOTOS = args.includes("--no-photos");
const NO_DETAILS = args.includes("--no-details");
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, "../data/roster-kkw.json");
const IMG_DIR = resolve(__dir, "../data/roster-photos");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "pl" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (e) { last = e; await sleep(700); }
  }
  throw last;
}

const decode = (s) => (s ?? "")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&#39;/g, "'");
const clean = (s) => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/* zdjęcie: <img … src="…"> + alt (kolejność atrybutów bywa różna) */
function parsePhoto(inner) {
  const img = inner.match(/<img[^>]*?\bsrc="([^"]+)"[^>]*?\balt="([^"]*)"/i)
    || inner.match(/<img[^>]*?\balt="([^"]*)"[^>]*?\bsrc="([^"]+)"/i);
  if (!img) return { src: null, alt: "" };
  const [a, b] = [img[1], img[2]];
  const isUrl = (s) => /^(https?:)?\/\//.test(s) || /^\//.test(s);
  return isUrl(a) ? { src: a, alt: b } : { src: b, alt: a };
}

/* bierzemy KAŻDE ogniwo <a href="…/strona,{zawodnik|trener},ID"> — strona trzyma
   podstawowy skład w .player-item, a rezerwowych w .reserve-item, więc klasa
   kontenera nie może być wyznacznikiem. Dedupe po URL (bywają zdublowane linki). */
function parseList(html) {
  const grab = (kind, isStaff) => {
    const out = [];
    const seen = new Set();
    const re = new RegExp(`<a\\s+href="([^"]*strona,${kind},\\d+)"[^>]*>([\\s\\S]*?)<\\/a>`, "gi");
    for (const m of html.matchAll(re)) {
      const href = m[1];
      if (seen.has(href)) continue;
      seen.add(href);
      const inner = m[2];
      const { src, alt } = parsePhoto(inner);
      const title = clean((inner.match(/<div class="title[^"]*">([\s\S]*?)<\/div>/i) || [])[1] || "");
      const name = title.replace(/#.*$/, "").trim() || alt;
      if (!name) continue;
      if (isStaff) {
        out.push({ name, role: (title.match(/#\s*(.+)$/) || [])[1] || null, url: href, photoUrl: src });
      } else {
        const number = (title.match(/#\s*(\d+)/) || [])[1] || null;
        out.push({ name, number: number != null ? +number : null, url: href, photoUrl: src, position: null, height: null, country: null, birthDate: null, contract: null, instagram: null });
      }
    }
    return out;
  };
  return { staff: grab("trener", true), players: grab("zawodnik", false) };
}

function parseProfile(html) {
  const out = {};
  const row = (label) => {
    const re = new RegExp(`<td[^>]*>\\s*${label}\\s*:?\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, "i");
    const m = html.match(re);
    return m ? clean(m[1]).replace(/^#\s*/, "") : null;
  };
  out.country = row("Paszport");
  out.height = row("Wzrost");
  out.birthDate = row("Data urodzenia");
  out.position = row("Pozycja");
  out.contract = row("Kontrakt");
  /* Instagram: link gracza jest w bloku .player-info (obok nazwiska). W nagłówku
     i stopce leży konto klubu (anwilwloclawek) — bierzemy tylko to, co jest
     w bloku gracza i nie jest kontem klubu; brak = gracz nie ma Instagrama. */
  const pi = html.indexOf("player-info");
  const block = pi >= 0 ? html.slice(pi, pi + 2500) : "";
  const igLinks = [...block.matchAll(/href="(https?:\/\/(?:www\.)?instagram\.com\/[^"]+)"/gi)].map((m) => m[1]);
  out.instagram = igLinks.find((u) => !/instagram\.com\/anwilwloclawek\b/i.test(u)) || null;
  return out;
}

const slugify = (s) => (s || "").toLowerCase()
  .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e").replace(/ł/g, "l").replace(/ń/g, "n")
  .replace(/ó/g, "o").replace(/ś/g, "s").replace(/ź/g, "z").replace(/ż/g, "z")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function downloadPhotos(items, prefix) {
  mkdirSync(IMG_DIR, { recursive: true });
  for (const it of items) {
    if (!it.photoUrl) continue;
    const ext = (it.photoUrl.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] || "jpg").replace("jpeg", "jpg");
    const file = resolve(IMG_DIR, `${prefix}-${slugify(it.name)}.${ext}`);
    const rel = `roster-photos/${prefix}-${slugify(it.name)}.${ext}`;
    it.localPhoto = rel;
    if (existsSync(file)) continue;
    try {
      const res = await fetch(it.photoUrl, { headers: { "User-Agent": UA, Referer: URL }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 400) throw new Error("podejrzanie mały plik");
      writeFileSync(file, buf);
      process.stderr.write(`Zdjęcie: ${it.name} (${Math.round(buf.length / 1024)} KB)\n`);
    } catch (e) {
      process.stderr.write(`Zdjęcie pominięte (${it.name}): ${e.message}\n`);
      it.localPhoto = null;
    }
    await sleep(180);
  }
}

async function main() {
  process.stderr.write(`Pobieram ${URL} ...\n`);
  const html = await get(URL);
  const { staff, players } = parseList(html);
  if (!players.length) throw new Error("Nie znaleziono zawodników — zmienił się szablon /sklad?");

  if (!NO_DETAILS) {
    let n = 0;
    for (const p of players) {
      n++;
      if (!p.url) continue;
      try {
        const prof = parseProfile(await get(p.url));
        Object.assign(p, prof);
        process.stderr.write(`Profil ${n}/${players.length}: ${p.name} — ${p.position ?? "?"}\n`);
      } catch (e) {
        process.stderr.write(`Profil pominięty (${p.name}): ${e.message}\n`);
      }
      await sleep(250);
    }
  }

  if (!NO_PHOTOS) {
    await downloadPhotos(players, "zaw");
    await downloadPhotos(staff, "sztab");
  }

  /* sezon: najczęstszy "20xx/20xx" z kontraktów; awaryjnie z bieżącej daty */
  const counts = {};
  for (const p of players) {
    const m = (p.contract || "").match(/20\d{2}\/20\d{2}/);
    if (m) counts[m[0]] = (counts[m[0]] || 0) + 1;
  }
  const season = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
    || (() => { const y = new Date().getFullYear(); return `${y}/${String(y + 1).slice(2)}`; })();

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    source: URL,
    scrapedAt: new Date().toISOString(),
    season,
    count: players.length,
    staffCount: staff.length,
    players,
    staff,
  }, null, 2), "utf8");
  console.log(`Zapisano skład ${season}: ${players.length} zawodników + ${staff.length} sztabu -> ${OUT}`);
}

main().catch((e) => { console.error("Błąd scrapera:", e.message); process.exit(1); });
