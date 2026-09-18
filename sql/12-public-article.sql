-- ════════════════════════════════════════════════════════════════════════════
-- 12 · The public article — the one page in this system with no sign-in
--
-- Everything else here is an internal tool. This is not, so it is built to a
-- different standard:
--
--   • Addressed by an unguessable token, never by the request id. A sequential
--     or known id would let anyone walk the corpus; a 128-bit token cannot be
--     enumerated.
--   • The token is issued only when a request is APPROVED. Draft, rejected and
--     in-flight work has no address at all, so there is nothing to leak.
--   • Views are counted without storing who. A salted hash of address and
--     browser, bucketed by day, is enough to stop one reader counting twenty
--     times on refresh, and is not a record of anybody.
-- ════════════════════════════════════════════════════════════════════════════

alter table content_requests
  add column if not exists public_token text unique;

create table if not exists article_views (
  id          bigserial primary key,
  request_id  uuid not null references content_requests(id) on delete cascade,
  -- Which draft was on the page. A view of r2 and a view of r5 are different
  -- facts, and the approved version can change under a stable URL.
  version_id  uuid references article_versions(id) on delete set null,
  viewed_at   timestamptz not null default now(),
  -- sha256(salt + address + user agent + date). Not reversible to a person,
  -- and rotates daily, so it cannot be used to follow anyone across days.
  visitor_day text not null,
  referrer    text,
  -- One reader, one view, per day. A refresh is not a reader.
  unique (request_id, visitor_day)
);

create index if not exists article_views_request_idx
  on article_views (request_id, viewed_at desc);

alter table article_views enable row level security;
