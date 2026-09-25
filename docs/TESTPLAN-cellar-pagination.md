# Testplan: cellar-liste og ekte `per_page`

Status: vedtatt (grill-sesjon 2026-09-25). Ingen implementering er startet.

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
| C1 | **Påkrevd:** `wine_id`, `wine_name`, `winery_name`, `vintage` (null = NV), `quantity`. **Nullable:** drikkevindu, egen rating, snittrating, pris, innkjøpsdato, innkjøpssted. |
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
| G1 | Sky-miljøet har `www.vivino.com` i allowlisten og `VIVINO_*` som miljøvariabler (bekreftet: `/api/session` svarer 200). |

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
- [ ] `npm test` er grønn, inkludert alle A-U* og C-U*
- [ ] `npm run build` fullfører uten feil
- [ ] Rapporten fra `npm run test:live` er grønn (L-2 til L-8) og ligger i PR- eller commit-beskrivelsen
- [ ] M-1 er bekreftet av brukeren
- [ ] Ingen personlige data i committede fixtures (pris, sted og notater er syntetiske)
- [ ] CLAUDE.md er oppdatert med det nye cellar-endepunktet under «Known Pitfalls»

## Åpent
- **Kjellerkilde (funn 2026-09-25):** Brukerens cURL-eksport inneholdt ingen XHR for kjellerdata. Siden `https://www.vivino.com/en/cellars/{cellar_id}` ser ut til å server-rendre dataene (sporingspixelen skraper «Total bottles», «Drink now», drikkevindu og «Added <dato>»). Siden bruker `window.__PRELOADED_STATE__`. `cellar_id` (144153) er **ikke** bruker-ID-en; `/cellars` videresender til riktig ID. Parseren bygges derfor sannsynligvis på HTML eller preloaded state, ikke på en JSON-API. Må bekreftes med en innlogget henting.
- `VIVINO_SESSION_COOKIE` i sky-miljøet gir `is_signed_in: false` fra `/api/session` (utløpt eller feil format). Dette blokkerer L-1 til L-8 og kildeanalysen over.
- MCP-klientens tool-timeout er ukjent. L-3 rapporterer målt tid, og brukeren vurderer den.
