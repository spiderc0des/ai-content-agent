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
    const keys = [
      'maxSearches',
      'maxFetches',
      'maxSources',
      'minReadable',
      // The time knobs. These were added after a 'quick' run took fourteen
      // minutes: the source budgets had been halved but the brief had not, and
      // the brief is what the wall clock is actually spent on. If a future
      // edit moves the source knobs without moving these, this fails.
      'briefWords',
      'maxOutputTokens',
      'maxContentTokens',
    ] as const;
    for (const key of keys) {
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

  it('bounds the brief well inside the output ceiling', () => {
    // Hitting max_tokens is a stage FAILURE, not a truncation — withRetry
    // treats it as one. So the ceiling has to leave room for the brief plus
    // however much adaptive thinking the model decides to do on top. Four
    // tokens per word is generous for prose; the rest is thinking headroom.
    for (const d of RESEARCH_DEPTHS) {
      const p = depthProfile(d);
      expect(p.maxOutputTokens, d).toBeGreaterThan(p.briefWords * 4 * 2);
    }
  });

  it('gives Quick a brief it can write quickly', () => {
    // Measured: the research call returned 8,000–21,000 output tokens and took
    // 149–533 seconds, against 600–2,000 input tokens. Generation is the wall
    // clock. A quick depth has to bound what gets written, not just what gets
    // read.
    const q = depthProfile('quick');
    expect(q.briefWords).toBeLessThanOrEqual(500);
    expect(q.maxContinuations).toBe(1);
  });

  it('tells the person picking a depth roughly what they are waiting for', () => {
    for (const d of RESEARCH_DEPTHS) {
      expect(depthProfile(d).pace, d).toMatch(/minutes/);
    }
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
