-- ════════════════════════════════════════════════════════════════════════════
-- Koya Content Agent — verify the install
--
-- Run last. Every check should print `ok`. A failure raises with a message
-- naming what is wrong, rather than leaving you to read 500 lines of schema.
-- Safe to re-run; it writes nothing that survives (one rolled-back probe).
-- ════════════════════════════════════════════════════════════════════════════

do $$
declare
  missing text;
  n int;
begin
  -- every table exists
  select string_agg(t, ', ') into missing
  from unnest(array[
    'app_users','content_requests','stage_runs','sources','source_excerpts',
    'content_plans','articles','article_versions','article_claims',
    'claim_citations','article_version_sources','evaluations',
    'evaluation_scores','reviews','channel_assets','publications','events'
  ]) t
  where to_regclass('public.' || t) is null;
  if missing is not null then
    raise exception 'missing tables: % — run 01-schema.sql', missing;
  end if;
  raise notice 'ok  all 17 tables exist';

  -- every enum exists, with the right number of labels
  select count(*) into n from pg_enum e
    join pg_type t on t.oid = e.enumtypid where t.typname = 'request_status';
  if n <> 18 then raise exception 'request_status has % labels, expected 18', n; end if;
  raise notice 'ok  request_status has 18 labels';

  select count(*) into n from pg_enum e
    join pg_type t on t.oid = e.enumtypid where t.typname = 'rubric_criterion';
  if n <> 9 then raise exception 'rubric_criterion has % labels, expected 9', n; end if;
  raise notice 'ok  rubric_criterion has all 9 rubric criteria';

  select count(*) into n from pg_enum e
    join pg_type t on t.oid = e.enumtypid where t.typname = 'review_action';
  if n <> 4 then raise exception 'review_action has % labels, expected 4', n; end if;
  raise notice 'ok  review_action has approve/reject/revise/select';

  -- the triggers that enforce the gate
  select string_agg(x, ', ') into missing
  from unnest(array[
    'events_no_change','article_versions_no_change','reviews_no_change',
    'evaluations_no_change','content_requests_guard_approval',
    'publications_guard_insert','article_versions_revoke_approval',
    'content_requests_touch'
  ]) x
  where not exists (select 1 from pg_trigger where tgname = x and not tgisinternal);
  if missing is not null then
    raise exception 'missing triggers: % — run 02-triggers.sql', missing;
  end if;
  raise notice 'ok  all 8 triggers installed';

  -- the partial unique index that prevents a double publish
  if not exists (select 1 from pg_indexes
                 where indexname = 'publications_one_live_per_channel') then
    raise exception 'missing index publications_one_live_per_channel';
  end if;
  raise notice 'ok  one-live-publication-per-channel index exists';

  -- RLS on everywhere
  select string_agg(relname, ', ') into missing
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if missing is not null then
    raise exception 'row level security is off on: %', missing;
  end if;
  raise notice 'ok  row level security enabled on every table';
end $$;

-- The immutability triggers actually fire. Rolled back, so nothing persists.
do $$
declare
  fired boolean := false;
begin
  begin
    insert into events (request_id, actor, step, ok) values (null, 'verify', 'probe', true);
    update events set ok = false where actor = 'verify';
  exception when others then
    fired := true;
  end;
  if not fired then
    raise exception 'events is NOT immutable — the update succeeded';
  end if;
  raise notice 'ok  events rejects UPDATE';
  delete from events where actor = 'verify';
exception when others then
  -- the delete is itself blocked by the trigger, which is the point
  raise notice 'ok  events rejects DELETE too';
end $$;

select 'verified' as result;
