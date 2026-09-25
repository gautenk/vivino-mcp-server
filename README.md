# 🍇 Vivino MCP Server

**Your years of wine ratings, finally readable by your AI. Ask it what to drink.**

![MCP](https://img.shields.io/badge/protocol-MCP-6E56CF?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node 20+](https://img.shields.io/badge/Node-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)

An MCP (Model Context Protocol) server that brings your Vivino wine ratings into Claude and other AI applications. Access personal wine data, search the Vivino catalog, read structured taste profiles, and sync your ratings to Obsidian, all from a chat.

## Features

- **Get Personal Ratings** — Fetch your Vivino wine ratings with filtering, pagination, and date range support
- **Cellar** — List the bottles in your Vivino cellar with quantity, drinking window, purchase details, tags and locations
- **Wine Details** — Retrieve comprehensive information about wines (grapes, region, ABV, food pairings, community ratings)
- **Taste Profiles** — Get structured sensory analysis (acidity, sweetness, tannin, intensity, fizziness) and flavor keywords
- **Wine Reviews** — Access community and critic tasting notes
- **Search Wines** — Search the Vivino catalog by name, winery, region, or grape variety
- **Obsidian Sync** — Export your ratings as markdown notes with automatic enrichment (details + taste profile + food pairings)

## Prerequisites

- Node.js 20+ and npm
- A Vivino account (vivino.com)
- Optionally: Obsidian vault for syncing ratings
- Optionally: Exa API key for web-based wine enrichment

## Installation

```bash
git clone https://github.com/gautenk/vivino-mcp-server.git
cd vivino-mcp-server
npm install
npm run build
```

## Setup

### 1. Get Your Vivino Session Cookie

1. Open [vivino.com](https://vivino.com) in your browser and log in
2. Open Chrome DevTools (F12 / Cmd+Option+I)
3. Go to **Application** → **Cookies** → **vivino.com**
4. Find the cookie(s) — copy their name and value (e.g., `_session_id=abc123`)
5. Save to `.env` as: `VIVINO_SESSION_COOKIE=_ruby-web_session=abc123` (a bare value without `name=` is also accepted and sent as `_ruby-web_session`)

### 2. Get Your Vivino User ID (Optional)

If you skip this, the server will scrape your username to resolve your user ID (slower).

1. On vivino.com, go to **DevTools** → **Network** tab
2. Refresh the page
3. Look for any XHR request to `/api/users/{number}/...`
4. Copy that number and save to `.env` as: `VIVINO_USER_ID=<your_number>`

### 3. Set Vivino Username

Add your Vivino username to `.env`:

```bash
VIVINO_USERNAME=your_username
```

### 4. Optional: Obsidian Sync Path

If you want to use the Obsidian sync feature, set:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/Obsidian Vault/Knowledge/Wine
```

### 5. Create `.env` File

Copy `.env.example` and fill in your values:

```bash
cp .env.example .env
# Edit .env with your credentials
```

## Usage

### With Claude Code

Register the server with the `claude mcp add` CLI command:

```bash
claude mcp add vivino-mcp -- node /path/to/vivino-mcp-server/dist/index.js
```

Or add it directly to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "vivino-mcp": {
      "command": "node",
      "args": ["/path/to/vivino-mcp-server/dist/index.js"]
    }
  }
}
```

The tools are then available to Claude Code automatically — no separate launch step needed.

### Standalone with MCP Client

```bash
npm run dev
# or
npm run start
```

The server listens on stdio and outputs to stderr.

## API Reference

### vivino_get_user_ratings

Fetch your personal wine ratings.

**Parameters:**
- `per_page` (number, default: 10, max: 100) — Ratings to return. The server keeps fetching Vivino batches until this many match the filters, the history ends, or Vivino rate-limits twice (then `warning` is set)
- `start_from` (string) — Cursor: the previous response's `next_start_from`
- `min_rating` (number, 1.0–5.0) — Filter: minimum rating
- `max_rating` (number, 1.0–5.0) — Filter: maximum rating
- `since` (string, ISO 8601) — Filter: ratings newer than this date
- `wine_name_query` (string) — Filter: wine or winery name contains this text

**Example:**
```
get my wine ratings since 2025-01-01 with min_rating 4.0
```

### vivino_get_cellar

List the wines in your cellar (My Wines → Cellar).

**Parameters:**
- `per_page` / `page` (number, optional) — Page through the result; omit for the whole cellar
- `enrich` (boolean, default: false) — Add taste profile (one request per wine), ABV, style and food pairings; fill `ready_to_drink` for wines without a drinking window
- Filters: `wine_name_query`, `vintage_min`, `vintage_max`, `country` (name or code), `region`, `min_quantity`, `ready_to_drink`

Filters are strict: a wine whose filtered field is unknown (e.g. NV for `vintage_min`) is left out and counted in `excluded_unknown`.

**Returns:** per wine `wine_id`, `vintage_id`, name, winery, vintage (null = NV), quantity, type, country, region, grapes, average rating, drinking window and `ready_to_drink` (Vivino's own verdict), purchase price/date, tags, cellar and purchase locations, and per-bottle bin, note, size, purchase date and price. Also Vivino's own cellar totals.

### vivino_get_wine_details

Get comprehensive info about a specific wine.

**Parameters:**
- `wine_id` (number, required) — Vivino wine ID

**Returns:**
- Grape varieties, region, country, ABV, style description
- Community average rating and total ratings count
- Food pairing suggestions
- Vivino URL

### vivino_get_wine_taste_profile

Get structured sensory profile for a wine.

**Parameters:**
- `wine_id` (number, required) — Vivino wine ID

**Returns:**
- Structure metrics (acidity, sweetness, tannin, intensity, fizziness) on 0–1 scale
- Flavor groups with primary keywords (e.g., black fruit, oak, earthy, floral)

### vivino_get_wine_reviews

Get community and critic tasting notes.

**Parameters:**
- `wine_id` (number, required) — Vivino wine ID
- `page` (number, default: 1)
- `per_page` (number, default: 10, max: 50)

### vivino_search_wines

Search the Vivino catalog.

**Parameters:**
- `query` (string, required) — Wine name, winery, region, or grape
- `country_codes` (string array) — Filter: country codes (e.g., "fr", "it", "us")
- `wine_type_ids` (number array) — Filter: 1=Red, 2=White, 3=Sparkling, 4=Rosé, 7=Dessert, 24=Fortified
- `min_rating` / `max_rating` (number, 1.0–5.0) — Filter by community rating

### vivino_sync_to_obsidian

Export your ratings to Obsidian.

**Parameters:**
- `full_sync` (boolean, default: false) — Fetch all ratings from scratch (incremental by default)
- `overwrite_existing` (boolean, default: false) — Overwrite existing note files
- `max_wines` (number, 1–500) — Limit processing (useful for testing)

**Requirements:**
- `OBSIDIAN_VAULT_PATH` environment variable must be set

**Output:**
- Individual `.md` files per wine with rating, tasting notes, details, and taste profile
- `Index.md` with all ratings sorted by world region and country
- `.sync-state.json` for incremental sync tracking

## Testing

```bash
npm test           # Run tests once (offline)
npm run test:watch # Watch mode
npm run test:live  # Live checks against vivino.com; writes live-report.md. Run by hand before pushing
```

## Troubleshooting

### Invalid Session Cookie

**Error:** `CSRF token validation failed` or `Invalid session`

**Fix:** Your session cookie has expired. Repeat the setup steps above to get a fresh cookie.

### Rate Limiting

**Error:** `429 Too Many Requests`

**Cause:** Making requests too quickly. The server automatically implements rate limiting (700ms between requests) and exponential backoff.

**Fix:** Wait a few minutes and try again. If persistent, check that you're not running multiple instances.

### Obsidian Path Not Found

**Error:** `OBSIDIAN_VAULT_PATH is not set` or path does not exist

**Fix:** Set `OBSIDIAN_VAULT_PATH` in `.env` to the full path to your Obsidian vault's Wine knowledge base folder.

### Username Required

**Error:** `Vivino username not provided`

**Fix:** Set `VIVINO_USERNAME` in `.env` with your Vivino username.

## License

MIT — See [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome. Please open an issue or pull request.
