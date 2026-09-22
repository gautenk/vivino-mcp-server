import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchWineSearch } = vi.hoisted(() => ({
  mockFetchWineSearch: vi.fn(),
}));

vi.mock('../client', () => ({
  fetchWineSearch: mockFetchWineSearch,
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
      wine_id: 42,
      name: 'Test Barolo',
      winery: 'Test Winery',
      region: 'Piedmont',
      country: 'Italy',
      avg_rating: 4.3,
      vivino_url: 'https://www.vivino.com/wines/test-barolo',
    });
  });

  it('does not throw on a bare-query error response and reports it as text', async () => {
    mockFetchWineSearch.mockRejectedValue(new Error('Request failed with status code 400'));
    const result = await searchWines(baseArgs());
    expect(result.content[0].text).toContain('Error searching wines');
  });
});
