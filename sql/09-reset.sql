-- ════════════════════════════════════════════════════════════════════════════
-- 09 · Reset — letting one operation delete what is otherwise append-only
--
-- `article_versions`, `reviews` and `evaluations` reject UPDATE and DELETE by
-- trigger. That is what makes "which exact text was approved, and who approved
-- it" answerable forever, and it is deliberately not negotiable from a route
-- handler.
--
-- Reset needs to delete them anyway: a request being started over should look
-- like a fresh one, not like a fresh one wearing the previous run's drafts.
-- So the triggers gain exactly one hole, with three deliberate limits:
--
--   • UPDATE stays forbidden, always. The guarantee that matters most is that
--     prose is never rewritten in place; reset does not need to rewrite
--     anything, it needs to remove it. Keeping UPDATE closed means the hole
--     cannot be used to quietly alter an approval.
--   • DELETE is permitted only when `app.resetting` is set, and it is set
--     with is_local => true, so it lives for one transaction and cannot leak
--     into the next query on a pooled connection.
--   • `events` is untouched and still rejects both. The narrative log outlives
--     the content — including the record that the reset happened, and what it
--     removed.
-- ════════════════════════════════════════════════════════════════════════════

create or replace function koya_reset_in_progress() returns boolean as $$
begin
  return coalesce(current_setting('app.resetting', true), '') = 'on';
end $$ language plpgsql stable;

create or replace function article_versions_are_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' and koya_reset_in_progress() then
    return old;
  end if;
  raise exception 'article_versions is append-only: % is not permitted', tg_op;
end $$ language plpgsql;

create or replace function reviews_are_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' and koya_reset_in_progress() then
    return old;
  end if;
  raise exception 'reviews is append-only: % is not permitted', tg_op;
end $$ language plpgsql;

create or replace function evaluations_are_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' and koya_reset_in_progress() then
    return old;
  end if;
  raise exception 'evaluations is append-only: % is not permitted', tg_op;
end $$ language plpgsql;

-- events_are_immutable() is intentionally NOT redefined here.
