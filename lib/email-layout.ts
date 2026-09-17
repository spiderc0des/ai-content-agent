import 'server-only';
import { parseMarkdownSubset, type Run } from './markdown-subset';

/**
 * The HTML shell every outgoing email is poured into.
 *
 * Email clients are not browsers. The rules this file follows, and why:
 *
 *   • Tables for layout, not flex or grid. Outlook renders through Word's
 *     HTML engine, which supports neither.
 *   • Inline styles on every element. Gmail strips <style> blocks in some
 *     contexts, notably the clipped-message view and several mobile apps.
 *   • No external CSS, no web fonts, no images. An image would need hosting
 *     and would be blocked by default anyway; a font would silently fall
 *     back. The palette below is the app's own (app/globals.css) hard-coded,
 *     because a CSS variable cannot survive here.
 *   • A plain-text alternative is always sent alongside (see send() in
 *     lib/email.ts). Not a courtesy — a mail with no text part scores worse
 *     with spam filters, and it is what a screen reader or a watch
 *     notification actually reads.
 *
 * Restrained on purpose. A newsletter that arrives looking like correspondence
 * is read; one that arrives looking like a campaign is archived. The house
 * style here is one accent rule, generous line height, and nothing else.
 */

const INK = '#16150f';
const BODY = '#2e2c24';
const SOFT = '#5d5a50';
const FAINT = '#8b877a';
const RULE = '#e6e2d9';
const PAPER = '#ffffff';
const SURFACE = '#f6f4ef';
const ACCENT = '#3d5a3d';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type EmailButton = { label: string; href: string };

/** A paragraph. `muted` for the small print at the end. */
export function p(text: string, muted = false): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${
    muted ? SOFT : BODY
  };">${text}</p>`;
}

/** A bordered box for something quoted. */
export function quote(label: string, text: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
    <tr><td style="border-left:3px solid ${ACCENT};background:${SURFACE};padding:12px 16px;border-radius:0 4px 4px 0;">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${FAINT};margin-bottom:4px;">${escapeHtml(label)}</div>
      <div style="font-size:15px;line-height:1.55;color:${BODY};">${escapeHtml(text)}</div>
    </td></tr>
  </table>`;
}

/**
 * The call to action. A table rather than a styled <a> because Outlook
 * ignores padding on an inline element, collapsing the button to bare text —
 * and this is the one element in the mail that has to look clickable. The URL
 * is repeated underneath because a proportion of recipients will not click a
 * styled link in a mail from an address they do not recognise.
 */
export function button(btn: EmailButton): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;">
    <tr><td align="center" bgcolor="${ACCENT}" style="background:${ACCENT};border-radius:6px;padding:13px 28px;">
      <a href="${escapeHtml(btn.href)}"
         style="font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;font-family:${FONT};white-space:nowrap;">${escapeHtml(btn.label)}</a>
    </td></tr>
  </table>
  <p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:${FAINT};word-break:break-all;">
    Or paste this into your browser:<br><span style="color:${SOFT};">${escapeHtml(btn.href)}</span>
  </p>`;
}

/** A horizontal rule, for separating the letter from the sign-off. */
export function divider(): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 20px;"><tr><td style="border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

/* ─── The newsletter body ────────────────────────────────────────────────── */

/**
 * The newsletter arrives as markdown — the same subset the article is written
 * in — and has to become inline-styled HTML.
 *
 * It reuses `parseMarkdownSubset` rather than doing its own pass, so the email
 * and the on-screen preview agree about what a heading and a link are. A
 * second parser would drift, and the version that drifts is the one nobody
 * looks at until a subscriber replies asking why half the mail is asterisks.
 *
 * Anything outside the subset arrives as literal text from the parser and is
 * escaped here, so a stray `<script>` in generated copy becomes visible text
 * rather than markup in somebody's inbox.
 */
export function markdownToEmailHtml(md: string): string {
  return parseMarkdownSubset(md)
    .map((block) => {
      switch (block.type) {
        // The newsletter's own H1 is the subject line's job; inside the body
        // it would repeat the title the shell already prints.
        case 'h1':
          return heading(block.text, 19, 26);
        case 'h2':
          return heading(block.text, 17, 24);
        case 'h3':
          return heading(block.text, 15, 20);
        case 'p':
          return p(runsToHtml(block.runs));
        case 'quote':
          return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
    <tr><td style="border-left:3px solid ${ACCENT};background:${SURFACE};padding:12px 16px;border-radius:0 4px 4px 0;font-size:15px;line-height:1.6;color:${BODY};">${runsToHtml(block.runs)}</td></tr>
  </table>`;
        case 'ul':
          // A <ul> with inline styles, not a table: lists survive everywhere,
          // and the only client-specific fix needed is the left padding,
          // which Outlook otherwise sets to something enormous.
          return `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.65;color:${BODY};">${block.items
            .map((item) => `<li style="margin-bottom:7px;">${runsToHtml(item)}</li>`)
            .join('')}</ul>`;
      }
    })
    .join('\n');
}

function heading(text: string, size: number, top: number): string {
  return `<h2 style="margin:${top}px 0 12px;font-size:${size}px;line-height:1.3;font-weight:600;color:${INK};font-family:${FONT};">${escapeHtml(text)}</h2>`;
}

function runsToHtml(runs: Run[]): string {
  return runs
    .map((run) => {
      const text = escapeHtml(run.text);
      const inner = run.bold ? `<strong>${text}</strong>` : text;
      if (!run.href) return inner;
      // Only http(s). A `javascript:` or `data:` href reaching a recipient's
      // client is not worth the one line it costs to rule out here.
      const safe = /^https?:\/\//i.test(run.href) ? run.href : '';
      if (!safe) return inner;
      return `<a href="${escapeHtml(safe)}" style="color:${ACCENT};text-decoration:underline;">${inner}</a>`;
    })
    .join('');
}

/* ─── The shell ──────────────────────────────────────────────────────────── */

/**
 * Wraps the blocks above into a full document.
 *
 * `preheader` is the line a mail client shows next to the subject in the inbox
 * list. Left unset, clients grab the first words of the body — for a letter
 * that is "Hi there," — wasting the one line that decides whether the mail
 * gets opened. Hidden in the rendered mail itself.
 */
export function emailShell(params: {
  title: string;
  preheader: string;
  body: string;
  footnote?: string;
  /** Overrides the "Sent by…" line under the card. */
  signature?: string;
}): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(params.title)}</title>
</head>
<body style="margin:0;padding:0;background:${SURFACE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(params.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${SURFACE};">
<tr><td align="center" style="padding:28px 12px;">

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background:${PAPER};border:1px solid ${RULE};border-radius:8px;">
    <tr><td style="padding:28px 32px 8px;font-family:${FONT};">
      <div style="font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${ACCENT};margin-bottom:14px;">Koya Talent</div>
      <h1 style="margin:0 0 18px;font-size:21px;line-height:1.3;font-weight:600;color:${INK};">${escapeHtml(params.title)}</h1>
    </td></tr>
    <tr><td style="padding:0 32px 24px;font-family:${FONT};">
${params.body}
    </td></tr>
    ${
      params.footnote
        ? `<tr><td style="padding:0 32px 26px;font-family:${FONT};">
      <div style="border-top:1px solid ${RULE};padding-top:14px;font-size:12px;line-height:1.55;color:${FAINT};">${params.footnote}</div>
    </td></tr>`
        : ''
    }
  </table>

  <div style="max-width:600px;margin:14px auto 0;font-family:${FONT};font-size:11px;line-height:1.5;color:${FAINT};text-align:center;">
    ${escapeHtml(params.signature ?? 'Sent by the Koya Content Agent.')}
  </div>

</td></tr></table>
</body></html>`;
}

/** Text going into an HTML document. Every interpolated value passes through. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The markdown body as plain text, for the text/plain part.
 *
 * Not the raw markdown: `**bold**` and `[label](url)` read as noise in a
 * plain-text client. Headings become their own lines, bullets become dashes,
 * and a link becomes "label (url)" so the URL is still reachable.
 */
export function markdownToPlainText(md: string): string {
  return parseMarkdownSubset(md)
    .map((block) => {
      switch (block.type) {
        case 'h1':
        case 'h2':
        case 'h3':
          return `\n${block.text}\n${'-'.repeat(Math.min(block.text.length, 60))}`;
        case 'p':
          return runsToText(block.runs);
        case 'quote':
          return `> ${runsToText(block.runs)}`;
        case 'ul':
          return block.items.map((item) => `- ${runsToText(item)}`).join('\n');
      }
    })
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function runsToText(runs: Run[]): string {
  return runs.map((r) => (r.href ? `${r.text} (${r.href})` : r.text)).join('');
}
