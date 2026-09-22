import { describe, it, expect } from 'vitest';
import { parseTasteProfile, parseWineDetails } from '../tools/wines';

describe('parseTasteProfile', () => {
  it('parses valid 0–1 values', () => {
    const raw = { tastes: { structure: { acidity: 0.7, sweetness: 0.2, tannin: 0.5, intensity: 0.8, fizziness: 0.1 }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBe(0.7);
    expect(result.structure.sweetness).toBe(0.2);
    expect(result.structure.tannin).toBe(0.5);
    expect(result.structure.intensity).toBe(0.8);
    expect(result.structure.fizziness).toBe(0.1);
  });

  it('clamps negative values to 0 (the original crash trigger)', () => {
    const raw = { tastes: { structure: { acidity: -3.1, sweetness: -0.5, tannin: -0.001 }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBe(0);
    expect(result.structure.sweetness).toBe(0);
    expect(result.structure.tannin).toBe(0);
  });

  it('scales down values on a ~1-5 reading (confirmed live against Vivino) instead of clamping to 1', () => {
    const raw = { tastes: { structure: { acidity: 3.1, intensity: 1.5 }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeCloseTo(0.62);
    expect(result.structure.intensity).toBeCloseTo(0.3);
  });

  it('still clamps an out-of-range reading above 5 to 1', () => {
    const raw = { tastes: { structure: { acidity: 12 }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBe(1);
  });

  it('keeps null fields as null', () => {
    const raw = { tastes: { structure: { acidity: null, sweetness: undefined }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeNull();
    expect(result.structure.sweetness).toBeNull();
  });

  it('returns all nulls when structure key is missing', () => {
    const raw = { tastes: { flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeNull();
    expect(result.structure.fizziness).toBeNull();
  });

  it('handles d.tastes = null by falling back to d (??  operator)', () => {
    // null ?? d → d; structure would be {} → all nulls
    const raw = { tastes: null };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeNull();
  });

  it('returns NaN values as null (non-finite check)', () => {
    const raw = { tastes: { structure: { acidity: NaN, intensity: Infinity }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeNull();
    expect(result.structure.intensity).toBeNull();
  });

  it('parses flavor groups', () => {
    const raw = {
      tastes: {
        structure: {},
        flavor: [
          { group: 'fruit', primary_keywords: [{ name: 'cherry' }, { name: 'plum' }] },
          { group: 'spice', primary_keywords: [{ name: 'pepper' }] },
        ],
      },
    };
    const result = parseTasteProfile(raw);
    expect(result.flavor_groups).toHaveLength(2);
    expect(result.flavor_groups[0].group).toBe('fruit');
    expect(result.flavor_groups[0].primary_keywords).toEqual(['cherry', 'plum']);
  });
});

describe('parseWineDetails', () => {
  const validRaw = {
    vintage: {
      id: 99001,
      // Confirmed live (2026-09-22): the label image is a protocol-relative
      // URL on the vintage object, not nested under wine.
      image: { location: '//images.vivino.com/thumbs/test_pl.png' },
      wine: {
        id: 12345,
        name: 'Cabernet Sauvignon',
        winery: { name: 'Chateau Test' },
        region: { name: 'Napa Valley', country: { name: 'United States' } },
        grapes: [{ name: 'Cabernet Sauvignon' }, { name: 'Merlot' }],
        alcohol: 14.5,
        statistics: { ratings_average: 4.2, ratings_count: 1500 },
        // Confirmed live: the field is "foods" (plural), not "food".
        foods: [{ name: 'beef' }, { name: 'lamb' }],
        style: { description: 'Full-bodied red with dark fruit' },
        seo_name: 'chateau-test-cabernet-sauvignon',
      },
    },
  };

  it('parses a complete valid API response', () => {
    const result = parseWineDetails(validRaw);
    expect(result.wine_id).toBe(12345);
    expect(result.name).toBe('Cabernet Sauvignon');
    expect(result.winery).toBe('Chateau Test');
    expect(result.region).toBe('Napa Valley');
    expect(result.country).toBe('United States');
    expect(result.grape_varieties).toEqual(['Cabernet Sauvignon', 'Merlot']);
    expect(result.abv).toBe(14.5);
    expect(result.avg_rating).toBe(4.2);
    expect(result.ratings_count).toBe(1500);
    expect(result.food_pairings).toEqual(['beef', 'lamb']);
    expect(result.style_description).toBe('Full-bodied red with dark fruit');
    expect(result.image_url).toBe('https://images.vivino.com/thumbs/test_pl.png');
    expect(result.vivino_url).toBe('https://www.vivino.com/chateau-test-cabernet-sauvignon/w/99001');
  });

  it('returns nulls and empty arrays for missing optional fields', () => {
    const raw = { wine: { id: 1, name: 'Mystery', winery: { name: 'Unknown' } } };
    const result = parseWineDetails(raw);
    expect(result.region).toBeNull();
    expect(result.country).toBeNull();
    expect(result.grape_varieties).toEqual([]);
    expect(result.abv).toBeNull();
    expect(result.avg_rating).toBeNull();
    expect(result.ratings_count).toBeNull();
    expect(result.food_pairings).toEqual([]);
    expect(result.style_description).toBeNull();
    expect(result.vivino_url).toBeNull();
  });

  it('handles top-level wine object (no wrapper)', () => {
    const raw = { id: 99, name: 'Flat Wine', winery: { name: 'Flat Winery' } };
    const result = parseWineDetails(raw);
    expect(result.wine_id).toBe(99);
    expect(result.name).toBe('Flat Wine');
  });
});
