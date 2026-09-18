import { describe, it, expect } from 'vitest';
import { SAMPLES, findSample } from '../lib/samples';

/**
 * The one-click samples on the intake form.
 *
 * They are the first thing anyone touches — a demo, a grader, or me testing a
 * change — so a broken one is worse than no sample at all. These assertions
 * cover the two ways they have actually been wrong: a source URL that was a
 * placeholder nobody replaced, and a set that had drifted so far into
 * marketing-industry topics that you could not tell a good article from a bad
 * one without working in marketing.
 */
describe('the intake samples', () => {
  it('has a unique, findable id for each', () => {
    const ids = SAMPLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(findSample(id)?.id).toBe(id);
  });

  it('covers the shapes the brief tests for', () => {
    // Raw idea with no source, idea anchored to a source URL, and a request
    // the audit should refuse. Losing any of these quietly removes a test
    // scenario from the demo.
    expect(SAMPLES.some((s) => !s.source_url)).toBe(true);
    expect(SAMPLES.some((s) => s.source_url)).toBe(true);
    expect(SAMPLES.some((s) => s.expect.includes('audit'))).toBe(true);
  });

  it('never ships a placeholder source URL', () => {
    // The previous set carried
    // "https://example.com/replace-me-with-a-real-article", which fails at the
    // fetch stage and makes the URL path look broken rather than unconfigured.
    for (const s of SAMPLES.filter((s) => s.source_url)) {
      expect(s.source_url, s.id).toMatch(/^https:\/\//);
      expect(s.source_url, s.id).not.toMatch(/example\.com|replace-me|your-url|TODO/i);
    }
  });

  it('is quick to run — depth and option count are the two levers', () => {
    // Research is the long pole and its cost scales with depth; every other
    // Claude stage scales with the option count. A sample that takes twenty
    // minutes does not get run, so it does not get tested.
    for (const s of SAMPLES) {
      expect(s.research_depth, s.id).toBe('quick');
      expect(s.option_count, s.id).toBeLessThanOrEqual(2);
    }
  });

  it('says how long it takes, so nobody sits watching a spinner', () => {
    for (const s of SAMPLES) {
      expect(s.expect, s.id).toMatch(/min|seconds/);
      expect(s.note.length, s.id).toBeGreaterThan(10);
    }
  });

  it('asks for at least one channel and a real audience', () => {
    for (const s of SAMPLES) {
      expect(s.channels_wanted.length, s.id).toBeGreaterThan(0);
      expect(s.raw_idea.trim().length, s.id).toBeGreaterThan(0);
      expect(s.target_audience.trim().length, s.id).toBeGreaterThan(0);
    }
  });
});
