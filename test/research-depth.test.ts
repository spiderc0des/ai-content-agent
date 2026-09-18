import { describe, it, expect } from 'vitest';
import { depthProfile, RESEARCH_DEPTHS, relativeCost } from '../lib/research-depth';

/**
 * Research is the most expensive stage in the pipeline, and it drives a second
 * cost that is easy to miss: retrieval makes one Claude call per readable
 * source. So maxSources is not just "how much evidence" — it is a multiplier
 * on a whole other stage.
 */
describe('research depth profiles', () => {
  it('gets strictly more expensive in one direction', () => {
    const [quick, standard, deep] = RESEARCH_DEPTHS.map(depthProfile);
    for (const key of ['maxSearches', 'maxFetches', 'maxSources', 'minReadable'] as const) {
      expect(quick![key], key).toBeLessThan(standard![key]);
      expect(standard![key], key).toBeLessThan(deep![key]);
    }
  });

  it('keeps Standard as the current behaviour, so existing requests are unchanged', () => {
    const s = depthProfile('standard');
    expect(s.maxSearches).toBe(8);
    expect(s.maxFetches).toBe(16);
    expect(s.minReadable).toBe(7);
    expect(s.maxRounds).toBe(3);
    expect(s.maxSources).toBe(12);
  });

  it('gives Quick a single round', () => {
    // A top-up is a whole extra research call — the single most expensive
    // thing the pipeline can decide to do. "Quick" that still triples its
    // research calls would not be quick.
    expect(depthProfile('quick').maxRounds).toBe(1);
  });

  it('always fetches more than it searches', () => {
    // Publishers block automated fetching, so the fetch budget has to outlast
    // the search budget or a bad draw leaves nothing readable.
    for (const d of RESEARCH_DEPTHS) {
      const p = depthProfile(d);
      expect(p.maxFetches, d).toBeGreaterThan(p.maxSearches);
    }
  });

  it('never asks for more readable sources than it will keep', () => {
    // minReadable above maxSources would make the top-up loop unsatisfiable,
    // burning every round and then giving up anyway.
    for (const d of RESEARCH_DEPTHS) {
      const p = depthProfile(d);
      expect(p.minReadable, d).toBeLessThanOrEqual(p.maxSources);
    }
  });

  it('falls back to Standard for anything unrecognised', () => {
    for (const bad of [null, undefined, '', 'thorough']) {
      expect(depthProfile(bad).label).toBe('Standard');
    }
  });

  it('describes cost as a ratio rather than inventing a price', () => {
    expect(relativeCost('standard')).toBe('the default');
    expect(relativeCost('quick')).toMatch(/%/);
    expect(relativeCost('deep')).toMatch(/%/);
  });
});
