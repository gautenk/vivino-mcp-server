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

  it('passes wine_url through to fetchWineDetails so the 404 fallback can use it', async () => {
    await getWineDetails({ wine_id: 42, wine_url: '/en/wines/w/42' });
    expect(mockFetchWineDetails).toHaveBeenCalledWith(42, '/en/wines/w/42');
  });

  it('passes null when no wine_url is given (id-only lookup, matching prior behavior)', async () => {
    await getWineDetails({ wine_id: 42 });
    expect(mockFetchWineDetails).toHaveBeenCalledWith(42, null);
  });
});
