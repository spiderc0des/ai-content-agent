-- ════════════════════════════════════════════════════════════════════════════
-- Koya Content Agent — triggers
--
-- Run after 01-schema.sql. Idempotent: safe to re-run.
--
-- These are the rules that must hold even if a route handler forgets them.
-- Application code can have a bug; a trigger is the floor.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Immutability ───────────────────────────────────────────────────────────

create or replace function events_are_immutable() returns trigger as $$
begin
  raise exception 'events is append-only: % is not permitted', tg_op;
end $$ language plpgsql;

drop trigger if exists events_no_change on events;
create trigger events_no_change
  before update or delete on events
  for each row execute function events_are_immutable();

-- The review history requirement (PRD test 4) rests on this. An "edit" in the
-- review UI is an INSERT with origin='human_edited'; there is no code path
-- that rewrites prose in place, and this makes that true rather than
-- merely intended.
create or replace function article_versions_are_immutable() returns trigger as $$
begin
  raise exception 'article_versions is append-only: % is not permitted', tg_op;
end $$ language plpgsql;

drop trigger if exists article_versions_no_change on article_versions;
create trigger article_versions_no_change
  before update or delete on article_versions
  for each row execute function article_versions_are_immutable();

create or replace function reviews_are_immutable() returns trigger as $$
begin
  raise exception 'reviews is append-only: % is not permitted', tg_op;
end $$ language plpgsql;

drop trigger if exists reviews_no_change on reviews;
create trigger reviews_no_change
  before update or delete on reviews
  for each row execute function reviews_are_immutable();

create or replace function evaluations_are_immutable() returns trigger as $$
begin
  raise exception 'evaluations is append-only: % is not permitted', tg_op;
end $$ language plpgsql;

drop trigger if exists evaluations_no_change on evaluations;
create trigger evaluations_no_change
  before update or delete on evaluations
  for each row execute function evaluations_are_immutable();

-- ─── updated_at ─────────────────────────────────────────────────────────────

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end $$ language plpgsql;

drop trigger if exists content_requests_touch on content_requests;
create trigger content_requests_touch
  before update on content_requests
  for each row execute function touch_updated_at();

-- ─── The human gate ─────────────────────────────────────────────────────────

-- PRD test 5: "must not publish or schedule until a human approves."
-- Three conditions, all required, none of them optional in any code path:
--   1. you can only approve from awaiting_review
--   2. you must have selected which of the article options you are approving
--   3. the exact version approved must be recorded, with its hash
create or replace function guard_content_approval() returns trigger as $$
begin
  if new.status = 'approved' and new.status is distinct from old.status then
    if old.status <> 'awaiting_review' then
      raise exception
        'cannot approve from %: a request must be awaiting_review first', old.status;
    end if;
    if new.selected_article_id is null then
      raise exception 'cannot approve without a selected article option';
    end if;
    if new.approved_version_id is null or new.approved_content_hash is null then
      raise exception
        'cannot approve without recording the exact version and its content hash';
    end if;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists content_requests_guard_approval on content_requests;
create trigger content_requests_guard_approval
  before update on content_requests
  for each row execute function guard_content_approval();

-- A publication must never outrun the approval. The asset being queued has to
-- derive from THE version that was approved — not a later one, not an earlier
-- one.
create or replace function guard_publication_insert() returns trigger as $$
declare
  r content_requests;
  asset_version uuid;
begin
  select * into r from content_requests where id = new.request_id;
  if r.id is null then
    raise exception 'no such content request: %', new.request_id;
  end if;
  if r.status not in ('ready','queued') then
    raise exception
      'cannot queue a publication for a request in status % (needs ready or queued)', r.status;
  end if;
  if r.approved_version_id is null then
    raise exception 'cannot queue a publication: this request has no recorded approval';
  end if;

  select version_id into asset_version from channel_assets where id = new.asset_id;
  if asset_version is null then
    raise exception 'no such channel asset: %', new.asset_id;
  end if;
  if asset_version <> r.approved_version_id then
    raise exception
      'asset derives from version % but version % was approved',
      asset_version, r.approved_version_id;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists publications_guard_insert on publications;
create trigger publications_guard_insert
  before insert on publications
  for each row execute function guard_publication_insert();

-- Editing after approval must cost the approval, or the gate is decorative.
--
-- Inserting an article_version for a request that is already approved / ready
-- / queued sends it back to awaiting_review, clears the approval block,
-- cancels anything still queued, and logs why. The actor comes from
-- `app.actor`, which lib/queries.ts sets on the connection before the insert.
create or replace function revoke_approval_on_new_version() returns trigger as $$
declare
  r content_requests;
begin
  select * into r from content_requests where id = new.request_id;
  if r.id is null then return new; end if;

  if r.status in ('approved','ready','queued') then
    update content_requests set
      status                = 'awaiting_review',
      approved_at           = null,
      approved_version_id   = null,
      approved_content_hash = null,
      reviewer_id           = null,
      version               = version + 1
    where id = new.request_id;

    update publications set
      state         = 'canceled',
      canceled_at   = now(),
      cancel_reason = 'approval revoked: the article was revised after approval'
    where request_id = new.request_id
      and state in ('queued','scheduled');

    insert into events (request_id, actor, stage, step, ok, detail)
    values (
      new.request_id,
      coalesce(current_setting('app.actor', true), 'system'),
      'review',
      'approval_revoked',
      true,
      jsonb_build_object(
        'reason', 'a new article version was written after approval',
        'previous_status', r.status,
        'new_version_id', new.id,
        'origin', new.origin
      )
    );
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists article_versions_revoke_approval on article_versions;
create trigger article_versions_revoke_approval
  after insert on article_versions
  for each row execute function revoke_approval_on_new_version();
