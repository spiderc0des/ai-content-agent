# Supabase Auth email templates

Six templates, matching the styling of the mail this app sends itself. Paste
each into **Authentication → Emails → Templates** in the Supabase dashboard.

They are generated, not hand-written — `lib/email-layout.ts` is the source of
the shell, so a change to the app's email styling regenerates all six:

```bash
EMAIL_TEMPLATES=1 npx vitest run test/supabase-templates.manual.test.ts
```

## What goes where

| Dashboard template | File | Subject |
| --- | --- | --- |
| Magic Link | `magic-link.html` | Your sign-in link |
| Invite user | `invite-user.html` | You're invited to the Koya Content Agent |
| Confirm signup | `confirm-signup.html` | Confirm your email |
| Reset password | `reset-password.html` | Reset your password |
| Change email address | `change-email.html` | Confirm your new email address |
| Reauthentication | `reauthentication.html` | Your verification code |

## Before they work

**Authentication → URL Configuration**

- **Site URL** — your deployed origin, e.g. `https://ai-content-agent.vercel.app`.
  Every template builds its link from `{{ .SiteURL }}`, so if this is wrong the
  links point at the wrong place and nothing else will save you.
- **Redirect URLs** — add `https://your-app.vercel.app/**`. Supabase refuses a
  `redirect_to` that is not on this list.

For local testing, set Site URL to `http://localhost:3000` and add
`http://localhost:3000/**`.

## Why these use `{{ .TokenHash }}` and not `{{ .ConfirmationURL }}`

Every link points at this app's own `/auth/confirm`:

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink&redirect_to={{ .RedirectTo }}
```

Two reasons, and the second is the one that actually bites:

- `ConfirmationURL` sends people to Supabase's verify endpoint, which returns
  tokens in a **URL fragment**. A fragment is never sent to the server, so a
  server-rendered app cannot read it.
- **Corporate mail scanners follow links in incoming mail.** A one-shot
  confirmation link is spent before the recipient ever clicks it, and they are
  told their link has expired. Verifying server-side from a `token_hash` is
  the pattern Supabase documents for this.

The `type` value must match what `/auth/confirm` accepts, and each template has
its own — `magiclink`, `invite`, `email`, `recovery`, `email_change`. Getting
one wrong fails *after* someone has clicked a link in their inbox, and looks
exactly like an expired link.

## Which of these this app actually sends

- **Magic Link** — `/login`, every sign-in.
- **Confirm signup** — also `/login`. Worth knowing: when the address is one
  Supabase has never seen, `signInWithOtp` sends **Confirm signup**, not Magic
  Link. A first-time sign-in uses a different template than every one after it,
  which is why both need to work.
- **Invite user** — *not used.* `/api/admin/invites` calls `generateLink()`,
  which creates the account and hands the link back without sending anything,
  and the app emails it over its own SMTP (`lib/email.ts`). The template is
  here so the dashboard is consistent if you ever invite from there directly.
- **Reset password**, **Change email**, **Reauthentication** — not reachable in
  the UI. Sign-in is passwordless and there is no password to reset. They are
  included so no template in the dashboard is left on a default that would not
  work with this app's auth routes.

## Security notification templates

Supabase also has seven notification-only templates — Password Changed, Email
Address Changed, Phone Number Changed, Sign-in Method Linked / Removed,
Verification Method Added / Removed. They carry no link and no token, so there
is nothing here that could be wrong. Left on their defaults.
