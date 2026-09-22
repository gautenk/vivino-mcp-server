import { z } from 'zod';
import { fetchWineDetails, fetchWineTastes } from '../client';
import { VivinoWineDetails, VivinoTasteProfile } from '../types';

export const wineDetailsInputSchema = {
  wine_id: z.number().int().positive()
    .describe('Vivino wine ID (numeric). Obtain from vivino_get_user_ratings or vivino_search_wines.'),
  vintage_id: z.number().int().positive().optional()
    .describe(
      'Strongly recommended when available: the vintage_id field from vivino_search_wines\' ' +
      'results. Vivino details live on a separate "vintage" ID, not the wine ID — passing this ' +
      'goes straight to the correct data. Without it, the server either scrapes the real vintage ' +
      'ID from wine_url (if given) or falls back to guessing wine_id also works as a vintage ID, ' +
      'which can silently return the WRONG wine instead of erroring.'
    ),
  wine_url: z.string().optional()
    .describe(
      'The wine_url (from vivino_get_user_ratings) or vivino_url (from vivino_search_wines) for ' +
      'this wine. Used only when vintage_id isn\'t known: the server scrapes the real vintage ID ' +
      'from this specific page rather than guessing. Always pass this when you don\'t have ' +
      'vintage_id — without either, results for a wine_id sourced from vivino_get_user_ratings ' +
      'can come back as a completely different, unrelated wine.'
    ),
};

export const tasteProfileInputSchema = {
  wine_id: z.number().int().positive()
    .describe(
      'Vivino wine ID — from vivino_get_user_ratings\' wine_id, or vivino_search_wines\' ' +
      'wine_id field specifically (NOT its vintage_id; that\'s a different ID space and returns ' +
      'a 404 here instead of the taste data).'
    ),
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

// Vivino has returned structure values on at least two different scales in the
// wild: 0–1 floats directly usable as-is, and ~1–5 floats that need dividing
// down. Rather than hard-coding one assumption (which has now broken this
// tool twice — the reverse-engineered API isn't documented and can vary by
// wine/endpoint), detect the scale per-value: anything already <= 1 is left
// alone, anything above is treated as a 1–5 reading and divided by 5.
function normalizeTasteVal(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  const scaled = n > 1 ? n / 5 : n;
  return Math.max(0, Math.min(1, scaled));
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
  args: { wine_id: number; vintage_id?: number; wine_url?: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const raw = await fetchWineDetails(args.wine_id, args.vintage_id ?? null, args.wine_url ?? null);
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
