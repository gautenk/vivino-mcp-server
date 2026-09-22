# Vivino MCP Server

MCP server exposing Vivino wine data to Claude Code. Solo repo, push to main.

## Obsidian Context (read before working)

**Wine preferences & taste profile:** `~/Documents/Obsidian Vault/Claude/Memory/wine-preferences.md`

**Synced wine notes:** `~/Documents/Obsidian Vault/Knowledge/Wine/` (400+ notes)

## Known Pitfalls

- **Cookie name:** `_ruby-web_session` IS the correct Vivino session cookie (not a Rails default — don't "fix" it)
- **User ID:** `15328411`
- **No official API.** All endpoints are reverse-engineered from vivino.com. They break without notice.
- **Rate limits are load-bearing.** 700ms between requests, 60s on 429, 2s on 5xx. Don't reduce.
- **Vintage endpoint** uses a different URL pattern than the wine endpoint — check `src/client.ts` before assuming.
- **Obsidian sync state** lives at `Knowledge/Wine/.sync-state.json` in the vault (and `.manifest.json` alongside it, used to detect re-rated wines). Delete both to force a full re-sync.

## Build & Test

- `npm run build` → compiles to `dist/`
- `npm test` → Vitest
- Local test: `node dist/index.js` (stdio transport)
- Env: `.env` with `VIVINO_SESSION_COOKIE`, `VIVINO_USER_ID`, `OBSIDIAN_VAULT_PATH`, optional `EXA_API_KEY`
