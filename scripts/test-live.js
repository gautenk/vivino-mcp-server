#!/usr/bin/env node
// Live checks against vivino.com (docs/TESTPLAN-cellar-pagination.md, L-1..L-8
// and M-1). Never run by `npm test`. Run by hand before pushing:
//   npm run test:live            (builds first; needs VIVINO_* in .env or env)
// Writes a Markdown report to live-report.md (gitignored: it holds personal
// cellar data) and exits non-zero when a pass/fail check fails.
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Count every HTTP request the tools make (the client calls axios.get and
// an axios.create() instance at call time, so patching here is enough).
let requests = 0;
const realGet = axios.default.get.bind(axios.default);
axios.default.get = (...a) => { requests++; return realGet(...a); };
const realCreate = axios.default.create.bind(axios.default);
axios.default.create = (...a) => {
  const inst = realCreate(...a);
  const instGet = inst.get.bind(inst);
  inst.get = (...b) => { requests++; return instGet(...b); };
  return inst;
};

const dist = path.join(__dirname, '..', 'dist');
const client = require(path.join(dist, 'client.js'));
const { USER_AGENT } = require(path.join(dist, 'constants.js'));
const { getUserRatings } = require(path.join(dist, 'tools', 'ratings.js'));
const { getCellar } = require(path.join(dist, 'tools', 'cellar.js'));
const { searchWines } = require(path.join(dist, 'tools', 'search.js'));
const { getWineDetails } = require(path.join(dist, 'tools', 'wines.js'));
const { getWineReviews } = require(path.join(dist, 'tools', 'reviews.js'));

// MCP TypeScript SDK's default request timeout; override if the client differs.
const TOOL_TIMEOUT_MS = Number(process.env.LIVE_TOOL_TIMEOUT_MS ?? 60_000);

const report = [];
const failures = [];
const line = s => { report.push(s); console.log(s); };
const pass = (id, ok, detail) => {
  line(`- **${id}: ${ok ? 'PASS' : 'FAIL'}**${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(id);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseTool(res) {
  const text = res.content[0].text;
  if (/^Error/.test(text)) throw new Error(text);
  return JSON.parse(text);
}

async function timed(fn) {
  const before = requests;
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0, calls: requests - before };
}

async function allRatings(perPage) {
  const seen = [];
  let cursor;
  for (;;) {
    const r = parseTool(await getUserRatings({ page: 1, per_page: perPage, start_from: cursor }));
    if (r.warning) throw new Error(`rate-limited during L-2: ${r.warning}`);
    seen.push(...r.ratings);
    if (!r.has_more) return seen;
    cursor = r.next_start_from;
  }
}

async function l1() {
  line('\n## L-1 Size parameter probe (informational)');
  const userId = await client.resolveUserId();
  const csrf = await client.fetchCsrfToken();
  const headers = {
    'User-Agent': USER_AGENT, Cookie: client.sessionCookieHeader(), 'X-CSRF-Token': csrf,
    'X-Requested-With': 'XMLHttpRequest', Accept: 'text/javascript, application/javascript',
  };
  for (const params of [{}, { limit: 50 }, { per_page: 50 }, { count: 50 }]) {
    await sleep(800);
    const res = await realGet(`https://www.vivino.com/users/${userId}/activities`, { params, headers });
    const ids = new Set([...String(res.data).matchAll(/user-activity-(\d+)/g)].map(m => m[1]));
    line(`- \`${JSON.stringify(params)}\` → ${ids.size} activities`);
  }
}

async function l2() {
  line('\n## L-2 Full history, per_page 7 vs 100 (F2)');
  const key = r => `${r.wine_id}|${r.rated_at}|${r.user_rating}`;
  const a = await timed(() => allRatings(7));
  const b = await timed(() => allRatings(100));
  const ka = a.value.map(key);
  const kb = b.value.map(key);
  const sa = new Set(ka);
  const sb = new Set(kb);
  const onlyA = [...sa].filter(k => !sb.has(k));
  const onlyB = [...sb].filter(k => !sa.has(k));
  line(`- per_page 7: ${ka.length} ratings, ${a.calls} requests, ${(a.ms / 1000).toFixed(1)} s`);
  line(`- per_page 100: ${kb.length} ratings, ${b.calls} requests, ${(b.ms / 1000).toFixed(1)} s`);
  pass('L-2', onlyA.length === 0 && onlyB.length === 0 && sa.size === ka.length
    && sb.size === kb.length && ka.length === kb.length,
  `duplicates ${ka.length - sa.size}/${kb.length - sb.size}, only-in-7 ${onlyA.length}, ` +
  `only-in-100 ${onlyB.length}${onlyA.length + onlyB.length ? `: ${[...onlyA, ...onlyB].slice(0, 5).join(', ')}` : ''}`);
}

async function l3() {
  line('\n## L-3 Worst case: min_rating 4.8, per_page 100');
  const t = await timed(async () => parseTool(await getUserRatings({ page: 1, per_page: 100, min_rating: 4.8 })));
  pass('L-3', t.ms <= TOOL_TIMEOUT_MS,
    `${t.value.count} ratings, ${t.calls} requests, ${(t.ms / 1000).toFixed(1)} s ` +
    `(timeout ${TOOL_TIMEOUT_MS / 1000} s)${t.value.warning ? `, warning: ${t.value.warning}` : ''}`);
}

async function l4() {
  line('\n## L-4 Default per_page');
  const r = parseTool(await getUserRatings({ page: 1, per_page: 10 }));
  pass('L-4', r.count === 10 && r.has_more === true, `count ${r.count}, has_more ${r.has_more}`);
}

let cellar;
async function l5() {
  line('\n## L-5 Cellar, default call');
  const t = await timed(async () => parseTool(await getCellar({ page: 1, enrich: false })));
  cellar = t.value;
  const required = ['wine_id', 'vintage_id', 'wine_name', 'quantity'];
  const missing = cellar.wines.filter(w => required.some(k => w[k] == null || w[k] === '')
    || !('vintage' in w) || !('winery_name' in w));
  const bottles = cellar.wines.reduce((s, w) => s + w.quantity, 0);
  line(`- ${cellar.count} wines, ${bottles} bottles, ${t.calls} requests, ${(t.ms / 1000).toFixed(1)} s`);
  line(`- Vivino statistics: ${JSON.stringify(cellar.vivino_statistics)}`);
  if (cellar.vivino_statistics.wines <= 50) {
    line('- The cellar fits in one internal page (50): multi-page paging is covered only offline (C-U4).');
  }
  if (cellar.warning) line(`- warning: ${cellar.warning}`);
  pass('L-5', missing.length === 0 && bottles === cellar.vivino_statistics.bottles
    && cellar.count === cellar.vivino_statistics.wines,
  `required fields missing on ${missing.length}; bottles ${bottles} vs Vivino ${cellar.vivino_statistics.bottles}`);
}

async function l6() {
  line('\n## L-6 Cellar vs CSV export (F3b)');
  const csv = await client.fetchCellarExport(cellar.cellar_id);
  const rows = csv.split(/\r?\n/).slice(1).filter(Boolean);
  const fromCsv = new Map();
  for (const row of rows) {
    const id = Number(row.match(/\/wines\/(\d+)/)?.[1]);
    fromCsv.set(id, (fromCsv.get(id) ?? 0) + 1);
  }
  const fromTool = new Map(cellar.wines.map(w => [w.vintage_id, w.quantity]));
  const diffs = [];
  for (const id of new Set([...fromCsv.keys(), ...fromTool.keys()])) {
    if (fromCsv.get(id) !== fromTool.get(id)) {
      diffs.push(`vintage ${id}: CSV ${fromCsv.get(id) ?? 0}, tool ${fromTool.get(id) ?? 0}`);
    }
  }
  diffs.forEach(d => line(`  - ${d}`));
  pass('L-6', diffs.length === 0, `${fromCsv.size} wines in CSV, ${fromTool.size} from the tool, ${diffs.length} differences`);
}

async function l7() {
  line('\n## L-7 enrich: true on 3 wines');
  const t = await timed(async () => parseTool(await getCellar({ page: 1, per_page: 3, enrich: true })));
  const filled = t.value.wines.filter(w => w.taste_profile || w.abv != null || (w.food_pairings ?? []).length);
  pass('L-7', t.value.count === 3 && filled.length === 3,
    `${filled.length}/3 wines got enrich fields, ${t.calls} requests, ${(t.ms / 1000).toFixed(1)} s`);
}

async function l8() {
  line('\n## L-8 Regression smoke');
  const search = parseTool(await searchWines({ query: 'barolo', page: 1, per_page: 5 }));
  const hit = search.results?.[0];
  pass('L-8 search', !!hit, hit ? `${hit.name} (${hit.wine_id})` : JSON.stringify(search).slice(0, 120));
  if (!hit) return;
  const details = parseTool(await getWineDetails({ wine_id: hit.wine_id, vintage_id: hit.vintage_id ?? undefined }));
  pass('L-8 details', details.wine_id === hit.wine_id, `${details.name} / ${details.winery}`);
  const reviews = parseTool(await getWineReviews({ wine_id: hit.wine_id, page: 1, per_page: 3 }));
  const list = reviews.reviews;
  pass('L-8 reviews', Array.isArray(list) && list.length > 0, `${Array.isArray(list) ? list.length : 0} reviews`);
}

function m1() {
  line('\n## M-1 For manual check against the Vivino app');
  line(`${cellar.count} wines, ${cellar.wines.reduce((s, w) => s + w.quantity, 0)} bottles. Five random wines:`);
  const pick = [...cellar.wines].sort(() => Math.random() - 0.5).slice(0, 5);
  for (const w of pick) {
    line(`- ${w.winery_name ?? '(no winery)'} ${w.wine_name} ${w.vintage ?? 'NV'}: ${w.quantity} bottle(s)`);
  }
}

(async () => {
  line(`# Live test report — ${new Date().toISOString()}`);
  const session = await realGet('https://www.vivino.com/api/session', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Cookie: client.sessionCookieHeader() },
  });
  pass('session', session.data?.is_signed_in === true, `is_signed_in ${session.data?.is_signed_in}`);
  if (!session.data?.is_signed_in) throw new Error('Not signed in — fix VIVINO_SESSION_COOKIE first.');

  const only = process.argv.slice(2).map(s => s.toUpperCase());
  const steps = { 'L-1': l1, 'L-2': l2, 'L-3': l3, 'L-4': l4, 'L-5': l5, 'L-6': l6, 'L-7': l7, 'L-8': l8 };
  for (const [id, fn] of Object.entries(steps)) {
    if (only.length && !only.includes(id) && !(id === 'L-5' && only.some(o => o === 'L-6'))) continue;
    try { await fn(); } catch (err) { pass(id, false, err instanceof Error ? err.message : String(err)); }
  }
  if (cellar) m1();
})()
  .catch(err => { line(`\n**Aborted:** ${err instanceof Error ? err.message : err}`); failures.push('aborted'); })
  .finally(() => {
    line(`\n**Result:** ${failures.length ? `FAIL (${failures.join(', ')})` : 'all checks passed'}`);
    const out = process.env.LIVE_REPORT_PATH ?? path.join(__dirname, '..', 'live-report.md');
    fs.writeFileSync(out, report.join('\n') + '\n');
    console.log(`\nReport written to ${out}`);
    process.exitCode = failures.length ? 1 : 0;
  });
