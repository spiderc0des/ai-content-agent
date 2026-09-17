import { describe, it, expect } from 'vitest';
import { composeXPost, composeLinkedInPost, xLength, X_MAX_CHARS } from '../lib/publishers/compose';

/**
 * The step where a post becomes irreversible. X rejects a post one character
 * over 280 outright rather than truncating, so the arithmetic here is the
 * difference between a post going out and a queue row failing at 3am.
 */
describe('composeXPost', () => {
  const ok = (body: string, tags: string[] = []) => {
    const r = composeXPost(body, tags);
    if (!r.ok) throw new Error(r.error);
    return r.text;
  };

  it('leaves an untagged post exactly as approved', () => {
    expect(ok('A clean post.')).toBe('A clean post.');
  });

  it('puts tags at the end, not the start', () => {
    // A post OPENING with a mention is shown only to people who follow both
    // accounts — it quietly halves the reach of every tagged post.
    const text = ok('The insight goes here.', ['@koyatalent']);
    expect(text.startsWith('The insight')).toBe(true);
    expect(text.endsWith('@koyatalent')).toBe(true);
  });

  it('counts the tags toward the limit, not just the body', () => {
    const body = 'x'.repeat(270); // passes its own rule check at 280
    const r = composeXPost(body, ['@koyatalent']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The message shows its own arithmetic: the post's own length, what the
      // tags added, the total, and the overage. "288 characters" on its own
      // invites "288 of what?", because the post passed its 280 check before
      // the tags existed.
      expect(r.error).toContain('the post is 270 characters');
      expect(r.error).toContain('adds');
      expect(r.error).toContain('in total');
      expect(r.error).toContain("over X's limit of 280");
    }
  });

  it('accepts a post that fits once the tags are added', () => {
    const body = 'x'.repeat(200);
    expect(ok(body, ['@koyatalent']).length).toBeLessThanOrEqual(X_MAX_CHARS);
  });

  it('rejects an over-length post even with no tags at all', () => {
    expect(composeXPost('x'.repeat(281), []).ok).toBe(false);
  });

  it('does not repeat a handle the copy already mentions', () => {
    const text = ok('Thanks to @koyatalent for the data.', ['@koyatalent']);
    expect(text).toBe('Thanks to @koyatalent for the data.');
  });

  it('matches an existing mention on a whole-handle boundary only', () => {
    // "@koya" in the copy must not suppress the tag "@koyatalent".
    const text = ok('Thanks @koya for the data.', ['@koyatalent']);
    expect(text).toContain('@koyatalent');
  });

  it('deduplicates and normalises the handles it is given', () => {
    expect(ok('Body.', ['koyatalent', '@koyatalent', '@KoyaTalent'])).toBe('Body.\n\n@koyatalent');
  });

  it('ignores empty handles rather than emitting a bare @', () => {
    expect(ok('Body.', ['', '@'])).toBe('Body.');
  });
});

describe('composeLinkedInPost', () => {
  const ok = (body: string, tags: string[] = []) => {
    const r = composeLinkedInPost(body, tags);
    if (!r.ok) throw new Error(r.error);
    return r.text;
  };

  it('appends the tagged accounts as text', () => {
    expect(ok('The post.', ['@koya-talent'])).toBe('The post.\n\n@koya-talent');
  });

  it('does not impose X’s character limit', () => {
    // LinkedIn allows 3000; applying 280 here would reject perfectly valid posts.
    expect(ok('x'.repeat(1200), ['@koya-talent']).length).toBeGreaterThan(X_MAX_CHARS);
  });

  it('refuses an empty post', () => {
    expect(composeLinkedInPost('   ', []).ok).toBe(false);
  });

  it('does not repeat a handle already in the copy', () => {
    expect(ok('Working with @koya-talent on this.', ['@koya-talent'])).toBe(
      'Working with @koya-talent on this.',
    );
  });
});

/**
 * X does not count characters the way `.length` does, and the difference runs
 * both ways. Undercounting is the dangerous one: it means accepting a post X
 * then rejects, after it has been queued and released.
 */
describe('xLength — counting the way X counts', () => {
  it('counts plain text one per character', () => {
    expect(xLength('hello')).toBe(5);
  });

  it('counts any URL as 23, however long', () => {
    // X rewrites every link to a 23-character t.co URL. Counting the raw
    // string rejects posts X would accept — and a content post with a source
    // link is exactly where that bites.
    const long = 'https://example.com/' + 'a'.repeat(300);
    expect(xLength(long)).toBe(23);
    expect(xLength(`Read this: ${long}`)).toBe('Read this: '.length + 23);
  });

  it('counts two URLs separately', () => {
    expect(xLength('https://a.example https://b.example')).toBe(23 + 1 + 23);
  });

  it('counts emoji as two, including ones JavaScript calls one character', () => {
    // ☀ is a single UTF-16 unit, so .length says 1 and X says 2. That is the
    // undercount that would let an over-length post through.
    expect('☀'.length).toBe(1);
    expect(xLength('☀')).toBe(2);
    expect(xLength('🎉')).toBe(2);
  });

  it('does not double-count an astral non-emoji character', () => {
    // .length reports 2 for a surrogate pair; X counts one character.
    expect('𝕏'.length).toBe(2);
    expect(xLength('𝕏')).toBe(1);
  });

  it('is what the length check actually uses', () => {
    // A post that is over 280 by raw .length but under by X's count must be
    // accepted, or every post carrying a long link is wrongly refused.
    const post = `A short hook. https://example.com/${'b'.repeat(400)}`;
    expect(post.length).toBeGreaterThan(280);
    expect(xLength(post)).toBeLessThan(280);
    expect(composeXPost(post, []).ok).toBe(true);
  });
});
