import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { mockFetchCellarPage, mockFetchCellarExport, mockFetchWineTastes } = vi.hoisted(() => ({
  mockFetchCellarPage: vi.fn(),
  mockFetchCellarExport: vi.fn(),
  mockFetchWineTastes: vi.fn(),
}));

vi.mock('../client', () => ({
  fetchCellarPage: mockFetchCellarPage,
  fetchCellarExport: mockFetchCellarExport,
  fetchWineTastes: mockFetchWineTastes,
}));

import { getCellar, parseCellarEntry, parseCsv, cellarInputSchema, CellarArgs } from '../tools/cellar';
import { CellarWine } from '../types';

// Anonymized from a live fetch on 2026-09-25 (E2): structure, IDs and names
// are real; notes, prices, purchase locations and tags are synthetic.
const fixtureDir = path.join(__dirname, 'fixtures');
const page = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'cellar-page.json'), 'utf8'));
const exportCsv = fs.readFileSync(path.join(fixtureDir, 'cellar-export.csv'), 'utf8');
const entries: unknown[] = page.props.entries;
const props = page.props;

// Fixture day: fixes "current year" for the drinking-window verdicts.
const YEAR = 2026;

const http429 = { response: { status: 429, headers: {} } };

function servePages(all: unknown[], size = 50, fail: Record<number, unknown> = {}) {
  let call = 0;
  mockFetchCellarPage.mockImplementation(async (p: number) => {
    call++;
    if (fail[call]) throw fail[call];
    return { ...props, total_count: all.length, entries: all.slice((p - 1) * size, p * size) };
  });
}

async function run(args: Partial<CellarArgs> = {}) {
  const res = await getCellar({ page: 1, enrich: false, ...args });
  const text = res.content[0].text;
  if (text.startsWith('Error')) throw new Error(text);
  return JSON.parse(text) as {
    count: number; total_matching: number; bottles_matching: number; has_more: boolean;
    excluded_unknown: number; warning?: string; wines: CellarWine[];
    vivino_statistics: Record<string, number>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
  servePages(entries);
  mockFetchCellarExport.mockResolvedValue(exportCsv);
  mockFetchWineTastes.mockResolvedValue({ tastes: { structure: { acidity: 3 }, flavor: [] } });
});

describe('parseCellarEntry', () => {
  const wines = entries.map(e => parseCellarEntry(e, YEAR));

  it('C-U1: every wine has the required fields with the right types', () => {
    expect(wines).toHaveLength(22);
    for (const w of wines) {
      expect(Number.isInteger(w.wine_id) && w.wine_id > 0).toBe(true);
      expect(Number.isInteger(w.vintage_id) && w.vintage_id > 0).toBe(true);
      expect(typeof w.wine_name).toBe('string');
      expect(w.wine_name.length).toBeGreaterThan(0);
      expect(Number.isInteger(w.quantity) && w.quantity > 0).toBe(true);
      expect(w.vintage === null || Number.isInteger(w.vintage)).toBe(true);
    }
    expect(wines.reduce((s, w) => s + w.quantity, 0)).toBe(props.statistics.bottle_count);
  });

  it('C-U2: NV wines (year 0 from Vivino) get vintage null, not 0', () => {
    const nv = wines.filter(w => w.vintage === null).map(w => w.wine_name);
    expect(nv).toHaveLength(4);
    expect(nv).toContain('Prosecco');
    expect(wines.some(w => w.vintage === 0)).toBe(false);
  });

  it('C-U3: missing nullable fields come back as null, never undefined or absent', () => {
    const noWinery = wines.find(w => w.wine_name === 'Hummingbirds Chardonnay')!;
    expect(noWinery).toHaveProperty('winery_name', null);
    const bare = parseCellarEntry({ vintage: { id: 1, wine: { id: 2, name: 'X' } } }, YEAR);
    for (const key of ['winery_name', 'vintage', 'wine_type', 'country', 'country_code', 'region',
      'avg_rating', 'ratings_count', 'user_rating', 'ready_to_drink', 'added_at', 'purchase_price',
      'purchase_price_currency', 'purchase_date'] as const) {
      expect(bare).toHaveProperty(key, null);
    }
    expect(bare.drinking_window).toEqual({ start_year: null, end_year: null, status: 'unknown' });
  });

  it('reproduces Vivino\'s own drinking-window statistics exactly', () => {
    const bottles = (pred: (w: CellarWine) => boolean) =>
      wines.filter(pred).reduce((s, w) => s + w.quantity, 0);
    const s = props.statistics;
    expect(bottles(w => w.ready_to_drink === true)).toBe(s.ready_to_drink_count);
    expect(bottles(w => w.drinking_window.status === 'hold')).toBe(s.wines_to_hold_count);
    expect(bottles(w => w.drinking_window.status === 'past_peak')).toBe(s.past_its_peak_count);
    expect(bottles(w => w.drinking_window.status === 'unknown')).toBe(s.unknown_drinking_window_count);
  });

  it('keeps per-bottle details and summarizes price and purchase date', () => {
    const w = wines.find(w => w.bottles.some(b => b.purchase_price !== null))!;
    expect(w.purchase_price).toEqual(expect.any(Number));
    expect(w.purchase_price_currency).toBe('NOK');
    expect(wines.some(w => w.bottles.some(b => b.size === '0.375l'))).toBe(true);
  });
});

describe('parseCsv', () => {
  it('handles quoted fields with commas and doubled quotes', () => {
    const rows = parseCsv('A,B\r\n"x, y","say ""hi"""\r\n');
    expect(rows).toEqual([{ A: 'x, y', B: 'say "hi"' }]);
  });

  it('reads the export fixture as one row per bottle', () => {
    expect(parseCsv(exportCsv)).toHaveLength(props.statistics.bottle_count);
  });
});

describe('getCellar', () => {
  it('C-U4: default call walks all pages, no duplicates, right number of calls', async () => {
    servePages(entries, 10); // 22 wines over 3 pages
    const r = await run();
    expect(r.count).toBe(22);
    expect(new Set(r.wines.map(w => w.vintage_id)).size).toBe(22);
    expect(mockFetchCellarPage).toHaveBeenCalledTimes(3);
    expect(r.has_more).toBe(false);
  });

  it('asks for 50 per page and tells the client not to wait on 429', async () => {
    await run();
    expect(mockFetchCellarPage).toHaveBeenCalledWith(1, 50, { retry429: false });
    expect(mockFetchCellarPage).toHaveBeenCalledTimes(1);
  });

  it('C-U5: per_page 5, page 2 gives wines 6–10 and correct has_more', async () => {
    const all = (await run()).wines;
    const r = await run({ per_page: 5, page: 2 });
    expect(r.wines.map(w => w.vintage_id)).toEqual(all.slice(5, 10).map(w => w.vintage_id));
    expect(r.has_more).toBe(true);
    const last = await run({ per_page: 5, page: 5 });
    expect(last.count).toBe(2);
    expect(last.has_more).toBe(false);
  });

  it('merges tags, cellar and purchase locations from the CSV export', async () => {
    const r = await run();
    expect(mockFetchCellarExport).toHaveBeenCalledWith(props.cellar_id, { retry429: false });
    const w = r.wines.find(w => w.wine_name === 'Hummingbirds Chardonnay')!;
    expect(w.tags).toEqual(['Gift', 'Tag A']);
    expect(w.cellar_locations).toEqual(['My cellar']);
    expect(r.wines.some(w => w.purchase_locations.length > 0)).toBe(true);
  });

  it('a failing CSV export only warns; the cellar still comes back', async () => {
    mockFetchCellarExport.mockRejectedValue(new Error('boom'));
    const r = await run();
    expect(r.count).toBe(22);
    expect(r.warning).toMatch(/CSV export.*boom/);
  });

  it('C-U6: enrich false makes no taste profile calls', async () => {
    const r = await run();
    expect(mockFetchWineTastes).not.toHaveBeenCalled();
    expect(r.wines[0]).not.toHaveProperty('taste_profile');
  });

  it('C-U7: enrich true makes one call per unique wine and fills the extra fields', async () => {
    const r = await run({ enrich: true });
    const unique = new Set(r.wines.map(w => w.wine_id)).size;
    expect(mockFetchWineTastes).toHaveBeenCalledTimes(unique);
    for (const w of r.wines) {
      expect(w.taste_profile?.structure.acidity).toBeCloseTo(0.6);
      expect(w).toHaveProperty('abv');
      expect(Array.isArray(w.food_pairings)).toBe(true);
    }
    expect(r.wines.some(w => w.style)).toBe(true);
  });

  it('C-U7: enrich only looks up the wines on the returned page', async () => {
    await run({ enrich: true, per_page: 3 });
    expect(mockFetchWineTastes).toHaveBeenCalledTimes(3);
  });

  describe('C-U8: each filter in isolation', () => {
    it('wine_name_query matches wine name and winery, case-insensitively', async () => {
      const byName = await run({ wine_name_query: 'riesling' });
      expect(byName.wines.every(w => /riesling/i.test(w.wine_name + w.winery_name))).toBe(true);
      expect(byName.count).toBeGreaterThan(0);
      const byWinery = await run({ wine_name_query: 'WITTMANN' });
      expect(byWinery.wines.map(w => w.winery_name)).toEqual(['Wittmann']);
    });

    it('vintage_min / vintage_max', async () => {
      const r = await run({ vintage_min: 2020, vintage_max: 2023 });
      expect(r.count).toBeGreaterThan(0);
      expect(r.wines.every(w => w.vintage! >= 2020 && w.vintage! <= 2023)).toBe(true);
      expect(r.excluded_unknown).toBe(4); // the NV wines
      expect(r.warning).toMatch(/NV/);
    });

    it('country by name or code', async () => {
      const byCode = await run({ country: 'IT' });
      const byName = await run({ country: 'italy' });
      expect(byCode.count).toBeGreaterThan(0);
      expect(byName.wines).toEqual(byCode.wines);
      expect(byCode.wines.every(w => w.country_code === 'it')).toBe(true);
    });

    it('region substring', async () => {
      const r = await run({ region: 'rheinhessen' });
      expect(r.wines.map(w => w.region)).toEqual(['Rheinhessen', 'Rheinhessen']);
      expect(r.excluded_unknown).toBe(1); // Blueberry Dry (fruit wine) has no region
    });

    it('min_quantity', async () => {
      const r = await run({ min_quantity: 2 });
      expect(r.count).toBeGreaterThan(0);
      expect(r.wines.every(w => w.quantity >= 2)).toBe(true);
      expect(r.excluded_unknown).toBe(0);
    });

    it('ready_to_drink true and false', async () => {
      const ready = await run({ ready_to_drink: true });
      expect(ready.bottles_matching).toBe(props.statistics.ready_to_drink_count);
      const notReady = await run({ ready_to_drink: false });
      expect(notReady.wines.map(w => w.drinking_window.status).sort())
        .toEqual(['hold', 'past_peak']);
    });
  });

  it('C-U9: ready_to_drink without enrich excludes unknown windows and suggests enrich', async () => {
    const r = await run({ ready_to_drink: true });
    expect(r.excluded_unknown).toBe(5);
    expect(r.warning).toMatch(/enrich: true/);
  });

  it('enrich fills ready_to_drink for "Drink at your pace" wines, marked inferred', async () => {
    const r = await run({ ready_to_drink: true, enrich: true });
    expect(r.excluded_unknown).toBe(0);
    const inferred = r.wines.filter(w => w.ready_to_drink_source === 'inferred');
    expect(inferred).toHaveLength(5);
    expect(inferred.every(w => w.drinking_window.status === 'unknown')).toBe(true);
  });

  it('C-U10: region filter with a null region counts it as unknown', async () => {
    const withNull = [...entries, { vintage: { id: 999, year: 2020, wine: { id: 998, name: 'No Region' } } }];
    servePages(withNull);
    const r = await run({ region: 'rheinhessen' });
    expect(r.count).toBe(2);
    expect(r.excluded_unknown).toBe(2); // the synthetic wine + Blueberry Dry
    expect(r.warning).toMatch(/region/);
    expect(r.warning).not.toMatch(/enrich/);
  });

  it('C-U11: combined filters are ANDed and each wine is counted unknown at most once', async () => {
    const r = await run({ vintage_min: 2000, ready_to_drink: true, country: 'fr' });
    expect(r.wines.every(w => w.country_code === 'fr' && w.vintage! >= 2000 && w.ready_to_drink)).toBe(true);
    expect(r.wines.map(w => w.wine_name).sort()).toEqual(['Gloire de Chablis', 'Réserve Sauternes']);
    // The two French NV sparklings are unknown on BOTH vintage and window but
    // count once each; Blueberry Dry has no country. Nothing else is unknown.
    expect(r.excluded_unknown).toBe(3);
  });

  it('C-U12: two 429s during paging return a partial result with a warning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    servePages(entries, 10, { 2: http429, 3: http429 });
    const pending = run();
    await vi.advanceTimersByTimeAsync(60_000);
    const r = await pending;
    expect(r.count).toBe(10);
    expect(r.has_more).toBe(true);
    expect(r.warning).toMatch(/429/);
    expect(mockFetchCellarExport).not.toHaveBeenCalled();
  });

  it('C-U13: a format error from the client surfaces as an error, not an empty cellar', async () => {
    mockFetchCellarPage.mockRejectedValue(new Error('Vivino cellar JSON response did not have the expected shape'));
    const res = await getCellar({ page: 1, enrich: false });
    expect(res.content[0].text).toMatch(/^Error fetching cellar: .*expected shape/);
  });

  it('reports Vivino\'s own totals for the unfiltered cellar', async () => {
    const r = await run({ min_quantity: 3 });
    expect(r.vivino_statistics.bottles).toBe(28);
    expect(r.vivino_statistics.wines).toBe(22);
  });

  it('schema: enrich defaults to false and page to 1; per_page is optional', () => {
    expect(cellarInputSchema.enrich.parse(undefined)).toBe(false);
    expect(cellarInputSchema.page.parse(undefined)).toBe(1);
    expect(cellarInputSchema.per_page.parse(undefined)).toBeUndefined();
  });
});
