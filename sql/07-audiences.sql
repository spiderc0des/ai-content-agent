-- ════════════════════════════════════════════════════════════════════════════
-- 07 · Audiences — who a newsletter goes to, and who gets tagged in a post
--
-- Everything before this file gets content as far as "approved and formatted".
-- None of it knows who the content is FOR. A newsletter with no recipient list
-- is not a newsletter, and a LinkedIn post that was supposed to tag a partner
-- and didn't is a post that has to be deleted and redone.
--
-- Two different shapes, because they are two different things:
--
--   • An email group is a LIST that outlives any one send. It is managed by an
--     admin, reused across requests, and its membership changes over time.
--     So: its own tables, owned by the admin page.
--
--   • Tags are chosen PER POST. "Tag the customer we quoted" is a decision
--     about this post, not a standing audience, and a saved directory of
--     handles would be a second thing to maintain for no gain.
--     So: a column on the publication, set by the publisher at queue time.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Email groups ───────────────────────────────────────────────────────────

create table if not exists email_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text not null default '',
  created_by  uuid not null references app_users(id),
  created_at  timestamptz not null default now(),
  -- Soft delete, like content_requests. A group that has been sent to is part
  -- of the record of who received what; deleting the row would make an old
  -- publication point at nothing.
  archived_at timestamptz,
  constraint email_groups_name_not_blank check (btrim(name) <> '')
);

-- Unique among LIVE groups only, so archiving "Q3 customers" frees the name.
create unique index if not exists email_groups_live_name_idx
  on email_groups (lower(btrim(name)))
  where archived_at is null;

create table if not exists email_group_members (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references email_groups(id) on delete cascade,
  email      text not null,
  name       text not null default '',
  added_by   uuid references app_users(id),
  added_at   timestamptz not null default now(),
  -- Someone who asked to stop receiving these. Kept rather than deleted so
  -- re-importing a list cannot silently resubscribe them.
  unsubscribed_at timestamptz,
  unique (group_id, email),
  -- Stored lowercase so "A@x.com" and "a@x.com" cannot both be in one group.
  constraint email_group_members_email_is_lower check (email = lower(email)),
  constraint email_group_members_email_shape check (email like '%_@_%._%')
);

create index if not exists email_group_members_group_idx
  on email_group_members (group_id)
  where unsubscribed_at is null;

-- ─── Publication targeting ──────────────────────────────────────────────────

alter table publications
  add column if not exists email_group_id uuid references email_groups(id),
  add column if not exists tag_handles    text[] not null default '{}',
  -- Filled at RELEASE, not at queue time: the group is a live list, and
  -- someone added the day before a scheduled send should receive it. What is
  -- recorded here is who it actually went to, which is the thing you need
  -- afterwards and the thing a queue-time snapshot would get wrong.
  add column if not exists recipients_json jsonb;

do $$
begin
  -- A recipient list only means anything for the newsletter, and tagging only
  -- means anything on a social channel. Enforced here rather than in the route
  -- so a future publisher cannot quietly attach one to the wrong channel.
  if not exists (select 1 from pg_constraint where conname = 'publications_group_is_newsletter_only') then
    alter table publications add constraint publications_group_is_newsletter_only
      check (email_group_id is null or channel = 'newsletter');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'publications_tags_are_social_only') then
    alter table publications add constraint publications_tags_are_social_only
      check (cardinality(tag_handles) = 0 or channel in ('x', 'linkedin'));
  end if;

  -- X allows a post to mention many accounts, but a post that is mostly
  -- mentions reads as spam and the platforms treat it that way. Ten is well
  -- past any legitimate use and stops a paste accident becoming a send.
  if not exists (select 1 from pg_constraint where conname = 'publications_tag_cap') then
    alter table publications add constraint publications_tag_cap
      check (cardinality(tag_handles) <= 10);
  end if;
end $$;

-- ─── RLS, same as every other table ─────────────────────────────────────────

alter table email_groups        enable row level security;
alter table email_group_members enable row level security;
