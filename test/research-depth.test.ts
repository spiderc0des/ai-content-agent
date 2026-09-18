import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('is sized to fit inside the platform function limit', () => {
    // Research is the ONLY stage that can outlast a 300-second function, and
    // the one failure no machinery recovers from: slicing happens BETWEEN
    // stages, so it cannot help a single stage that is too long. A killed
    // research call loses every page it fetched and starts again from nothing.
    //
    // Measured before these budgets were cut: standard reached 657s and quick
    // reached 290s, against a 300s limit. Time tracks fetches, because each
    // fetch is a real HTTP request to a real website.
    //
    // These ceilings are what the measurements support. Raising them is a
    // decision to make the slowest runs unable to finish in production.
    const CEILINGS = {
      quick: { maxFetches: 5, maxSearches: 3, maxSources: 5 },
      standard: { maxFetches: 9, maxSearches: 5, maxSources: 8 },
      deep: { maxFetches: 14, maxSearches: 8, maxSources: 12 },
    } as const;

    for (const [depth, caps] of Object.entries(CEILINGS)) {
      const p = depthProfile(depth);
      for (const [key, cap] of Object.entries(caps)) {
        expect(p[key as keyof typeof caps], `${depth}.${key}`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('does not let a smaller budget cost more through extra rounds', () => {
    // Cutting fetches without cutting minReadable is self-defeating: research
    // comes back short, goes round again, and a whole extra call costs more
    // than the fetches saved. The floor has to stay reachable inside one
    // round's fetch budget.
    for (const d of RESEARCH_DEPTHS) {
      const p = depthProfile(d);
      expect(p.minReadable, d).toBeLessThan(p.maxFetches);
      expect(p.maxRounds, d).toBeLessThanOrEqual(2);
    }
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

/**
 * A top-up round is a whole extra research call, and the sum was unbounded.
 *
 * Measured: one real run spent 793 seconds across two rounds — roughly 400s
 * each — against a platform that kills a function at 300. The per-call
 * deadline cannot catch that, because each call is individually reasonable.
 * What is unreasonable is starting a second one when there is no time left to
 * use the answer.
 */
describe('research stops going back for more once time is spent', () => {
  const PIPELINE = readFileSync(join(process.cwd(), 'lib', 'pipeline.ts'), 'utf8');

  it('bounds the stage by elapsed time, not only by round count', () => {
    const m = /const RESEARCH_ROUND_BUDGET_MS = ([\d_]+);/.exec(PIPELINE);
    expect(m, 'research must bound its total time').not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ''));
    // Room for one round inside a 300s function, and not room for two.
    expect(ms).toBeLessThan(300_000);
    expect(ms).toBeGreaterThan(120_000);
  });

  it('checks the budget before starting a round, not after', () => {
    const at = PIPELINE.indexOf('for (let round = 1; round <= depth.maxRounds');
    expect(at).toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, at + 1600);
    expect(body).toContain('RESEARCH_ROUND_BUDGET_MS');
    // The round already running finishes — abandoning a call that is about to
    // answer throws away everything it fetched.
    expect(body).toMatch(/round > 1/);
  });

  it('never lets rounds multiply past what one function can hold', () => {
    for (const d of RESEARCH_DEPTHS) {
      expect(depthProfile(d).maxRounds, d).toBeLessThanOrEqual(2);
    }
  });
});
