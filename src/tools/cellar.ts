import { z } from 'zod';
import { fetchCellarPage, fetchCellarExport, fetchWineTastes, CellarPageProps } from '../client';
import { CellarBottle, CellarWine, DrinkingWindowStatus } from '../types';
import { MAX_PER_PAGE } from '../constants';
import { rateLimitGuard, RATE_LIMITED, RATE_LIMIT_WARNING } from '../paging';
import { parseTasteProfile } from './wines';

// Page size for the internal fetch loop. Confirmed live that the cellar page
// honors per_page (50 returned a whole 22-wine cellar in one call); the upper
// bound is untested, so stay at a size that is known to work.
const CELLAR_FETCH_PAGE_SIZE = 50;

export const cellarInputSchema = {
  per_page: z.number().int().min(1).max(MAX_PER_PAGE).optional()
    .describe('Wines per page, counted after filters. Omit to get the whole cellar in one response.'),
  page: z.number().int().min(1).default(1)
    .describe('Page number (1-based). Only used together with per_page.'),
  enrich: z.boolean().default(false)
    .describe(
      'Also fetch each returned wine\'s taste profile (one extra request per unique wine) and add ' +
      'abv, style and food_pairings. Also fills ready_to_drink (as "inferred") for wines Vivino ' +
      'shows as "Drink at your pace" (no drinking window), which otherwise count as unknown.'
    ),
  wine_name_query: z.string().optional()
    .describe('Filter: wine name or winery contains this text (case-insensitive).'),
  vintage_min: z.number().int().optional()
    .describe('Filter: vintage year at or after this. NV wines count as unknown and are excluded.'),
  vintage_max: z.number().int().optional()
    .describe('Filter: vintage year at or before this. NV wines count as unknown and are excluded.'),
  country: z.string().optional()
    .describe('Filter: country name or 2-letter code (e.g. "Italy" or "it"), case-insensitive.'),
  region: z.string().optional()
    .describe('Filter: region name contains this text (case-insensitive), e.g. "Piemonte".'),
  min_quantity: z.number().int().min(1).optional()
    .describe('Filter: only wines with at least this many bottles.'),
  ready_to_drink: z.boolean().optional()
    .describe(
      'Filter on Vivino\'s own verdict: true = ready now (drink now / drink or hold, window not ' +
      'passed), false = hold or past its peak. Wines without a drinking window are excluded as ' +
      'unknown unless enrich is true.'
    ),
};

export type CellarArgs = {
  per_page?: number;
  page: number;
  enrich: boolean;
  wine_name_query?: string;
  vintage_min?: number;
  vintage_max?: number;
  country?: string;
  region?: string;
  min_quantity?: number;
  ready_to_drink?: boolean;
};

// Same IDs as vivino_search_wines documents.
const WINE_TYPES: Record<number, string> = {
  1: 'Red', 2: 'White', 3: 'Sparkling', 4: 'Rosé', 7: 'Dessert', 24: 'Fortified',
};

// bottle_size_id → label, matched against the CSV export's "Bottle size" column.
const BOTTLE_SIZES: Record<number, string> = { 1: '0.75l', 3: '0.375l' };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? v as Obj : {});
const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

// recommended_drinking_window.status, mapped against the page's own labels
// (confirmed live): 5 "Drink now", 4 "Drink or hold", 3 "Hold"; 0 and 2 come
// with null years and render as "Drink at your pace".
// Vivino's "ready to drink" count is status 4/5 whose window has not ended —
// this reproduced its statistics exactly (19 ready, 3 hold, 1 past peak, 5 unknown).
export function drinkingWindow(raw: unknown, currentYear: number): {
  window: CellarWine['drinking_window'];
  ready: boolean | null;
} {
  const w = obj(raw);
  const start = num(w.start_year);
  const end = num(w.end_year);
  const code = num(w.status);
  let status: DrinkingWindowStatus = 'unknown';
  let ready: boolean | null = null;
  if (code === 3) {
    status = 'hold';
    ready = false;
  } else if (code === 4 || code === 5) {
    if (end !== null && end < currentYear) {
      status = 'past_peak';
      ready = false;
    } else {
      status = code === 5 ? 'drink_now' : 'drink_or_hold';
      ready = true;
    }
  }
  return { window: { start_year: start, end_year: end, status }, ready };
}

export function parseCellarEntry(entry: unknown, currentYear: number): CellarWine {
  const e = obj(entry);
  const vintage = obj(e.vintage);
  const wine = obj(vintage.wine);
  const region = obj(wine.region);
  const country = obj(region.country);
  const stats = obj(vintage.statistics);
  const extras = obj(e.extras);
  const rawBottles = Array.isArray(extras.bottles) ? extras.bottles.map(obj) : [];

  const bottles: CellarBottle[] = rawBottles.map(b => ({
    size: BOTTLE_SIZES[num(b.bottle_size_id) ?? -1] ?? null,
    bin: str(b.bin),
    note: str(b.note),
    purchase_date: str(b.purchase_date),
    purchase_price: num(b.purchase_price),
    purchase_price_currency: str(b.purchase_price_currency_code),
  }));

  const priced = bottles.filter(b => b.purchase_price !== null);
  const currencies = new Set(priced.map(b => b.purchase_price_currency));
  const oneCurrency = priced.length > 0 && currencies.size === 1;
  const dates = bottles.map(b => b.purchase_date).filter((d): d is string => d !== null).sort();

  // NV wines come back as year 0 (confirmed live); wine.non_vintage is only
  // set on some of them, so it can't be relied on.
  const year = num(vintage.year);
  const { window, ready } = drinkingWindow(vintage.recommended_drinking_window, currentYear);
  const vintageId = Number(vintage.id);

  return {
    wine_id: Number(wine.id),
    vintage_id: vintageId,
    wine_name: String(wine.name ?? vintage.name ?? ''),
    winery_name: str(obj(wine.winery).name),
    vintage: year !== null && year > 0 ? year : null,
    quantity: num(obj(e.user_vintage).cellar_count) ?? rawBottles.length,
    wine_type: WINE_TYPES[num(wine.type_id) ?? -1] ?? null,
    country: str(country.name),
    country_code: str(country.code),
    region: str(region.name),
    grapes: (Array.isArray(vintage.grapes) ? vintage.grapes : [])
      .map(g => str(obj(g).name)).filter((g): g is string => g !== null),
    avg_rating: num(stats.ratings_average) || null,
    ratings_count: num(stats.ratings_count),
    user_rating: null,
    drinking_window: window,
    ready_to_drink: ready,
    ready_to_drink_source: ready === null ? null : 'vivino',
    added_at: str(e.created_at),
    purchase_price: oneCurrency
      ? Math.round(priced.reduce((sum, b) => sum + b.purchase_price!, 0) / priced.length * 100) / 100
      : null,
    purchase_price_currency: oneCurrency ? [...currencies][0] : null,
    purchase_date: dates.length ? dates[dates.length - 1] : null,
    purchase_locations: [],
    cellar_locations: [],
    tags: [],
    bottles,
    // The link form Vivino's own CSV export uses.
    vivino_url: `https://www.vivino.com/wines/${vintageId}`,
  };
}

// RFC 4180-style: quoted fields, doubled quotes, CRLF or LF.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.some(f => f !== ''));
  if (!header) return [];
  return body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// The CSV has one row per bottle; its "Link to wine" ends in the vintage ID.
// Merge the three columns the page JSON lacks, per wine, as distinct values.
export function mergeExport(wines: CellarWine[], rows: Record<string, string>[]): void {
  const byVintage = new Map(wines.map(w => [w.vintage_id, w]));
  const addUnique = (list: string[], value: string) => {
    if (value && !list.includes(value)) list.push(value);
  };
  for (const row of rows) {
    const id = Number(row['Link to wine']?.match(/\/wines\/(\d+)/)?.[1]);
    const wine = byVintage.get(id);
    if (!wine) continue;
    addUnique(wine.purchase_locations, row['Purchase Location'] ?? '');
    addUnique(wine.cellar_locations, row['Cellar Location'] ?? '');
    for (const tag of (row['Tag'] ?? '').split(',')) addUnique(wine.tags, tag.trim());
  }
}

type FilterOutcome = 'match' | 'no_match' | 'unknown';

// D4: a wine that fails a known filter is simply dropped; one that passes
// every known filter but has null in a filtered field is dropped AND counted
// as unknown (once, whatever the number of unknown fields).
function applyFilter(w: CellarWine, a: CellarArgs, unknownFields: Set<string>): FilterOutcome {
  const unknown: string[] = [];
  const check = (field: string, value: unknown, test: () => boolean): boolean => {
    if (value === null) { unknown.push(field); return true; }
    return test();
  };

  if (a.wine_name_query) {
    const needle = a.wine_name_query.toLowerCase();
    const hay = `${w.wine_name} ${w.winery_name ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return 'no_match';
  }
  if (a.vintage_min !== undefined && !check('vintage', w.vintage, () => w.vintage! >= a.vintage_min!)) return 'no_match';
  if (a.vintage_max !== undefined && !check('vintage', w.vintage, () => w.vintage! <= a.vintage_max!)) return 'no_match';
  if (a.country) {
    const c = a.country.toLowerCase();
    const known = w.country ?? w.country_code;
    if (!check('country', known, () => w.country?.toLowerCase() === c || w.country_code?.toLowerCase() === c)) {
      return 'no_match';
    }
  }
  if (a.region && !check('region', w.region, () => w.region!.toLowerCase().includes(a.region!.toLowerCase()))) {
    return 'no_match';
  }
  if (a.min_quantity !== undefined && w.quantity < a.min_quantity) return 'no_match';
  if (a.ready_to_drink !== undefined
      && !check('ready_to_drink', w.ready_to_drink, () => w.ready_to_drink === a.ready_to_drink)) {
    return 'no_match';
  }
  if (unknown.length) {
    unknown.forEach(f => unknownFields.add(f));
    return 'unknown';
  }
  return 'match';
}

function unknownWarning(count: number, fields: Set<string>, enrich: boolean): string {
  let msg = `${count} wine(s) were left out because a filtered field is unknown ` +
    `(${[...fields].join(', ')}).`;
  if (fields.has('vintage')) msg += ' NV wines have no vintage.';
  if (fields.has('ready_to_drink') && !enrich) {
    msg += ' Call again with enrich: true to fill ready_to_drink for wines without a drinking window.';
  }
  return msg;
}

type Content = { content: Array<{ type: 'text'; text: string }> };

export async function getCellar(args: CellarArgs): Promise<Content> {
  try {
    const guarded = rateLimitGuard();
    const warnings: string[] = [];
    let partial = false;

    // Whole cellar first (D2), so filters and per_page/page work on the full set.
    const entries: unknown[] = [];
    let first: CellarPageProps | null = null;
    for (let page = 1; ; page++) {
      const props = await guarded(() =>
        fetchCellarPage(page, CELLAR_FETCH_PAGE_SIZE, { retry429: false })
      );
      if (props === RATE_LIMITED) {
        partial = true;
        warnings.push(RATE_LIMIT_WARNING);
        break;
      }
      first ??= props;
      entries.push(...props.entries);
      if (props.entries.length === 0 || entries.length >= props.total_count) break;
    }
    if (!first) {
      return { content: [{ type: 'text', text: `Error fetching cellar: ${RATE_LIMIT_WARNING}` }] };
    }

    const currentYear = new Date().getFullYear();
    const wines = entries.map(e => parseCellarEntry(e, currentYear));

    if (!partial) {
      try {
        const csv = await guarded(() => fetchCellarExport(first!.cellar_id, { retry429: false }));
        if (csv === RATE_LIMITED) {
          partial = true;
          warnings.push(RATE_LIMIT_WARNING);
        } else {
          mergeExport(wines, parseCsv(csv));
        }
      } catch (err) {
        warnings.push(
          'Could not read the cellar CSV export, so tags, cellar_locations and purchase_locations are ' +
          `empty: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (args.enrich) {
      for (const w of wines) {
        if (w.ready_to_drink === null && w.drinking_window.status === 'unknown') {
          w.ready_to_drink = true;
          w.ready_to_drink_source = 'inferred';
        }
      }
    }

    const unknownFields = new Set<string>();
    let excludedUnknown = 0;
    const matching = wines.filter(w => {
      const outcome = applyFilter(w, args, unknownFields);
      if (outcome === 'unknown') excludedUnknown++;
      return outcome === 'match';
    });
    if (excludedUnknown) warnings.push(unknownWarning(excludedUnknown, unknownFields, args.enrich));

    const start = args.per_page ? (args.page - 1) * args.per_page : 0;
    const pageWines = args.per_page ? matching.slice(start, start + args.per_page) : matching;
    const hasMore = partial || (args.per_page !== undefined && start + pageWines.length < matching.length);

    if (args.enrich) await enrichWines(pageWines, entries, guarded, warnings);

    const stats = obj(first.statistics);
    const result = {
      cellar_id: first.cellar_id,
      page: args.per_page ? args.page : 1,
      per_page: args.per_page ?? null,
      count: pageWines.length,
      total_matching: matching.length,
      bottles_matching: matching.reduce((sum, w) => sum + w.quantity, 0),
      has_more: hasMore,
      excluded_unknown: excludedUnknown,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      // Vivino's own totals for the whole, unfiltered cellar.
      vivino_statistics: {
        wines: first.total_count,
        bottles: num(stats.bottle_count),
        ready_to_drink: num(stats.ready_to_drink_count),
        to_hold: num(stats.wines_to_hold_count),
        past_peak: num(stats.past_its_peak_count),
        unknown_drinking_window: num(stats.unknown_drinking_window_count),
        cellar_value: num(stats.average_price_sum),
        currency: str(stats.currency_code),
      },
      wines: pageWines,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error fetching cellar: ${message}` }] };
  }
}

// abv, style and food pairings are already in the page JSON; only the taste
// profile costs a request (one per unique wine_id, cached by the client).
async function enrichWines(
  wines: CellarWine[],
  entries: unknown[],
  guarded: ReturnType<typeof rateLimitGuard>,
  warnings: string[],
): Promise<void> {
  const rawByVintage = new Map(entries.map(e => [Number(obj(obj(e).vintage).id), obj(obj(e).vintage)]));
  const tastes = new Map<number, CellarWine['taste_profile']>();
  let stopped = false;
  for (const w of wines) {
    const wine = obj(rawByVintage.get(w.vintage_id)?.wine);
    w.abv = num(wine.alcohol) || null;
    w.style = str(obj(wine.style).name);
    w.food_pairings = (Array.isArray(wine.foods) ? wine.foods : [])
      .map(f => str(obj(f).name)).filter((f): f is string => f !== null);

    if (!tastes.has(w.wine_id) && !stopped) {
      try {
        const raw = await guarded(() => fetchWineTastes(w.wine_id, { retry429: false }));
        if (raw === RATE_LIMITED) {
          stopped = true;
          warnings.push('Vivino rate-limited the taste profile lookups; some taste_profile values are null.');
        } else {
          tastes.set(w.wine_id, parseTasteProfile(raw));
        }
      } catch {
        tastes.set(w.wine_id, null);
      }
    }
    w.taste_profile = tastes.get(w.wine_id) ?? null;
  }
}
