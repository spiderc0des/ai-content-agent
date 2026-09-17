/**
 * A parser for exactly the markdown subset the system prompt allows Claude to
 * write: one `#` H1, `##`/`###` headings, paragraphs, `-` bullets, `**bold**`,
 * and `[anchor](url)` links. Nothing else — no tables, no HTML, no images.
 *
 * Deliberately not a general markdown library. Anything outside the subset is
 * rendered as plain text rather than rendered wrong, so the prompt's promise
 * to write only this subset is what keeps this file honest. It is also what
 * lib/seo.ts counts against, so the two agree on what a heading and a link are.
 */

export type Run = { text: string; bold: boolean; href?: string };

export type Block =
  | { type: 'h1'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'p'; runs: Run[] }
  | { type: 'ul'; items: Run[][] }
  | { type: 'quote'; runs: Run[] };

/**
 * Inline parsing in one pass over links and bold together, so `**[a](b)**`
 * and `[**a**](b)` both survive. Running two separate passes drops whichever
 * one goes second inside the other's match.
 */
function parseInline(line: string): Run[] {
  const runs: Run[] = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line))) {
    if (m.index > last) {
      runs.push({ text: line.slice(last, m.index), bold: false });
    }
    if (m[1] !== undefined) {
      runs.push({ text: stripMarks(m[1]), bold: true });
    } else {
      runs.push({ text: stripMarks(m[2]), bold: false, href: m[3] });
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), bold: false });

  return runs.length ? runs : [{ text: line, bold: false }];
}

/** Leftover emphasis inside a match — `[**a**](b)` should render "a", not "**a**". */
function stripMarks(s: string): string {
  return s.replace(/\*\*/g, '');
}

export function parseMarkdownSubset(md: string): Block[] {
  const blocks: Block[] = [];
  // Code fences are not in the subset; dropping them whole beats rendering
  // their contents as if they were prose.
  const lines = md.replace(/```[\s\S]*?```/g, '').split('\n');

  let paragraph: string[] = [];
  let bullets: Run[][] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'p', runs: parseInline(paragraph.join(' ').trim()) });
      paragraph = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length) {
      blocks.push({ type: 'ul', items: bullets });
      bullets = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushBullets();
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      blocks.push({
        type: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3',
        text: stripMarks(heading[2].trim()),
      });
      continue;
    }

    const bullet = /^[-+*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(parseInline(bullet[1]));
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushAll();
      blocks.push({ type: 'quote', runs: parseInline(quote[1]) });
      continue;
    }

    flushBullets();
    paragraph.push(line);
  }

  flushAll();
  return blocks;
}
