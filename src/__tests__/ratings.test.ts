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

  it('has_more is true whenever a cursor and at least one item come back, even if shorter than per_page', async () => {
    // Live testing (2026-09-22) showed Vivino's activities endpoint doesn't
    // reliably honor the requested per_page/limit — it can return a shorter
    // batch than asked for while more history still exists. Comparing raw
    // count to per_page produced a false has_more:false in that case, so a
    // present next_start_from cursor is now trusted on its own.
    const html = activityHtml([{ id: 1, rating: 4, wine: 'A', winery: 'W1' }]);
    mockFetchActivities.mockResolvedValue(html);
    const result = await getUserRatings({ page: 1, per_page: 25 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_start_from).toBe('act1');
  });

  it('has_more is false only on a genuinely empty page (true end of data)', async () => {
    mockFetchActivities.mockResolvedValue(activityHtml([]));
    const result = await getUserRatings({ page: 1, per_page: 25 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.has_more).toBe(false);
  });

  it('truncates to per_page when Vivino ignores the requested limit, without skipping items', async () => {
    // Live testing (2026-09-22) showed Vivino's activities endpoint can return
    // a fixed ~10-item batch regardless of the per_page/limit we ask for.
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, rating: 4, wine: `Wine ${i + 1}`, winery: `Winery ${i + 1}`,
    }));
    mockFetchActivities.mockResolvedValue(activityHtml(items));
    const result = await getUserRatings({ page: 1, per_page: 5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(5);
    expect(parsed.ratings).toHaveLength(5);
    expect(parsed.ratings[4].wine_name).toBe('Wine 5');
    expect(parsed.has_more).toBe(true);
    // Cursor must point at the LAST RETURNED item (#5), not the raw batch's
    // last item (#10) — otherwise the next call would skip activities 6-9.
    expect(parsed.next_start_from).toBe('act5');
    // The internal cursor field must never leak into the response.
    expect(parsed.ratings[0]).not.toHaveProperty('_activityId');
  });

  it('rejects an out-of-range vintage year instead of returning a bogus one', () => {
    const html = `$("#activities").append('
      <div id="user-activity-act1">
        <span class="icon-400-pct"></span>
        <div class="activity-wine-card">
          <a href="/en/wines/w/1">wine</a>
          <a>Ruggeri</a>
          <a>Angelino Prosecco</a>
          <a>Region</a>
          <a>Country</a>
        </div>
        <a title="Sat, Jan 15th at 10:00:00 UTC" href="/activities/1">1 hour ago</a>
        <span>2051 ratings</span>
      </div>');`;
    const { ratings } = parseActivitiesBody(html);
    expect(ratings).toHaveLength(1);
    expect(ratings[0].vintage).toBeNull();
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
