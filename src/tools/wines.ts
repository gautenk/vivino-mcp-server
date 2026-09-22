import { z } from 'zod';
import { fetchWineDetails, fetchWineTastes } from '../client';
import { VivinoWineDetails, VivinoTasteProfile } from '../types';

export const wineDetailsInputSchema = {
  wine_id: z.number().int().positive()
    .describe('Vivino wine ID (numeric). Obtain from vivino_get_user_ratings or vivino_search_wines.'),
  wine_url: z.string().optional()
    .describe(
      'Optional: the wine_url (from vivino_get_user_ratings) or vivino_url (from ' +
      'vivino_search_wines) for this wine. The direct /api/wines/{id} lookup 404s for many ' +
      'IDs; when that happens the server falls back to scraping the real vintage ID from this ' +
      'page and retrying against /api/vintages/{id}. Passing it up front avoids the 404 round-trip.'
    ),
};

export const tasteProfileInputSchema = {
  wine_id: z.number().int().positive()
    .describe('Vivino wine ID (numeric). Obtain from vivino_get_user_ratings or vivino_search_wines.'),
};

export function parseWineDetails(raw: unknown): VivinoWineDetails {
  const d = raw as Record<string, unknown>;
  // Vintage endpoint returns { vintage: { wine: {...}, statistics: {...} } }
  const vintageObj = d.vintage as Record<string, unknown> | undefined;
  const wine = (vintageObj?.wine ?? d.wine ?? d) as Record<string, unknown>;
  const winery = wine.winery as Record<string, unknown> | undefined;
  const region = wine.region as Record<string, unknown> | undefined;
  const country = region?.country as Record<string, unknown> | undefined;
  const stats = (vintageObj?.statistics ?? wine.statistics) as Record<string, unknown> | undefined;
  const grapes = (wine.grapes as Array<Record<string, unknown>>) ?? [];
  const food = (wine.food as Array<Record<string, unknown>>) ?? [];
  const style = wine.style as Record<string, unknown> | undefined;

  return {
    wine_id: Number(wine.id),
    name: String(wine.name ?? ''),
    winery: String(winery?.name ?? ''),
    region: region ? String(region.name) : null,
    country: country ? String(country.name) : null,
    grape_varieties: grapes.map(g => String(g.name ?? '')).filter(Boolean),
    abv: wine.alcohol != null ? Number(wine.alcohol) : null,
    avg_rating: stats?.ratings_average != null ? Number(stats.ratings_average) : null,
    ratings_count: stats?.ratings_count != null ? Number(stats.ratings_count) : null,
    style_description: style?.description ? String(style.description) : null,
    food_pairings: food.map(f => String(f.name ?? '')).filter(Boolean),
    image_url: ((wine.label_image_url ?? (wine.image as Record<string, unknown> | undefined)?.location) as string | undefined) ?? null,
    vivino_url: wine.seo_name ? `https://www.vivino.com/wines/${wine.seo_name}` : null,
  };
}

function normalizeTasteVal(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  // Vivino's taste structure values are already on a 0–1 scale; only clamp
  // the occasional stray out-of-range reading. (A prior version divided by 5
  // here on the mistaken assumption of a 0–5 scale, which silently corrupted
  // every taste profile — e.g. an actual 0.7 acidity displayed as 14%.)
  return Math.max(0, Math.min(1, n));
}

export function parseTasteProfile(raw: unknown): VivinoTasteProfile {
  const d = raw as Record<string, unknown>;
  const tastes = (d.tastes ?? d) as Record<string, unknown>;
  const structure = (tastes.structure ?? {}) as Record<string, unknown>;
  const flavors = (tastes.flavor ?? []) as Array<Record<string, unknown>>;

  return {
    structure: {
      acidity: normalizeTasteVal(structure.acidity),
      fizziness: normalizeTasteVal(structure.fizziness),
      intensity: normalizeTasteVal(structure.intensity),
      sweetness: normalizeTasteVal(structure.sweetness),
      tannin: normalizeTasteVal(structure.tannin),
    },
    flavor_groups: flavors.map(group => ({
      group: String(group.group ?? ''),
      primary_keywords: ((group.primary_keywords ?? []) as Array<Record<string, unknown>>)
        .map(k => String(k.name ?? '')).filter(Boolean),
    })).filter(g => g.group),
  };
}

export async function getWineDetails(
  args: { wine_id: number; wine_url?: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const raw = await fetchWineDetails(args.wine_id, args.wine_url ?? null);
    const details = parseWineDetails(raw);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error fetching wine details: ${message}` }] };
  }
}

export async function getWineTasteProfile(
  args: { wine_id: number }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const raw = await fetchWineTastes(args.wine_id);
    const profile = parseTasteProfile(raw);
    return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error fetching taste profile: ${message}` }] };
  }
}
