import { z } from 'zod';

/**
 * Shared field rules, so a field is validated the same way in the form, in
 * the route handler, and in anything else that ever touches it.
 *
 * Two things this file is careful about:
 *
 * **Dates are directional.** A date field is almost never "any date" — it is
 * either something that has to be ahead of now (a deadline, a publish time)
 * or behind it (a publication date on a source you are citing). Allowing the
 * wrong direction produces nonsense that nothing downstream can catch: a
 * deadline in the past is unmeetable, and content scheduled for last Tuesday
 * is published the instant the worker next runs, with no warning.
 *
 * **Messages are for the person, not the schema.** "Invalid input" tells
 * someone nothing about what to change. Every message here names the field's
 * actual constraint.
 */

/* ─── Text ───────────────────────────────────────────────────────────────── */

/** Trimmed, non-empty, bounded. `what` appears in the message. */
export const requiredText = (what: string, min = 1, max = 2000) =>
  z
    .string()
    .trim()
    .min(min, min === 1 ? `${what} is required.` : `${what} needs at least ${min} characters.`)
    .max(max, `${what} is too long — keep it under ${max} characters.`);

export const optionalText = (max = 2000) =>
  z.string().trim().max(max, `Too long — keep it under ${max} characters.`).default('');

/**
 * A URL we are willing to fetch. http/https only: a `javascript:` or `data:`
 * URL in a field that later renders as a link is a stored-XSS vector, and a
 * `file:` one asks the server to read its own disk.
 */
export const httpUrl = (what = 'That') =>
  z
    .string()
    .trim()
    .url(`${what} does not look like a URL.`)
    .refine((u) => /^https?:\/\//i.test(u), `${what} must start with http:// or https://.`)
    .refine((u) => {
      try {
        const host = new URL(u).hostname;
        // Blocks the obvious SSRF shapes. Not a complete defence — that needs
        // egress rules — but it stops the accidental and the casual.
        return !/^(localhost|127\.|0\.0\.0\.0|169\.254\.|10\.|192\.168\.)/i.test(host);
      } catch {
        return false;
      }
    }, `${what} cannot point at a local or private address.`);

/** Optional URL: empty string is allowed and becomes null. */
export const optionalHttpUrl = (what = 'That') =>
  z
    .union([httpUrl(what), z.literal('')])
    .optional()
    .transform((v) => (v ? v : null));

export const email = () =>
  z
    .string()
    .trim()
    .toLowerCase()
    .email('That does not look like an email address.')
    .max(254, 'That email address is too long.');

/* ─── Dates ──────────────────────────────────────────────────────────────── */

/** A little slack, so "now" typed in a form isn't rejected by the round trip. */
const CLOCK_SLACK_MS = 60_000;

/**
 * A moment that must not have passed yet — a deadline, a scheduled publish.
 *
 * `maxYearsAhead` catches the other direction of nonsense: a typo that puts a
 * publish date in 2125 would otherwise sit in the queue forever, invisible,
 * because the worker only ever looks for rows that are due.
 */
export const futureDate = (what: string, maxYearsAhead = 2) =>
  z
    .string()
    .datetime({ offset: true, message: `${what} is not a valid date and time.` })
    .refine(
      (v) => new Date(v).getTime() > Date.now() - CLOCK_SLACK_MS,
      `${what} has to be in the future.`,
    )
    .refine((v) => {
      const limit = new Date();
      limit.setFullYear(limit.getFullYear() + maxYearsAhead);
      return new Date(v).getTime() <= limit.getTime();
    }, `${what} is further ahead than ${maxYearsAhead} year${maxYearsAhead === 1 ? '' : 's'} — check the year.`);

/**
 * A moment that must already have happened — when a source was published,
 * for instance. A future publication date on a citation is either a typo or
 * a claim about something that has not been said yet.
 */
export const pastDate = (what: string, maxYearsBack = 100) =>
  z
    .string()
    .datetime({ offset: true, message: `${what} is not a valid date and time.` })
    .refine(
      (v) => new Date(v).getTime() <= Date.now() + CLOCK_SLACK_MS,
      `${what} cannot be in the future.`,
    )
    .refine((v) => {
      const limit = new Date();
      limit.setFullYear(limit.getFullYear() - maxYearsBack);
      return new Date(v).getTime() >= limit.getTime();
    }, `${what} is further back than ${maxYearsBack} years — check the year.`);

export const optionalFutureDate = (what: string, maxYearsAhead = 2) =>
  z
    .union([futureDate(what, maxYearsAhead), z.literal('')])
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

/* ─── Helpers for the browser side ───────────────────────────────────────── */

/**
 * `min`/`max` for a `<input type="datetime-local">`, in the format that input
 * demands (local time, no timezone, no seconds).
 *
 * The browser constraint and the Zod rule have to agree or the form becomes a
 * liar: the picker lets you choose something the server then refuses.
 */
export function dateTimeLocalBounds(direction: 'future' | 'past', years = 2) {
  const fmt = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  };
  const now = new Date();
  const far = new Date();
  if (direction === 'future') {
    far.setFullYear(far.getFullYear() + years);
    return { min: fmt(now), max: fmt(far) };
  }
  far.setFullYear(far.getFullYear() - years);
  return { min: fmt(far), max: fmt(now) };
}

/** The first message from a ZodError, which is the one worth showing. */
export function firstIssue(err: z.ZodError): string {
  return err.issues[0]?.message ?? 'Something in that form is not valid.';
}

/* ─── Social handles ─────────────────────────────────────────────────────── */

/**
 * An account to tag in a post.
 *
 * The two platforms are genuinely different, so one regex for both would have
 * to be the loose one, and a handle that is silently wrong is worse than a
 * rejected one: the post goes out mentioning nobody, and you find out when the
 * person you meant to credit says they never saw it.
 *
 *   X         — 1–15 characters, letters/digits/underscore. Hard platform rule.
 *   LinkedIn  — a vanity slug, 3–100 characters, letters/digits/hyphens. People
 *               usually have a trailing number; companies usually do not.
 *
 * Both accept what someone will actually paste — a bare name, an @name, or the
 * full profile URL — and normalise to a leading @, because that is what has to
 * end up in the post body.
 */
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const LINKEDIN_SLUG = /^[A-Za-z0-9\-À-ÿ]{3,100}$/;

/** Strip @, a full profile URL, and surrounding whitespace down to the slug. */
export function bareHandle(input: string): string {
  let v = input.trim();
  const url = v.match(/^https?:\/\/(?:[a-z]{2,3}\.)?(?:twitter\.com|x\.com|linkedin\.com)\/(?:in\/|company\/|school\/)?([^/?#]+)/i);
  if (url) v = url[1]!;
  return v.replace(/^@+/, '').replace(/\/+$/, '').trim();
}

export function normaliseHandle(channel: 'x' | 'linkedin', input: string): string | null {
  const bare = bareHandle(input);
  if (!bare) return null;
  const ok = channel === 'x' ? X_HANDLE.test(bare) : LINKEDIN_SLUG.test(bare);
  return ok ? `@${bare}` : null;
}

/**
 * A list of accounts to tag, as typed into one field.
 *
 * Accepts commas, spaces or newlines as separators, because people paste from
 * all three. Duplicates are dropped rather than rejected — the same handle
 * twice is a slip, not a decision worth an error message.
 */
export const tagHandles = (channel: 'x' | 'linkedin', max = 10) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => v ?? '')
    .transform((v, ctx) => {
      // The separator differs by channel, and it matters.
      //
      // X handles never contain a space and people type them space-separated
      // ("@ada @grace"), so whitespace splits. LinkedIn slugs never contain a
      // space either — but the thing people reach for there is the person's
      // NAME, and splitting "Ada Lovelace" on the space would turn one wrong
      // input into two plausible-looking mentions of accounts that are not
      // theirs. Keeping the space inside the token makes it fail the slug
      // check and say so.
      const separator = channel === 'x' ? /[\s,]+/ : /[,\n\r\t]+/;
      const parts = v.split(separator).map((x) => x.trim()).filter(Boolean);
      const out: string[] = [];
      for (const part of parts) {
        const handle = normaliseHandle(channel, part);
        if (!handle) {
          ctx.addIssue({
            code: 'custom',
            message:
              channel === 'x'
                ? `"${part}" is not an X handle. They are 1–15 letters, digits or underscores.`
                : `"${part}" is not a LinkedIn profile. Use the name from the profile URL, or paste the URL.`,
          });
          return z.NEVER;
        }
        if (!out.includes(handle)) out.push(handle);
      }
      if (out.length > max) {
        ctx.addIssue({ code: 'custom', message: `That is more than ${max} accounts to tag.` });
        return z.NEVER;
      }
      return out;
    });
