import { describe, it, expect } from 'vitest';
import { parseMarkdownSubset } from '../lib/markdown-subset';

describe('parseMarkdownSubset', () => {
  it('reads the heading levels the prompt allows', () => {
    const blocks = parseMarkdownSubset('# One\n\n## Two\n\n### Three');
    expect(blocks.map((b) => b.type)).toEqual(['h1', 'h2', 'h3']);
  });

  it('joins wrapped lines into one paragraph', () => {
    const [block] = parseMarkdownSubset('a line\nand its continuation');
    expect(block).toMatchObject({ type: 'p' });
  });

  it('parses bold and links in the same line', () => {
    const [block] = parseMarkdownSubset('see **this** and [that](https://x.com)');
    if (block.type !== 'p') throw new Error('expected a paragraph');
    expect(block.runs.find((r) => r.bold)?.text).toBe('this');
    expect(block.runs.find((r) => r.href)).toMatchObject({ text: 'that', href: 'https://x.com' });
  });

  it('strips leftover emphasis inside a link', () => {
    const [block] = parseMarkdownSubset('[**bold link**](https://x.com)');
    if (block.type !== 'p') throw new Error('expected a paragraph');
    expect(block.runs[0].text).toBe('bold link');
  });

  it('groups consecutive bullets into one list', () => {
    const blocks = parseMarkdownSubset('- one\n- two\n- three');
    expect(blocks).toHaveLength(1);
    if (blocks[0].type !== 'ul') throw new Error('expected a list');
    expect(blocks[0].items).toHaveLength(3);
  });

  it('drops code fences rather than rendering them as prose', () => {
    const blocks = parseMarkdownSubset('before\n\n```\nsecret();\n```\n\nafter');
    const text = JSON.stringify(blocks);
    expect(text).not.toContain('secret');
  });

  it('keeps a blockquote separate from a paragraph', () => {
    const blocks = parseMarkdownSubset('> a quote\n\nnot a quote');
    expect(blocks.map((b) => b.type)).toEqual(['quote', 'p']);
  });
});
