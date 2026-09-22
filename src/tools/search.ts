import { z } from 'zod';
import { fetchWineSearch } from '../client';
import { VivinoSearchResult } from '../types';

export const searchInputSchema = {
  query: z.string().min(1)
    .describe('Search term: wine name, winery, region, grape variety, or style'),
  country_codes: z.array(z.string()).optional()
    .describe('Filter by country codes e.g. ["fr", "it", "us", "au", "es"]'),
  grape_ids: z.array(z.number().int()).optional()
    .describe('Filter by Vivino grape IDs (numeric)'),
  min_rating: z.number().min(1).max(5).optional()
    .describe('Minimum average community rating (1.0–5.0)'),
  max_rating: z.number().min(1).max(5).optional()
    .describe('Maximum average community rating (1.0–5.0)'),
  wine_type_ids: z.array(z.number().int()).optional()
    .describe('Filter by wine type: 1=Red, 2=White, 3=Sparkling, 4=Rosé, 7=Dessert, 24=Fortified'),
  page: z.number().int().min(1).default(1)
    .describe('Page number (1-based)'),
  per_page: z.number().int().min(1).max(50).default(25)
    .describe('Results per page (max 50)'),
};

function parseSearchResults(raw: unknown): VivinoSearchResult[] {
  const d = raw as { explore_vintage?: { matches?: unknown[] } };
  const matches = d?.explore_vintage?.matches ?? [];
  return (matches as unknown[]).flatMap((item) => {
    const m = item as Record<string, unknown>;
    const vintage = m.vintage as Record<string, unknown> | undefined;
    const wine = vintage?.wine as Record<string, unknown> | undefined;
    const winery = wine?.winery as Record<string, unknown> | undefined;
    const region = wine?.region as Record<string, unknown> | undefined;
    const country = region?.country as Record<string, unknown> | undefined;
    const stats = vintage?.statistics as Record<string, unknown> | undefined;
    if (!wine || vintage?.id == null) return [];
    return [{
      // Deliberately the VINTAGE id, not wine.id: confirmed live that
      // /api/wines/{wine.id} 404s unconditionally on Vivino's side, while
      // /api/vintages/{vintage.id} (which vivino_get_wine_details/taste_profile/
      // reviews all key off) works. Using vintage.id here means results from
      // this tool plug straight into those without a wine_url round-trip.
      wine_id: Number(vintage.id),
      name: String(wine.name ?? ''),
      winery: String(winery?.name ?? ''),
      region: region ? String(region.name) : null,
      country: country ? String(country.name) : null,
      avg_rating: stats?.ratings_average != null ? Number(stats.ratings_average) : null,
      ratings_count: stats?.ratings_count != null ? Number(stats.ratings_count) : null,
      style_id: wine.style_id != null ? Number(wine.style_id) : null,
      // Same /{wine-seo}/w/{vintage-id} shape as the URLs getUserRatings
      // already parses IDs out of — the one URL format confirmed to work
      // with the vintage-page scrape fallback.
      vivino_url: wine.seo_name
        ? `https://www.vivino.com/${wine.seo_name}/w/${vintage.id}`
        : null,
    }];
  });
}

export async function searchWines(args: {
  query: string;
  country_codes?: string[];
  grape_ids?: number[];
  min_rating?: number;
  max_rating?: number;
  wine_type_ids?: number[];
  page: number;
  per_page: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const raw = await fetchWineSearch(args);
    const results = parseSearchResults(raw);
    // Vivino renamed this field from records_count to records_matched; read
    // whichever the live API returns (records_count kept as a fallback for
    // older cached responses / in case Vivino reverts).
    const explore = (raw as {
      explore_vintage?: { records_matched?: number; records_count?: number };
    })?.explore_vintage;
    const totalMatches = explore?.records_matched ?? explore?.records_count ?? null;
    const result = {
      query: args.query,
      page: args.page,
      per_page: args.per_page,
      total_matches: totalMatches,
      has_more: totalMatches !== null ? args.page * args.per_page < totalMatches : null,
      results,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error searching wines: ${message}` }] };
  }
}
