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

import { fetchWineSearch, resolveRegionFromQuery, sessionCookieHeader } from '../client';

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
