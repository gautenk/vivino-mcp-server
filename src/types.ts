export interface VivinoUserRating {
  wine_id: number;
  wine_name: string;
  winery_name: string;
  vintage: number | null;
  user_rating: number;
  user_notes: string | null;
  rated_at: string;
  wine_url: string | null;
  country?: string | null;
  region?: string | null;
}

export interface VivinoWineDetails {
  wine_id: number;
  name: string;
  winery: string;
  region: string | null;
  country: string | null;
  grape_varieties: string[];
  abv: number | null;
  avg_rating: number | null;
  ratings_count: number | null;
  style_description: string | null;
  food_pairings: string[];
  image_url: string | null;
  vivino_url: string | null;
}

export interface VivinoTasteStructure {
  acidity: number | null;
  fizziness: number | null;
  intensity: number | null;
  sweetness: number | null;
  tannin: number | null;
}

export interface VivinoFlavorGroup {
  group: string;
  primary_keywords: string[];
}

export interface VivinoTasteProfile {
  structure: VivinoTasteStructure;
  flavor_groups: VivinoFlavorGroup[];
}

export interface VivinoReview {
  reviewer: string;
  rating: number | null;
  text: string;
  created_at: string;
  language: string;
  note_type: string | null;
}

export interface VivinoSearchResult {
  wine_id: number;
  // Pass this (not wine_id) to vivino_get_wine_details when you have it —
  // details live on the vintage endpoint, not the wine endpoint.
  vintage_id: number | null;
  name: string;
  winery: string;
  region: string | null;
  country: string | null;
  avg_rating: number | null;
  ratings_count: number | null;
  style_id: number | null;
  vivino_url: string | null;
}

export interface SyncState {
  last_sync_at: string;
  last_activity_id: string | null;
  total_wines_synced: number;
}

export interface CellarBottle {
  size: string | null;
  bin: string | null;
  note: string | null;
  purchase_date: string | null;
  purchase_price: number | null;
  purchase_price_currency: string | null;
}

export type DrinkingWindowStatus = 'drink_now' | 'drink_or_hold' | 'hold' | 'past_peak' | 'unknown';

export interface CellarWine {
  wine_id: number;
  // Pass this to vivino_get_wine_details as vintage_id.
  vintage_id: number;
  wine_name: string;
  // Vivino has wines with no winery at all (confirmed live), so this can be null.
  winery_name: string | null;
  vintage: number | null;
  quantity: number;
  wine_type: string | null;
  country: string | null;
  country_code: string | null;
  region: string | null;
  grapes: string[];
  avg_rating: number | null;
  ratings_count: number | null;
  // No cellar source carries the user's own rating; kept for the C1 contract.
  user_rating: null;
  drinking_window: { start_year: number | null; end_year: number | null; status: DrinkingWindowStatus };
  ready_to_drink: boolean | null;
  // 'vivino': Vivino's own drinking-window verdict. 'inferred': enrich filled it
  // in for a wine Vivino shows as "Drink at your pace" (no window).
  ready_to_drink_source: 'vivino' | 'inferred' | null;
  added_at: string | null;
  // Mean of the bottles with a known price, only when they share one currency.
  purchase_price: number | null;
  purchase_price_currency: string | null;
  // Most recent known purchase date across the bottles.
  purchase_date: string | null;
  // From the CSV export (not in the page JSON).
  purchase_locations: string[];
  cellar_locations: string[];
  tags: string[];
  bottles: CellarBottle[];
  vivino_url: string;
  // enrich: true only
  abv?: number | null;
  style?: string | null;
  food_pairings?: string[];
  taste_profile?: VivinoTasteProfile | null;
}
