import * as dotenv from 'dotenv';
dotenv.config();

export const VIVINO_BASE_URL = 'https://www.vivino.com';
export const VIVINO_API_BASE = 'https://www.vivino.com/api';

export const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ?? '';

export const DEFAULT_USERNAME = process.env.VIVINO_USERNAME ?? 'anonymous';

// Rate limiting
export const MIN_REQUEST_INTERVAL_MS = 700;
export const RETRY_AFTER_429_MS = 60_000;
export const RETRY_AFTER_5XX_MS = 2_000;

// Cache TTLs
export const CACHE_TTL_WINE_DETAILS_MS = 60 * 60 * 1000; // 60 minutes
export const CACHE_TTL_TASTE_MS = 60 * 60 * 1000;        // 60 minutes

// Pagination defaults
export const DEFAULT_PER_PAGE = 25;
export const MAX_PER_PAGE = 100;

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';
