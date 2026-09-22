import { z } from 'zod';
import { fetchWineSearch, resolveRegionFromQuery } from '../client';
import { VivinoSearchResult } from '../types';

export const searchInputSchema = {
  query: z.string().min(1)
    .describe(
      'Search term. Works well for a wine REGION or appellation (e.g. "Chianti", "Barolo", ' +
      '"Napa Valley", "Rioja") — Vivino resolves these to a region filter, confirmed live. Does ' +
      'NOT work as a general full-text search for a specific wine or winery name (e.g. ' +
      '"Sassicaia", "Opus One") — Vivino has no server-side text search for those; when the query ' +
      'doesn\'t resolve to a region, results fall back to broad/unfiltered top-rated wines and the ' +
      'response says so explicitly (query_resolved: false). Prefer country_codes/grape_ids/' +
      'wine_type_ids/rating filters below for anything not a region name.'
    ),
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
    if (!wine || wine.id == null) return [];
    // Vivino runs two separate, non-interchangeable ID spaces that different
    // endpoints key off, confirmed live (2026-09-22) — using the wrong one
    // against the wrong endpoint doesn't error, it silently returns a
    // completely unrelated wine:
    //   - wine.id      -> /api/wines/{id}/tastes and /api/wines/{id}/reviews
    //   - vintage.id   -> /api/vintages/{id} (the actual detail data)
    // Both are exposed here so each downstream tool can use the right one.
    return [{
      wine_id: Number(wine.id),
      vintage_id: vintage?.id != null ? Number(vintage.id) : null,
      name: String(wine.name ?? ''),
      winery: String(winery?.name ?? ''),
      region: region ? String(region.name) : null,
      country: country ? String(country.name) : null,
      avg_rating: stats?.ratings_average != null ? Number(stats.ratings_average) : null,
      ratings_count: stats?.ratings_count != null ? Number(stats.ratings_count) : null,
      style_id: wine.style_id != null ? Number(wine.style_id) : null,
      // /{wine-seo}/w/{vintage-id} — the same URL shape getUserRatings parses
      // IDs out of, and what vivino_get_wine_details' scrape fallback expects.
      vivino_url: wine.seo_name && vintage?.id != null
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
    // Resolve free text to a region filter (the only text lookup confirmed to
    // work server-side) before searching — see resolveRegionFromQuery/
    // fetchWineSearch in client.ts for why this is necessary at all.
    let resolvedRegion: { id: number; name: string } | null = null;
    try {
      resolvedRegion = await resolveRegionFromQuery(args.query);
    } catch {
      // Lookup failure shouldn't block the search — fall through with no
      // region resolved, same as a genuine no-match.
    }

    const raw = await fetchWineSearch({
      ...args,
      region_ids: resolvedRegion ? [resolvedRegion.id] : undefined,
    });
    const results = parseSearchResults(raw);
    // Vivino renamed this field from records_count to records_matched; read
    // whichever the live API returns (records_count kept as a fallback for
    // older cached responses / in case Vivino reverts).
    const explore = (raw as {
      explore_vintage?: { records_matched?: number; records_count?: number };
    })?.explore_vintage;
    const totalMatches = explore?.records_matched ?? explore?.records_count ?? null;
    const hasOtherFilter =
      !!args.country_codes?.length || !!args.grape_ids?.length ||
      args.min_rating != null || args.max_rating != null || !!args.wine_type_ids?.length;
    const result = {
      query: args.query,
      query_resolved: resolvedRegion !== null,
      resolved_region: resolvedRegion?.name ?? null,
      ...(resolvedRegion === null && !hasOtherFilter ? {
        warning: 'query did not resolve to a known region, and no other filter was given — ' +
          'results below are Vivino\'s broad top-rated list, NOT filtered by your search text. ' +
          'Try a region/appellation name, or use country_codes/grape_ids/wine_type_ids/rating filters instead.',
      } : {}),
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
