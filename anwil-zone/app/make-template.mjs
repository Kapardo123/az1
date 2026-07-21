// Jednorazowy skrypt: robi szablon z aktualnego prototypu (wycina wbudowane
// newsy + base64 i zostawia token __NEWS_DATA__ dla build.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) { console.error("użycie: node make-template.mjs <ścieżka do anwil-zone.html>"); process.exit(1); }

let html = readFileSync(src, "utf8");
const re = /\/\* Prawdziwe newsy pobrane scraperem[\s\S]*?\n\];/;
if (!re.test(html)) { console.error("Nie znaleziono bloku NEWS"); process.exit(1); }
html = html.replace(re,
  "/* NEWS wstrzykiwane przez build.mjs z danych scrapera (data/news.json) */\nconst NEWS = __NEWS_DATA__;");
writeFileSync(resolve(dir, "template.html"), html);
console.log("template.html zapisany, rozmiar: " + Math.round(html.length / 1024) + " KB");
