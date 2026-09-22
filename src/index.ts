import * as dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ratingsInputSchema, getUserRatings } from './tools/ratings';
import { wineDetailsInputSchema, tasteProfileInputSchema, getWineDetails, getWineTasteProfile } from './tools/wines';
import { reviewsInputSchema, getWineReviews } from './tools/reviews';
import { searchInputSchema, searchWines } from './tools/search';
import { syncInputSchema, syncToObsidian } from './tools/obsidian';

const server = new McpServer({
  name: 'vivino-mcp-server',
  version: '1.0.0',
});

server.registerTool(
  'vivino_get_user_ratings',
  {
    title: 'Get My Vivino Ratings',
    description:
      "Fetch the user's personal wine ratings from Vivino. Returns wine IDs, names, wineries, " +
      'user ratings (1.0–5.0), personal tasting notes, and rated_at dates. Paginated by cursor — ' +
      'check has_more and, if true, call again with start_from set to the previous response\'s ' +
      'next_start_from (the page param is cosmetic and not sent to Vivino). ' +
      'Filter with min_rating/max_rating, since (only ratings newer than a date), or ' +
      'wine_name_query ("have I rated this wine?" — matches within the page(s) fetched; ' +
      'paginate with start_from if not found and has_more is true). ' +
      'Wine IDs (and wine_url) returned here can be used with vivino_get_wine_taste_profile and ' +
      'vivino_get_wine_reviews directly. For vivino_get_wine_details, this wine_id/wine_url pair ' +
      'only supports a slower page-scrape lookup (no vintage_id is available from ratings data) — ' +
      'still pass wine_url so that scrape can happen; omitting it risks getting back the wrong wine.',
    inputSchema: ratingsInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  getUserRatings
);

server.registerTool(
  'vivino_get_wine_details',
  {
    title: 'Get Wine Details',
    description:
      'Get comprehensive information about a specific wine by its Vivino ID. ' +
      'Returns grape varieties, region, country of origin, ABV, average community rating, ' +
      'total ratings count, food pairing suggestions, and style description. ' +
      'Requires a wine_id obtainable from vivino_get_user_ratings or vivino_search_wines. ' +
      'Vivino details live on a separate "vintage" ID, not the wine ID — when calling this after ' +
      'vivino_search_wines, always also pass that result\'s vintage_id field for a direct, ' +
      'reliable lookup. When calling this after vivino_get_user_ratings (no vintage_id available), ' +
      'always pass wine_url instead so the server can scrape the real vintage ID from that page. ' +
      'Skipping both can silently return details for the WRONG wine rather than an error.',
    inputSchema: wineDetailsInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  getWineDetails
);

server.registerTool(
  'vivino_get_wine_taste_profile',
  {
    title: 'Get Wine Taste Profile',
    description:
      'Get the structured sensory profile for a wine: acidity, sweetness, tannin, ' +
      'intensity, and fizziness scores (0–1 scale, where 1 = maximum), plus categorized ' +
      'flavor groups such as black_fruit, oak, earthy, floral, etc. with specific keywords. ' +
      'Requires a wine_id from vivino_get_user_ratings or vivino_search_wines.',
    inputSchema: tasteProfileInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  getWineTasteProfile
);

server.registerTool(
  'vivino_get_wine_reviews',
  {
    title: 'Get Wine Reviews',
    description:
      'Get community and critic tasting notes for a specific wine. ' +
      'Returns reviewer name, numeric rating, review text, date, and language. ' +
      'Paginated. Requires a wine_id from vivino_get_user_ratings or vivino_search_wines.',
    inputSchema: reviewsInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  getWineReviews
);

server.registerTool(
  'vivino_search_wines',
  {
    title: 'Search Wines',
    description:
      "Search Vivino's wine catalog by name, winery, region, or grape variety. " +
      'Supports filters: country codes (e.g. "fr", "it"), wine type ' +
      '(1=Red, 2=White, 3=Sparkling, 4=Rosé, 7=Dessert, 24=Fortified), and rating range. ' +
      'Returns wine IDs usable with other vivino_* tools. ' +
      'Use this to discover wines or find Vivino IDs for wines you know.',
    inputSchema: searchInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  searchWines
);

server.registerTool(
  'vivino_sync_to_obsidian',
  {
    title: 'Sync Wine Ratings to Obsidian',
    description:
      'Export Vivino wine ratings to Obsidian as individual markdown notes. ' +
      'By default runs incrementally — only fetches ratings newer than the last sync. ' +
      'Set full_sync=true for a complete re-fetch. ' +
      'Each note includes wine details, rating and notes, taste profile, and food pairings. ' +
      'Also writes Index.md sorted by rating and updates .sync-state.json. ' +
      'Requires OBSIDIAN_VAULT_PATH environment variable to be set. ' +
      'Use max_wines=3 for a test run before syncing everything.',
    inputSchema: syncInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  syncToObsidian
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Vivino MCP server running on stdio\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
