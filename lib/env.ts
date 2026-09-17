import 'server-only';
import { z } from 'zod';

/**
 * Every setting the app needs, checked once at startup.
 *
 * The point of this file: if a variable is missing, the app refuses to start
 * and NAMES the variable. Without it you get `undefined` thrown from deep
 * inside an API route an hour later, and you debug the wrong thing.
 */
const Schema = z.object({
  ANTHROPIC_API_KEY: z.string().min(10, 'looks too short to be a real key'),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  DATABASE_URL: z.string().startsWith('postgres'),

  APP_URL: z.string().url(),

  // Optional, but the publishing worker refuses to run without it rather
  // than running unsecured — an endpoint that publishes content on a GET is
  // not something to leave open. Vercel Cron sends it as `Authorization: Bearer`.
  CRON_SECRET: z.string().min(16, 'use something long enough to be worth guessing at').optional(),

  MOCK_ANTHROPIC: z.enum(['0', '1']).default('0'),

  // Gmail SMTP, the same transport week 3 uses.
  //
  // Optional on purpose. Without it the newsletter still reaches the queue,
  // is still approved, formatted and scheduled — it is simply released for a
  // person to send rather than delivered by the app, and the publication row
  // says which of the two happened. Making it required would mean nobody can
  // run this project at all without a mail account, to automate one channel
  // out of three.
  GMAIL_USER: z.string().email().optional(),
  GMAIL_APP_PASSWORD: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('Koya Talent'),

  /* ─── Live posting (all optional) ───────────────────────────────────────
   *
   * Absent, the channel stays on the manual publisher: the post is still
   * approved, formatted, scheduled and released — a person copies it across.
   * Present, the app posts for you. Which of the two happened is recorded on
   * the publication, so nobody has to guess afterwards.
   */

  // Encrypts OAuth tokens at rest (lib/crypto.ts). 32 random bytes, base64:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  // Changing it invalidates every stored connection, which then has to be
  // reconnected — so it is checked for length rather than silently accepted.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(32, 'needs to be at least 32 characters — generate one with randomBytes(32)')
    .optional(),

  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),

  LINKEDIN_CLIENT_ID: z.string().optional(),
  LINKEDIN_CLIENT_SECRET: z.string().optional(),
  // Which LinkedIn account the posts are authored by. An organization page
  // (urn:li:organization:12345, needs w_organization_social and a page admin
  // role) or a personal profile (urn:li:person:abc123, needs w_member_social).
  // Left unset, the connect flow reads the signed-in member's own URN.
  LINKEDIN_AUTHOR_URN: z
    .string()
    .regex(
      /^urn:li:(organization|person):[A-Za-z0-9_-]+$/,
      'must look like urn:li:organization:12345 or urn:li:person:abc123',
    )
    .optional(),
});

function load() {
  const parsed = Schema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')} — ${i.message}`)
      .join('\n');
    throw new Error(
      `\nThe app cannot start. These environment variables are missing or wrong:\n\n${problems}\n\n` +
        `Copy .env.example to .env.local and fill them in.\n`,
    );
  }
  return parsed.data;
}

export const env = load();

/** True when Claude calls should be served from recorded fixtures. */
export const mockClaude = env.MOCK_ANTHROPIC === '1';

/** True when the scheduled publishing worker is allowed to run at all. */
export const cronEnabled = Boolean(env.CRON_SECRET);

/**
 * True when the app can actually deliver email.
 *
 * Both halves or neither: a user without a password authenticates as nobody,
 * and nodemailer would fail per-send rather than at startup — which is the
 * worst place to find out, because by then a newsletter has been marked
 * published.
 */
export const emailEnabled = Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD);

/**
 * Whether a channel can post for itself.
 *
 * Both halves of the app's own OAuth registration must be present. The token
 * for the connected ACCOUNT is a separate question, answered per request from
 * channel_credentials — an app can be configured and simply not connected yet,
 * which is the normal state on a fresh install.
 */
export const xConfigured = Boolean(
  env.X_CLIENT_ID && env.X_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY,
);
export const linkedinConfigured = Boolean(
  env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY,
);
