import { describe, it, expect } from 'vitest';
import { excerptsFrom, applyKeepFloor } from '../lib/excerpts';

const DIGEST = `Relevant material from "A source":

> "Teams with a named owner resolve issues forty per cent faster."
Why it matters: a citable number for the central claim.

> "Most organisations treat this as a checklist rather than as a system."
Why it matters: states the problem the article argues against.`;

describe('excerptsFrom', () => {
  it('prefers the API citations, which are text the model actually read', () => {
    const out = excerptsFrom(DIGEST, [
      {
        type: 'char_location',
        cited_text: 'Teams with a named owner resolve issues forty per cent faster.',
        start_char_index: 0,
        end_char_index: 61,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].quote).toContain('forty per cent faster');
    expect(out[0].locator).toMatchObject({ type: 'char_location' });
  });

  it('carries the "why it matters" line across from the digest prose', () => {
    const out = excerptsFrom(DIGEST, [
      { cited_text: 'Teams with a named owner resolve issues forty per cent faster.' },
    ]);
    expect(out[0].gist).toBe('a citable number for the central claim.');
  });

  it('falls back to the blockquotes when no citations came back', () => {
    const out = excerptsFrom(DIGEST, []);
    expect(out).toHaveLength(2);
    expect(out[1].gist).toContain('states the problem');
  });

  it('drops quotes too short to support anything', () => {
    expect(excerptsFrom('> "Yes."\n', [])).toHaveLength(0);
  });

  it('deduplicates identical quotes', () => {
    const out = excerptsFrom(DIGEST, [
      { cited_text: 'Most organisations treat this as a checklist rather than as a system.' },
      { cited_text: 'Most organisations treat this as a checklist rather than as a system.' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('caps how many excerpts one source can contribute', () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `> "A sufficiently long quoted sentence number ${i}."\nWhy it matters: reason ${i}`,
    ).join('\n\n');
    expect(excerptsFrom(many, []).length).toBeLessThanOrEqual(12);
  });
});

/**
 * The floor that stops selection from emptying the evidence base. This is the
 * second half of a pair of real failures: research parked a request because no
 * page could be read, a person pasted one source by hand, retrieval turned it
 * into a single excerpt — and selection then dropped that one excerpt as
 * insufficiently selective, failing the request all over again.
 */
describe('applyKeepFloor', () => {
  const d = (id: string, keep: boolean, relevance: number) => ({
    excerpt_id: id,
    keep,
    relevance,
  });

  it('leaves a normal selection completely alone', () => {
    const input = [d('a', true, 0.9), d('b', false, 0.2), d('c', true, 0.7)];
    const { decisions, floored } = applyKeepFloor(input);
    expect(floored).toBe(false);
    expect(decisions).toBe(input);
  });

  it('rescues the single excerpt a thin corpus produced', () => {
    const { decisions, floored } = applyKeepFloor([d('only', false, 0.4)]);
    expect(floored).toBe(true);
    expect(decisions.filter((x) => x.keep).map((x) => x.excerpt_id)).toEqual(['only']);
  });

  it('rescues the highest-scoring ones, using the model ranking it still gave', () => {
    const { decisions, floored } = applyKeepFloor([
      d('low', false, 0.1),
      d('best', false, 0.95),
      d('mid', false, 0.5),
      d('second', false, 0.8),
      d('worst', false, 0.02),
    ]);
    expect(floored).toBe(true);
    const kept = decisions.filter((x) => x.keep).map((x) => x.excerpt_id).sort();
    expect(kept).toEqual(['best', 'mid', 'second']);
  });

  it('never invents decisions when there were none to begin with', () => {
    const { decisions, floored } = applyKeepFloor([]);
    expect(floored).toBe(false);
    expect(decisions).toEqual([]);
  });

  it('keeps every decision in the output, not only the rescued ones', () => {
    const { decisions } = applyKeepFloor([d('a', false, 0.9), d('b', false, 0.1)], 1);
    expect(decisions).toHaveLength(2);
    expect(decisions.find((x) => x.excerpt_id === 'b')?.keep).toBe(false);
  });
});
