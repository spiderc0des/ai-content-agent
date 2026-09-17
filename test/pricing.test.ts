import { describe, it, expect } from 'vitest';
import { costOf, cacheSavings, ratesFor, formatUsd, formatTokens } from '../lib/pricing';

const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * Four token counts, four different rates. Getting cache reads wrong by a
 * factor of ten is invisible in a total, which is exactly why this is tested
 * against figures worked by hand from the published price list.
 */
describe('costOf — claude-sonnet-5 at $2 / $10 / $2.50 / $0.20 per MTok', () => {
  it('prices a million of each token type at its own rate', () => {
    const M = 1_000_000;
    expect(costOf('claude-sonnet-5', { ...none, inputTokens: M })).toBeCloseTo(2, 6);
    expect(costOf('claude-sonnet-5', { ...none, outputTokens: M })).toBeCloseTo(10, 6);
    expect(costOf('claude-sonnet-5', { ...none, cacheWriteTokens: M })).toBeCloseTo(2.5, 6);
    expect(costOf('claude-sonnet-5', { ...none, cacheReadTokens: M })).toBeCloseTo(0.2, 6);
  });

  it('adds the four together', () => {
    // 10k in, 5k out, 20k cached read, 8k cache write
    // = 0.02 + 0.05 + 0.004 + 0.02 = 0.094
    const cost = costOf('claude-sonnet-5', {
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 8_000,
    });
    expect(cost).toBeCloseTo(0.094, 6);
  });

  it('charges nothing for nothing', () => {
    expect(costOf('claude-sonnet-5', none)).toBe(0);
  });

  it('does not treat cache reads as free', () => {
    // The tempting simplification. A run with a million cached tokens and
    // nothing else would report $0 and the page would look broken-cheap.
    expect(costOf('claude-sonnet-5', { ...none, cacheReadTokens: 1_000_000 })).toBeGreaterThan(0);
  });
});

describe('ratesFor', () => {
  it('matches a dated model id to its family', () => {
    // The API returns claude-sonnet-5-20260115, not claude-sonnet-5.
    const { rates, known } = ratesFor('claude-sonnet-5-20260115');
    expect(known).toBe(true);
    expect(rates.input).toBe(2);
  });

  it('prices opus higher than sonnet, as published', () => {
    expect(ratesFor('claude-opus-5').rates.output).toBe(25);
    expect(ratesFor('claude-sonnet-5').rates.output).toBe(10);
  });

  it('flags an unknown model rather than silently pricing it at zero', () => {
    // A substituted fallback model must show up as an estimate, not vanish.
    const { known, rates } = ratesFor('some-future-model');
    expect(known).toBe(false);
    expect(rates.input).toBeGreaterThan(0);
  });

  it('flags a null model the same way', () => {
    expect(ratesFor(null).known).toBe(false);
  });
});

describe('cacheSavings', () => {
  it('is the difference against paying full input rate for the same tokens', () => {
    // 1M read: $0.20 paid vs $2 not paid  → saves $1.80
    // 1M write: $2.50 paid vs $2 not paid → costs $0.50 more
    // net on both: $1.30
    const saved = cacheSavings('claude-sonnet-5', {
      ...none,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(saved).toBeCloseTo(1.3, 6);
  });

  it('never reports a negative saving', () => {
    // A cache written and never read costs MORE than not caching. Reporting
    // "saved -$0.50" on a dashboard is worse than reporting nothing.
    expect(cacheSavings('claude-sonnet-5', { ...none, cacheWriteTokens: 1_000_000 })).toBe(0);
  });

  it('is zero when nothing was cached', () => {
    expect(cacheSavings('claude-sonnet-5', { ...none, inputTokens: 50_000 })).toBe(0);
  });
});

describe('formatting', () => {
  it('keeps small amounts visible instead of rounding them to $0.00', () => {
    // A single stage costs fractions of a cent; two decimals makes the whole
    // per-stage table read as free.
    expect(formatUsd(0.00042)).toBe('$0.0004');
    expect(formatUsd(0.0)).toBe('$0');
    expect(formatUsd(0.234)).toBe('$0.234');
    expect(formatUsd(12.5)).toBe('$12.50');
  });

  it('abbreviates token counts', () => {
    expect(formatTokens(912)).toBe('912');
    expect(formatTokens(84_100)).toBe('84.1k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });
});
