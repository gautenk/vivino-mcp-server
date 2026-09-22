import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveUserId, mockFetchActivities } = vi.hoisted(() => ({
  mockResolveUserId: vi.fn().mockResolvedValue(12345),
  mockFetchActivities: vi.fn(),
}));

vi.mock('../client', () => ({
  resolveUserId: mockResolveUserId,
  fetchActivities: mockFetchActivities,
}));

import { getUserRatings, parseActivitiesBody } from '../tools/ratings';

function activityHtml(items: { id: number; rating: number; wine: string; winery: string }[]): string {
  const html = items.map(i => `
    <div id="user-activity-act${i.id}">
      <span class="icon-${Math.round(i.rating * 100)}-pct"></span>
      <div class="activity-wine-card">
        <a href="/en/wines/w/${i.id}">wine</a>
        <a>${i.winery}</a>
        <a>${i.wine}</a>
        <a>Region</a>
        <a>Country</a>
      </div>
      <a title="Sat, Jan 15th at 10:00:00 UTC" href="/activities/1">1 hour ago</a>
    </div>`).join('\n');
  const escaped = html.replace(/'/g, "\\'").replace(/\n/g, '\\n');
  return `$("#activities").append('${escaped}');`;
}

describe('parseActivitiesBody', () => {
  it('reports rawItemCount separately from filtered ratings count', () => {
    // One item has a 0 rating (a cellar addition, not a review) and gets dropped
    // by the ratings filter, but should still count toward rawItemCount.
    const html = activityHtml([
      { id: 1, rating: 4, wine: 'A', winery: 'W1' },
      { id: 2, rating: 0, wine: 'B', winery: 'W2' },
      { id: 3, rating: 3.5, wine: 'C', winery: 'W3' },
    ]);
    const { ratings, rawItemCount } = parseActivitiesBody(html);
    expect(rawItemCount).toBe(3);
    expect(ratings).toHaveLength(2); // the 0-rating item is excluded
  });
});

describe('getUserRatings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveUserId.mockResolvedValue(12345);
  });

  it('has_more is false when the raw page is shorter than per_page (true end of data)', async () => {
    const html = activityHtml([{ id: 1, rating: 4, wine: 'A', winery: 'W1' }]);
    mockFetchActivities.mockResolvedValue(html);
    const result = await getUserRatings({ page: 1, per_page: 25 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(false);
  });

  it('has_more is true when a filtered result set is small but the raw page was full', async () => {
    // 25 raw activities (== per_page) but only 1 survives the min_rating filter —
    // the old bug reported has_more:false here because it checked filtered count.
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      rating: i === 0 ? 5 : 2, // only the first passes min_rating: 4.5 below
      wine: `Wine ${i}`,
      winery: `Winery ${i}`,
    }));
    mockFetchActivities.mockResolvedValue(activityHtml(items));
    const result = await getUserRatings({ page: 1, per_page: 25, min_rating: 4.5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.has_more).toBe(true);
  });

  it('wine_name_query filters by wine or winery name, case-insensitively', async () => {
    const items = [
      { id: 1, rating: 4, wine: 'Barolo Riserva', winery: 'Ceretto' },
      { id: 2, rating: 4, wine: 'Chianti', winery: 'Antinori' },
    ];
    mockFetchActivities.mockResolvedValue(activityHtml(items));
    const result = await getUserRatings({ page: 1, per_page: 25, wine_name_query: 'barolo' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.ratings[0].wine_name).toBe('Barolo Riserva');
  });
});
