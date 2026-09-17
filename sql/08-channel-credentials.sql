-- ════════════════════════════════════════════════════════════════════════════
-- 08 · Channel credentials — the tokens that let this app post as you
--
-- One row per channel, holding an OAuth access token and (where the provider
-- issues one) a refresh token. Both are CREDENTIALS: anyone holding them can
-- post as the connected account until they are revoked. Three consequences,
-- all of them deliberate:
--
--   • The tokens are stored ENCRYPTED, not as text. A service-role key plus a
--     connection string is enough to read this table; the encryption key lives
--     in the environment and not in the database, so a database dump alone
--     does not hand someone the ability to post as the agency.
--   • Nothing here is ever written to `events`. That table is append-only by
--     trigger, so a token logged into it could never be removed again — the
--     same reason the invite link is kept out of it.
--   • There is no history. This is the one table in the project that is
--     deliberately mutable and deliberately forgetful: a rotated token must
--     leave no trace of its predecessor.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists channel_credentials (
  -- The channel IS the identity. One connected account per channel: an agency
  -- posts as itself, and "which of our four X accounts" is a question this
  -- system has no way to answer at queue time.
  channel            channel primary key,

  -- AES-256-GCM, base64, as written by lib/crypto.ts. Never plaintext.
  access_token_enc   text not null,
  refresh_token_enc  text,

  -- When the access token dies. Null means the provider did not say, in which
  -- case it is refreshed on a 401 rather than on a clock.
  expires_at         timestamptz,

  -- What the tokens were granted for. Checked before posting, so a token that
  -- predates a scope change fails with "reconnect" rather than a raw 403.
  scopes             text[] not null default '{}',

  -- Who this posts as, for the UI to show and for LinkedIn to address.
  -- LinkedIn needs it in the request body (urn:li:person:… or
  -- urn:li:organization:…); X does not, and stores the handle for display.
  account_label      text not null default '',
  author_urn         text,

  connected_by       uuid references app_users(id),
  connected_at       timestamptz not null default now(),
  -- Set when a refresh or a post comes back 401, so the UI can say
  -- "reconnect" instead of failing every scheduled post in silence.
  invalid_since      timestamptz,
  last_error         text
);

alter table channel_credentials enable row level security;
