-- ─────────────────────────────────────────────────────────────────────────────
-- 13 · Spend one revision round by default, not two.
--
-- Measured across every completed run in this database:
--
--   revision 1 (draft → rev 2):  +0.40 average score, improved 19 of 19
--   revision 2 (rev 2 → rev 3):  +0.13 average score, improved 10 of 16
--
-- The first revision earns its cost every time. The second costs a revision
-- call plus a re-evaluation — about four minutes of a twelve-minute run — and
-- fails to improve the draft more than a third of the time.
--
-- It was never the deciding factor either way: 53 of 55 evaluations returned
-- `revise`, so the loop ran to exhaustion on every request and the draft went
-- to a human regardless. Spending the extra round bought a marginally better
-- draft for the reviewer, not a different destination.
--
-- Existing requests are left alone. Changing the budget under a run that is
-- mid-loop would either strand it above its own cap or hand it a round it was
-- not costed for; only new requests get the new default.
-- ─────────────────────────────────────────────────────────────────────────────

alter table content_requests alter column max_revision_rounds set default 1;

-- Verify: should print 1.
select column_default from information_schema.columns
where table_name = 'content_requests' and column_name = 'max_revision_rounds';
