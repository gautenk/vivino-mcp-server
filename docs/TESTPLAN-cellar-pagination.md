# Testplan: cellar-liste og ekte `per_page`

Status: implementert 2026-09-25 (sesjon 2). `npm test` er grønn (104 tester), og `npm run test:live` er grønn for L-1 til L-8. M-1 venter på brukeren.

## Beslutninger

### A. Paginering i `vivino_get_user_ratings`
| # | Beslutning |
|---|---|
| A1 | Problemet: `/users/{id}/activities` gir ca. 10 elementer per kall uansett `limit`, og `per_page` blir dermed aldri oppfylt. |
| A2 | Hvis Vivino ikke respekterer en størrelsesparameter, henter verktøyet batcher internt til `per_page` er fylt opp eller historikken er tom. **Ingen tak.** 700 ms-throttlingen beholdes. |
| A3 | Ved første 429: vent 60 s og prøv igjen. Ved neste 429 i samme kall: avbryt og returner delvis resultat med `has_more: true`, en gyldig `next_start_from` og `warning`. |
| F1 | Standardverdien for `per_page` i ratings senkes fra 25 til 10, og settes lokalt i ratings-skjemaet, ikke i den globale `DEFAULT_PER_PAGE`. Beskrivelsen oppdateres: `per_page` garanterer nå antallet, med unntak for tom historikk eller 429-avbrudd. |

### B–D. Nytt verktøy `vivino_get_cellar`
| # | Beslutning |
|---|---|
| B1 | «Cellar» betyr faktisk beholdning (My Wines → Cellar): flasker med antall. Ikke activity-hendelser, ikke wishliste. |
| B2 | Endepunktet hentes fra en HAR eller cURL fra brukeren (uten cookie). Live-verifiseringen kjøres i denne sesjonen. |
| C1 | **Påkrevd:** `wine_id`, `wine_name`, `vintage` (null = NV), `quantity`. **Nullable:** `winery_name` (H3), drikkevindu, egen rating, snittrating, pris, innkjøpsdato, innkjøpssted. |
| C2 | `enrich: boolean`, standard `false`. Med `true` hentes wine details per vin, med cache og throttling. |
| D1 | Obsidian-integrasjon er utenfor omfang og tas i en egen runde senere. |
| D2 | Hele kjelleren returneres som standard, med intern paginering. Valgfri `per_page`/`page` overstyrer, med samme utfyllingssemantikk som A2. |
| D3 | Filtre (lokale): `wine_name_query`, `vintage_min`, `vintage_max`, `country`, `region`, `min_quantity`, `ready_to_drink`. |
| D4 | Streng håndtering av `null`: en vin med `null` i et filtrert felt utelates, telles i `excluded_unknown`, og svaret får en `warning` som foreslår `enrich: true`. Ingen automatisk berikelse. |

### E–G. Verifisering
| # | Beslutning |
|---|---|
| E1 | `npm test` = Vitest, offline og deterministisk. `npm run test:live` = eget skript som aldri kjøres av `npm test`, og som kjøres manuelt før push. |
| E2 | Fixtures fra HAR anonymiseres før commit. Struktur, feltnavn, vin-ID og navn beholdes. Pris, sted og notater erstattes med syntetiske verdier. |
| F2 | Hovedbeviset for A: historikken hentes fullt med `per_page: 7` og `per_page: 100`. Mengden `(wine_id, rated_at)` må være identisk, uten duplikater. |
| F3 | Kjelleren verifiseres automatisk mot HAR (samme ID-er og antall) og manuelt av brukeren mot appen. |
| G1 | Sky-miljøet har `www.vivino.com` i allowlisten og `VIVINO_*` som miljøvariabler. Bekreftet innlogget (`is_signed_in: true`) etter cookie-fiksen. |

## Rekkefølge

0. **Forutsetninger:** HAR eller cURL for kjeller-siden er mottatt, og live-tilgangen er bekreftet (✅).
1. **Probe (live, før koding):** `/users/{id}/activities` kalles med `limit=50`, `per_page=50` og `count=50`, og antall `user-activity-*` telles. Resultatet avgjør om A blir en parameterendring eller en løkke.
2. **Offline-tester skrives først** (de skal feile før implementering).
3. Implementering av A, deretter B–D.
4. `npm test` grønn, så `npm run build`, så `npm run test:live`, så manuell F3a.

## Offline-tester (`npm test`)

### A: ratings (`src/__tests__/ratings.test.ts`)
Mock `fetchActivities` med batcher på 10 elementer, inkludert cellar-hendelser (rating 0).

| ID | Scenario | Forventet |
|---|---|---|
| A-U1 | `per_page: 25`, 5 batcher tilgjengelig | 25 ratinger. 3 fetch-kall. `next_start_from` = activity-ID for rating nr. 25. |
| A-U2 | `per_page: 25`, historikken tom etter 12 | 12 ratinger, `has_more: false`, ingen ekstra kall etter en tom batch. |
| A-U3 | Batch med bare cellar-hendelser (rating 0) i midten | Løkken fortsetter. Cellar-hendelsene telles ikke mot `per_page`. |
| A-U4 | `min_rating: 4.5`, treff spredt over mange batcher | Løkken går til `per_page` er fylt opp eller historikken er tom (ingen tak). |
| A-U5 | Kall 1 med `per_page: 7`, kall 2 med `start_from = next_start_from` | Kall 1 og 2 samlet = de første 14 i historikken, uten overlapp eller hull. |
| A-U6 | 429 på batch 3, deretter 200 | Kallet fullføres. Én ventetid på 60 s (fake timers). Ingen duplikater. |
| A-U7 | 429 på batch 3, og 429 igjen | Batch 1–2 returneres, `has_more: true`, `warning` satt, `next_start_from` = siste returnerte element. |
| A-U8 | `per_page` utelatt | Standard er 10. |
| A-U9 | Throttling | ≥ 700 ms mellom påfølgende batch-kall (fake timers og spy på throttle). |
| A-U10 | Regresjon | Eksisterende tester i `ratings.test.ts` og `sync.test.ts` er fortsatt grønne. Obsidian-sync er uendret. |

### B–D: cellar (`src/__tests__/cellar.test.ts`, fixture `src/__tests__/fixtures/cellar-*.json`)
| ID | Scenario | Forventet |
|---|---|---|
| C-U1 | Parse av anonymisert HAR-fixture | Alle påkrevde felt er satt for hvert element. Typene er riktige (`quantity` er heltall, `vintage` er heltall eller null). |
| C-U2 | NV-vin i fixture | `vintage: null`, ikke 0 eller en tilfeldig 4-sifret verdi. |
| C-U3 | Nullable felt mangler i responsen | Feltet er `null`, ikke `undefined` og ikke fraværende. |
| C-U4 | Fixture over flere sider (syntetisk, 3 sider) | Standardkall gir alle elementer. Ingen duplikater. Riktig antall kall. |
| C-U5 | `per_page: 5, page: 2` | Elementene 6–10. `has_more` er korrekt. |
| C-U6 | `enrich: false` | Null kall til `fetchWineDetails`. |
| C-U7 | `enrich: true` | Ett kall per unik vin (cache-treff teller ikke). Felt fra wine details fylles ut. |
| C-U8 | Hvert filter isolert (7 tester) | Riktig delmengde. `wine_name_query` treffer både navn og produsent, uten hensyn til store og små bokstaver. |
| C-U9 | `ready_to_drink: true`, `enrich: false`, vindu mangler | Vinene utelates. `excluded_unknown: N` og `warning` nevner `enrich: true`. |
| C-U10 | `region` filtrert, noen viner med `region: null` | Samme semantikk som C-U9. |
| C-U11 | Kombinerte filtre | AND-semantikk. `excluded_unknown` teller hver vin maks én gang. |
| C-U12 | 429×2 under intern paginering | Delvis resultat med `warning` (samme regel som A3). |
| C-U13 | Endepunktet returnerer HTML eller uventet form (Vivino har endret seg) | Tydelig feilmelding, ikke en tom liste som ser gyldig ut. |

## Live-tester (`npm run test:live`)
Skriptet leser `.env` eller miljøet, kjører mot vivino.com og skriver en Markdown-rapport. Det kjøres manuelt før push.

| ID | Test | Bestått når |
|---|---|---|
| L-1 | Probe av størrelsesparameter (steg 1) | Rapporterer antall per kall for hver parameter. Informativ, ikke en bestått/feilet-test. |
| L-2 | **F2:** hele historikken med `per_page: 7` og med `per_page: 100` | Mengdene av `(wine_id, rated_at)` er identiske. 0 duplikater. Antallet er likt. |
| L-3 | Tidsbruk i verste fall: `min_rating: 4.8, per_page: 100` | Fullfører uten feil. Tid og antall kall rapporteres og sammenlignes mot MCP-klientens tool-timeout. Kallet feiler hvis tiden overskrider timeouten. |
| L-4 | Standard `per_page` | 10 ratinger, `has_more: true`. |
| L-5 | Kjelleren, standardkall | Svar uten feil. Alle påkrevde felt er satt. Rapporterer antall viner, totalt antall flasker og om kjelleren strekker seg over mer enn én Vivino-side. |
| L-6 | **F3b:** kjelleren mot HAR | Samme sett med `wine_id` og `quantity` som i HAR-en. Avvik listes (en flaske kan ha blitt drukket, men avvik skal forklares, ikke ignoreres). |
| L-7 | `enrich: true` på 3 viner | Minst ett nullable felt fylles ut per vin. Tidsbruken rapporteres. |
| L-8 | Regresjon | `vivino_search_wines`, `vivino_get_wine_details` og `vivino_get_wine_reviews` svarer som før (smoke). |

Hvis kjelleren er på én Vivino-side eller mindre, dekkes intern paginering bare av C-U4 (offline). Rapporten skal da si det eksplisitt.

## Manuell verifisering
| ID | Test | Bestått når |
|---|---|---|
| M-1 | **F3a:** rapporten fra L-5 viser antall viner, antall flasker og 5 tilfeldige viner med antall | Brukeren bekrefter at tallene stemmer med Vivino-appen. |
| M-2 | `node dist/index.js` over stdio: `tools/list` | `vivino_get_cellar` er listet med alle parametere og beskrivelser. `per_page` har standard 10 i ratings. |

## Ferdig når
- [x] `npm test` er grønn, inkludert alle A-U* og C-U*
- [x] `npm run build` fullfører uten feil
- [x] Rapporten fra `npm run test:live` er grønn (L-2 til L-8) og ligger i PR- eller commit-beskrivelsen
- [ ] M-1 er bekreftet av brukeren
- [x] Ingen personlige data i committede fixtures (pris, sted og notater er syntetiske)
- [x] CLAUDE.md er oppdatert med det nye cellar-endepunktet under «Known Pitfalls»

## Funn fra live-sondering (2026-09-25, sesjon 2)

### Innlogging (G1)
- Årsaken til `is_signed_in: false` var formatet: `VIVINO_SESSION_COOKIE` i sky-miljøet inneholder bare verdien, uten `navn=`, og klienten sendte den rått i `Cookie`-headeren. Vivino ignorerer en navnløs cookie.
- **Fikset** i `src/client.ts` (`sessionCookieHeader()`): en verdi uten `=` sendes som `_ruby-web_session=<verdi>`. En full header sendes uendret. Med fiksen gir `/api/session` `is_signed_in: true`. Enhetstester er lagt til i `client.test.ts`.
- `/api/session` → `user_session.id` = `6702495`, som stemmer med `VIVINO_USER_ID` i miljøet. CLAUDE.md oppgir `15328411`. Dette må avklares med brukeren.

### L-1: størrelsesparameter i aktivitetsstrømmen
`/users/6702495/activities` ble kalt med `{}`, `limit=50`, `per_page=50`, `count=50` og alle tre samtidig. Alle svarene var byte-identiske (80 468 byte) og ga **10 aktiviteter**. Vivino ignorerer alle størrelsesparametere. **Konsekvens:** A implementeres som en løkke (A2), ikke som en parameterendring.

### Kjellerkilde (B2): tre kandidater evaluert
`/en/cellars` gir 302 til `/en/cellars/144153`. Løs `cellar_id` via denne videresendingen, ikke via bruker-ID-en. `__PRELOADED_STATE__` og `data-ssr-props` inneholder **ikke** kjellerdata. Siden er en **Inertia.js**-side (`component: "cellars/show"`).

| Kilde | Hvordan | Vurdering |
|---|---|---|
| **1. Inertia-JSON** (anbefalt primærkilde) | `GET /en/cellars/{id}?per_page=N&page=P` med `X-Inertia: true`, `X-Requested-With: XMLHttpRequest` og `X-Inertia-Version: <v>` gir `application/json`. Samme objekt ligger i `data-page`-attributtet i HTML-en. | Strukturert og komplett for vin og årgang. `per_page=50` ga alle 22 i ett kall. Feil eller manglende versjon gir **409** med `X-Inertia-Location` (også uten cookie). Hent derfor HTML én gang, les `version` og side 1 fra `data-page`, og bruk JSON for resten. Ved 409 hentes versjonen på nytt. |
| **2. CSV-eksport** (anbefalt supplement) | `GET /cellars/{id}/export` → `text/csv`, `attachment; filename="<seo_name>-cellar.csv"`. Samme kall som «Export»-knappen (`feature_flag cellar_export: true`). | Én rad **per flaske** (28), 16 kolonner. Har tre felt som JSON mangler: `Cellar Location`, `Tag` og `Purchase Location`. Mangler `wine_id`, drikkevindu, ratinger og region. Datoformatet er `DD-MM-YYYY`. Hele kjelleren kommer i ett kall uten paginering. |
| 3. HTML-kort (forkastet) | cheerio på `[data-testid=cellar-list] > li` | Fungerer (sum `quantity` = 28), men gir færre felt enn JSON. Klassenavnene har hash-suffiks, og `cellar_v2` vil sannsynligvis bryte parseren. Brukes ikke. |

**Paginering:** `?page=N` gir 20 per side som standard. Side 3 er tom (slutt-signal). `per_page=50` gir alt, men den øvre grensen er ikke testet. `page=2&per_page=50` gir 0, altså vanlig `page` × `per_page`. Svaret har `total_count` (22), så løkken kan stoppe presist.

#### Inertia-JSON: feltkart (`props.entries[]`)
| C1-felt | Sti | Merknad |
|---|---|---|
| `wine_id` | `vintage.wine.id` | |
| (vintage-ID) | `vintage.id` | Nøkkelen for kobling mot CSV-ens `Link to wine` = `https://www.vivino.com/wines/{vintage.id}` (28/28 treff) |
| `wine_name` | `vintage.wine.name` | Uten årgang og produsent. `vintage.name` er fullt navn med «U.V.»/«N.V.». |
| `winery_name` | `vintage.wine.winery.name` | **Mangler helt** for 1 av 22 (Hummingbirds Chardonnay). CSV-en har også tom `Winery` for den, så hullet ligger i Vivinos data og ikke i parsingen. Må være nullable, eller C1 må endres. |
| `vintage` | `vintage.year` | **NV = `0`** (4 av 22: «U.V.»/«N.V.»). `wine.non_vintage` er `true` for bare 1 av dem og er upålitelig. Regel: `year === 0` → `null`. |
| `quantity` | `user_vintage.cellar_count` | Sum 28 = `statistics.bottle_count`. `extras.count` og `extras.bottles.length` er like. |
| drikkevindu | `vintage.recommended_drinking_window` `{start_year, end_year, status}` | status 5 = Drink now, 4 = Drink or hold, 3 = Hold, 0/2 = ukjent (årene er `null`) |
| snittrating | `vintage.statistics.ratings_average` / `ratings_count` | |
| region, land | `vintage.wine.region.name`, `.country.code/.name` | |
| pris | `extras.bottles[].purchase_price` + `purchase_price_currency_code` | Per flaske. Fylt for 8 av 28. |
| innkjøpsdato | `extras.bottles[].purchase_date` (ISO) | Fylt for 24 av 28. Ikke det samme som `created_at` (lagt i kjeller). |
| innkjøpssted | finnes **ikke** i JSON | Bare i CSV (`Purchase Location`, 14 av 28) |
| egen rating | finnes ikke i noen av kildene | Alltid `null` uten `enrich` |
| ekstra per flaske | `bin`, `note`, `bottle_size_id` (1 = 0.75l, 3 = ?) | CSV har `Bin number` og `Cellar note`, samt `Bottle size` som tekst |
| ekstra, ikke i C1 | `wine.type_id`, `grapes[]`, `wine.style`, `wine_facts.alcohol` | Gratis og relevant for filtre (vintype), så `enrich` blir mindre nødvendig |

**Konsekvens for C2/D4:** Drikkevindu, region og snittrating kommer allerede med i grunnkallet. `enrich` trengs nesten ikke for kjelleren, og `excluded_unknown` gjelder i praksis bare ukjent drikkevindu (5 flasker) og manglende produsent.

#### `ready_to_drink` er løst av `props.statistics`
`bottle_count 28 = ready_to_drink 19 + wines_to_hold 3 + past_its_peak 1 + unknown_drinking_window 5`. Rekonstruert: status ∈ {4, 5} **og** `end_year ≥ inneværende år` gir 19 (Gran Reserva 2006, vindu til 2023, er `past_its_peak`). Status 0/2 er ukjent. Vivino har i tillegg et serverside-filter (`props.ready_to_drink`, `search`, `sort_by`, `wine_type_id`), men D3 er lokale filtre og beholdes.

#### Kontrolltall (grunnlag for L-5 og L-6 i stedet for HAR)
22 viner og 28 flasker, identisk i HTML, JSON og CSV. CSV-ens vintage-lenker gir 22 unike ID-er, og alle matcher `vintage.id`. `statistics.bottle_count` = sum(`cellar_count`) er en billig invariant i L-5.

### Anbefaling
Bruk Inertia-JSON som hovedkilde for `vivino_get_cellar`, og slå inn CSV-feltene `Tag`, `Cellar Location` og `Purchase Location` per vintage (aggregert fra flaskerader) når de trengs. Da er C1 komplett bortsett fra egen rating, og CSV-en fungerer i tillegg som en uavhengig kryssjekk i L-6. Om CSV skal hentes alltid eller bare med et flagg, må avgjøres (se «Åpent»).

## Beslutninger fra sesjon 2 (brukeren, 2026-09-25)
| # | Beslutning |
|---|---|
| H1 | Bruker-ID i CLAUDE.md rettes til `6702495`. |
| H2 | CSV-eksporten hentes **alltid** (+1 request). Hvis den feiler, gir det bare en `warning`, og kjelleren returneres likevel. |
| H3 | `winery_name` er nullable (C1 er endret). Det finnes ingen fallback-parsing, fordi `vintage.name` ikke har produsenten når den mangler. |
| H4 | `ready_to_drink` følger Vivinos definisjon (status 4/5 og vindu ikke passert). Med `enrich: true` fylles mer ut: viner uten drikkevindu («Drink at your pace») settes til `ready_to_drink: true` med `ready_to_drink_source: "inferred"`. |

**Avvik fra C2/C-U7, med begrunnelse:** `/api/vintages/{id}` ble sjekket live for de 5 vinene uten drikkevindu. Den gir det samme tomme vinduet og ingen felt som ikke allerede ligger i kjeller-JSON-en. `enrich` henter derfor **smaksprofilen** (`/wines/{id}/tastes`, ett kall per unike `wine_id`, bare for vinene på den returnerte siden) og legger til `abv`, `style` og `food_pairings` fra JSON-en uten ekstra kall.

## Implementert
- `src/client.ts`: `sessionCookieHeader()`, `withRetry(..., { retry429: false })`, `fetchCellarPage` (Inertia med bootstrap av versjon og `cellar_id` fra HTML, og ny henting ved 409), `fetchCellarExport`, `parseInertiaPage` og `VivinoFormatError` (C-U13).
- `src/paging.ts`: `rateLimitGuard()` er A3-regelen for et helt verktøykall og deles av ratings, kjeller og enrich.
- `src/tools/ratings.ts`: fyll-løkke (A2), lokal standard `per_page` = 10 (F1). Cursoren er den sist gjennomgåtte aktiviteten, eller den sist returnerte ratingen hvis siden ble fylt midt i en batch. Obsidian-sync er uendret.
- `src/tools/cellar.ts` + `vivino_get_cellar` i `src/index.ts`. Fixtures i `src/__tests__/fixtures/` er anonymisert: notater, priser, kjøpssteder og tags er syntetiske.
- `scripts/test-live.js` (`npm run test:live [L-n ...]`) skriver `live-report.md`, som er gitignored.

## Resultat av live-testene (2026-09-25)
| ID | Resultat |
|---|---|
| L-1 | Alle størrelsesparametere → 10 per kall |
| L-2 | ✅ 100 = 100 ratinger, 0 duplikater, identiske mengder. 17 requests (7) og 11 requests (100). Vivinos `/api/users/{id}` oppgir `ratings_count: 100`, så hele historikken er dekket. |
| L-3 | ✅ `min_rating: 4.8, per_page: 100`: 1 treff, 11 requests, 7,7 s (grense 60 s). Med 100 ratinger er verste fall en hel skanning på rundt 8 s. |
| L-4 | ✅ 10 ratinger, `has_more: true` |
| L-5 | ✅ 22 viner og 28 flasker = Vivinos `statistics`, 3 requests (HTML-bootstrap, JSON og CSV). Kjelleren får plass på én intern side, så paginering over flere sider er bare dekket offline (C-U4). |
| L-6 | ✅ Kjelleren mot CSV: 22 og 22 viner, 0 avvik i `quantity` |
| L-7 | ✅ 3 av 3 viner beriket, 5 requests, 3,5 s |
| L-8 | ✅ Søk, detaljer og anmeldelser svarer som før |
| M-2 | ✅ `tools/list` viser `vivino_get_cellar` med alle parametere og beskrivelser, og ratings har `per_page`-standard 10 |

## Åpent
- **M-1:** Brukeren sammenligner tallene i `live-report.md` (22 viner, 28 flasker og 5 tilfeldige viner) med Vivino-appen.
- **`rated_at` for gamle ratinger (eksisterende feil, utenfor omfang):** Vivino-titlene mangler årstall, og `parseVivinoDate` velger det nyeste året som ikke ligger i fremtiden. Den eldste aktiviteten (ID 25125908, som er mye eldre enn de nyeste) fikk derfor `2026-04-12`. `since`-filteret og Obsidian-datoene er upålitelige for ratinger som er mer enn ett år gamle.
- MCP-klientens faktiske tool-timeout er ukjent. L-3 bruker 60 s (MCP SDK-standard), som kan overstyres med `LIVE_TOOL_TIMEOUT_MS`.
