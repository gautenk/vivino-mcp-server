import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { resolveUserId, fetchActivities, fetchWineDetails, fetchWineTastes } from '../client';
import { OBSIDIAN_VAULT_PATH } from '../constants';
import { VivinoUserRating, VivinoWineDetails, VivinoTasteProfile, SyncState } from '../types';
import { parseActivitiesBody } from './ratings';
import { parseWineDetails, parseTasteProfile } from './wines';
import { fetchExaEnrichment, fetchExaTastingNotes } from './exa';

export const syncInputSchema = {
  full_sync: z.boolean().default(false)
    .describe('If true, fetch all ratings from the beginning regardless of last sync date. Defaults to incremental (only ratings newer than last sync).'),
  overwrite_existing: z.boolean().default(false)
    .describe('If true, overwrite existing .md note files. Useful after a format change.'),
  max_wines: z.number().int().min(1).max(500).optional()
    .describe('Cap the number of wines processed — useful for testing (e.g. max_wines: 5).'),
};

// ---- Sync state ----
function loadSyncState(syncStatePath: string): SyncState | null {
  try {
    if (fs.existsSync(syncStatePath)) return JSON.parse(fs.readFileSync(syncStatePath, 'utf-8')) as SyncState;
  } catch { /* treat as first run */ }
  return null;
}

function saveSyncState(syncStatePath: string, state: SyncState): void {
  fs.writeFileSync(syncStatePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ---- Helpers ----
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function ratingFilename(r: VivinoUserRating): string {
  const v = r.vintage ? ` ${r.vintage}` : '';
  return sanitizeFilename(`${r.winery_name} ${r.wine_name}${v}`) + '.md';
}

const OLD_WORLD_COUNTRIES = new Set([
  'France', 'Italy', 'Spain', 'Portugal', 'Germany', 'Austria', 'Greece',
  'Hungary', 'Romania', 'Bulgaria', 'Croatia', 'Slovenia', 'Switzerland',
  'Georgia', 'Moldova', 'Czech Republic', 'Slovakia', 'Luxembourg',
  'England', 'United Kingdom', 'Serbia', 'North Macedonia', 'Turkey',
  'Lebanon', 'Israel', 'Morocco', 'Tunisia', 'Algeria',
]);

function classifyWorld(country: string | null | undefined): 'Old World' | 'New World' | 'Other' {
  if (!country) return 'Other';
  return OLD_WORLD_COUNTRIES.has(country) ? 'Old World' : 'New World';
}

export function renderBar(val: number): string {
  const n = Math.round(Math.max(0, Math.min(1, val)) * 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

// ---- Markdown note formatter ----
function formatWineNote(
  rating: VivinoUserRating,
  details: VivinoWineDetails | null,
  tastes: VivinoTasteProfile | null,
  today: string,
  exaTastingNotes?: string | null,
): string {
  const tags = ['wine', 'tasting-notes'];
  if (details?.country) tags.push(details.country.toLowerCase().replace(/\s+/g, '-'));
  if (details?.grape_varieties.length) {
    details.grape_varieties.slice(0, 2).forEach(g => tags.push(g.toLowerCase().replace(/\s+/g, '-')));
  }

  const lines: string[] = [
    '---',
    `tags: [${tags.join(', ')}]`,
    `created: ${today}`,
    `updated: ${today}`,
    `status: active`,
  ];
  if (details?.vivino_url) lines.push(`vivino_url: "${details.vivino_url}"`);
  if (details?.country) lines.push(`country: "${details.country}"`);
  if (details?.region) lines.push(`region: "${details.region}"`);
  lines.push('---', '');

  const v = rating.vintage ? ` ${rating.vintage}` : '';
  lines.push(`# ${rating.winery_name} ${rating.wine_name}${v}`, '');

  lines.push('## My Rating', '');
  const full = Math.round(rating.user_rating);
  lines.push(`**Rating:** ${'★'.repeat(full)}${'☆'.repeat(5 - full)} (${rating.user_rating}/5)`);
  lines.push(`**Tasted:** ${rating.rated_at.slice(0, 10)}`);
  if (rating.user_notes) { lines.push('', `**Notes:** ${rating.user_notes}`); }
  lines.push('');

  if (details) {
    lines.push('## Wine Details', '', '| Field | Value |', '|---|---|');
    lines.push(`| Winery | ${details.winery} |`);
    if (details.region) lines.push(`| Region | ${details.region} |`);
    if (details.country) lines.push(`| Country | ${details.country} |`);
    if (details.grape_varieties.length) lines.push(`| Grapes | ${details.grape_varieties.join(', ')} |`);
    if (details.abv) lines.push(`| ABV | ${details.abv}% |`);
    if (details.avg_rating != null) {
      lines.push(`| Community Rating | ${details.avg_rating.toFixed(1)}/5 (${details.ratings_count?.toLocaleString() ?? '?'} ratings) |`);
    }
    if (details.food_pairings.length) lines.push(`| Food Pairings | ${details.food_pairings.join(', ')} |`);
    lines.push('');
    if (details.style_description) { lines.push('### Style', '', details.style_description, ''); }
  }

  if (tastes) {
    lines.push('## Taste Profile', '');
    const s = tastes.structure;
    const rows = ([
      ['Acidity', s.acidity], ['Sweetness', s.sweetness], ['Tannin', s.tannin],
      ['Intensity', s.intensity], ['Fizziness', s.fizziness],
    ] as [string, number | null][]).filter((row): row is [string, number] => row[1] !== null);

    if (rows.length) {
      lines.push('### Structure', '', '| Attribute | Level |', '|---|---|');
      rows.forEach(([name, val]) => lines.push(`| ${name} | ${renderBar(val)} ${(val * 100).toFixed(0)}% |`));
      lines.push('');
    }
    if (tastes.flavor_groups.length) {
      lines.push('### Flavor Profile', '');
      tastes.flavor_groups.forEach(g => {
        lines.push(`- **${g.group.replace(/_/g, ' ')}:** ${g.primary_keywords.join(', ')}`);
      });
      lines.push('');
    } else if (exaTastingNotes) {
      lines.push('### Tasting Notes (via Exa)', '', exaTastingNotes, '');
    }
  } else if (exaTastingNotes) {
    lines.push('## Taste Profile', '', '### Tasting Notes (via Exa)', '', exaTastingNotes, '');
  }
  return lines.join('\n');
}

function formatIndex(all: VivinoUserRating[], today: string): string {
  const TABLE_HEADER = '| Rating | Wine | Winery | Region | Vintage | Tasted |';
  const TABLE_SEP    = '|---|---|---|---|---|---|';

  function renderRow(r: VivinoUserRating): string {
    const stars = '★'.repeat(Math.round(r.user_rating)) + '☆'.repeat(5 - Math.round(r.user_rating));
    const note  = sanitizeFilename(`${r.winery_name} ${r.wine_name}${r.vintage ? ` ${r.vintage}` : ''}`);
    return `| ${stars} ${r.user_rating} | [[${note}]] | ${r.winery_name} | ${r.region ?? ''} | ${r.vintage ?? 'NV'} | ${r.rated_at.slice(0, 10)} |`;
  }

  // Group: world → country → wines[]
  const groups = new Map<string, Map<string, VivinoUserRating[]>>();
  for (const r of all) {
    const world   = classifyWorld(r.country);
    const country = r.country ?? 'Unknown';
    if (!groups.has(world)) groups.set(world, new Map());
    const cm = groups.get(world)!;
    if (!cm.has(country)) cm.set(country, []);
    cm.get(country)!.push(r);
  }
  for (const cm of groups.values())
    for (const wines of cm.values())
      wines.sort((a, b) => b.user_rating - a.user_rating);

  const lines = [
    '---', 'tags: [wine, index]', `created: ${today}`, `updated: ${today}`, 'status: active', '---', '',
    '# Wine Ratings Index', '',
    `**Total wines rated:** ${all.length}`,
    `**Last synced:** ${today}`, '',
  ];

  for (const world of ['Old World', 'New World', 'Other'] as const) {
    const cm = groups.get(world);
    if (!cm?.size) continue;
    const worldTotal = [...cm.values()].reduce((s, ws) => s + ws.length, 0);
    lines.push(`## ${world} (${worldTotal})`, '');
    for (const country of [...cm.keys()].sort()) {
      const wines = cm.get(country)!;
      lines.push(`### ${country} (${wines.length})`, '', TABLE_HEADER, TABLE_SEP);
      wines.forEach(r => lines.push(renderRow(r)));
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ---- Main sync ----
export async function syncToObsidian(args: {
  full_sync: boolean;
  overwrite_existing: boolean;
  max_wines?: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const log: string[] = [];
  const syncStartedAt = new Date().toISOString();

  if (!OBSIDIAN_VAULT_PATH) {
    return {
      content: [{
        type: 'text',
        text: 'Error: OBSIDIAN_VAULT_PATH environment variable is not set. ' +
              'Set it to your Obsidian vault\'s Wine knowledge base path (e.g., /path/to/Obsidian Vault/Knowledge/Wine)',
      }],
    };
  }

  const syncStatePath = path.join(OBSIDIAN_VAULT_PATH, '.sync-state.json');
  const manifestPath = path.join(OBSIDIAN_VAULT_PATH, '.manifest.json');

  try {
    if (!fs.existsSync(OBSIDIAN_VAULT_PATH)) {
      fs.mkdirSync(OBSIDIAN_VAULT_PATH, { recursive: true });
      log.push(`Created: ${OBSIDIAN_VAULT_PATH}`);
    }

    await resolveUserId();

    const syncState = loadSyncState(syncStatePath);
    const isFirstRun = syncState === null;
    const sinceDate = (!args.full_sync && syncState) ? new Date(syncState.last_sync_at) : null;

    log.push(sinceDate
      ? `Incremental sync since ${sinceDate.toISOString()}`
      : `Full sync from scratch`);

    // Paginate activities with startFrom-based cursor
    const newRatings: VivinoUserRating[] = [];
    const seenWineIds = new Set<number>();
    const seenCursors = new Set<string>();
    let startFrom: string | undefined = undefined;
    let reachedOld = false;

    while (!reachedOld) {
      const body = await fetchActivities(100, startFrom);
      const { ratings: page, lastActivityId } = parseActivitiesBody(body);

      let newInBatch = 0;
      for (const r of page) {
        if (sinceDate && new Date(r.rated_at) <= sinceDate) { reachedOld = true; break; }
        if (seenWineIds.has(r.wine_id)) continue;
        seenWineIds.add(r.wine_id);
        newRatings.push(r);
        newInBatch++;
        if (args.max_wines && newRatings.length >= args.max_wines) { reachedOld = true; break; }
      }

      log.push(`Fetched batch: ${page.length} activities, ${newRatings.length} new so far`);

      if (!lastActivityId) break; // truly exhausted
      if (seenCursors.has(lastActivityId)) break; // cursor not advancing — pagination loop
      seenCursors.add(lastActivityId);
      startFrom = lastActivityId;
    }

    log.push(`Processing ${newRatings.length} new ratings`);

    // Load the existing manifest up front (if any) so we can tell a genuine
    // re-rating apart from "note file already exists, nothing changed" — see
    // the skip check below. Without this, re-rating a wine on Vivino never
    // reached the note because the file-exists check alone always skipped it.
    const priorManifestByWineId = new Map<number, VivinoUserRating>();
    try {
      if (fs.existsSync(manifestPath)) {
        const priorManifest: VivinoUserRating[] = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        for (const r of priorManifest) priorManifestByWineId.set(r.wine_id, r);
      }
    } catch { /* treat as no prior manifest */ }

    let written = 0, skipped = 0, errors = 0;
    const today = syncStartedAt.slice(0, 10);

    for (const rating of newRatings) {
      const filename = ratingFilename(rating);
      const filePath = path.join(OBSIDIAN_VAULT_PATH, filename);

      const priorEntry = priorManifestByWineId.get(rating.wine_id);
      const wasReRated = priorEntry != null &&
        (priorEntry.user_rating !== rating.user_rating || priorEntry.rated_at !== rating.rated_at);
      if (wasReRated) {
        log.push(`  Re-rated: ${rating.wine_name} (${priorEntry!.user_rating} → ${rating.user_rating}), rewriting note`);
      }

      if (!args.overwrite_existing && !wasReRated && fs.existsSync(filePath)) { skipped++; continue; }

      let details: VivinoWineDetails | null = null;
      let tastes: VivinoTasteProfile | null = null;

      if (rating.wine_id > 0) {
        try {
          details = parseWineDetails(await fetchWineDetails(rating.wine_id, rating.wine_url));
        } catch (e) {
          log.push(`  Warning: no Vivino details for wine ${rating.wine_id} (${rating.wine_name}): ${e instanceof Error ? e.message : e}`);
          // Exa fallback: fetch region/country/grapes from web search
          if (process.env.EXA_API_KEY) {
            try {
              const exaData = await fetchExaEnrichment(rating);
              if (Object.keys(exaData).length > 0) {
                details = {
                  wine_id: rating.wine_id,
                  name: rating.wine_name,
                  winery: rating.winery_name,
                  region: exaData.region ?? null,
                  country: exaData.country ?? null,
                  grape_varieties: exaData.grape_varieties ?? [],
                  abv: null,
                  avg_rating: null,
                  ratings_count: null,
                  style_description: null,
                  food_pairings: [],
                  image_url: null,
                  vivino_url: null,
                };
                log.push(`  Exa enrichment for ${rating.wine_name}: region=${details.region ?? 'n/a'}, grapes=${details.grape_varieties.join(', ') || 'n/a'}`);
              }
            } catch { /* Exa fallback optional */ }
          }
        }
        // Persist geography into the rating so manifest + index can use it
        if (details?.country) rating.country = details.country;
        if (details?.region) rating.region = details.region;

        try {
          tastes = parseTasteProfile(await fetchWineTastes(rating.wine_id));
        } catch { /* taste profile optional */ }
      }

      // Exa tasting notes: only fetch when Vivino has no flavor data
      let exaTastingNotes: string | null = null;
      if ((!tastes || tastes.flavor_groups.length === 0) && process.env.EXA_API_KEY) {
        try {
          exaTastingNotes = await fetchExaTastingNotes(rating);
          if (exaTastingNotes) log.push(`  Exa tasting notes for ${rating.wine_name}: fetched`);
        } catch { /* optional */ }
      }

      try {
        fs.writeFileSync(filePath, formatWineNote(rating, details, tastes, today, exaTastingNotes), 'utf-8');
        written++;
      } catch (e) {
        errors++;
        log.push(`  Error writing ${filename}: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Merge with existing manifest for complete index
    let allRatings = newRatings;
    if (sinceDate && !args.full_sync) {
      let manifest: VivinoUserRating[] = [];
      try {
        if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch { /* empty */ }
      const newIds = new Set(newRatings.map(r => r.wine_id));
      allRatings = [...newRatings, ...manifest.filter(r => !newIds.has(r.wine_id))];
    }
    fs.writeFileSync(manifestPath, JSON.stringify(allRatings, null, 2), 'utf-8');
    fs.writeFileSync(path.join(OBSIDIAN_VAULT_PATH, 'Index.md'), formatIndex(allRatings, today), 'utf-8');
    log.push(`Wrote Index.md with ${allRatings.length} wines`);

    saveSyncState(syncStatePath, { last_sync_at: syncStartedAt, last_activity_id: startFrom ?? null, total_wines_synced: allRatings.length });

    return {
      content: [{
        type: 'text', text: [
          `Sync complete (${args.full_sync || isFirstRun ? 'full' : 'incremental'}).`,
          `  Written: ${written}  Skipped: ${skipped}  Errors: ${errors}`,
          `  Index: ${allRatings.length} total wines`,
          `  Next incremental sync will pick up from: ${syncStartedAt}`,
          '', 'Log:', ...log,
        ].join('\n'),
      }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Sync failed: ${message}\n\nLog:\n${log.join('\n')}` }] };
  }
}
