#!/usr/bin/env node
/**
 * Lokalny serwer aplikacji Anwil Zone + API panelu administratora.
 *
 * Po co: opublikowany artefakt to statyczna strona — przeglądarka nie może
 * uruchomić procesu Node, więc przyciski w panelu admina tylko odgrywają
 * przebieg scrapera. Ten serwer daje panelowi prawdziwy backend:
 *   GET /                 -> app/prototype.html (świeżo z dysku)
 *   GET /api/status       -> stan danych (liczby rekordów + czas pobrania)
 *   GET /api/run?id=news  -> URUCHAMIA scraper i strumieniuje jego wyjście
 *
 * Bezpieczeństwo: uruchamiane są WYŁĄCZNIE komendy z listy JOBS poniżej —
 * nic z zapytania nie trafia do powłoki. Serwer słucha tylko na localhost.
 *
 * Użycie:
 *   node anwil-zone/server.mjs            # http://localhost:4180
 *   node anwil-zone/server.mjs --port=5000
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 4180);
const APP = resolve(dir, "app/prototype.html");
const DATA = resolve(dir, "data");

/* whitelista zadań: id -> [ścieżka skryptu, argumenty] */
const JOBS = {
  news: ["scrapers/kkwloclawek-news.mjs", ["--pages", "2", "--full", "--images"]],
  table: ["scrapers/plk-table.mjs", ["--logos"]],
  schedule: ["scrapers/plk-schedule.mjs", ["--team", "anwil-wloclawek", "--out", "../data/plk-schedule-anwil.json"]],
  match: ["scrapers/plk-match.mjs", ["--all"]],
  shop: ["scrapers/sklep-products.mjs", ["--images"]],
  build: ["app/build.mjs", ["--count", "8"]],
};

/* aktualny stan danych — te same liczby, które pokazuje panel */
function status() {
  const meta = (f) => {
    const p = resolve(DATA, f);
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
  };
  const news = meta("news.json"), table = meta("plk-table.json");
  const sched = meta("plk-schedule-anwil.json"), shop = meta("shop.json");
  const mDir = resolve(DATA, "matches");
  const files = existsSync(mDir) ? readdirSync(mDir).filter((f) => f.endsWith(".json")) : [];
  let matchAt = null;
  for (const f of files) {
    try {
      const at = JSON.parse(readFileSync(resolve(mDir, f), "utf8")).scrapedAt;
      if (at && (!matchAt || at > matchAt)) matchAt = at;
    } catch { /* pomijamy */ }
  }
  return {
    live: true,
    scrapers: {
      news: { at: news.scrapedAt ?? null, info: news.count != null ? `${news.count} newsów w bazie` : "brak danych" },
      table: { at: table.scrapedAt ?? null, info: table.count != null ? `${table.count} drużyn · sezon ${table.season ?? "?"}` : "brak danych" },
      schedule: { at: sched.scrapedAt ?? null, info: sched.count != null ? `${sched.count} meczów · rozegrane ${sched.played ?? 0}` : "brak danych" },
      match: { at: matchAt, info: `${files.length} meczów w data/matches/` },
      shop: { at: shop.scrapedAt ?? null, info: shop.count != null ? `${shop.count} produktów w katalogu` : "brak danych" },
      build: { at: existsSync(APP) ? statSync(APP).mtime.toISOString() : null, info: "generuje prototype.html" },
    },
  };
}

/* uruchomienie zadania ze strumieniowaniem wyjścia do przeglądarki */
function runJob(id, res) {
  const job = JOBS[id];
  if (!job) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Nieznane zadanie"); return; }
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  const script = resolve(dir, job[0]);
  const child = spawn(process.execPath, [script, ...job[1]], { cwd: dirname(script) });
  const pipe = (chunk) => { try { res.write(chunk); } catch { /* klient odszedł */ } };
  child.stdout.on("data", pipe);
  child.stderr.on("data", pipe);
  child.on("error", (e) => { res.write(`\nBŁĄD uruchomienia: ${e.message}\n`); res.end("__DONE__ 1\n"); });
  child.on("close", (code) => { res.end(`\n__DONE__ ${code ?? 0}\n`); });
  res.on("close", () => { if (!child.killed) child.kill(); });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/status") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(status()));
    return;
  }
  if (url.pathname === "/api/run") { runJob(url.searchParams.get("id"), res); return; }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (!existsSync(APP)) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Brak app/prototype.html — uruchom najpierw: node app/build.mjs");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync(APP));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Nie znaleziono");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Anwil Zone — tryb LIVE: http://localhost:${PORT}`);
  console.log("Panel admina: 5x klik w logo, login 123 / hasło 321");
});
