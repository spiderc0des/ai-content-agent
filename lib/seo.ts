/**
 * The SEO rules from the brief, checked deterministically over the stored
 * text — no model involved.
 *
 * Why this is code and not a prompt: a model asked "does the title contain
 * the primary keyword?" is guessing at its own output, and a model asked to
 * count words is famously unreliable. Claude's `seo_fit` rubric score is
 * advisory judgement about whether the keywords were used *well*; this file
 * answers whether they are *there*.
 *
 * Rules (assets/seo-best-practices.md):
 *   Keyword integration — primary keyword in the title, and within the first
 *     100 words; relevant secondary keywords in the body and section headers.
 *   Structure — exactly one H1, H2 section headers, H3 subheaders as needed;
 *     short paragraphs of 2 to 3 sentences.
 *   Enrichment — 2 to 3 relevant internal or external links.
 */

export interface SeoCheck {
  key: string;
  label: string;
  pass: boolean;
  detail: string;
  /** Advisory checks do not block the pipeline; required ones do. */
  required: boolean;
}

export interface SeoReport {
  pass: boolean;
  checks: SeoCheck[];
  word_count: number;
  reading_time_s: number;
}

const WORDS_PER_MINUTE = 225;

export function wordCount(text: string): number {
  return stripMarkdown(text).split(/\s+/).filter(Boolean).length;
}

/**
 * Markdown syntax removed so a word count counts words, not hashes and
 * brackets. Link text is kept, URLs dropped — a reader reads the anchor.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>]/g, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heading lines with their level, in document order. */
export function headings(md: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const line of withoutCodeFences(md).split('\n')) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (m) out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** Prose paragraphs — blank-line separated blocks that are not headings,
 *  list items, quotes, or code. */
export function paragraphs(md: string): string[] {
  return withoutCodeFences(md)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(
      (p) => p.length > 0 && !/^#{1,6}\s/.test(p) && !/^[-+*]\s/.test(p) && !/^>/.test(p) && !/^\|/.test(p),
    );
}

/** Sentence count, tolerant of abbreviations that end in a period. */
export function sentenceCount(text: string): number {
  const cleaned = text.replace(/\b(e\.g|i\.e|etc|vs|Mr|Mrs|Dr|St)\./gi, '$1');
  return cleaned.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

export function links(md: string): { anchor: string; url: string }[] {
  const out: { anchor: string; url: string }[] = [];
  const re = /(?<!!)\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutCodeFences(md)))) {
    out.push({ anchor: m[1], url: m[2] });
  }
  return out;
}

function withoutCodeFences(md: string): string {
  return md.replace(/```[\s\S]*?```/g, '');
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (!p) return false;
  return haystack.toLowerCase().includes(p);
}

/** The first N words of the body prose, headings included as text. */
export function firstWords(md: string, n: number): string {
  return stripMarkdown(md).split(/\s+/).slice(0, n).join(' ');
}

export function checkSeo(input: {
  title: string;
  body_md: string;
  primary_keyword: string;
  secondary_keywords?: string[];
}): SeoReport {
  const { title, body_md } = input;
  const primary = input.primary_keyword.trim();
  const secondary = (input.secondary_keywords ?? []).filter((k) => k.trim());

  const hs = headings(body_md);
  const h1s = hs.filter((h) => h.level === 1);
  const h2s = hs.filter((h) => h.level === 2);
  const paras = paragraphs(body_md);
  const ls = links(body_md);
  const words = wordCount(body_md);

  // The brief says "in the first 100 words". The H1 is part of the article,
  // so it counts toward that window — which is also why a well-formed article
  // usually passes this the moment it passes the title check.
  const opening = firstWords(`${title}\n\n${body_md}`, 100);

  const longParas = paras.filter((p) => sentenceCount(p) > 3);
  const secondaryInBody = secondary.filter((k) => containsPhrase(stripMarkdown(body_md), k));
  const secondaryInHeaders = secondary.filter((k) =>
    hs.some((h) => containsPhrase(h.text, k)),
  );

  const checks: SeoCheck[] = [
    {
      key: 'primary_keyword_set',
      label: 'A primary keyword is set',
      pass: primary.length > 0,
      detail: primary ? `"${primary}"` : 'no primary keyword on this request',
      required: true,
    },
    {
      key: 'keyword_in_title',
      label: 'Primary keyword appears in the title',
      pass: primary.length > 0 && containsPhrase(title, primary),
      detail: primary
        ? containsPhrase(title, primary)
          ? `"${primary}" is in the title`
          : `"${primary}" is missing from "${title}"`
        : 'no primary keyword to look for',
      required: true,
    },
    {
      key: 'keyword_in_first_100_words',
      label: 'Primary keyword appears within the first 100 words',
      pass: primary.length > 0 && containsPhrase(opening, primary),
      detail:
        primary.length > 0 && containsPhrase(opening, primary)
          ? 'found in the opening'
          : 'not found in the first 100 words',
      required: true,
    },
    {
      key: 'one_h1',
      label: 'Exactly one H1',
      pass: h1s.length === 1,
      detail: `${h1s.length} H1 heading${h1s.length === 1 ? '' : 's'}`,
      required: true,
    },
    {
      key: 'has_h2_sections',
      label: 'Has H2 section headers',
      pass: h2s.length >= 2,
      detail: `${h2s.length} H2 section${h2s.length === 1 ? '' : 's'}`,
      required: true,
    },
    {
      key: 'short_paragraphs',
      label: 'Paragraphs are 2 to 3 sentences',
      pass: longParas.length === 0,
      detail:
        longParas.length === 0
          ? `all ${paras.length} paragraphs are 3 sentences or fewer`
          : `${longParas.length} of ${paras.length} paragraphs run longer than 3 sentences`,
      required: false, // advisory: a 4-sentence paragraph is a smell, not a defect
    },
    {
      key: 'link_count',
      label: '2 to 3 relevant internal or external links',
      pass: ls.length >= 2 && ls.length <= 3,
      detail: `${ls.length} link${ls.length === 1 ? '' : 's'}`,
      required: true,
    },
    {
      key: 'secondary_keywords_in_body',
      label: 'Secondary keywords used in the body',
      pass: secondary.length === 0 || secondaryInBody.length > 0,
      detail: secondary.length
        ? `${secondaryInBody.length} of ${secondary.length} used`
        : 'none supplied',
      required: false,
    },
    {
      key: 'secondary_keywords_in_headers',
      label: 'Secondary keywords used in section headers',
      pass: secondary.length === 0 || secondaryInHeaders.length > 0,
      detail: secondary.length
        ? `${secondaryInHeaders.length} of ${secondary.length} appear in a heading`
        : 'none supplied',
      required: false,
    },
  ];

  return {
    pass: checks.every((c) => !c.required || c.pass),
    checks,
    word_count: words,
    reading_time_s: Math.round((words / WORDS_PER_MINUTE) * 60),
  };
}

/** A URL-safe slug from a title, for the article's stored slug. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
