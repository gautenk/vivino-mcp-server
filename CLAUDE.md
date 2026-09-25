# Vivino MCP Server

MCP server exposing Vivino wine data to Claude Code. Solo repo, push to main.

## Obsidian Context (read before working)

**Wine preferences & taste profile:** `~/Documents/Obsidian Vault/Claude/Memory/wine-preferences.md`

**Synced wine notes:** `~/Documents/Obsidian Vault/Knowledge/Wine/` (400+ notes)

## Known Pitfalls

- **Cookie name:** `_ruby-web_session` IS the correct Vivino session cookie (not a Rails default — don't "fix" it). A bare cookie value in `VIVINO_SESSION_COOKIE` is sent as `_ruby-web_session=<value>`; sent without a name Vivino ignores it (`is_signed_in: false`).
- **User ID:** `6702495` (confirmed via `/api/session`, 2026-09-25)
- **No official API.** All endpoints are reverse-engineered from vivino.com. They break without notice.
- **Rate limits are load-bearing.** 700ms between requests, 60s on 429, 2s on 5xx. Don't reduce.
- **Activities ignore page size.** `/users/{id}/activities` always returns 10 items whatever `limit`/`per_page`/`count` say. `vivino_get_user_ratings` loops batches until `per_page` is filled.
- **Cellar endpoint:** no JSON API. `/en/cellars` redirects to `/en/cellars/{cellar_id}` (not the user ID). That page is Inertia.js: the data is the `data-page` attribute, or JSON when requested with `X-Inertia: true` + `X-Inertia-Version` (stale/missing version → 409, re-read it from the HTML). Takes `page` and `per_page`. NV wines have `year: 0`. `GET /cellars/{id}/export` gives a CSV (one row per bottle) with tag, cellar location and purchase location that the JSON lacks. `__PRELOADED_STATE__` has no cellar data. Feature flag `cellar_v2` will probably change all of this.
- **Vintage endpoint** uses a different URL pattern than the wine endpoint — check `src/client.ts` before assuming.
- **Obsidian sync state** lives at `Knowledge/Wine/.sync-state.json` in the vault (and `.manifest.json` alongside it, used to detect re-rated wines). Delete both to force a full re-sync.

## Build & Test

- `npm run build` → compiles to `dist/`
- `npm test` → Vitest (offline)
- `npm run test:live` → live checks against vivino.com (L-1..L-8 in `docs/TESTPLAN-cellar-pagination.md`), writes gitignored `live-report.md`. Run by hand before pushing; never part of `npm test`.
- Local test: `node dist/index.js` (stdio transport)
- Env: `.env` with `VIVINO_SESSION_COOKIE`, `VIVINO_USER_ID`, `OBSIDIAN_VAULT_PATH`, optional `EXA_API_KEY`
