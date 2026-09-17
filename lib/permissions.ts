/**
 * Pure permission logic — no database, no Supabase, no 'server-only'.
 * Split out from lib/auth.ts specifically so it can be unit tested without
 * pulling in the whole env/db chain.
 */
import type { AppUserRow } from './db-schemas';

export type Capability = 'creator' | 'reviewer' | 'publisher';

type Caps = Pick<AppUserRow, 'is_creator' | 'is_reviewer' | 'is_publisher' | 'is_admin'>;

/** Display only — "admin + reviewer", "creator", "no capabilities". */
export function capabilityLabel(user: Caps): string {
  const parts = [
    user.is_admin && 'admin',
    user.is_creator && 'creator',
    user.is_reviewer && 'reviewer',
    user.is_publisher && 'publisher',
  ].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'no capabilities';
}

/**
 * Does `user` satisfy the given capability requirement? is_admin always
 * does, regardless of which specific capability was asked for. Used by
 * requireUser() (lib/auth.ts) for route-level gating.
 */
export function hasCapability(user: Caps, capability?: Capability): boolean {
  if (!capability) return true;
  if (user.is_admin) return true;
  if (capability === 'creator') return user.is_creator;
  if (capability === 'reviewer') return user.is_reviewer;
  return user.is_publisher;
}

/**
 * A reviewer needs to open a request to review it (the review queue links
 * straight to /r/:id), and an admin sees everything. A creator who is
 * neither the author nor an admin gets turned away.
 */
export function canViewRequest(
  user: Pick<AppUserRow, 'id' | 'is_reviewer' | 'is_publisher' | 'is_admin'>,
  request: { author_id: string },
): boolean {
  return (
    user.id === request.author_id || user.is_reviewer || user.is_publisher || user.is_admin
  );
}

/**
 * Narrower than canViewRequest: only the author (or an admin) may drive the
 * pipeline — run a stage, retry, re-plan. A reviewer's job is to review,
 * not to co-author.
 */
export function canRunPipeline(
  user: Pick<AppUserRow, 'id' | 'is_admin'>,
  request: { author_id: string },
): boolean {
  return user.id === request.author_id || user.is_admin;
}

/**
 * A THIRD, independent check alongside canRunPipeline — that one asks "is
 * this person allowed to drive *a* pipeline"; this one asks "is this
 * particular request's pipeline runnable *at all right now*", regardless of
 * who is asking. Both must pass.
 *
 * A published request is delivered content: the whole point of the approval
 * gate is that nothing changes unreviewed after that point.
 *
 * `approved` and `ready` ARE included, on purpose: writing a new
 * article_version during either is exactly what triggers
 * sql/02-triggers.sql's revoke_approval_on_new_version(), which bounces the
 * request back to `awaiting_review` and clears the approval — the mechanism
 * that makes "an edit after approval requires a fresh approval" true.
 * Blocking it here would silently prevent that mechanism from ever running,
 * not strengthen it.
 */
const RUNNABLE_STATUSES = new Set([
  'draft',
  'blocked',
  'researching',
  'retrieving',
  'selecting',
  'planning',
  'generating',
  'evaluating',
  'revising',
  'awaiting_review',
  'approved',
  'rejected',
  'packaging',
  'ready',
  'failed',
]);

export function isPipelineRunnable(request: { status: string }): boolean {
  return RUNNABLE_STATUSES.has(request.status);
}

/**
 * The human gate. `awaiting_review` is the only status a review action may
 * be taken from — with one exception: a rejected request can be revived by
 * a `revise`, which is the resubmit path.
 */
export function canReview(request: { status: string }, action: string): boolean {
  if (request.status === 'awaiting_review') return true;
  return request.status === 'rejected' && action === 'revise';
}

/* ═══════════════════════════════════════════════════════════════════════════
   The review transition table
   ═══════════════════════════════════════════════════════════════════════════ */

export type ReviewAction = 'approve' | 'reject' | 'revise' | 'select';

/**
 * Where each review action leaves the request.
 *
 * `select` is the one that does not move it: choosing which option you are
 * looking at is not a decision about the content, so the request stays at the
 * gate until somebody approves, rejects, or revises.
 */
export function reviewTargetStatus(action: ReviewAction): string {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'revise':
      return 'revising';
    case 'select':
      return 'awaiting_review';
  }
}

/**
 * Is this review action legal from this status, and does it have what it
 * needs? The database enforces the approval rules independently
 * (guard_content_approval in sql/02-triggers.sql); this is the same logic
 * stated where it can be tested and where it can produce a good message.
 */
export function checkReviewAction(input: {
  status: string;
  action: ReviewAction;
  hasSelectedArticle: boolean;
  hasVersion: boolean;
  note: string;
  instruction: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!canReview({ status: input.status }, input.action)) {
    return {
      ok: false,
      reason: `Cannot '${input.action}' a request that is '${input.status}'.`,
    };
  }
  if (input.action === 'revise' && !input.instruction.trim()) {
    return { ok: false, reason: 'A revision needs an instruction saying what to change.' };
  }
  if (input.action === 'reject' && !input.note.trim()) {
    return { ok: false, reason: 'A rejection needs a reason.' };
  }
  if (input.action === 'approve') {
    if (!input.hasSelectedArticle) {
      return { ok: false, reason: 'Select which article option you are approving first.' };
    }
    if (!input.hasVersion) {
      return { ok: false, reason: 'That option has no draft to approve.' };
    }
  }
  return { ok: true };
}

/**
 * Can this asset be queued for publishing?
 *
 * Three independent conditions, and all three are also enforced elsewhere:
 * the approval by a database trigger, the content hash by the publish route,
 * the duplicate by a partial unique index. Stated here so the UI can explain
 * itself before a round trip.
 */
export function checkQueueable(input: {
  status: string;
  approvedVersionId: string | null;
  assetVersionId: string;
  assetRulesPass: boolean;
  alreadyLiveOnChannel: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.status !== 'ready' && input.status !== 'queued') {
    return { ok: false, reason: `Cannot queue from status '${input.status}'.` };
  }
  if (!input.approvedVersionId) {
    return { ok: false, reason: 'This request has no recorded approval.' };
  }
  if (input.assetVersionId !== input.approvedVersionId) {
    return { ok: false, reason: 'That asset was made from a version that was not the one approved.' };
  }
  if (!input.assetRulesPass) {
    return { ok: false, reason: 'That asset does not pass its channel formatting rules.' };
  }
  if (input.alreadyLiveOnChannel) {
    return { ok: false, reason: 'There is already a live publication for that channel.' };
  }
  return { ok: true };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The bounded auto-revision loop
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * What runEvaluation (lib/pipeline.ts) does after scoring every current
 * draft. Pulled out as a pure function specifically so the loop's exit
 * condition can be unit tested without a database or a live evaluation run —
 * a real bug here previously meant nothing exercised it until watching a
 * request cycle evaluate → revise → evaluate → revise for tens of minutes at
 * a time with no way to tell whether it would ever stop.
 *
 * `revisionRound` must be the count BEFORE this decision — the caller
 * (startAutoRevision in lib/queries.ts) is what spends the round, atomically,
 * only on the 'revising' branch. This function only decides; it does not
 * itself account for spending the budget.
 */
export function nextAfterEvaluation(input: {
  anyPassed: boolean;
  revisionRound: number;
  maxRevisionRounds: number;
}): 'revising' | 'awaiting_review' {
  if (input.anyPassed) return 'awaiting_review';
  const budgetLeft = input.revisionRound < input.maxRevisionRounds;
  return budgetLeft ? 'revising' : 'awaiting_review';
}

/**
 * Has the driver stopped making progress?
 *
 * Tracks "the same stage was chosen again, from the same status" — a stage
 * that ran and changed nothing. Once is a retry worth allowing (a transient
 * API failure, say); twice in a row is a loop.
 *
 * This exists because loops here are expensive in a way an ordinary infinite
 * loop is not: every turn is a full set of Claude calls. Two have shipped
 * already — an auto-revision loop whose round counter never incremented, and
 * packaging re-running forever because one channel could not pass its rules
 * and the status therefore never left 'packaging'. A stage cap alone is not
 * enough protection when each wasted turn costs money.
 */
export function shouldStopRepeating(input: {
  stage: string;
  status: string;
  lastStage: string | null;
  lastStatus: string | null;
  repeats: number;
}): { stop: boolean; repeats: number } {
  const same = input.stage === input.lastStage && input.status === input.lastStatus;
  const repeats = same ? input.repeats + 1 : 0;
  return { stop: repeats >= 2, repeats };
}
