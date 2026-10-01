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

## 3a. Terminarz klubowy PLK + ENBL — `kkw-schedule.mjs`

Pobiera **cały** terminarz Anwilu z https://kkwloclawek.pl/terminarz. To jedyne
miejsce, gdzie mecze PLK i europejskiego pucharu **ENBL** są w jednym
zestawieniu (plk.pl nie zna ENBL). Tabela `.table-terminarz` renderuje się
serwerowo, kolumny: DATA | ROZGRYWKI | MECZ | WYNIK | WIDEO | GALERIA | RELACJA.

```
node kkw-schedule.mjs                 # -> ../data/kkw-schedule.json
node kkw-schedule.mjs --out ../data/inny.json
```

Każdy mecz: `date` (ISO), `dateRaw`, `timeTbd` (godzina „0" = nieustalona),
`competition`, `league` (`PLK`/`ENBL`), `label`, `home`, `away`, `homeScore`,
`awayScore`, `played`, `anwilHome`, linki `video`/`gallery`/`report`.
Nagłówek pliku: `seasons`, `count`, `played`, `byLeague` (np. `{"ENBL":8,"PLK":30}`).

**Anwil gra w dwóch ligach jednocześnie** — dlatego terminarz i terminarzowy
widok aplikacji pokazują etykietę rozgrywek (PLK / ENBL) przy każdym meczu,
a rywale z ENBL dostają własne loga (patrz niżej).

## 3b. ENBL — `enbl.mjs` (tabela, statystyki zawodników, loga)

```
node enbl.mjs                 # -> ../data/enbl.json + ../data/logos/enbl/
node enbl.mjs --no-logos      # tylko statystyki
```

Dwa źródła:

1. **Loga drużyn** — https://www.enbleague.eu/ (Wix). Na stronie głównej jest
   pasek drużyn; grafiki to media `static.wixstatic.com/media/<id>` (w HTML
   escape'owane `&quot;`). Pobieramy wersję zmniejszoną (`w_180`) do
   `../data/logos/enbl/<slug>.png`. Część plików nie ma rozszerzenia, część ma
   nazwy „Artboard…" — filtr `SKIP` odsiewa sponsoring, a `ALIASES` wyrównuje
   pisownię (np. logo `zrinski` ↔ „HKK Zrinjski Mostar", `ael` ↔ „Tria Eka AEL BC").
2. **Tabela i statystyki zawodników** — ENBL osadza widgety **Genius Sports**
   (`hosted.dcd.shared.geniussports.com`). Scraper sam wykrywa **najnowszy
   sezon**: strona `/ENBL/en/standings` ma chooser z pozycjami
   `ENBL 20xx/20xx` → `competition/{id}/standings` (np. 2026/2027 = `50063`),
   i z niego czyta dane przez `/embednf/ENBL/en/competition/{id}/<strona>`
   (pole `html`), bez logowania:
   - `standings` → tabela (16 drużyn w sezonie 2026/27, poz. GP/W/L/kosze/Pkt),
   - `leaders` → średnie zawodników: PTS, AST, BLK, REB, STL, 3PM, 2PM, FTM, EFF
     (przed startem sezonu lista bywa pusta).

`data/enbl.json`: `season`, `standings[]`, `leaders[]`
(`{title, unit, rows:[{player, team, value}]}`) oraz `logos[]`
(`{name, slug, tokens, localLogo, logoUrl}`) — z tokenami do dopasowania
rywala z terminarza do loga.

W aplikacji tabela ENBL jest widoczna w widoku **Tabela** oraz przez
przełącznik **PLK / ENBL** na stronie głównej.

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
z terminarza/tabeli.

## 4a. Szczegóły meczu ENBL — `enbl-match.mjs`

To samo, co `plk-match.mjs`, ale dla pucharu ENBL. Genius Sports udostępnia:

- **termiarz** — `fibalivestats.../data/competition/{id}.json` (to źródło zasila
  widget meczu na stronie głównej enbleague.eu); scraper filtruje mecze z Anwilem.
- **szczegóły** — `fibalivestats.../data/{matchId}/data.json`: boxscore, play-by-play,
  rzuty (x/y w %, `r` = celny), kwarty, sędziowie. Hala jest w HTML strony
  `.../u/ENBL/{matchId}/` (sekcja „Venue").

Dane Geniuss są tłumaczone na format z `plk-match.mjs`, żeby **Match Center
wyglądał identycznie** (kwarty, przebieg, momentum, mapa rzutów, MVP). Uwaga:
pole `scoring` w source bywa prawdziwe także dla niecelnych — akcje punktowe
wyznaczamy po zmianie wyniku bieżącego (`s1`/`s2`).

```
node enbl-match.mjs                    # wszystkie rozegrane mecze Anwilu
node enbl-match.mjs 2910551            # pojedynczy matchId
node enbl-match.mjs --comp 50063       # wskaż turniej ręcznie
node enbl-match.mjs --force            # nadpisz pobrane
node enbl-match.mjs --team Donar       # inny filtr drużyny
```

Wyjście: `../data/matches/{matchId}.json` + `../data/enbl-matches.json`
(indeks: id, termin, wynik, status). Identyfikatory ENBL (7 cyfr) nie kolidują
z PLK (6 cyfr). `app/build.mjs` łączy mecze z terminarza z indeksem po dacie
i nazwie rywala — dzięki temu wynik i szczegóły pojawiają się w aplikacji
automatycznie.

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

## 5a. Aktualny skład + sztab — `kkw-roster.mjs`

Aktualna kadra i **sztab szkoleniowy** z https://kkwloclawek.pl/sklad
(oficjalna strona klubu). To źródło jest świeższe niż plk.pl — pokazuje
sezon 2026/27 z nowymi zawodnikami.

```
node kkw-roster.mjs                 # skład + sztab + profile + zdjęcia
node kkw-roster.mjs --no-photos     # bez zdjęć
node kkw-roster.mjs --no-details    # bez profili zawodników (szybko)
```

Strona renderuje się serwerowo: sztab w `.couch-item`, zawodnicy w
`.player-item` (na grafice boiska). Scraper dodatkowo wchodzi na profil
każdego zawodnika (`/strona,zawodnik,ID`) i czyta: **pozycję, wzrost, kraj
(paszport), datę urodzenia, kontrakt** oraz link Instagram. Zdjęcia lądują
w `../data/roster-photos/`.

Wyjście: `../data/roster-kkw.json` — `{ season, players[{name, number,
position, height, country, birthDate, contract, url, instagram, localPhoto}],
staff[{name, role, url, localPhoto}] }`.

W aplikacji (widok **Drużyna**) skład 2026/27 i sekcja **Sztab trenerski**
pochodzą z tego pliku; zawodnicy, którzy grali też w poprzednim sezonie,
otwierają pełny profil ze statystykami PLK (`plk-roster.mjs`).

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

**Warianty rozmiarów (`variants`)** — mapa `rozmiar -> ID wariantu`. WooCommerce
traktuje każdy rozmiar jako osobny produkt (variation) z własnym ID, i tylko
takim ID można dodać konkretny rozmiar do koszyka. Uwaga: Store API zwraca
w `variations` **wyłącznie rozmiary dostępne w magazynie**, więc różnica między
`sizes` a `variants` to rozmiary wyprzedane — aplikacja pokazuje je przekreślone
i nieklikalne.

### Przeniesienie koszyka do sklepu

Koszyk w aplikacji jest lokalny, ale przycisk „Przejdź do kasy" odtwarza go
w prawdziwym sklepie: otwiera jedno okno i ładuje w nim kolejno adresy
`sklep.kkwloclawek.pl/?add-to-cart=<id>&quantity=<n>` (dla rozmiarów `<id>`
to ID wariantu), a na końcu `/koszyk`. Sesja WooCommerce narasta między
wywołaniami, więc na końcu w sklepie są wszystkie pozycje.

Dlaczego tak, a nie przez API: Store API pozwala dodawać do koszyka
(`POST /wp-json/wc/store/v1/cart/add-item`, wymaga nagłówka `Nonce`,
zwraca `Cart-Token`), ale token jest nagłówkiem HTTP — przeglądarka nie wyśle
go przy zwykłym otwarciu strony sklepu, a CORS i tak blokuje takie żądania
z innej domeny. WooCommerce nie obsługuje też wielu produktów naraz
(`?add-to-cart=1,2` nie działa) — stąd sekwencja.

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

- **Statystyki ENBL Anwilu per zawodnik** — Genius Sports udostępnia strony drużyn
  (`/ENBL/en/team/{id}`); do dociągnięcia, gdy Anwil pojawi się w bieżącej fazie ENBL.
