import { describe, it, expect } from 'vitest';
import { renderBar } from '../tools/obsidian';

describe('renderBar', () => {
  it('renders all empty at 0', () => {
    expect(renderBar(0)).toBe('░'.repeat(10));
  });

  it('renders all full at 1', () => {
    expect(renderBar(1)).toBe('█'.repeat(10));
  });

  it('renders half at 0.5', () => {
    expect(renderBar(0.5)).toBe('█'.repeat(5) + '░'.repeat(5));
  });

  it('renders 3 blocks at 0.3', () => {
    expect(renderBar(0.3)).toBe('█'.repeat(3) + '░'.repeat(7));
  });

  it('clamps negative values to 0 (was crashing: -3.1 → repeat(-31))', () => {
    expect(renderBar(-3.1)).toBe('░'.repeat(10));
    expect(renderBar(-0.1)).toBe('░'.repeat(10));
  });

  it('clamps values over 1 to 1 (was crashing: 3.1 → 10-31 = repeat(-21))', () => {
    expect(renderBar(3.1)).toBe('█'.repeat(10));
    expect(renderBar(1.5)).toBe('█'.repeat(10));
  });

  it('handles NaN safely (coerces to 0 in repeat)', () => {
    // Math.max(0, Math.min(1, NaN)) = NaN → Math.round(NaN*10) = NaN → repeat(NaN) = ''
    // Documenting actual behavior: ''.repeat(0 full) + ''.repeat(NaN) → no throw
    expect(() => renderBar(NaN)).not.toThrow();
  });

  it('output is always exactly 10 characters wide', () => {
    for (const val of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const bar = renderBar(val);
      expect(bar.length).toBe(10);
    }
  });
});
