import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveUserId, mockFetchActivities } = vi.hoisted(() => ({
  mockResolveUserId: vi.fn().mockResolvedValue(12345),
  mockFetchActivities: vi.fn(),
}));

vi.mock('../client', () => ({
  resolveUserId: mockResolveUserId,
  fetchActivities: mockFetchActivities,
}));

import { getUserRatings, parseActivitiesBody, ratingsInputSchema } from '../tools/ratings';

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

type Item = { id: number; rating: number; wine: string; winery: string };

function makeItems(n: number, rating = (i: number) => 4): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, rating: rating(i), wine: `Wine ${i + 1}`, winery: `Winery ${i + 1}`,
  }));
}

// Serves `items` the way Vivino does: 10 per call regardless of the requested
// limit, starting right after start_from. `fail` maps a 1-based call number to
// an error thrown instead of answering.
function serveHistory(items: Item[], fail: Record<number, unknown> = {}) {
  let call = 0;
  mockFetchActivities.mockImplementation(async (_limit: number, startFrom?: string) => {
    call++;
    if (fail[call]) throw fail[call];
    const start = startFrom ? items.findIndex(i => `act${i.id}` === startFrom) + 1 : 0;
    return activityHtml(items.slice(start, start + 10));
  });
}

const http429 = { response: { status: 429, headers: {} } };

async function run(args: Partial<Parameters<typeof getUserRatings>[0]> = {}) {
  const result = await getUserRatings({ page: 1, per_page: 10, ...args });
  return JSON.parse(result.content[0].text);
}

describe('getUserRatings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockResolveUserId.mockResolvedValue(12345);
  });

  it('A-U1: fills per_page across batches and points the cursor at the last returned rating', async () => {
    serveHistory(makeItems(50));
    const parsed = await run({ per_page: 25 });
    expect(parsed.count).toBe(25);
    expect(mockFetchActivities).toHaveBeenCalledTimes(3);
    expect(parsed.next_start_from).toBe('act25');
    expect(parsed.has_more).toBe(true);
    expect(parsed.ratings[0]).not.toHaveProperty('_activityId');
  });

  it('A-U2: stops at the end of history without extra calls after the empty batch', async () => {
    serveHistory(makeItems(12));
    const parsed = await run({ per_page: 25 });
    expect(parsed.count).toBe(12);
    expect(parsed.has_more).toBe(false);
    expect(mockFetchActivities).toHaveBeenCalledTimes(3); // 10 + 2 + empty
  });

  it('A-U3: keeps going through a batch of only cellar events (rating 0), which do not count', async () => {
    const items = makeItems(30, i => (i >= 10 && i < 20 ? 0 : 4));
    serveHistory(items);
    const parsed = await run({ per_page: 15 });
    expect(parsed.count).toBe(15);
    expect(parsed.ratings.map((r: { wine_name: string }) => r.wine_name)).toContain('Wine 25');
    expect(parsed.ratings.every((r: { user_rating: number }) => r.user_rating > 0)).toBe(true);
  });

  it('A-U4: a selective min_rating keeps fetching with no batch cap', async () => {
    // 3 matches spread over 12 batches.
    const items = makeItems(120, i => ([5, 64, 117].includes(i) ? 4.8 : 3));
    serveHistory(items);
    const parsed = await run({ per_page: 10, min_rating: 4.5 });
    expect(parsed.count).toBe(3);
    expect(parsed.has_more).toBe(false);
    expect(mockFetchActivities).toHaveBeenCalledTimes(13);
  });

  it('A-U5: two calls chained by next_start_from give the first 14, no overlap, no gap', async () => {
    const items = makeItems(40);
    serveHistory(items);
    const first = await run({ per_page: 7 });
    const second = await run({ per_page: 7, start_from: first.next_start_from });
    const names = [...first.ratings, ...second.ratings].map((r: { wine_name: string }) => r.wine_name);
    expect(names).toEqual(items.slice(0, 14).map(i => i.wine));
  });

  it('A-U6: one 429 waits 60 s once, then completes without duplicates', async () => {
    vi.useFakeTimers();
    serveHistory(makeItems(50), { 3: http429 });
    const pending = run({ per_page: 25 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(mockFetchActivities).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    const parsed = await pending;
    expect(parsed.count).toBe(25);
    expect(new Set(parsed.ratings.map((r: { wine_name: string }) => r.wine_name)).size).toBe(25);
    expect(parsed.warning).toBeUndefined();
    expect(mockFetchActivities).toHaveBeenCalledTimes(4);
  });

  it('A-U7: a second 429 returns batches 1–2 as a partial result with a warning', async () => {
    vi.useFakeTimers();
    serveHistory(makeItems(50), { 3: http429, 4: http429 });
    const pending = run({ per_page: 25 });
    await vi.advanceTimersByTimeAsync(60_000);
    const parsed = await pending;
    expect(parsed.count).toBe(20);
    expect(parsed.has_more).toBe(true);
    expect(parsed.warning).toMatch(/429/);
    expect(parsed.next_start_from).toBe('act20');
  });

  it('A-U7b: resuming from a partial result continues where it stopped', async () => {
    vi.useFakeTimers();
    const items = makeItems(50);
    serveHistory(items, { 3: http429, 4: http429 });
    const pending = run({ per_page: 25 });
    await vi.advanceTimersByTimeAsync(60_000);
    const partial = await pending;
    vi.useRealTimers();
    serveHistory(items);
    const rest = await run({ per_page: 5, start_from: partial.next_start_from });
    expect(rest.ratings[0].wine_name).toBe('Wine 21');
  });

  it('A-U8: per_page defaults to 10 in the schema', () => {
    expect(ratingsInputSchema.per_page.parse(undefined)).toBe(10);
  });

  it('asks the client not to wait on 429 itself (the loop owns the budget)', async () => {
    serveHistory(makeItems(5));
    await run();
    expect(mockFetchActivities.mock.calls[0][2]).toEqual({ retry429: false });
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

  it('wine_name_query filters by wine or winery name, case-insensitively', async () => {
    serveHistory([
      { id: 1, rating: 4, wine: 'Barolo Riserva', winery: 'Ceretto' },
      { id: 2, rating: 4, wine: 'Chianti', winery: 'Antinori' },
    ]);
    const parsed = await run({ per_page: 25, wine_name_query: 'barolo' });
    expect(parsed.count).toBe(1);
    expect(parsed.ratings[0].wine_name).toBe('Barolo Riserva');
  });
});
