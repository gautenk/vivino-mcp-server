import { z } from 'zod';
import { fetchWineReviews } from '../client';
import { VivinoReview } from '../types';

export const reviewsInputSchema = {
  wine_id: z.number().int().positive()
    .describe('Vivino wine ID. Obtain from vivino_get_user_ratings or vivino_search_wines.'),
  page: z.number().int().min(1).default(1)
    .describe('Page number (1-based)'),
  per_page: z.number().int().min(1).max(50).default(10)
    .describe('Reviews per page (max 50)'),
};

function parseReviews(raw: unknown): VivinoReview[] {
  const d = raw as { reviews?: unknown[] };
  const reviews = d?.reviews ?? [];
  return (reviews as unknown[]).map((item) => {
    const r = item as Record<string, unknown>;
    const user = r.user as Record<string, unknown> | undefined;
    return {
      reviewer: String(user?.alias ?? user?.username ?? 'Anonymous'),
      rating: r.rating != null ? Number(r.rating) : null,
      text: String(r.note ?? ''),
      created_at: String(r.created_at ?? ''),
      language: String(r.language ?? 'en'),
      note_type: r.note_type ? String(r.note_type) : null,
    };
  });
}

export async function getWineReviews(args: {
  wine_id: number;
  page: number;
  per_page: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const raw = await fetchWineReviews(args.wine_id, args.page, args.per_page);
    const reviews = parseReviews(raw);
    const result = {
      wine_id: args.wine_id,
      page: args.page,
      per_page: args.per_page,
      count: reviews.length,
      reviews,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error fetching reviews: ${message}` }] };
  }
}
