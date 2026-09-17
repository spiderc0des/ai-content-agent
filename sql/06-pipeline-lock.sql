-- ════════════════════════════════════════════════════════════════════════════
-- Koya Content Agent — the pipeline lock
--
-- Run after 01-05. Idempotent: safe to re-run.
--
-- Why this exists. Two separate incidents, both traced to the same gap:
--
--   1. A request sat at 'retrieving' for eight hours. Research had finished
--      fine; nothing had gone wrong server-side. The browser tab that was
--      driving the pipeline one fetch at a time had simply stopped looping —
--      a dropped connection, a backgrounded tab, a sleeping laptop. Nothing
--      on the server knew the work was unfinished, because nothing on the
--      server was ever in charge of finishing it.
--
--   2. A request was marked 'failed' with "Cannot move to 'evaluating' from
--      'evaluating'". Two revision runs had started seven seconds apart —
--      one person, two clicks. Both spent ~9 minutes of real Claude calls on
--      the same work; the second one then lost the status transition race and
--      took the whole request down with it.
--
-- The pipeline now runs server-side (lib/pipeline.ts drivePipeline), and this
-- lock is what makes exactly one driver own a request at a time. Claiming is
-- a single conditional UPDATE — the WHERE clause is the mutual exclusion, so
-- two concurrent claims cannot both win.
-- ════════════════════════════════════════════════════════════════════════════

alter table content_requests
  add column if not exists pipeline_lock_at timestamptz,
  add column if not exists pipeline_lock_by text,
  -- Heartbeat. A driver refreshes this after every stage, so "the lock is
  -- old" can be told apart from "the lock is held by something still working"
  -- — a single stage can legitimately run for ten minutes (research, or three
  -- article generations), which is far too long to treat as stalled.
  add column if not exists pipeline_heartbeat_at timestamptz;

-- Finding the drivers that died mid-run: a held lock whose heartbeat has gone
-- quiet. Partial, because a request with no lock is the overwhelmingly common
-- case and is never interesting to this query.
create index if not exists content_requests_stale_lock_idx
  on content_requests (pipeline_heartbeat_at)
  where pipeline_lock_at is not null;
