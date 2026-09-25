import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  VIVINO_BASE_URL,
  VIVINO_API_BASE,
  USER_AGENT,
  MIN_REQUEST_INTERVAL_MS,
  RETRY_AFTER_429_MS,
  RETRY_AFTER_5XX_MS,
  CACHE_TTL_WINE_DETAILS_MS,
  CACHE_TTL_TASTE_MS,
  DEFAULT_USERNAME,
} from './constants';

// ---- In-memory cache ----
interface CacheEntry<T> { data: T; expiresAt: number; }
const cache = new Map<string, CacheEntry<unknown>>();

async function getCached<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<T> {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data as T;
  const data = await fetcher();
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

// ---- Rate limiter ----
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

// ---- Headers ----
function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `${VIVINO_BASE_URL}/en/users/${DEFAULT_USERNAME}`,
    'Origin': VIVINO_BASE_URL,
    ...extra,
  };
  const cookie = sessionCookieHeader();
  if (cookie) h['Cookie'] = cookie;
  return h;
}

// VIVINO_SESSION_COOKIE may hold a full Cookie header ("name=value; ...") or just the bare
// session value copied from DevTools. A bare value sent as-is is ignored by Vivino
// (/api/session answers is_signed_in: false), so name it with the session cookie.
export function sessionCookieHeader(): string | undefined {
  const raw = process.env.VIVINO_SESSION_COOKIE?.trim();
  if (!raw) return undefined;
  return raw.includes('=') ? raw : `_ruby-web_session=${raw}`;
}

function xhrHeaders(csrf: string, extra: Record<string, string> = {}): Record<string, string> {
  return baseHeaders({
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRF-Token': csrf,
    'Accept': 'text/javascript, application/javascript',
    ...extra,
  });
}

// ---- Retry ----
// retry429: false hands a 429 straight back to the caller. The paging loops
// (ratings, cellar) use it so they can own the "one 60 s wait per tool call,
// then return partial" policy themselves — see rateLimitGuard in paging.ts.
export interface RetryOptions { retry429?: boolean }

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  await throttle();
  try {
    return await fn();
  } catch (err) {
    const e = err as AxiosError;
    if (e.response?.status === 429 && opts.retry429 !== false) {
      const wait = Number(e.response.headers['retry-after'] ?? 0) * 1000 || RETRY_AFTER_429_MS;
      await new Promise(r => setTimeout(r, wait));
      await throttle();
      return fn();
    }
    if (e.response && e.response.status >= 500) {
      await new Promise(r => setTimeout(r, RETRY_AFTER_5XX_MS));
      await throttle();
      return fn();
    }
    throw err;
  }
}

// ---- Session / user ID ----
let resolvedUserId: number | null = null;

export async function resolveUserId(): Promise<number> {
  if (resolvedUserId !== null) return resolvedUserId;

  const envId = process.env.VIVINO_USER_ID;
  if (envId && !isNaN(Number(envId)) && Number(envId) > 0) {
    resolvedUserId = Number(envId);
    return resolvedUserId;
  }

  if (!process.env.VIVINO_SESSION_COOKIE) {
    throw new Error(
      'Vivino requires authentication. Set VIVINO_SESSION_COOKIE in the MCP server env.\n\n' +
      'How to get it:\n' +
      '1. Log into vivino.com in Chrome\n' +
      '2. Open DevTools (⌘+Option+I) → Application tab → Cookies → https://www.vivino.com\n' +
      '3. Copy the "_vivino_production_session" value\n' +
      '4. Set VIVINO_SESSION_COOKIE=<that value> in Claude Desktop config env block\n' +
      '5. Also set VIVINO_USER_ID=<your_user_id> to skip auto-resolution'
    );
  }

  const res = await withRetry(() =>
    axios.get(`${VIVINO_API_BASE}/session`, { headers: baseHeaders({ Accept: 'application/json' }), timeout: 10_000 })
  );
  const id = (res.data?.user_session as Record<string, unknown> | undefined)?.id;
  if (id && Number(id) > 0) {
    resolvedUserId = Number(id);
    return resolvedUserId;
  }
  throw new Error('Could not resolve Vivino user ID from /api/session. Check VIVINO_SESSION_COOKIE.');
}

// ---- CSRF token ----
let cachedCsrf: string | null = null;

export async function fetchCsrfToken(): Promise<string> {
  if (cachedCsrf) return cachedCsrf;

  const res = await withRetry(() =>
    axios.get(`${VIVINO_BASE_URL}/en/users/${DEFAULT_USERNAME}`, {
      headers: baseHeaders(),
      timeout: 15_000,
    })
  );
  const html: string = res.data;
  const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
  if (!match) {
    // Vivino serves a 200 with its normal chrome (including a CSRF meta tag) even for a
    // profile page that doesn't exist, so a typo'd VIVINO_USERNAME silently yields a token
    // here and only fails confusingly later. Point at both likely causes.
    throw new Error(
      'Could not extract CSRF token from Vivino profile page. ' +
      'Check that VIVINO_USERNAME is correct and that VIVINO_SESSION_COOKIE is still valid.'
    );
  }
  cachedCsrf = match[1];
  return cachedCsrf;
}

export function invalidateCsrf(): void {
  cachedCsrf = null;
}

// ---- Activities (ratings) ----
// Returns the raw jQuery/HTML response body.
// Uses user ID in the path and start_from_id for cursor pagination (discovered via browser network inspection).
export async function fetchActivities(
  limit: number,
  startFrom?: string,
  opts: RetryOptions = {}
): Promise<string> {
  const csrf = await fetchCsrfToken();
  const userId = await resolveUserId();
  const params: Record<string, string | number> = { limit };
  if (startFrom) params['start_from_id'] = startFrom;

  try {
    const res = await withRetry(() =>
      axios.get(`${VIVINO_BASE_URL}/users/${userId}/activities`, {
        params,
        headers: xhrHeaders(csrf),
        timeout: 20_000,
      }),
      opts
    );
    return String(res.data);
  } catch (err) {
    const e = err as AxiosError;
    if (e.response?.status === 422) {
      // CSRF expired — invalidate and retry once
      invalidateCsrf();
      const freshCsrf = await fetchCsrfToken();
      const res = await withRetry(() =>
        axios.get(`${VIVINO_BASE_URL}/users/${userId}/activities`, {
          params,
          headers: xhrHeaders(freshCsrf),
          timeout: 20_000,
        }),
        opts
      );
      return String(res.data);
    }
    throw err;
  }
}

// ---- Cellar ----
// Confirmed live (2026-09-25): the cellar page is an Inertia.js page
// (component "cellars/show"). There is no JSON API behind it — the data is the
// Inertia page object, embedded in the HTML as <div data-page="..."> and served
// as plain JSON when the same URL is requested with X-Inertia headers. That JSON
// request needs the current asset version (X-Inertia-Version); a missing or
// stale one gets a 409, so the version is bootstrapped from the HTML once.
// /en/cellars redirects to /en/cellars/{cellar_id}; cellar_id is NOT the user ID.
export interface CellarPageProps {
  cellar_id: number;
  total_count: number;
  entries: unknown[];
  statistics?: unknown;
  [key: string]: unknown;
}

let cellarBootstrap: { cellarId: number; version: string } | null = null;

export class VivinoFormatError extends Error {}

function assertCellarProps(page: unknown, where: string): CellarPageProps {
  const props = (page as { props?: Record<string, unknown> } | null)?.props;
  if (!props || !Array.isArray(props.entries) || typeof props.total_count !== 'number'
      || typeof props.cellar_id !== 'number') {
    throw new VivinoFormatError(
      `Vivino cellar ${where} did not have the expected shape (props.entries / total_count / ` +
      'cellar_id). Vivino has probably changed the cellar page (feature flag cellar_v2?), ' +
      'or the session cookie is no longer signed in.'
    );
  }
  return props as unknown as CellarPageProps;
}

export function parseInertiaPage(html: string): { version: string; props: CellarPageProps } {
  const raw = cheerio.load(html)('[data-page]').attr('data-page');
  if (!raw) {
    throw new VivinoFormatError(
      'Vivino cellar page had no Inertia data-page attribute. Either the session cookie is not ' +
      'signed in (VIVINO_SESSION_COOKIE) or Vivino has changed the cellar page.'
    );
  }
  const page = JSON.parse(raw) as { version?: unknown };
  return { version: String(page.version ?? ''), props: assertCellarProps(page, 'page HTML') };
}

async function bootstrapCellar(opts: RetryOptions): Promise<{ cellarId: number; version: string }> {
  const res = await withRetry(() =>
    axios.get(`${VIVINO_BASE_URL}/en/cellars`, { headers: baseHeaders(), timeout: 30_000 }),
    opts
  );
  const { version, props } = parseInertiaPage(String(res.data));
  cellarBootstrap = { cellarId: props.cellar_id, version };
  return cellarBootstrap;
}

export async function fetchCellarPage(
  page: number,
  perPage: number,
  opts: RetryOptions = {}
): Promise<CellarPageProps> {
  const boot = cellarBootstrap ?? await bootstrapCellar(opts);
  const get = (b: { cellarId: number; version: string }) => withRetry(() =>
    axios.get(`${VIVINO_BASE_URL}/en/cellars/${b.cellarId}`, {
      params: { page, per_page: perPage },
      headers: baseHeaders({
        Accept: 'text/html, application/xhtml+xml',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Inertia': 'true',
        'X-Inertia-Version': b.version,
      }),
      timeout: 20_000,
    }),
    opts
  );
  try {
    return assertCellarProps((await get(boot)).data, 'JSON response');
  } catch (err) {
    if ((err as AxiosError).response?.status !== 409) throw err;
    // Asset version moved on (Vivino deployed) — re-read it and retry once.
    return assertCellarProps((await get(await bootstrapCellar(opts))).data, 'JSON response');
  }
}

// Same request the cellar page's "Export" button makes (feature flag cellar_export).
// One CSV row per bottle, with the fields the Inertia JSON lacks: Tag,
// Cellar Location and Purchase Location.
export async function fetchCellarExport(cellarId: number, opts: RetryOptions = {}): Promise<string> {
  const res = await withRetry(() =>
    axios.get(`${VIVINO_BASE_URL}/cellars/${cellarId}/export`, {
      headers: baseHeaders({ Accept: 'text/csv' }),
      responseType: 'text',
      timeout: 30_000,
    }),
    opts
  );
  const type = String(res.headers?.['content-type'] ?? '');
  if (!type.includes('text/csv')) {
    throw new VivinoFormatError(`Vivino cellar export returned ${type || 'no content type'}, not text/csv.`);
  }
  return String(res.data);
}

// ---- Wine detail API (may work with valid session cookie) ----
const apiHttp = axios.create({
  baseURL: VIVINO_API_BASE,
  timeout: 15_000,
  headers: baseHeaders({ Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
});

// Scrape the real Vivino vintage ID from the wine detail page.
// The URL's /w/{id} is a routing ID; the actual API vintage ID lives in the page HTML
// as `"vintage":{"id":<N>}`.
// wineUrl may be an absolute URL (as returned by vivino_search_wines' vivino_url) or a
// relative path (as returned by vivino_get_user_ratings' wine_url) — handle both.
async function scrapeRealVintageId(urlWineId: number, wineUrl: string): Promise<number> {
  return getCached(`vintage-page:${urlWineId}`, async () => {
    const fullUrl = /^https?:\/\//i.test(wineUrl) ? wineUrl : `${VIVINO_BASE_URL}${wineUrl}`;
    const res = await withRetry(() =>
      axios.get(fullUrl, { headers: baseHeaders(), timeout: 15_000 })
    );
    const html: string = res.data;
    const m = html.match(/"vintage":\{"id":(\d+)/);
    if (!m) throw new Error(`Could not extract vintage ID from page: ${wineUrl}`);
    return parseInt(m[1]);
  }, CACHE_TTL_WINE_DETAILS_MS);
}

// Vivino runs two separate, non-interchangeable ID spaces (confirmed live,
// 2026-09-22): a "wine" ID (works with /api/wines/{id}/tastes and /reviews)
// and a "vintage" ID (works with /api/vintages/{id}, the only endpoint that
// actually serves detail data — /api/wines/{id} itself is dead, 404s
// unconditionally). Critically, the two ID spaces overlap: a wine ID handed
// to /api/vintages/{id} can return HTTP 200 with a completely unrelated
// wine's data instead of a clean error, so guessing is dangerous — a wrong
// ID has to be resolved via a real vintage ID or a page scrape, never
// assumed to work "close enough".
export async function fetchWineDetails(
  wineId: number,
  vintageId?: number | null,
  wineUrl?: string | null
): Promise<unknown> {
  return getCached(`wine:${wineId}:${vintageId ?? ''}:${wineUrl ?? ''}`, async () => {
    // 1) A real vintage ID (e.g. from vivino_search_wines' vintage_id field)
    //    is authoritative — use it directly, no scrape needed.
    if (vintageId != null) {
      const res = await withRetry(() => apiHttp.get(`/vintages/${vintageId}`));
      return res.data;
    }
    // 2) No vintage ID, but a page URL — scrape the real vintage ID from
    //    that specific page rather than guessing wineId is also a valid
    //    vintage ID (it usually isn't, and when it coincidentally IS a valid
    //    ID in that space, it silently points at some unrelated wine).
    if (wineUrl) {
      const realVintageId = await scrapeRealVintageId(wineId, wineUrl);
      const res = await withRetry(() => apiHttp.get(`/vintages/${realVintageId}`));
      return res.data;
    }
    // 3) Last resort: neither given. Best-effort guess that wineId is
    //    usable directly — may 404, or (rarely) return the wrong wine.
    const res = await withRetry(() => apiHttp.get(`/vintages/${wineId}`));
    return res.data;
  }, CACHE_TTL_WINE_DETAILS_MS);
}

export async function fetchWineTastes(wineId: number, opts: RetryOptions = {}): Promise<unknown> {
  return getCached(`tastes:${wineId}`, async () => {
    const res = await withRetry(() => apiHttp.get(`/wines/${wineId}/tastes`), opts);
    return res.data;
  }, CACHE_TTL_TASTE_MS);
}

export async function fetchWineReviews(wineId: number, page: number, perPage: number): Promise<unknown> {
  await throttle();
  const res = await withRetry(() =>
    apiHttp.get(`/wines/${wineId}/reviews`, { params: { per_page: perPage, page } })
  );
  return res.data;
}

// All Vivino wine type IDs, used as the default "any filter" below.
const ALL_WINE_TYPE_IDS = [1, 2, 3, 4, 7, 24];

// Confirmed live (2026-09-22), via decoding the "e=" param on Vivino's own
// /en/explore?e=<deflate+base64> result page URL: Vivino's search bar does
// NOT do free-text search against /api/explore/explore. Typing text there
// only resolves it against a handful of lookup endpoints — regions being the
// one confirmed to filter server-side (?name=<query>) — and the actual
// results page filters by the resolved entity's ID (region_ids[]=683 for
// "Chianti", confirmed live to return real Chianti wines; a bare q=Chianti
// is silently ignored). This resolves free text to a region filter the same
// way; grape/country/wine-style resolution would need their own (unverified)
// lookup shapes and is left for a later pass.
export async function resolveRegionFromQuery(query: string): Promise<{ id: number; name: string } | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  await throttle();
  const res = await withRetry(() =>
    apiHttp.get('/regions', { params: { name: trimmed, language: 'en' } })
  );
  // Confirmed live (2026-09-22): the response is { regions: [...] }, not a
  // bare array. Also confirmed: results are NOT ranked with the best match
  // first — searching "chianti" returned 11 sub-regions/related entries
  // (Chianti Rùfina, Chianti Classico, Vin Santo del Chianti, ...) with the
  // actual "Chianti" region dead LAST. Prefer an exact case-insensitive name
  // match; only fall back to the API's own first result when nothing matches
  // exactly (a genuinely ambiguous/fuzzy query).
  const regions = (res.data as { regions?: Array<Record<string, unknown>> } | undefined)?.regions;
  if (!regions?.length) return null;
  const exact = regions.find(r => String(r.name ?? '').trim().toLowerCase() === trimmed.toLowerCase());
  const chosen = exact ?? regions[0];
  if (chosen.id == null) return null;
  return { id: Number(chosen.id), name: String(chosen.name ?? trimmed) };
}

export async function fetchWineSearch(params: {
  query: string; region_ids?: number[]; country_codes?: string[]; grape_ids?: number[];
  min_rating?: number; max_rating?: number; wine_type_ids?: number[];
  page?: number; per_page?: number;
}): Promise<unknown> {
  const searchParams: Record<string, unknown> = {
    per_page: params.per_page ?? 25, page: params.page ?? 1,
  };
  const hasExplicitFilter =
    !!params.region_ids?.length ||
    !!params.country_codes?.length ||
    !!params.grape_ids?.length ||
    params.min_rating != null ||
    params.max_rating != null ||
    !!params.wine_type_ids?.length;

  // NOTE: deliberately not sending params.query as `q` — confirmed live that
  // /api/explore/explore ignores it silently rather than filtering by it.
  // See resolveRegionFromQuery above for the actual text-to-filter path.
  if (params.region_ids?.length) searchParams['region_ids[]'] = params.region_ids;
  if (params.country_codes?.length) searchParams['country_codes[]'] = params.country_codes;
  if (params.grape_ids?.length) searchParams['grape_ids[]'] = params.grape_ids;
  if (params.min_rating != null) searchParams['min_rating'] = params.min_rating;
  if (params.max_rating != null) searchParams['max_rating'] = params.max_rating;
  if (params.wine_type_ids?.length) searchParams['wine_type_ids[]'] = params.wine_type_ids;

  // Vivino's explore API rejects a request with no filter at all
  // ("at least one filter should be set", HTTP 400). When the caller gave
  // none and no region was resolved either, default to "all wine types" — a
  // filter that doesn't actually narrow results, just satisfies the API.
  if (!hasExplicitFilter) searchParams['wine_type_ids[]'] = ALL_WINE_TYPE_IDS;

  await throttle();
  const res = await withRetry(() => apiHttp.get('/explore/explore', { params: searchParams }));
  return res.data;
}

export function clearCache(): void {
  cache.clear();
  resolvedUserId = null;
  cachedCsrf = null;
  cellarBootstrap = null;
}
