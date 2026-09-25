import { z } from 'zod';
import * as cheerio from 'cheerio';
import { resolveUserId, fetchActivities } from '../client';
import { VivinoUserRating } from '../types';
import { MAX_PER_PAGE } from '../constants';
import { rateLimitGuard, RATE_LIMITED, RATE_LIMIT_WARNING } from '../paging';

// Ratings-specific default (decision F1). Each call now keeps fetching until
// per_page is filled, so a smaller default keeps plain calls fast.
const RATINGS_DEFAULT_PER_PAGE = 10;

// Vivino's activities endpoint ignores every size parameter (limit, per_page,
// count — confirmed live 2026-09-25, always 10 items). Sent anyway as a no-op.
const ACTIVITIES_BATCH = 10;

export const ratingsInputSchema = {
  page: z.number().int().min(1).default(1)
    .describe(
      'Cosmetic page counter echoed back in the response — Vivino itself is not paginated by ' +
      'page number. To actually advance through results, pass the next_start_from value from ' +
      'the previous response as start_from.'
    ),
  per_page: z.number().int().min(1).max(MAX_PER_PAGE).default(RATINGS_DEFAULT_PER_PAGE)
    .describe('Number of ratings to return (default 10, max 100). Guaranteed: the server keeps ' +
      'fetching Vivino batches (after applying min_rating/max_rating/since/wine_name_query) until ' +
      'per_page ratings are found. Fewer come back only when the history runs out (has_more: ' +
      'false) or Vivino rate-limits twice (has_more: true plus a warning). Selective filters can ' +
      'scan the whole history and take a while.'),
  min_rating: z.number().min(1).max(5).optional()
    .describe('Filter: only return wines rated at or above this score (1.0–5.0)'),
  max_rating: z.number().min(1).max(5).optional()
    .describe('Filter: only return wines rated at or below this score (1.0–5.0)'),
  since: z.string().optional()
    .describe('ISO 8601 date — only return ratings newer than this date (e.g. "2025-01-01")'),
  start_from: z.string().optional()
    .describe('Activity ID to paginate from (returned as next_start_from in previous response). Leave empty for first page.'),
  wine_name_query: z.string().optional()
    .describe(
      'Filter: only return ratings where the wine name or winery name contains this text ' +
      '(case-insensitive). Use this to answer "have I rated this wine?" without paginating ' +
      'through the full history yourself.'
    ),
};

// Extract HTML from jQuery .append('...') response
function extractHtml(body: string): string {
  const start = body.indexOf(".append('");
  if (start === -1) return body; // may already be raw HTML
  const contentStart = start + ".append('".length;
  const end = body.lastIndexOf("');");
  const escaped = body.slice(contentStart, end === -1 ? undefined : end);
  return escaped
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

// A rating with its source activity ID attached — used internally to compute
// a correct pagination cursor even when we truncate to per_page ourselves
// (see getUserRatings). Never exposed to the caller.
type RatingWithActivityId = VivinoUserRating & { _activityId: string };

// Parse "Sat, Mar 28th at 17:26:00 UTC" → ISO string.
// Vivino titles omit the year, so we try the current year and walk back until the date is not in the future.
function parseVivinoDate(title: string): string {
  try {
    const cleaned = title
      .replace(/(\d+)(st|nd|rd|th)/g, '$1')
      .replace(' at ', ' ');
    const now = new Date();
    for (let offset = 0; offset <= 10; offset++) {
      const year = now.getFullYear() - offset;
      // Insert year after the day number: "Sat, Mar 28 17:26:00 UTC" → "Sat, Mar 28 2026 17:26:00 UTC"
      const withYear = cleaned.replace(/^(\w+,\s+\w+\s+\d+)/, `$1 ${year}`);
      const d = new Date(withYear);
      if (!isNaN(d.getTime()) && d <= now) return d.toISOString();
    }
  } catch { /* fall through */ }
  return new Date().toISOString();
}

export function parseActivitiesBody(body: string): {
  ratings: RatingWithActivityId[];
  lastActivityId: string | null;
  rawItemCount: number;
} {
  const html = extractHtml(body);
  const $ = cheerio.load(html);
  const ratings: RatingWithActivityId[] = [];
  let lastActivityId: string | null = null;
  let rawItemCount = 0;

  $('[id^="user-activity-"]').each((_, el) => {
    const item = $(el);
    rawItemCount++;
    const actId = (item.attr('id') ?? '').replace('user-activity-', '');
    if (actId) lastActivityId = actId;

    // Star rating: sum icon-{N}-pct values (each represents N/100 of a star fill)
    let rating = 0;
    item.find('[class*="icon-"][class*="-pct"]').each((_, icon) => {
      const cls = $(icon).attr('class') ?? '';
      const m = cls.match(/icon-(\d+)-pct/);
      if (m) rating += parseInt(m[1]) / 100;
    });
    rating = Math.round(rating * 10) / 10;

    // Skip non-rating activities (e.g. cellar additions with 0 rating)
    if (rating === 0) return;

    // Wine card: links are [0]=wine page, [1]=winery, [2]=wine name, [3]=region, [4]=country
    const card = item.find('.activity-wine-card');
    const links = card.find('a');
    const wineUrl = links.eq(0).attr('href') ?? null;
    const winery = links.eq(1).text().trim();
    const wineName = links.eq(2).text().trim();
    const region = links.eq(3).text().trim();
    const country = links.eq(4).text().trim();

    if (!winery || !wineName) return;

    // Wine ID from URL: /en/{seo}/w/{id}
    const wineIdMatch = wineUrl?.match(/\/w\/(\d+)/);
    const wineId = wineIdMatch ? parseInt(wineIdMatch[1]) : 0;

    // Vintage: first 4-digit year in text, sanity-bounded to a plausible
    // wine year (1900..currentYear+1). Without a bound this regex can grab
    // an unrelated 4-digit number elsewhere in the card's text (e.g. an NV
    // wine showed vintage 2051) — out-of-range matches are treated as NV
    // (no vintage) instead of returned as a bogus year.
    const fullText = item.text();
    const currentYear = new Date().getFullYear();
    const vintageMatch = fullText.match(/\b(19|20)\d{2}\b/);
    const vintageCandidate = vintageMatch ? parseInt(vintageMatch[0]) : null;
    const vintage = vintageCandidate != null && vintageCandidate >= 1900 && vintageCandidate <= currentYear + 1
      ? vintageCandidate
      : null;

    // Rated at: from the time link's title attribute
    const timeTitle = item.find('a[title]').first().attr('title') ?? '';
    const ratedAt = timeTitle ? parseVivinoDate(timeTitle) : new Date().toISOString();

    // User notes: look for a review/note block
    const noteText = item.find('.activity-note, .note-text, [class*="tasting-note"]').text().trim() || null;

    ratings.push({
      wine_id: wineId,
      wine_name: wineName,
      winery_name: winery,
      vintage,
      user_rating: rating,
      user_notes: noteText,
      rated_at: ratedAt,
      wine_url: wineUrl,
      _activityId: actId,
    });
  });

  return { ratings, lastActivityId, rawItemCount };
}

type Filters = {
  min_rating?: number;
  max_rating?: number;
  since?: string;
  wine_name_query?: string;
};

function matchesFilters(r: VivinoUserRating, f: Filters): boolean {
  if (f.min_rating !== undefined && r.user_rating < f.min_rating) return false;
  if (f.max_rating !== undefined && r.user_rating > f.max_rating) return false;
  if (f.since && new Date(r.rated_at).getTime() <= new Date(f.since).getTime()) return false;
  if (f.wine_name_query) {
    const needle = f.wine_name_query.toLowerCase();
    if (!r.wine_name.toLowerCase().includes(needle) && !r.winery_name.toLowerCase().includes(needle)) {
      return false;
    }
  }
  return true;
}

export async function getUserRatings(args: {
  page: number;
  per_page: number;
  min_rating?: number;
  max_rating?: number;
  since?: string;
  start_from?: string;
  wine_name_query?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    await resolveUserId(); // validates auth early
    const guarded = rateLimitGuard();
    const collected: RatingWithActivityId[] = [];
    // Cursor = last activity we have fully looked at. Every activity up to it
    // is either returned or filtered out, so resuming from it never skips or
    // repeats a rating.
    let cursor: string | null = args.start_from ?? null;
    let hasMore = true;
    let warning: string | undefined;

    // Decision A2: no cap on batches — stop only when per_page is filled, the
    // history is empty, or the 429 budget is spent. The client throttles every
    // request to 700 ms.
    while (collected.length < args.per_page) {
      const body = await guarded(() =>
        fetchActivities(ACTIVITIES_BATCH, cursor ?? undefined, { retry429: false })
      );
      if (body === RATE_LIMITED) {
        warning = RATE_LIMIT_WARNING;
        break;
      }
      const { ratings, lastActivityId, rawItemCount } = parseActivitiesBody(body);
      if (rawItemCount === 0 || lastActivityId === null) {
        hasMore = false;
        break;
      }
      let filledAt: string | null = null;
      for (const r of ratings) {
        if (!matchesFilters(r, args)) continue;
        collected.push(r);
        if (collected.length === args.per_page) {
          filledAt = r._activityId;
          break;
        }
      }
      // Filled mid-batch: resume right after the last returned rating so the
      // rest of this batch comes back on the next call.
      cursor = filledAt ?? lastActivityId;
    }

    const result = {
      page: args.page,
      per_page: args.per_page,
      count: collected.length,
      next_start_from: cursor,
      has_more: hasMore,
      ...(warning ? { warning } : {}),
      // Strip the internal cursor field before returning to the caller.
      ratings: collected.map(({ _activityId, ...r }) => r),
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error fetching ratings: ${message}` }] };
  }
}
