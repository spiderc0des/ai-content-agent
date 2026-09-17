-- ════════════════════════════════════════════════════════════════════════════
-- Koya Content Agent — activate users
--
-- Signing in at /login creates a PENDING app_users row (no capabilities, and
-- `active` false). That is the allowlist working as intended: a session alone
-- does not grant access. This file is how a real person gets switched on.
--
-- Edit the email addresses below, then run.
-- ════════════════════════════════════════════════════════════════════════════

-- Give yourself everything, so a solo demo can drive the whole pipeline.
update app_users set
  active       = true,
  is_creator   = true,
  is_reviewer  = true,
  is_publisher = true,
  is_admin     = true
where email = 'abdul.spidercodes@gmail.com';

-- A content creator: can submit requests and run the pipeline, cannot approve.
-- update app_users set active = true, is_creator = true
--   where email = 'creator@example.com';

-- A reviewer: can approve/reject/revise/select, cannot run the pipeline.
-- update app_users set active = true, is_creator = false, is_reviewer = true
--   where email = 'reviewer@example.com';

-- A publisher: can queue and schedule approved content.
-- update app_users set active = true, is_creator = false, is_publisher = true
--   where email = 'publisher@example.com';

select email, active, is_creator, is_reviewer, is_publisher, is_admin
from app_users order by created_at;
