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

/** X's own limit for a standard post. */
export const X_MAX_CHARS = 280;

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
    return base.length <= X_MAX_CHARS
      ? { ok: true, text: base }
      : {
          ok: false,
          error: `the post is ${base.length} characters, ${base.length - X_MAX_CHARS} over X's limit of ${X_MAX_CHARS}`,
        };
  }

  // A handle already written into the copy is not repeated underneath it.
  const missing = tags.filter((t) => !mentions(base, t));
  const text = missing.length ? `${base}\n\n${missing.join(' ')}` : base;

  if (text.length > X_MAX_CHARS) {
    const over = text.length - X_MAX_CHARS;
    const added = text.length - base.length;
    // Shows its own arithmetic. "288 characters" alone invites the question
    // "288 of what?" — the post passed its own 280 check before the tags
    // existed, so the number only makes sense broken into its two parts.
    return {
      ok: false,
      error:
        `the post is ${base.length} characters and tagging ${missing.length} ` +
        `account${missing.length === 1 ? '' : 's'} adds ${added} more — ` +
        `${text.length} in total, ${over} over X's limit of ${X_MAX_CHARS}. ` +
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
