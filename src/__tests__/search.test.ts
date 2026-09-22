import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchWineSearch, mockResolveRegionFromQuery } = vi.hoisted(() => ({
  mockFetchWineSearch: vi.fn(),
  mockResolveRegionFromQuery: vi.fn(),
}));

vi.mock('../client', () => ({
  fetchWineSearch: mockFetchWineSearch,
  resolveRegionFromQuery: mockResolveRegionFromQuery,
}));

import { searchWines } from '../tools/search';

function baseArgs(overrides: Partial<Parameters<typeof searchWines>[0]> = {}) {
  return {
    query: 'barolo',
    page: 1,
    per_page: 25,
    ...overrides,
  };
}

describe('searchWines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: query text doesn't resolve to a region — matches the prior
    // (mock-unset) behavior for tests that don't care about this path.
    mockResolveRegionFromQuery.mockResolvedValue(null);
  });

  it('reads total_matches from records_matched (the current live field)', async () => {
    mockFetchWineSearch.mockResolvedValue({
      explore_vintage: { records_matched: 72926, matches: [] },
    });
    const result = await searchWines(baseArgs());
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_matches).toBe(72926);
  });

  it('falls back to records_count when records_matched is absent', async () => {
    mockFetchWineSearch.mockResolvedValue({
      explore_vintage: { records_count: 500, matches: [] },
    });
    const result = await searchWines(baseArgs());
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_matches).toBe(500);
  });

  it('has_more is true when more results exist beyond the current page', async () => {
    mockFetchWineSearch.mockResolvedValue({
      explore_vintage: { records_matched: 100, matches: [] },
    });
    const result = await searchWines(baseArgs({ page: 1, per_page: 25 }));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(true);
  });

  it('has_more is false on the last page', async () => {
    mockFetchWineSearch.mockResolvedValue({
      explore_vintage: { records_matched: 10, matches: [] },
    });
    const result = await searchWines(baseArgs({ page: 1, per_page: 25 }));
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(false);
  });

  it('parses wine matches into flat search results', async () => {
    mockFetchWineSearch.mockResolvedValue({
      explore_vintage: {
        records_matched: 1,
        matches: [{
          vintage: {
            id: 99001,
            wine: {
              id: 42,
              name: 'Test Barolo',
              seo_name: 'test-barolo',
              style_id: 1,
              winery: { name: 'Test Winery' },
              region: { name: 'Piedmont', country: { name: 'Italy' } },
            },
            statistics: { ratings_average: 4.3, ratings_count: 900 },
          },
        }],
      },
    });
    const result = await searchWines(baseArgs());
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({
      // wine_id stays wine.id (42) — it's what vivino_get_wine_taste_profile
      // and vivino_get_wine_reviews need. vintage_id (99001) is separate and
      // is what vivino_get_wine_details needs — confirmed live that the two
      // ID spaces are NOT interchangeable (/api/wines/{id} is dead outright,
      // and /api/vintages/{wine.id} can silently return an unrelated wine).
      wine_id: 42,
      vintage_id: 99001,
      name: 'Test Barolo',
      winery: 'Test Winery',
      region: 'Piedmont',
      country: 'Italy',
      avg_rating: 4.3,
      vivino_url: 'https://www.vivino.com/test-barolo/w/99001',
    });
  });

  it('sets vintage_id to null (not omitted) when a match has no vintage id', async () => {
    mockFetchWineSearch.mockResolvedValue({
      explore_vintage: {
        records_matched: 1,
        matches: [{
          vintage: {
            wine: { id: 42, name: 'No Vintage Id', seo_name: 'x', winery: {}, region: null },
            statistics: {},
          },
        }],
      },
    });
    const result = await searchWines(baseArgs());
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].vintage_id).toBeNull();
    expect(parsed.results[0].vivino_url).toBeNull();
  });

  it('does not throw on a bare-query error response and reports it as text', async () => {
    mockFetchWineSearch.mockRejectedValue(new Error('Request failed with status code 400'));
    const result = await searchWines(baseArgs());
    expect(result.content[0].text).toContain('Error searching wines');
  });

  it('resolves a region query and passes region_ids through to fetchWineSearch', async () => {
    // Confirmed live (2026-09-22): "Chianti" resolves to region id 683 via
    // /api/regions?name=chianti, and region_ids[]=683 returns real matches
    // (a bare q=Chianti is silently ignored by Vivino).
    mockResolveRegionFromQuery.mockResolvedValue({ id: 683, name: 'Chianti' });
    mockFetchWineSearch.mockResolvedValue({ explore_vintage: { records_matched: 53, matches: [] } });

    const result = await searchWines(baseArgs({ query: 'Chianti' }));
    const parsed = JSON.parse(result.content[0].text);

    expect(mockResolveRegionFromQuery).toHaveBeenCalledWith('Chianti');
    expect(mockFetchWineSearch).toHaveBeenCalledWith(
      expect.objectContaining({ region_ids: [683] })
    );
    expect(parsed.query_resolved).toBe(true);
    expect(parsed.resolved_region).toBe('Chianti');
    expect(parsed.warning).toBeUndefined();
  });

  it('warns when the query resolves to nothing and no other filter was given', async () => {
    mockResolveRegionFromQuery.mockResolvedValue(null);
    mockFetchWineSearch.mockResolvedValue({ explore_vintage: { records_matched: 999999, matches: [] } });

    const result = await searchWines(baseArgs({ query: 'Sassicaia' }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.query_resolved).toBe(false);
    expect(parsed.resolved_region).toBeNull();
    expect(parsed.warning).toMatch(/did not resolve/);
  });

  it('does not warn when the query does not resolve but another filter was given', async () => {
    mockResolveRegionFromQuery.mockResolvedValue(null);
    mockFetchWineSearch.mockResolvedValue({ explore_vintage: { records_matched: 100, matches: [] } });

    const result = await searchWines(baseArgs({ query: 'Sassicaia', country_codes: ['it'] }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.warning).toBeUndefined();
  });

  it('does not let a lookup failure block the search — falls through unresolved', async () => {
    mockResolveRegionFromQuery.mockRejectedValue(new Error('network error'));
    mockFetchWineSearch.mockResolvedValue({ explore_vintage: { records_matched: 5, matches: [] } });

    const result = await searchWines(baseArgs());
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.query_resolved).toBe(false);
    expect(mockFetchWineSearch).toHaveBeenCalledWith(
      expect.objectContaining({ region_ids: undefined })
    );
  });
});
