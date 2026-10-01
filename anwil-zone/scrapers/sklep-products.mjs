#!/usr/bin/env node
/**
 * Scraper oficjalnego sklepu Anwilu (https://sklep.kkwloclawek.pl).
 *
 * Sklep stoi na WooCommerce, które wystawia publiczne Store API —
 * nie parsujemy HTML, tylko czytamy JSON:
 *   /wp-json/wc/store/v1/products?per_page=100&page=N
 *   /wp-json/wc/store/v1/products/categories
 * Ceny przychodzą w jednostkach mniejszych (grosze) + currency_minor_unit.
 *
 * Użycie:
 *   node sklep-products.mjs                 # wszystkie produkty -> ../data/shop.json
 *   node sklep-products.mjs --images       # + pobiera pierwsze zdjęcie każdego produktu
 *   node sklep-products.mjs --out PATH --delay 400
 *
 * Wyjście: ../data/shop.json + ../data/shop-images/{productId}.jpg (z --images)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://sklep.kkwloclawek.pl";
const UA = "AnwilZoneScraper/1.0 (prototyp aplikacji kibica; kontakt: rafavek@gmail.com)";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const IMAGES = args.includes("--images");
const DELAY = Math.max(0, parseInt(opt("delay", "400"), 10) || 0);
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dir, opt("out", "../data/shop.json"));
const IMG_DIR = resolve(dirname(OUT), "shop-images");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return { data: await res.json(), totalPages: +(res.headers.get("x-wp-totalpages") ?? 1) };
}

/* nazwy przychodzą z encjami HTML (&#8217; itd.) */
const decodeEntities = (s) => (s ?? "")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

/* cena ze Store API: minor units + przecinek wg minor_unit */
function fmtPrice(raw, minorUnit) {
  if (raw == null || raw === "") return null;
  const v = Number(raw) / 10 ** minorUnit;
  return Math.round(v * 100) / 100;
}

async function main() {
  process.stderr.write("Kategorie...\n");
  const { data: catsRaw } = await getJson(`${BASE}/wp-json/wc/store/v1/products/categories?per_page=100`);
  const categories = catsRaw
    .filter((c) => !["Bez kategorii", "Strona Główna"].includes(c.name))
    .map((c) => ({ id: c.id, name: c.name, slug: c.slug, count: c.count }));

  const products = [];
  let page = 1, totalPages = 1;
  do {
    process.stderr.write(`Produkty, strona ${page}...\n`);
    const { data, totalPages: tp } = await getJson(`${BASE}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    totalPages = tp;
    for (const p of data) {
      const mu = p.prices?.currency_minor_unit ?? 2;
      /* Atrybuty produktu wariantowego (w tym sklepie zawsze dokładnie jeden:
         "Rozmiar", "Kolor", "Zapach"…). Każdy = nazwa + lista wartości. */
      const options = (p.attributes ?? [])
        .filter((a) => (a.terms ?? []).length)
        .map((a) => ({ name: decodeEntities(a.name), terms: (a.terms ?? []).map((t) => decodeEntities(t.name)) }));
      // rozmiary z atrybutów (np. "Rozmiar": S/M/L/XL)
      const sizes = options
        .filter((o) => /rozmiar|size/i.test(o.name))
        .flatMap((o) => o.terms);
      /* Mapa wartość -> ID wariantu; potrzebna, by przekazać koszyk do sklepu
         (WooCommerce dodaje wariant przez ?add-to-cart=<id>&variation_id=<vid>).
         Warianty operują SLUGAMI ("110-116"), a atrybuty NAZWAMI ("110/116"),
         więc trzeba je przetłumaczyć — inaczej wartości z ukośnikiem
         (rozmiary dziecięce) nigdy się nie dopasują. Kolor/Zapach też tu trafia. */
      const slugToName = {};
      for (const a of p.attributes ?? []) {
        for (const t of a.terms ?? []) if (t.slug) slugToName[t.slug] = decodeEntities(t.name);
      }
      /* Lista wariantów w produkcie bywa nieaktualna (zwraca też wyprzedane),
         więc dla produktów wariantowych pytamy o nie osobno — razem ze
         stanem magazynu. Bez tego aplikacja proponuje rozmiar/kolor,
         którego sklep nie doda (kończy się przekierowaniem na produkt). */
      let vars = p.variations ?? [];
      if (p.type === "variable" && vars.length) {
        try {
          const { data } = await getJson(`${BASE}/wp-json/wc/store/v1/products?type=variation&parent=${p.id}&per_page=100`);
          if (data?.length) vars = data;
        } catch (e) {
          process.stderr.write(`  warianty ${p.id}: ${e.message}\n`);
        }
        await sleep(DELAY);
      }
      const variants = {};
      for (const v of vars) {
        if (v.is_in_stock === false || !v.id) continue; /* wyprzedany */
        /* produkt zwraca warianty w formie skróconej (attributes[].value = slug)
           albo pełnej (pole "variation" = "Atrybut: Wartość") */
        const a = (v.attributes ?? [])[0];
        let name = a?.value ? (slugToName[a.value] ?? decodeEntities(a.value)) : null;
        if (!name && v.variation) name = decodeEntities(v.variation.replace(/^[^:]+:\s*/, ""));
        if (name) variants[name] = v.id;
      }
      products.push({
        id: p.id,
        name: decodeEntities(p.name),
        slug: p.slug,
        url: p.permalink,
        sku: p.sku || null,
        price: fmtPrice(p.prices?.price, mu),
        regularPrice: fmtPrice(p.prices?.regular_price, mu),
        salePrice: p.on_sale ? fmtPrice(p.prices?.sale_price, mu) : null,
        currency: p.prices?.currency_code ?? "PLN",
        onSale: !!p.on_sale,
        /* produkt wariantowy bez ani jednego dostępnego wariantu = wyprzedany */
        inStock: !!p.is_in_stock && !(options.length && !Object.keys(variants).length),
        purchasable: !!p.is_purchasable,
        type: p.type,
        hasOptions: !!p.has_options,
        sizes: [...new Set(sizes)],
        options,
        variants,
        categories: (p.categories ?? []).map((c) => c.name).filter((n) => !["Bez kategorii", "Strona Główna"].includes(n)),
        image: p.images?.[0]?.src ?? null,
        images: (p.images ?? []).map((i) => i.src),
      });
    }
    page++;
    if (page <= totalPages) await sleep(DELAY);
  } while (page <= totalPages);

  if (IMAGES) {
    mkdirSync(IMG_DIR, { recursive: true });
    let n = 0;
    for (const p of products) {
      n++;
      if (!p.image) continue;
      const ext = (p.image.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] ?? "jpg").replace("jpeg", "jpg");
      const file = resolve(IMG_DIR, `${p.id}.${ext}`);
      const rel = `shop-images/${p.id}.${ext}`;
      if (existsSync(file)) { p.localImage = rel; continue; }
      await sleep(DELAY);
      try {
        const res = await fetch(p.image, { headers: { "User-Agent": UA, Referer: BASE + "/" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 500) throw new Error("podejrzanie mały plik");
        writeFileSync(file, buf);
        p.localImage = rel;
        process.stderr.write(`Zdjęcie ${n}/${products.length}: ${p.name} (${Math.round(buf.length / 1024)} KB)\n`);
      } catch (e) {
        process.stderr.write(`Zdjęcie pominięte (${p.name}): ${e.message}\n`);
      }
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ source: BASE, scrapedAt: new Date().toISOString(), count: products.length, categories, products }, null, 2),
    "utf8"
  );
  const inStock = products.filter((p) => p.inStock).length;
  console.log(`Zapisano ${products.length} produktów (w magazynie: ${inStock}), ${categories.length} kategorii do ${OUT}`);
}

main().catch((e) => { console.error("Błąd scrapera:", e.message); process.exit(1); });
