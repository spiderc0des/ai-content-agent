import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { emailShell, p as para, button } from '../lib/email-layout';

/**
 * Not a test — a generator.
 *
 * Supabase's email templates live in its dashboard, which means they are the
 * one part of this system with no source of truth in the repo and no way to
 * review a change. Generating them from the app's OWN email shell fixes both:
 * they cannot drift from the styling of the mail this app sends itself, and a
 * change to the shell regenerates all six.
 *
 *   EMAIL_TEMPLATES=1 npx vitest run test/supabase-templates.manual.test.ts
 */

/**
 * Every link uses `{{ .TokenHash }}` against this app's own /auth/confirm,
 * not `{{ .ConfirmationURL }}`.
 *
 * Two reasons, and the second is the one that bites:
 *   • ConfirmationURL points at Supabase's verify endpoint, which hands back
 *     tokens in a URL fragment. A fragment never reaches the server, so a
 *     server-rendered app cannot read it.
 *   • Corporate mail scanners follow links in incoming mail. A one-shot
 *     confirmation link is then spent before the recipient ever clicks it, and
 *     the person is told their link expired. Verifying server-side from a
 *     token_hash is the pattern Supabase documents for exactly this.
 */
const confirmUrl = (type: string) =>
  `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}&redirect_to={{ .RedirectTo }}`;

const TEMPLATES: { file: string; subject: string; title: string; preheader: string; body: string }[] = [
  {
    file: 'magic-link',
    subject: 'Your sign-in link',
    title: 'Sign in to Koya',
    preheader: 'One link, no password. It expires shortly.',
    body:
      para('Here is your sign-in link.') +
      button({ label: 'Sign in', href: confirmUrl('magiclink') }) +
      para('If you did not ask for this, ignore it — nothing happens until the link is used.', true),
  },
  {
    file: 'invite-user',
    subject: "You're invited to the Koya Content Agent",
    title: "You're invited",
    preheader: 'Your access is set up and switches on when you sign in.',
    body:
      para('You have been invited to the Koya Content Agent.') +
      button({ label: 'Accept invitation', href: confirmUrl('invite') }) +
      para('Your access is already set up. It switches on the first time you sign in.', true),
  },
  {
    file: 'confirm-signup',
    subject: 'Confirm your email',
    title: 'Confirm your email',
    preheader: 'One click and you are in.',
    body:
      para('Confirm this address to finish signing in.') +
      button({ label: 'Confirm email', href: confirmUrl('email') }) +
      para('If you did not ask for this, ignore it.', true),
  },
  {
    file: 'reset-password',
    subject: 'Reset your password',
    title: 'Reset your password',
    preheader: 'Only use this if you asked for it.',
    body:
      para('Use this link to set a new password.') +
      button({ label: 'Set a new password', href: confirmUrl('recovery') }) +
      para(
        'If you did not ask for this, ignore it — your password stays as it is.',
        true,
      ),
  },
  {
    file: 'change-email',
    subject: 'Confirm your new email address',
    title: 'Confirm your new address',
    preheader: 'Until you confirm, the old address stays in use.',
    body:
      para('Confirm the change from {{ .Email }} to <strong>{{ .NewEmail }}</strong>.') +
      button({ label: 'Confirm the change', href: confirmUrl('email_change') }) +
      para('Until you confirm, the old address stays in use.', true),
  },
  {
    file: 'reauthentication',
    subject: 'Your verification code',
    title: 'Your verification code',
    preheader: 'A six-digit code, good for a few minutes.',
    // The only one with no link: reauthentication sends a code to type back in.
    body:
      para('Enter this code to confirm it is you:') +
      `<p style="margin:0 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:600;letter-spacing:.18em;color:#16150f;">{{ .Token }}</p>` +
      para('It expires in a few minutes. If you did not ask for it, ignore it.', true),
  },
];

describe.skipIf(!process.env.EMAIL_TEMPLATES)('supabase email templates', () => {
  it('writes one HTML file per template', () => {
    const index: string[] = [];
    for (const t of TEMPLATES) {
      const html = emailShell({
        title: t.title,
        preheader: t.preheader,
        body: t.body,
        signature: 'Koya Talent',
      });
      writeFileSync(`supabase/email-templates/${t.file}.html`, html);
      index.push(`${t.file}.html  —  subject: ${t.subject}`);
    }
    console.log(index.join('\n'));
  });
});
