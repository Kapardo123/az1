# Anwil Zone — scrapery

Zestaw scraperów zasilających danymi aplikację **Anwil Włocławek Zone**.
Wszystkie działają na czystym Node (>= 18, wbudowany `fetch`), bez żadnych zależności.
Wyniki lądują jako JSON w `../data/`.

## 1. Aktualności — `kkwloclawek-news.mjs`

Pobiera newsy z oficjalnej strony klubu https://kkwloclawek.pl (strona nie ma
publicznego API, listing i artykuły są renderowane serwerowo).

```
node kkwloclawek-news.mjs                    # 1 strona listingu (10 newsów), bez treści
node kkwloclawek-news.mjs --pages 3 --full   # 3 strony + pełna treść artykułów
node kkwloclawek-news.mjs --category transfery --pages 2
node kkwloclawek-news.mjs --fresh            # nadpisz plik zamiast dołączać
```

| Opcja | Opis |
|---|---|
| `--pages N` | liczba stron listingu (domyślnie 1; 10 newsów/strona) |
| `--category X` | `zapowiedzi` `relacje` `transfery` `wywiady` `podcasty` `wideo` `inne` `archiwum` |
| `--full` | dociąga pełną treść i autora każdego artykułu (+1 request/artykuł) |
| `--images` | pobiera grafiki na dysk do `../data/images/<id>/` (miniatura `_lista`, pełny `_org` z og:image, zdjęcia z treści) |
| `--out PATH` | plik wyjściowy (domyślnie `../data/news.json`) |
| `--fresh` | nadpisuje plik; bez tej flagi wyniki są scalane po `id` |
| `--refresh` | pobiera ponownie także artykuły już obecne w bazie (domyślnie są pomijane) |
| `--delay MS` | przerwa między requestami (domyślnie 500 ms) |

Format wpisu w `data/news.json`:

```json
{
  "id": "20260710-anwil-wloclawek-zagra-w-lidze-enbl",
  "url": "https://kkwloclawek.pl/czytaj,aktualnosci,20260710,...",
  "title": "Anwil Włocławek zagra w lidze ENBL",
  "date": "2026-07-10T10:54:00",
  "image": "https://kkwloclawek.pl/files/icons/article/.../..._lista.jpg",
  "lead": "…",
  "author": "Damian Puchalski",      // tylko z --full
  "content": "…pełny tekst…",        // tylko z --full
  "imageFull": "…og:image…",         // tylko z --full
  "contentImages": ["…"],            // tylko z --full (zdjęcia osadzone w treści)
  "localImage": "images/<id>/…_lista.jpg",   // tylko z --images (główna, ścieżka względem news.json)
  "localImages": ["images/<id>/…"]           // tylko z --images (wszystkie pobrane)
}
```

Uwagi:
- Scraper jest **przyrostowy**: artykuły, które już mamy w komplecie (treść,
  a przy `--images` także grafiki), są pomijane — pobierane są tylko nowe wpisy.
  Pełne odświeżenie: `--refresh`.
- Kolejne uruchomienia domyślnie **scalają** wyniki z istniejącym plikiem
  (dedupe po `id`), więc plik może rosnąć jako lokalne archiwum newsów.
- Scraper jest uprzejmy: sekwencyjne requesty + 500 ms przerwy, własny User-Agent.
- Selektory bazują na strukturze strony z lipca 2026 (`.article-item`,
  `h3.article-item-header`, `h1.header-single-article`, `div.content`).
  Jak klub zmieni szablon, trzeba będzie je zaktualizować.

## 2. Tabela PLK + loga drużyn — `plk-table.mjs`

Pobiera aktualną tabelę Orlen Basket Ligi z https://plk.pl/tabele (Next.js, ale tabela
`#stats-table` jest renderowana serwerowo) oraz loga drużyn z CDN `esor.pzkosz.pl`.

```
node plk-table.mjs           # tabela -> ../data/plk-table.json
node plk-table.mjs --logos   # + loga PNG (300x300) do ../data/logos/{id}-{slug}.png
```

Każda drużyna: `pos, teamId, slug, name, url, points, games, wins, losses,
home, away, scored, conceded, diff, ratio, logoUrl, localLogo`.
Sezon wykrywany automatycznie (np. `2025/2026`).

## 3. Terminarz PLK — `plk-schedule.mjs`

Pobiera terminarz + wyniki z https://plk.pl/terminarz (sezon zasadniczy, 30 kolejek;
każda kolejka to serwerowo renderowana tabela Gospodarz | Gość | Data | TV | Wynik).

```
node plk-schedule.mjs                                              # caly sezon (240 meczów)
node plk-schedule.mjs --team anwil-wloclawek --out ../data/plk-schedule-anwil.json
node plk-schedule.mjs --sezon 2026/2027                            # inny sezon (?sezon=)
```

Każdy mecz: `round, matchId, url, date (ISO), dateRaw, home{teamId,slug,name},
away{...}, homeScore, awayScore, played, tv`. Rok w dacie wyliczany z sezonu
(sie–gru = pierwszy rok, sty–lip = drugi). Uwaga: jeśli plk.pl nie ma jeszcze meczów
żądanego sezonu w bazie, strona zwraca sezon domyślny — scraper to wykrywa i ostrzega
(stan 07.2026: terminarz 2026/27 ogłoszony, ale jeszcze nie wpisany na plk.pl).
Play-off (`/terminarz/play-off`) ma inny układ — do zrobienia osobno.

## 4. Szczegóły meczu — `plk-match.mjs`

Pobiera pełne dane meczu ze strony `plk.pl/mecz/{id}/{slug}` — dane siedzą
w strumieniu Next.js flight (`self.__next_f.push`), scraper skleja chunki,
odescapowuje i wycina zbalansowane JSON-y:

- **boxscore**: rostery obu drużyn scalone ze statystykami po `playerId`
  (punkty, zbiórki, asysty, przechwyty, bloki, straty, +/-, eval, minuty,
  celne/oddane za 2 i 3, pierwsza piątka, zdjęcia zawodników)
- **kwarty** (wyniki), **play-by-play** (każda akcja po polsku, wynik na bieżąco)
- **mapa rzutów**: x/y w % boiska + strona; celność łączona z play-by-play
  po `actionNumber` tej samej kwarty
- sędziowie, hala; trenerzy w rosterze

```
node plk-match.mjs https://plk.pl/mecz/222605/anwil-wloclawek-vs-mks-dabrowa-gornicza
node plk-match.mjs --all            # wszystkie rozegrane z plk-schedule-anwil.json
node plk-match.mjs --all --force    # nadpisz pobrane
```

Wyjście: `../data/matches/{matchId}.json` (~200-300 KB/mecz). Uwaga: strona
meczu nie podaje wprost daty ani sluga drużyn — build uzupełnia je
z terminarza/tabeli (mecze posezonowe: mapy `PHASE_LABELS`/`PHASE_DATES` w build.mjs).

## 5. Skład drużyny — `plk-roster.mjs`

Kadra Anwilu z `plk.pl/druzyny/33/anwil-wloclawek/sklad` + statystyki sezonu
i log **mecz po meczu** każdego zawodnika.

```
node plk-roster.mjs --photos     # skład + statystyki + zdjęcia (350x350)
node plk-roster.mjs --no-games   # sam skład, bez logu meczowego (szybko)
node plk-roster.mjs --team 33 --slug anwil-wloclawek
```

Wyjście: `../data/roster.json` + `../data/players/{id}.jpg`.
Zawodnik: `id, name, number, height, position(s), birthDate, age, country,
photoUrl/localPhoto, season{…}, games[…], career[…]`.

**Uwaga o statystykach sezonu:** liczymy je **sami z logu mecz-po-meczu**,
a nie z tabeli zbiorczej na plk.pl — ta ma scalone nagłówki (grupy kolumn
„Rzuty za 2 / % ”, „Zbiórki A/O/S”) i pozycyjne mapowanie bywa dwuznaczne.
Suma z logu jest weryfikowalna: sprawdzona co do sztuki względem boxscore'ów
pobranych przez `plk-match.mjs` (10/10 zawodników zgodnych: punkty, zbiórki,
asysty, eval, +/-), a wyliczone średnie zgadzają się ze średnimi podawanymi
przez plk.pl.

Uwaga: kolumna **S5** (pierwsza piątka) nie zawiera tekstu, tylko ikonę gwiazdki
w SVG — czytamy ją z surowej komórki (`/<svg/`), inaczej wychodziłoby zawsze
„false". Kontrola poprawności: 160 wpisów = dokładnie 5 zawodników × 32 mecze.

Kolumny logu meczowego (pozycyjnie, zweryfikowane):
`rywal | d/w | Z/P | wynik | data | S5 | PKT | min | za2 | % | za3 | % |
z gry | % | wolne | % | zbA | zbO | zbSuma | AS | F | FW | straty |
przechwyty | bloki | blokiOtrz | Eval | +/-`

Scraper wykrył przy okazji, że Anwil rozegrał **32 mecze** (30 sezonu
zasadniczego + **dwa** mecze play-in: z Zastalem 8.05 i MKS-em 10.05) —
drugiego z nich nie było wcześniej w danych.

## 6. Sklep klubowy — `sklep-products.mjs`

Sklep (https://sklep.kkwloclawek.pl) stoi na WooCommerce z otwartym **Store API** —
czytamy czysty JSON, bez parsowania HTML:
`/wp-json/wc/store/v1/products` (paginacja po 100) + `/products/categories`.

```
node sklep-products.mjs --images    # produkty + pierwsze zdjęcie każdego
```

Wyjście: `../data/shop.json` (nazwa, slug, ceny w zł z minor-units, promocje,
stany magazynowe, rozmiary z atrybutów, kategorie, linki) +
`../data/shop-images/{id}.jpg`. Encje HTML w nazwach dekodowane.

## Tryb LIVE — panel admina, który naprawdę uruchamia scrapery

```
node anwil-zone/server.mjs        # http://localhost:4180
```

Serwer podaje `app/prototype.html` **i** wystawia API panelu administratora:
`GET /api/status` (stan danych) oraz `GET /api/run?id=…` (uruchamia zadanie
i strumieniuje jego wyjście do konsoli w panelu). Uruchamiane są wyłącznie
komendy z listy `JOBS` w `server.mjs` — nic z zapytania nie trafia do powłoki,
serwer słucha tylko na `127.0.0.1`.

Panel admina: **5× klik w logo** → login `123`, hasło `321`.
- otwarty przez `server.mjs` → plakietka **TRYB LIVE**, przyciski realnie
  uruchamiają scrapery, a „Przebuduj aplikację" na koniec przeładowuje stronę
  ze świeżymi danymi;
- otwarty jako plik/artefakt → **TRYB DEMO**, przyciski tylko odgrywają przebieg
  (statyczna strona nie ma backendu), przycisk „Kopiuj" podaje prawdziwą komendę.

## Budowanie prototypu z danych — `../app/build.mjs`

Prototyp aplikacji jest generowany z szablonu (`app/template.html`) + danych scrapera:

```
node ../app/build.mjs               # 8 najnowszych newsów z pełną treścią
node ../app/build.mjs --count 12
node ../app/build.mjs --no-images   # bez osadzania grafik (mniejszy plik)
```

Wynik: `app/prototype.html` — pełne artykuły (treść, autor, link do źródła) i miniatury
zmniejszone do 640 px, osadzone jako data-URI. Wymaga wcześniejszego uruchomienia
scrapera z `--full --images`. **Zmiany w wyglądzie prototypu robimy w `template.html`**,
potem przebudowujemy.

## Planowane kolejne scrapery

- **Terminarz / wyniki** — `kkwloclawek.pl/terminarz` (albo plk.pl)
- **Skład** — `kkwloclawek.pl/sklad` (zawodnicy, numery, pozycje, zdjęcia)
- **Tabela PLK** — plk.pl
