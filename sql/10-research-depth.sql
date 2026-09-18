-- ════════════════════════════════════════════════════════════════════════════
-- 10 · Research depth — how hard the research stage works, per request
--
-- Research is the most expensive stage by a wide margin, and it drives a
-- second cost that is easy to miss: retrieval makes one Claude call per
-- readable source, so finding twice as many sources costs twice as much twice
-- over. A topic that needs a broad sweep and one that needs three good pages
-- should not pay the same.
--
-- Stored per request rather than set globally, because it is a property of the
-- topic, not of the installation.
-- ════════════════════════════════════════════════════════════════════════════

alter table content_requests
  add column if not exists research_depth text not null default 'standard';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'content_requests_research_depth') then
    alter table content_requests add constraint content_requests_research_depth
      check (research_depth in ('quick', 'standard', 'deep'));
  end if;
end $$;
