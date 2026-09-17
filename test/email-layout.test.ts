import { describe, it, expect } from 'vitest';
import {
  markdownToEmailHtml,
  markdownToPlainText,
  emailShell,
  escapeHtml,
} from '../lib/email-layout';

/**
 * Email clients are not browsers, and a mistake here lands in somebody's
 * inbox where it cannot be edited afterwards. These pin the rules that are
 * easy to break and expensive to break.
 */
describe('markdownToEmailHtml', () => {
  it('inlines a style on every element — Gmail strips <style> blocks', () => {
    const html = markdownToEmailHtml('## A heading\n\nSome copy.\n\n- one\n- two');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('class=');
    for (const tag of ['<h2', '<p', '<ul', '<li']) {
      const at = html.indexOf(tag);
      expect(at, `${tag} missing`).toBeGreaterThan(-1);
      expect(html.slice(at, html.indexOf('>', at))).toContain('style=');
    }
  });

  it('renders bold and links', () => {
    const html = markdownToEmailHtml('A **strong** word and a [link](https://example.com).');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('href="https://example.com"');
  });

  it('refuses a javascript: href rather than putting it in someone’s inbox', () => {
    const html = markdownToEmailHtml('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click');
  });

  it('escapes markup in generated copy instead of emitting it', () => {
    const html = markdownToEmailHtml('An <script>alert(1)</script> in the text.');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('uses no external resources — no image, font or stylesheet to be blocked', () => {
    const html = emailShell({ title: 'T', preheader: 'P', body: markdownToEmailHtml('Hi.') });
    expect(html).not.toMatch(/<img|<link|@import|https:\/\/fonts\./);
  });

  it('lays out with tables, because Outlook has neither flex nor grid', () => {
    const html = emailShell({ title: 'T', preheader: 'P', body: 'x' });
    expect(html).toContain('<table');
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
  });

  it('hides the preheader in the body while keeping it for the inbox list', () => {
    const html = emailShell({ title: 'T', preheader: 'The inbox line', body: 'x' });
    expect(html).toContain('The inbox line');
    const at = html.indexOf('The inbox line');
    expect(html.slice(Math.max(0, at - 200), at)).toContain('display:none');
  });
});

describe('markdownToPlainText', () => {
  it('keeps a link reachable instead of dropping the URL with the markup', () => {
    const text = markdownToPlainText('Read [our guide](https://example.com/guide) today.');
    expect(text).toContain('https://example.com/guide');
    expect(text).not.toContain('](');
  });

  it('strips the asterisks that read as noise in a plain-text client', () => {
    expect(markdownToPlainText('A **strong** word.')).toBe('A strong word.');
  });

  it('turns bullets into dashes and underlines headings', () => {
    const text = markdownToPlainText('## Why it matters\n\n- first\n- second');
    expect(text).toContain('Why it matters');
    expect(text).toContain('- first');
    expect(text).toContain('---');
  });

  it('produces something for every body, so the text part is never empty', () => {
    // A message with no text part scores worse with spam filters, and is what
    // a screen reader and a watch notification actually read.
    expect(markdownToPlainText('# Title\n\nBody copy.').trim().length).toBeGreaterThan(0);
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break out of markup or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});
