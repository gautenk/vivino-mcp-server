import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { fetchWineSearch } from '../client';

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
