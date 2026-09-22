import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchWineDetails, mockFetchWineTastes } = vi.hoisted(() => ({
  mockFetchWineDetails: vi.fn(),
  mockFetchWineTastes: vi.fn(),
}));

vi.mock('../client', () => ({
  fetchWineDetails: mockFetchWineDetails,
  fetchWineTastes: mockFetchWineTastes,
}));

import { getWineDetails } from '../tools/wines';

describe('getWineDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchWineDetails.mockResolvedValue({
      wine: { id: 1, name: 'Test', winery: { name: 'Test Winery' } },
    });
  });

  it('passes vintage_id through as the authoritative lookup id when given', async () => {
    await getWineDetails({ wine_id: 42, vintage_id: 99001, wine_url: '/en/wines/w/42' });
    expect(mockFetchWineDetails).toHaveBeenCalledWith(42, 99001, '/en/wines/w/42');
  });

  it('passes wine_url through with a null vintage_id so the scrape fallback can use it', async () => {
    await getWineDetails({ wine_id: 42, wine_url: '/en/wines/w/42' });
    expect(mockFetchWineDetails).toHaveBeenCalledWith(42, null, '/en/wines/w/42');
  });

  it('passes null/null when neither vintage_id nor wine_url is given (id-only best-effort lookup)', async () => {
    await getWineDetails({ wine_id: 42 });
    expect(mockFetchWineDetails).toHaveBeenCalledWith(42, null, null);
  });
});
