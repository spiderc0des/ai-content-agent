import { describe, it, expect } from 'vitest';
import { findingsOf, documentTextOf, mergeFindings, readableCount, MAX_SOURCES } from '../lib/research-results';
import type Anthropic from '@anthropic-ai/sdk';

/** A message carrying only the blocks under test. */
const msg = (content: unknown[]) => ({ content }) as unknown as Anthropic.Beta.BetaMessage;

const searchResult = (urls: string[]) => ({
  type: 'web_search_tool_result',
  content: urls.map((url) => ({ type: 'web_search_result', url, title: `Title for ${url}` })),
});

const fetchResult = (url: string, text: string | null) => ({
  type: 'web_fetch_tool_result',
  content: {
    type: 'web_fetch_result',
    url,
    content: {
      type: 'document',
      title: `Doc at ${url}`,
      source: text === null ? {} : { type: 'text', media_type: 'text/plain', data: text },
    },
  },
});

describe('documentTextOf', () => {
  it('reads the page body out of a document block', () => {
    expect(documentTextOf({ source: { data: 'the page text' } })).toBe('the page text');
  });

  it('falls back to text directly on the block', () => {
    expect(documentTextOf({ text: 'the page text' })).toBe('the page text');
  });

  it('returns null rather than an empty string when there is nothing', () => {
    expect(documentTextOf(undefined)).toBeNull();
    expect(documentTextOf({})).toBeNull();
    expect(documentTextOf({ source: { data: '   ' } })).toBeNull();
  });
});

describe('findingsOf', () => {
  /**
   * The regression this file exists for: an earlier version kept only the URL
   * and title from a fetch result, so every source arrived with no text and
   * retrieval had nothing to digest.
   */
  it('keeps the fetched page text', () => {
    const [f] = findingsOf(msg([fetchResult('https://a.com', 'the article body')]));
    expect(f.text).toBe('the article body');
    expect(f.fetched).toBe(true);
  });

  it('marks a search-only result as unread, with no text', () => {
    const [f] = findingsOf(msg([searchResult(['https://a.com'])]));
    expect(f.fetched).toBe(false);
    expect(f.text).toBeNull();
  });

  it('upgrades a search result once the same URL is fetched', () => {
    const out = findingsOf(
      msg([searchResult(['https://a.com']), fetchResult('https://a.com', 'body')]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fetched: true, text: 'body' });
  });

  it('puts readable sources first', () => {
    const out = findingsOf(
      msg([searchResult(['https://x.com', 'https://y.com']), fetchResult('https://z.com', 'body')]),
    );
    expect(out[0].url).toBe('https://z.com');
  });

  it('caps how many sources one request keeps', () => {
    const many = Array.from({ length: 60 }, (_, i) => `https://s${i}.com`);
    expect(findingsOf(msg([searchResult(many)])).length).toBeLessThanOrEqual(MAX_SOURCES);
  });

  it('never drops a readable source to stay under the cap', () => {
    const many = Array.from({ length: 60 }, (_, i) => `https://s${i}.com`);
    const fetches = Array.from({ length: 15 }, (_, i) => fetchResult(`https://f${i}.com`, `body ${i}`));
    const out = findingsOf(msg([searchResult(many), ...fetches]));
    expect(out.filter((f) => f.text)).toHaveLength(15);
  });

  it('survives a server-tool error, which arrives as an object where results are an array', () => {
    const errored = { type: 'web_search_tool_result', content: { error_code: 'max_uses_exceeded' } };
    expect(() => findingsOf(msg([errored]))).not.toThrow();
    expect(findingsOf(msg([errored, fetchResult('https://a.com', 'body')]))).toHaveLength(1);
  });

  it('ignores a fetch result whose document carried no text', () => {
    const [f] = findingsOf(msg([fetchResult('https://a.com', null)]));
    expect(f.text).toBeNull();
  });
});

/**
 * Research runs again when too few of its sources could actually be read —
 * thirteen URLs of which two can be quoted is a worse evidence base than six
 * of which five can. These pin down how the rounds fold together, because
 * getting the overlap wrong would silently discard the sources the extra
 * round was run to find.
 */
describe('mergeFindings across research rounds', () => {
  const found = (url: string) => ({ url, title: url, fetched: false, text: null });
  const read = (url: string, text = 'real page text') => ({ url, title: url, fetched: true, text });

  it('is a plain pass-through for a single round', () => {
    const r1 = [read('https://a.example'), found('https://b.example')];
    expect(mergeFindings([r1]).map((f) => f.url)).toEqual(['https://a.example', 'https://b.example']);
  });

  it('upgrades a URL an earlier round only saw to the later round that read it', () => {
    const merged = mergeFindings([[found('https://a.example')], [read('https://a.example', 'body')]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.text).toBe('body');
    expect(merged[0]!.fetched).toBe(true);
  });

  it('never downgrades a page it already read back to unread', () => {
    const merged = mergeFindings([[read('https://a.example', 'body')], [found('https://a.example')]]);
    expect(merged[0]!.text).toBe('body');
  });

  it('counts a URL found in two rounds once', () => {
    const merged = mergeFindings([
      [found('https://a.example'), found('https://b.example')],
      [found('https://b.example'), found('https://c.example')],
    ]);
    expect(merged).toHaveLength(3);
  });

  it('accumulates readable sources across rounds — the whole point of topping up', () => {
    const r1 = [read('https://a.example'), found('https://x.example'), found('https://y.example')];
    const r2 = [read('https://b.example'), read('https://c.example')];
    const r3 = [read('https://d.example')];
    expect(readableCount(mergeFindings([r1]))).toBe(1);
    expect(readableCount(mergeFindings([r1, r2]))).toBe(3);
    expect(readableCount(mergeFindings([r1, r2, r3]))).toBe(4);
  });

  it('keeps every readable source even when the unreadable ones blow past the cap', () => {
    const readable = Array.from({ length: 9 }, (_, i) => read(`https://r${i}.example`));
    const junk = Array.from({ length: 40 }, (_, i) => found(`https://j${i}.example`));
    const merged = mergeFindings([junk, readable]);
    expect(readableCount(merged)).toBe(9);
    expect(merged).toHaveLength(MAX_SOURCES);
    // Readable first, so the selection prompt sees what it can actually quote.
    expect(merged.slice(0, 9).every((f) => f.text)).toBe(true);
  });

  it('does not drop readable sources when they alone exceed the cap', () => {
    const readable = Array.from({ length: 18 }, (_, i) => read(`https://r${i}.example`));
    const merged = mergeFindings([readable]);
    expect(merged).toHaveLength(18);
    expect(readableCount(merged)).toBe(18);
  });

  it('handles a round that found nothing at all', () => {
    expect(mergeFindings([[read('https://a.example')], []])).toHaveLength(1);
    expect(mergeFindings([[], []])).toEqual([]);
  });
});
