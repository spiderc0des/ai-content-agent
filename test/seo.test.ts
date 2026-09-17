import { describe, it, expect } from 'vitest';
import {
  checkSeo,
  wordCount,
  headings,
  paragraphs,
  sentenceCount,
  links,
  slugify,
} from '../lib/seo';

const GOOD = `# Remote onboarding that actually works

Remote onboarding is the first real test of a distributed team. Most companies
treat it as paperwork. It is closer to a product launch.

## Why the first week decides retention

New hires form their view of a company fast. A dull first week is hard to undo.
See the [Gallup engagement data](https://example.com/gallup) for the numbers.

## What to change on Monday

Give every new hire one owner. Give them one shippable task. Nothing else.
The [Koya onboarding guide](https://koya.example.com/guide) has a template.

### A note on tooling

Tools matter less than the owner. Pick anything and be consistent.
`;

describe('primitives', () => {
  it('counts words without markdown syntax', () => {
    expect(wordCount('# Title\n\nSome **bold** words here.')).toBe(5);
  });

  it('keeps link anchor text and drops the URL', () => {
    expect(wordCount('See the [Gallup data](https://example.com/x) now.')).toBe(5);
  });

  it('reads headings with their level', () => {
    const hs = headings(GOOD);
    expect(hs.filter((h) => h.level === 1)).toHaveLength(1);
    expect(hs.filter((h) => h.level === 2)).toHaveLength(2);
    expect(hs.filter((h) => h.level === 3)).toHaveLength(1);
  });

  it('excludes headings and list items from paragraphs', () => {
    const ps = paragraphs('# H\n\nReal prose.\n\n- a bullet\n\n> a quote');
    expect(ps).toEqual(['Real prose.']);
  });

  it('does not split sentences on common abbreviations', () => {
    expect(sentenceCount('Use a tool, e.g. Notion. Then stop.')).toBe(2);
  });

  it('finds links but not images', () => {
    expect(links('![alt](img.png) and [real](https://x.com)')).toEqual([
      { anchor: 'real', url: 'https://x.com' },
    ]);
  });

  it('slugifies a title', () => {
    expect(slugify('Remote Onboarding That Works!')).toBe('remote-onboarding-that-works');
  });
});

describe('checkSeo', () => {
  const base = {
    title: 'Remote onboarding that actually works',
    body_md: GOOD,
    primary_keyword: 'remote onboarding',
    secondary_keywords: ['new hires', 'retention'],
  };

  it('passes a well-formed article', () => {
    const r = checkSeo(base);
    expect(r.pass).toBe(true);
  });

  it('fails when the primary keyword is missing from the title', () => {
    const r = checkSeo({ ...base, title: 'Starting well' });
    expect(r.pass).toBe(false);
    expect(r.checks.find((c) => c.key === 'keyword_in_title')?.pass).toBe(false);
  });

  it('fails when the keyword is absent from the first 100 words', () => {
    const filler = Array(120).fill('filler').join(' ');
    const r = checkSeo({
      ...base,
      title: 'A title with no keyword',
      primary_keyword: 'remote onboarding',
      body_md: `# A title\n\n${filler}\n\n## Later\n\nremote onboarding appears far too late.`,
    });
    expect(r.checks.find((c) => c.key === 'keyword_in_first_100_words')?.pass).toBe(false);
  });

  it('requires exactly one H1', () => {
    const r = checkSeo({ ...base, body_md: `${GOOD}\n\n# A second H1\n\nMore.` });
    expect(r.checks.find((c) => c.key === 'one_h1')?.pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('requires 2 to 3 links — one is too few', () => {
    const r = checkSeo({
      ...base,
      body_md: GOOD.replace('[Koya onboarding guide](https://koya.example.com/guide)', 'the guide'),
    });
    expect(r.checks.find((c) => c.key === 'link_count')?.pass).toBe(false);
  });

  it('requires 2 to 3 links — four is too many', () => {
    const r = checkSeo({
      ...base,
      body_md: `${GOOD}\n\n[a](https://a.com) [b](https://b.com)`,
    });
    expect(r.checks.find((c) => c.key === 'link_count')?.pass).toBe(false);
  });

  it('flags long paragraphs without failing the report', () => {
    const long = '# T\n\nremote onboarding one. Two. Three. Four. Five.\n\n## A\n\nx.\n\n## B\n\n[a](https://a.com) [b](https://b.com)';
    const r = checkSeo({ ...base, title: 'remote onboarding', body_md: long });
    expect(r.checks.find((c) => c.key === 'short_paragraphs')?.pass).toBe(false);
    expect(r.pass).toBe(true); // advisory only
  });
});
