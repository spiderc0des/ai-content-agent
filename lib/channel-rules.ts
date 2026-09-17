import type { Channel, LinkedInPost, XPost, Newsletter } from './schemas';
import { wordCount, sentenceCount, paragraphs } from './seo';
// One definition of "how long is this X post", shared with the composer that
// runs at queue time. Two counts would disagree, and a post that passed its
// rule check would then be refused on its way out — or worse, the reverse.
import { X_MAX_CHARS, xLength } from './publishers/compose';

/**
 * The platform formatting rules from the brief, checked deterministically —
 * no model involved. Same reasoning as lib/seo.ts: Claude's `channel_fit`
 * rubric score judges whether the post reads well for the platform; this file
 * answers whether it obeys the rules.
 *
 * From assets/channel-formatting-rules.md:
 *
 *   LinkedIn — PAS structure (problem, agitation, solution); short
 *     paragraphs; bullets or simple symbols where they help; a small number
 *     of relevant emojis; ends with a clear call to action.
 *   X — leads with the benefit/insight/hook; one core idea; line breaks for
 *     readability; no more than 1 to 2 hashtags.
 *   Newsletter — strong subject line; short intro of 1 to 3 sentences; a
 *     skimmable main section; optional secondary item; clear CTA; friendly
 *     sign-off; 250 to 600 words.
 */

export interface RuleCheck {
  key: string;
  label: string;
  pass: boolean;
  detail: string;
  required: boolean;
}

export interface RuleReport {
  pass: boolean;
  checks: RuleCheck[];
  word_count: number;
}

const NEWSLETTER_MIN_WORDS = 250;
const NEWSLETTER_MAX_WORDS = 600;

/**
 * Emoji, counted by code point rather than by UTF-16 unit — a single emoji is
 * often a surrogate pair, and flags or skin-tone sequences are several code
 * points joined by ZWJ. Counting `.length` would report one emoji as four.
 */
export function countEmoji(text: string): number {
  const matches = text.match(/\p{Extended_Pictographic}/gu);
  return matches ? matches.length : 0;
}

export function countHashtags(text: string): number {
  const matches = text.match(/(^|\s)#[A-Za-z0-9_]+/g);
  return matches ? matches.length : 0;
}

function report(checks: RuleCheck[], words: number): RuleReport {
  return { pass: checks.every((c) => !c.required || c.pass), checks, word_count: words };
}

export function checkLinkedIn(post: LinkedInPost): RuleReport {
  const body = post.body ?? '';
  const paras = paragraphs(body);
  const longParas = paras.filter((p) => sentenceCount(p) > 3);
  const emoji = countEmoji(body);
  const hasBullets = /^\s*([-+*•→▸✅]|\d+[.)])\s+/m.test(body);

  const checks: RuleCheck[] = [
    {
      key: 'pas_structure',
      label: 'Uses the PAS structure (problem, agitation, solution)',
      pass: Boolean(post.problem?.trim() && post.agitation?.trim() && post.solution?.trim()),
      detail: [
        post.problem?.trim() ? 'problem ✓' : 'problem ✗',
        post.agitation?.trim() ? 'agitation ✓' : 'agitation ✗',
        post.solution?.trim() ? 'solution ✓' : 'solution ✗',
      ].join(', '),
      required: true,
    },
    {
      key: 'has_cta',
      label: 'Ends with a clear call to action',
      pass: Boolean(post.cta?.trim()),
      detail: post.cta?.trim() ? `"${post.cta.trim()}"` : 'no CTA',
      required: true,
    },
    {
      key: 'short_paragraphs',
      label: 'Paragraphs are short',
      pass: longParas.length === 0,
      detail:
        longParas.length === 0
          ? `all ${paras.length} paragraphs are 3 sentences or fewer`
          : `${longParas.length} paragraph(s) run longer than 3 sentences`,
      required: true,
    },
    {
      key: 'bullets',
      label: 'Uses bullets or simple symbols where they improve clarity',
      pass: hasBullets || (post.bullets?.length ?? 0) > 0,
      detail: hasBullets ? 'bullets present in the body' : 'no bullets',
      required: false, // "when they improve clarity" — not every post needs them
    },
    {
      key: 'emoji_restraint',
      label: 'A small number of relevant emojis',
      pass: emoji <= 5,
      detail: `${emoji} emoji`,
      required: true,
    },
    {
      key: 'body_present',
      label: 'The assembled post is non-empty',
      pass: body.trim().length > 0,
      detail: `${wordCount(body)} words`,
      required: true,
    },
  ];

  return report(checks, wordCount(body));
}

export function checkX(post: XPost): RuleReport {
  const body = post.body ?? '';
  // Hashtags declared in the structured field and hashtags actually written
  // into the body are the same budget — a model that returns [] while writing
  // three into the text has still broken the rule.
  const declared = post.hashtags?.length ?? 0;
  const inBody = countHashtags(body);
  const hashtags = Math.max(declared, inBody);
  const firstLine = body.trim().split('\n')[0] ?? '';

  const checks: RuleCheck[] = [
    {
      key: 'hashtag_cap',
      label: 'No more than 1 to 2 hashtags',
      pass: hashtags <= 2,
      detail: `${hashtags} hashtag${hashtags === 1 ? '' : 's'}${
        declared !== inBody ? ` (${declared} declared, ${inBody} in the body)` : ''
      }`,
      required: true,
    },
    {
      key: 'leads_with_hook',
      label: 'Leads with the benefit, insight, or hook',
      pass: Boolean(post.hook?.trim()) && firstLine.length > 0 && !firstLine.startsWith('#'),
      detail: firstLine ? `opens: "${firstLine.slice(0, 60)}"` : 'empty first line',
      required: true,
    },
    {
      key: 'single_idea',
      label: 'Focused on one core idea',
      pass: Boolean(post.single_idea?.trim()),
      detail: post.single_idea?.trim() ? post.single_idea.trim().slice(0, 80) : 'not stated',
      required: true,
    },
    {
      key: 'line_breaks',
      label: 'Uses line breaks for readability',
      pass: body.includes('\n') || body.length <= 120,
      detail: body.includes('\n') ? 'has line breaks' : 'one unbroken block',
      required: false, // a genuinely short post does not need them
    },
    {
      key: 'fits_the_platform',
      label: `Fits in ${X_MAX_CHARS} characters`,
      pass: xLength(body) <= X_MAX_CHARS,
      // X's own count: URLs are 23 whatever their length, emoji are 2.
      detail: `${xLength(body)} characters`,
      required: true,
    },
  ];

  return report(checks, wordCount(body));
}

export function checkNewsletter(n: Newsletter): RuleReport {
  const body = n.body_md ?? '';
  const words = wordCount(body);
  const introSentences = sentenceCount(n.intro ?? '');
  // Bold lead-ins and bullets, NOT markdown headings.
  //
  // A newsletter is a letter, not an article. `## The Reality Check` renders
  // as a heading the size of the subject line, which in an inbox reads as a
  // second article stapled inside the first — and in a plain-text client it
  // arrives as literal hashes. A bold lead-in does the same skimming job and
  // reads as correspondence in both.
  const main = n.main_section_md ?? '';
  const headings = main.match(/^#{1,6}\s+.+$/gm) ?? [];
  const skimmable = /\*\*[^*\n]+\*\*/.test(main) || /^\s*[-+*]\s+/m.test(main);

  const checks: RuleCheck[] = [
    {
      key: 'has_subject',
      label: 'Strong subject line',
      pass: Boolean(n.subject?.trim()),
      detail: n.subject?.trim() ? `"${n.subject.trim()}"` : 'no subject line',
      required: true,
    },
    {
      key: 'intro_length',
      label: 'Short intro of 1 to 3 sentences',
      pass: introSentences >= 1 && introSentences <= 3,
      detail: `${introSentences} sentence${introSentences === 1 ? '' : 's'}`,
      required: true,
    },
    {
      key: 'skimmable_main',
      label: 'Main value section is easy to skim',
      pass: skimmable,
      detail: skimmable ? 'has bold lead-ins or bullets' : 'no bold lead-ins or bullets',
      required: true,
    },
    {
      key: 'no_headings',
      label: 'Bold lead-ins, not markdown headings',
      pass: headings.length === 0,
      detail:
        headings.length === 0
          ? 'no markdown headings'
          : `${headings.length} markdown heading${headings.length === 1 ? '' : 's'} (${headings
              .slice(0, 2)
              .map((h) => h.trim())
              .join(', ')}${headings.length > 2 ? '…' : ''})`,
      required: true,
    },
    {
      key: 'has_cta',
      label: 'Clear call to action',
      pass: Boolean(n.cta?.trim()),
      detail: n.cta?.trim() ? `"${n.cta.trim()}"` : 'no CTA',
      required: true,
    },
    {
      key: 'has_sign_off',
      label: 'Friendly sign-off',
      pass: Boolean(n.sign_off?.trim()),
      detail: n.sign_off?.trim() ? `"${n.sign_off.trim()}"` : 'no sign-off',
      required: true,
    },
    {
      key: 'word_band',
      label: `${NEWSLETTER_MIN_WORDS} to ${NEWSLETTER_MAX_WORDS} words`,
      pass: words >= NEWSLETTER_MIN_WORDS && words <= NEWSLETTER_MAX_WORDS,
      detail: `${words} words`,
      required: true,
    },
    {
      key: 'secondary_item',
      label: 'Optional secondary item',
      pass: true, // optional by the brief; reported for visibility, never blocks
      detail: n.secondary_item_md?.trim() ? 'present' : 'none (allowed)',
      required: false,
    },
  ];

  return report(checks, words);
}

/** Dispatch on channel. The payload is the channel's own parsed structure. */
export function checkChannel(channel: Channel, payload: unknown): RuleReport {
  if (channel === 'linkedin') return checkLinkedIn(payload as LinkedInPost);
  if (channel === 'x') return checkX(payload as XPost);
  return checkNewsletter(payload as Newsletter);
}

/** The one-line reason a report failed, for an error message or a log. */
export function failureSummary(r: RuleReport): string {
  const failed = r.checks.filter((c) => c.required && !c.pass);
  if (!failed.length) return '';
  return failed.map((c) => `${c.label} (${c.detail})`).join('; ');
}

/**
 * The same failures, written as instructions to fix them.
 *
 * Handed back to the model on a packaging retry. "Fits in 280 characters
 * (384 characters)" states a fact; "cut at least 104 characters" is an
 * instruction, and the retry that follows it lands far more often — the
 * model does not have to work out the arithmetic it was bad at in the first
 * place.
 */
export function failureInstructions(channel: Channel, r: RuleReport, body: string): string {
  const failed = r.checks.filter((c) => c.required && !c.pass);
  if (!failed.length) return '';

  return failed
    .map((c) => {
      if (channel === 'x' && c.key === 'fits_the_platform') {
        const over = xLength(body) - X_MAX_CHARS;
        return `The post is ${xLength(body)} characters — ${over} too many. Cut at least ${over + 20} characters (aim for about 180 in total, not ${X_MAX_CHARS}).`;
      }
      if (channel === 'newsletter' && c.key === 'word_band') {
        if (r.word_count < NEWSLETTER_MIN_WORDS) {
          return `The newsletter is ${r.word_count} words — add at least ${NEWSLETTER_MIN_WORDS - r.word_count} more.`;
        }
        return `The newsletter is ${r.word_count} words — cut at least ${r.word_count - NEWSLETTER_MAX_WORDS}.`;
      }
      if (c.key === 'hashtag_cap') {
        return `Too many hashtags (${c.detail}). Keep one, at most two.`;
      }
      if (channel === 'newsletter' && c.key === 'no_headings') {
        // Names the exact rewrite rather than restating the rule, for the
        // same reason the character count does: the model is being asked to
        // make one mechanical substitution, so hand it the substitution.
        return (
          `The main section uses markdown headings — ${c.detail}. Remove every "#" line and ` +
          `turn each one into a bold lead-in on the first sentence of its paragraph instead: ` +
          `"## The Reality Check" becomes "**The reality check.**" at the start of the ` +
          `paragraph that followed it. A newsletter is a letter, not an article.`
        );
      }
      return `${c.label} — ${c.detail}. Fix this.`;
    })
    .join('\n');
}
