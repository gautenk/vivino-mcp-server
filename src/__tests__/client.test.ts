import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGet, mockCreate } = vi.hoisted(() => {
  const mockGet = vi.fn().mockResolvedValue({ data: { explore_vintage: { matches: [] } } });
  const mockCreate = vi.fn(() => ({ get: mockGet }));
  return { mockGet, mockCreate };
});

vi.mock('axios', () => ({
  default: {
    get: mockGet,
    create: mockCreate,
  },
}));

import {
  fetchWineSearch, resolveRegionFromQuery, sessionCookieHeader, fetchActivities, clearCache,
  fetchCellarPage, fetchCellarExport, parseInertiaPage, VivinoFormatError,
} from '../client';

describe('sessionCookieHeader', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('names a bare session value with _ruby-web_session', () => {
    vi.stubEnv('VIVINO_SESSION_COOKIE', 'abc%2Fdef--123');
    expect(sessionCookieHeader()).toBe('_ruby-web_session=abc%2Fdef--123');
  });

  it('passes a full Cookie header through unchanged', () => {
    vi.stubEnv('VIVINO_SESSION_COOKIE', '_ruby-web_session=abc; other=1');
    expect(sessionCookieHeader()).toBe('_ruby-web_session=abc; other=1');
  });

  it('returns undefined when unset or blank', () => {
    vi.stubEnv('VIVINO_SESSION_COOKIE', '  ');
    expect(sessionCookieHeader()).toBeUndefined();
  });
});

describe('fetchWineSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { explore_vintage: { matches: [] } } });
  });

  it('adds a default wine_type_ids filter when the caller gave no filter (bare query)', async () => {
    await fetchWineSearch({ query: 'barolo' });
    const [, config] = mockGet.mock.calls[0];
    expect(config.params['wine_type_ids[]']).toBeDefined();
    expect(config.params['wine_type_ids[]'].length).toBeGreaterThan(0);
  });

  it('does not override an explicit filter the caller provided', async () => {
    await fetchWineSearch({ query: 'barolo', country_codes: ['it'] });
    const [, config] = mockGet.mock.calls[0];
    expect(config.params['country_codes[]']).toEqual(['it']);
    expect(config.params['wine_type_ids[]']).toBeUndefined();
  });

  it('does not add a default filter when an explicit wine_type_ids was given', async () => {
    await fetchWineSearch({ query: 'barolo', wine_type_ids: [1] });
    const [, config] = mockGet.mock.calls[0];
    expect(config.params['wine_type_ids[]']).toEqual([1]);
  });
});

describe('resolveRegionFromQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unwraps the { regions: [...] } response shape (not a bare array)', async () => {
    mockGet.mockResolvedValue({
      data: { regions: [{ id: 683, name: 'Chianti', parent_id: 394 }] },
    });
    const result = await resolveRegionFromQuery('Chianti');
    expect(result).toEqual({ id: 683, name: 'Chianti' });
  });

  it('prefers an exact case-insensitive name match over the API\'s own result order', async () => {
    // Confirmed live: searching "chianti" returns 11 results with the real
    // "Chianti" region (id 683) listed LAST, after every sub-region
    // (Chianti Rùfina, Chianti Classico, ...). Taking regions[0] would
    // silently resolve to the wrong, narrower region.
    mockGet.mockResolvedValue({
      data: {
        regions: [
          { id: 962, name: 'Chianti Rùfina', parent_id: 683 },
          { id: 1798, name: 'Chianti Classico', parent_id: 683 },
          { id: 683, name: 'Chianti', parent_id: 394 },
        ],
      },
    });
    const result = await resolveRegionFromQuery('chianti'); // different case on purpose
    expect(result).toEqual({ id: 683, name: 'Chianti' });
  });

  it('falls back to the first result when no exact match exists', async () => {
    mockGet.mockResolvedValue({
      data: { regions: [{ id: 1798, name: 'Chianti Classico', parent_id: 683 }] },
    });
    const result = await resolveRegionFromQuery('chianti classic'); // no exact match
    expect(result).toEqual({ id: 1798, name: 'Chianti Classico' });
  });

  it('returns null when nothing matches', async () => {
    mockGet.mockResolvedValue({ data: { regions: [] } });
    const result = await resolveRegionFromQuery('Sassicaia');
    expect(result).toBeNull();
  });
});

describe('fetchActivities throttling (A-U9)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it('spaces consecutive batch requests by at least 700 ms', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VIVINO_USER_ID', '1');
    clearCache();
    const times: number[] = [];
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/activities')) times.push(Date.now());
      return { data: '<meta name="csrf-token" content="t">' };
    });
    const pending = (async () => {
      await fetchActivities(10);
      await fetchActivities(10, 'a');
      await fetchActivities(10, 'b');
    })();
    await vi.runAllTimersAsync();
    await pending;
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(700);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(700);
  });

  it('passes a 429 straight through when retry429 is false', async () => {
    vi.stubEnv('VIVINO_USER_ID', '1');
    clearCache();
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/activities')) throw { response: { status: 429, headers: {} } };
      return { data: '<meta name="csrf-token" content="t">' };
    });
    await expect(fetchActivities(10, undefined, { retry429: false }))
      .rejects.toMatchObject({ response: { status: 429 } });
  });
});

function pageHtml(page: unknown): string {
  const attr = JSON.stringify(page).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<html><body><div id="app" data-page="${attr}"></div></body></html>`;
}

const cellarProps = (entries: unknown[] = []) =>
  ({ cellar_id: 42, total_count: entries.length, entries, statistics: {} });

describe('cellar client', () => {
  beforeEach(() => { clearCache(); vi.clearAllMocks(); });

  it('parseInertiaPage decodes the data-page attribute, including entities in values', () => {
    const { version, props } = parseInertiaPage(
      pageHtml({ version: 'v1', props: cellarProps([{ note: 'Kjøpt "på" Polet & co' }]) })
    );
    expect(version).toBe('v1');
    expect((props.entries[0] as { note: string }).note).toBe('Kjøpt "på" Polet & co');
  });

  it('bootstraps version and cellar_id from HTML, then requests JSON with Inertia headers', async () => {
    mockGet
      .mockResolvedValueOnce({ data: pageHtml({ version: 'v1', props: cellarProps() }) })
      .mockResolvedValueOnce({ data: { props: cellarProps([{}]) } });
    const props = await fetchCellarPage(2, 50);
    expect(props.entries).toHaveLength(1);
    const [url, config] = mockGet.mock.calls[1];
    expect(url).toMatch(/\/en\/cellars\/42$/);
    expect(config.params).toEqual({ page: 2, per_page: 50 });
    expect(config.headers['X-Inertia']).toBe('true');
    expect(config.headers['X-Inertia-Version']).toBe('v1');
  });

  it('re-reads the asset version once on 409', async () => {
    mockGet
      .mockResolvedValueOnce({ data: pageHtml({ version: 'old', props: cellarProps() }) })
      .mockRejectedValueOnce({ response: { status: 409, headers: {} } })
      .mockResolvedValueOnce({ data: pageHtml({ version: 'new', props: cellarProps() }) })
      .mockResolvedValueOnce({ data: { props: cellarProps([{}, {}]) } });
    const props = await fetchCellarPage(1, 50);
    expect(props.entries).toHaveLength(2);
    expect(mockGet.mock.calls[3][1].headers['X-Inertia-Version']).toBe('new');
  });

  it('C-U13: an HTML page without data-page is a clear error, not an empty cellar', async () => {
    mockGet.mockResolvedValueOnce({ data: '<html><body>Log in</body></html>' });
    await expect(fetchCellarPage(1, 50)).rejects.toThrow(/data-page/);
  });

  it('C-U13: JSON of an unexpected shape is a clear error', async () => {
    mockGet
      .mockResolvedValueOnce({ data: pageHtml({ version: 'v1', props: cellarProps() }) })
      .mockResolvedValueOnce({ data: { props: { items: [] } } });
    await expect(fetchCellarPage(1, 50)).rejects.toBeInstanceOf(VivinoFormatError);
  });

  it('fetchCellarExport rejects a non-CSV response', async () => {
    mockGet.mockResolvedValueOnce({ data: '<html/>', headers: { 'content-type': 'text/html' } });
    await expect(fetchCellarExport(42)).rejects.toThrow(/not text\/csv/);
  });
});
