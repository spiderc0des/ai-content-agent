-- ════════════════════════════════════════════════════════════════════════════
-- Koya Content Agent — gate tests
--
-- The half of the testing evidence that only a real database can produce.
-- npm run scenarios covers the application logic; this file proves that the
-- rules which must hold even when application code is wrong actually hold.
--
-- Run in the Supabase SQL editor AFTER 01 and 02. Everything happens inside a
-- transaction that is rolled back at the end, so it writes nothing that
-- survives — safe to run against a database with real content in it.
--
-- Every check raises with a message naming what is wrong, or prints 'ok'.
-- ════════════════════════════════════════════════════════════════════════════

begin;

do $$
declare
  u_id     uuid := gen_random_uuid();
  r_id     uuid;
  plan_id  uuid;
  art_id   uuid;
  v1_id    uuid;
  v2_id    uuid;
  asset_id uuid;
  ex_id    uuid;
  src_id   uuid;
  pub_id   uuid;
  failed   boolean;
  n        int;
begin
  -- ── Fixtures ─────────────────────────────────────────────────────────────

  insert into app_users (id, email, full_name, is_creator, is_reviewer, is_publisher, active)
  values (u_id, 'gate-test@example.invalid', 'Gate Test', true, true, true, true);

  insert into content_requests (raw_idea, target_audience, intake_hash, author_id, status)
  values ('a gate test idea', 'testers', 'hash', u_id, 'awaiting_review')
  returning id into r_id;

  insert into sources (request_id, kind, url, title, status)
  values (r_id, 'web', 'https://example.invalid/a', 'A source', 'digested')
  returning id into src_id;

  insert into source_excerpts (source_id, request_id, ordinal, quote, gist, selected, relevance)
  values (src_id, r_id, 1, 'An exactly quoted sentence.', 'it matters', true, 0.9)
  returning id into ex_id;

  insert into content_plans (request_id, plan_no, primary_keyword, thesis, outline_json, angles_json)
  values (r_id, 1, 'gate test', 'a thesis', '[]'::jsonb, '[]'::jsonb)
  returning id into plan_id;

  insert into articles (request_id, option_index, angle, plan_id)
  values (r_id, 1, 'the only angle', plan_id)
  returning id into art_id;

  insert into article_versions (
    article_id, request_id, revision_no, origin, title, body_md, content_hash)
  values (art_id, r_id, 1, 'generated', 'A title', '# A title', 'hash-v1')
  returning id into v1_id;

  update articles set current_version_id = v1_id where id = art_id;
  raise notice 'ok  fixtures created';

  -- ── 1 · article_versions is append-only ──────────────────────────────────
  -- This is what "preserve the review history" (PRD test 4) rests on.

  failed := false;
  begin
    update article_versions set body_md = 'rewritten in place' where id = v1_id;
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: article_versions accepted an UPDATE — history is not preserved';
  end if;
  raise notice 'ok  article_versions rejects UPDATE';

  failed := false;
  begin
    delete from article_versions where id = v1_id;
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: article_versions accepted a DELETE';
  end if;
  raise notice 'ok  article_versions rejects DELETE';

  -- ── 2 · approving is refused from the wrong status ───────────────────────
  -- PRD test 5: nothing publishes or schedules until a human approves.

  update content_requests set status = 'generating' where id = r_id;

  failed := false;
  begin
    update content_requests set
      status = 'approved', selected_article_id = art_id,
      approved_version_id = v1_id, approved_content_hash = 'hash-v1'
    where id = r_id;
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a request was approved directly from generating';
  end if;
  raise notice 'ok  approval refused from a status other than awaiting_review';

  -- ── 3 · approving is refused without a selected option ───────────────────

  update content_requests set status = 'awaiting_review' where id = r_id;

  failed := false;
  begin
    update content_requests set
      status = 'approved', selected_article_id = null,
      approved_version_id = v1_id, approved_content_hash = 'hash-v1'
    where id = r_id;
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a request was approved with no selected article option';
  end if;
  raise notice 'ok  approval refused without a selected option';

  -- ── 4 · approving is refused without recording what was approved ─────────

  failed := false;
  begin
    update content_requests set
      status = 'approved', selected_article_id = art_id,
      approved_version_id = null, approved_content_hash = null
    where id = r_id;
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a request was approved without recording the version and hash';
  end if;
  raise notice 'ok  approval refused without a recorded version and hash';

  -- ── 5 · a proper approval succeeds ───────────────────────────────────────

  update content_requests set
    status = 'approved', selected_article_id = art_id, reviewer_id = u_id,
    approved_at = now(), approved_version_id = v1_id, approved_content_hash = 'hash-v1'
  where id = r_id;
  raise notice 'ok  a complete, correctly-ordered approval is accepted';

  -- ── 6 · publishing is refused before the assets are ready ────────────────

  insert into channel_assets (request_id, version_id, channel, asset_no, body, rules_pass)
  values (r_id, v1_id, 'linkedin', 1, 'the post body', true)
  returning id into asset_id;

  failed := false;
  begin
    insert into publications (request_id, asset_id, channel, queued_by)
    values (r_id, asset_id, 'linkedin', u_id);
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a publication was queued while the request was still in approved';
  end if;
  raise notice 'ok  publication refused before the request is ready';

  -- ── 7 · a legitimate publication is accepted ─────────────────────────────

  update content_requests set status = 'ready' where id = r_id;

  insert into publications (request_id, asset_id, channel, queued_by)
  values (r_id, asset_id, 'linkedin', u_id)
  returning id into pub_id;
  raise notice 'ok  an approved, ready asset can be queued';

  -- ── 8 · no second live publication on the same channel ───────────────────
  -- The "no duplicate post" guarantee, at the database rather than in a route.

  failed := false;
  begin
    insert into publications (request_id, asset_id, channel, queued_by)
    values (r_id, asset_id, 'linkedin', u_id);
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: the same channel was queued twice';
  end if;
  raise notice 'ok  a second live publication on the same channel is refused';

  -- …but once the first is cancelled, re-queueing is allowed again.
  update publications set state = 'canceled', canceled_at = now() where id = pub_id;
  insert into publications (request_id, asset_id, channel, queued_by)
  values (r_id, asset_id, 'linkedin', u_id)
  returning id into pub_id;
  raise notice 'ok  re-queueing after a cancellation is allowed';

  -- ── 9 · an asset from an unapproved version cannot be queued ─────────────

  insert into article_versions (
    article_id, request_id, revision_no, parent_version_id, origin, title, body_md, content_hash)
  values (art_id, r_id, 2, v1_id, 'human_edited', 'A new title', '# A new title', 'hash-v2')
  returning id into v2_id;

  -- …which, by rule 10 below, has just revoked the approval. Restore it so
  -- this check tests the version mismatch and nothing else.
  update content_requests set
    status = 'ready', selected_article_id = art_id,
    approved_version_id = v1_id, approved_content_hash = 'hash-v1'
  where id = r_id;
  update content_requests set status = 'awaiting_review' where id = r_id;
  update content_requests set
    status = 'approved', approved_version_id = v1_id, approved_content_hash = 'hash-v1'
  where id = r_id;
  update content_requests set status = 'ready' where id = r_id;

  insert into channel_assets (request_id, version_id, channel, asset_no, body, rules_pass)
  values (r_id, v2_id, 'x', 1, 'the x post', true)
  returning id into asset_id;

  failed := false;
  begin
    insert into publications (request_id, asset_id, channel, queued_by)
    values (r_id, asset_id, 'x', u_id);
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: an asset from an unapproved version was queued';
  end if;
  raise notice 'ok  an asset not derived from the approved version is refused';

  -- ── 10 · a new version after approval revokes the approval ───────────────
  -- Editing after approval must cost the approval, or the gate is decorative.

  update content_requests set
    status = 'awaiting_review' where id = r_id;
  update content_requests set
    status = 'approved', selected_article_id = art_id,
    approved_version_id = v1_id, approved_content_hash = 'hash-v1'
  where id = r_id;

  insert into article_versions (
    article_id, request_id, revision_no, parent_version_id, origin, title, body_md, content_hash)
  values (art_id, r_id, 3, v1_id, 'human_edited', 'Edited again', '# Edited again', 'hash-v3');

  select count(*) into n from content_requests
  where id = r_id and status = 'awaiting_review'
    and approved_version_id is null and approved_content_hash is null;
  if n <> 1 then
    raise exception 'FAIL: writing a version after approval did not revoke the approval';
  end if;
  raise notice 'ok  a new version after approval revokes the approval';

  select count(*) into n from events
  where request_id = r_id and step = 'approval_revoked';
  if n < 1 then
    raise exception 'FAIL: the revoked approval was not logged';
  end if;
  raise notice 'ok  the revoked approval is logged as an event';

  -- ── 11 · reviews and evaluations are append-only too ─────────────────────

  insert into reviews (request_id, article_id, action, note, reviewer_id, from_status, to_status)
  values (r_id, art_id, 'approve', 'looks good', u_id, 'awaiting_review', 'approved');

  failed := false;
  begin
    update reviews set note = 'actually it did not' where request_id = r_id;
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: the review audit trail is editable';
  end if;
  raise notice 'ok  reviews reject UPDATE';

  -- ── 12 · a version can never be re-scored ────────────────────────────────
  -- This is what makes "score improved across revisions" mean something.

  insert into evaluations (version_id, request_id, status, overall_score, raw_json)
  values (v1_id, r_id, 'revise', 3.2, '{}'::jsonb);

  failed := false;
  begin
    insert into evaluations (version_id, request_id, status, overall_score, raw_json)
    values (v1_id, r_id, 'pass', 4.8, '{}'::jsonb);
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: the same version was evaluated twice';
  end if;
  raise notice 'ok  a version cannot be re-scored';

  -- ── 13 · the CHECK constraints the brief's rules depend on ───────────────

  failed := false;
  begin
    insert into channel_assets (request_id, version_id, channel, asset_no, body, hashtags)
    values (r_id, v1_id, 'x', 99, 'body', array['#a', '#b', '#c']);
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: an X post with three hashtags was accepted';
  end if;
  raise notice 'ok  an X post is capped at two hashtags';

  failed := false;
  begin
    insert into channel_assets (request_id, version_id, channel, asset_no, body, subject)
    values (r_id, v1_id, 'newsletter', 99, 'body', '');
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a newsletter with no subject line was accepted';
  end if;
  raise notice 'ok  a newsletter requires a subject line';

  failed := false;
  begin
    insert into reviews (request_id, action, instruction, reviewer_id, from_status, to_status)
    values (r_id, 'revise', '', u_id, 'awaiting_review', 'revising');
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: a revise was recorded with no instruction';
  end if;
  raise notice 'ok  a revise requires an instruction';

  raise notice '';
  raise notice 'ALL GATE TESTS PASSED';
end $$;

rollback;

select 'gate tests complete (rolled back — nothing was written)' as result;
