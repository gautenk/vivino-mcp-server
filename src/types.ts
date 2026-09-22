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
