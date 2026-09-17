/**
 * Turning an approved asset plus its chosen tags into the exact text that gets
 * posted.
 *
 * Pure — no database, no 'server-only', no network — because this is the step
 * where a post becomes irreversible and the arithmetic has to be right. The
 * publishers call it; the queue route calls it too, so a post that cannot be
 * composed is refused while someone is looking at it rather than at 3am when
 * the worker picks it up.
 */

/**
 * X's limit for a STANDARD account.
 *
 * Not from the brief — the brief's X rules cover the hook, one idea, line
 * breaks and hashtags, and say nothing about length. 280 is the platform's
 * own limit, and it is tier-dependent: X Premium allows 4,000 and Premium+
 * 25,000. Overridable for that reason, because silently capping a Premium
 * account at 280 is a limit the platform is not imposing.
 */
export const X_MAX_CHARS = Number(process.env.X_POST_MAX_CHARS ?? 280);

/**
 * How many characters X thinks a post is, which is not `text.length`.
 *
 * Two rules move the number in opposite directions, and both matter:
 *
 *   • Every URL counts as 23, however long it is — X rewrites links to t.co.
 *     Counting the raw string rejects posts X would happily accept, and a
 *     content post with a source link is exactly where that bites.
 *   • Emoji count as 2. JavaScript already counts most of them as 2 (a
 *     surrogate pair), but not all: a BMP emoji like ☀ is 1 to JS and 2 to X.
 *     That is the dangerous direction — undercounting means accepting a post
 *     X then rejects, after it has been queued and released.
 *
 * Everything else is one per code point, so an astral non-emoji character is
 * 1 rather than the 2 that `.length` reports. This is not full twitter-text
 * parity, which needs their weighted-range table; it is the two rules that
 * account for essentially every real post this system writes.
 */
export function xLength(text: string): number {
  // Matched first so their contents are not also counted as characters.
  const urls = text.match(/https?:\/\/[^\s]+/g) ?? [];
  const withoutUrls = text.replace(/https?:\/\/[^\s]+/g, '');

  let count = urls.length * 23;
  for (const char of withoutUrls) {
    count += /\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
  }
  return count;
}

export type Composed = { ok: true; text: string } | { ok: false; error: string };

/**
 * An X post with its mentions.
 *
 * The tags go at the END, on their own line. Two reasons, and the first is
 * the one that matters: a post that OPENS with a mention is shown by X only
 * to people who follow both accounts, which quietly halves the reach of every
 * tagged post. Putting them last avoids that entirely. The second is simply
 * that the approved copy stays the first thing a reader sees.
 *
 * The count is the whole composed string, not the body: a 275-character post
 * with two handles appended is 300 characters, and X rejects it outright
 * rather than truncating. The asset passed its rule check at 280 before the
 * tags existed, so this is the only place the real number is known.
 */
export function composeXPost(body: string, tagHandles: string[]): Composed {
  const base = body.trim();
  const tags = dedupe(tagHandles);

  if (!tags.length) {
    const length = xLength(base);
    return length <= X_MAX_CHARS
      ? { ok: true, text: base }
      : {
          ok: false,
          error: `the post is ${length} characters, ${length - X_MAX_CHARS} over X's limit of ${X_MAX_CHARS}`,
        };
  }

  // A handle already written into the copy is not repeated underneath it.
  const missing = tags.filter((t) => !mentions(base, t));
  const text = missing.length ? `${base}\n\n${missing.join(' ')}` : base;

  const length = xLength(text);
  if (length > X_MAX_CHARS) {
    const over = length - X_MAX_CHARS;
    const added = length - xLength(base);
    // Shows its own arithmetic. "288 characters" alone invites the question
    // "288 of what?" — the post passed its own 280 check before the tags
    // existed, so the number only makes sense broken into its two parts.
    return {
      ok: false,
      error:
        `the post is ${xLength(base)} characters and tagging ${missing.length} ` +
        `account${missing.length === 1 ? '' : 's'} adds ${added} more — ` +
        `${length} in total, ${over} over X's limit of ${X_MAX_CHARS}. ` +
        'Shorten the post or tag fewer accounts.',
    };
  }
  return { ok: true, text };
}

/**
 * LinkedIn commentary with its mentions.
 *
 * **These are plain text, not real mentions**, and that is a genuine
 * limitation rather than an oversight. LinkedIn only renders a mention when
 * the commentary carries the entity's URN — `@[Koya Talent](urn:li:organization:123)`
 * — and the visible text matches that entity's name exactly. A handle typed
 * into a form is a vanity slug, which is not a URN and cannot be turned into
 * one without a lookup the app has no permission to make.
 *
 * So the accounts appear, and a reader can find them, but LinkedIn will not
 * notify them. Saying that plainly in the UI beats shipping something that
 * looks like tagging and silently is not.
 *
 * There is no character limit here worth enforcing: LinkedIn's commentary
 * limit is 3000, and the channel rules already hold these posts far below it.
 */
export function composeLinkedInPost(body: string, tagHandles: string[]): Composed {
  const base = body.trim();
  if (!base) return { ok: false, error: 'the post is empty' };

  const tags = dedupe(tagHandles).filter((t) => !mentions(base, t));
  return { ok: true, text: tags.length ? `${base}\n\n${tags.join(' ')}` : base };
}

/** Case-insensitive, and only on a whole-handle boundary — @koya must not match @koyatalent. */
function mentions(text: string, handle: string): boolean {
  const bare = handle.replace(/^@+/, '');
  return new RegExp(`@${escapeRegExp(bare)}(?![A-Za-z0-9_-])`, 'i').test(text);
}

function dedupe(handles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of handles) {
    const key = h.replace(/^@+/, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h.startsWith('@') ? h : `@${h}`);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
