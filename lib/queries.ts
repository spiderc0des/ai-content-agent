import 'server-only';
import { sql } from './db';
import {
  AppUserRow,
  ContentRequestRow,
  StageRunRow,
  SourceRow,
  SourceExcerptRow,
  ContentPlanRow,
  ArticleRow,
  ArticleVersionRow,
  ArticleClaimRow,
  EvaluationRow,
  EvaluationScoreRow,
  ReviewRow,
  ChannelAssetRow,
  PublicationRow,
  EventRow,
  EmailGroupRow,
  EmailGroupMemberRow,
  type PipelineStage,
  type RequestStatus,
} from './db-schemas';
import type { Channel } from './schemas';
import { sha256 } from './hash';
import { encryptSecret, decryptSecret } from './crypto';

/**
 * Every SQL statement in the app.
 *
 * The governing idea: the WHERE clause IS the business rule. A transition that
 * is only legal from one status says so in SQL and affects zero rows
 * otherwise — it does not read the row, check in TypeScript, then write.
 * Between those two steps another request can change the row; between the
 * WHERE and the UPDATE, nothing can.
 *
 * Optimistic concurrency rides along on the same clause: every human-driven
 * write takes the `version` the caller last saw, and zero affected rows means
 * somebody else got there first.
 */

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class VersionConflictError extends Error {
  /**
   * The version the row is actually on now.
   *
   * Carried so a caller can retry against it instead of fetching the version
   * first, every time, on the chance of a conflict that almost never happens.
   * That pre-fetch cost a full auth-plus-query round trip — about two seconds
   * against a remote database — on the happy path of every review action.
   */
  readonly currentVersion: number | null;

  constructor(
    message = 'Someone else changed this request while you were working on it. Reload and try again.',
    currentVersion: number | null = null,
  ) {
    super(message);
    this.name = 'VersionConflictError';
    this.currentVersion = currentVersion;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Users
   ═══════════════════════════════════════════════════════════════════════════ */

export async function findAppUser(id: string) {
  const rows = await sql`select * from app_users where id = ${id} and active`;
  return rows.length ? AppUserRow.parse(rows[0]) : null;
}

/**
 * Everyone who can actually act on a review.
 *
 * Active reviewers only. An admin is not included unless they are also a
 * reviewer: the notification exists to reach the people who can approve the
 * thing, and mailing everyone with a login teaches them to ignore it.
 */
/**
 * The best evaluation score at the latest revision, and at the one before it.
 *
 * Grouped by the version's revision number rather than by time, because
 * options are evaluated in parallel and their rows interleave — ordering by
 * id would compare an option against a sibling rather than against its own
 * previous draft.
 */
export async function bestScoreByRound(
  requestId: string,
): Promise<{ current: number | null; previous: number | null }> {
  const rows = await sql`
    select av.revision_no, max(e.overall_score)::float as best
    from evaluations e
    join article_versions av on av.id = e.version_id
    where e.request_id = ${requestId}
    group by av.revision_no
    order by av.revision_no desc
    limit 2`;
  return {
    current: rows[0] ? Number(rows[0].best) : null,
    previous: rows[1] ? Number(rows[1].best) : null,
  };
}

export async function listReviewerEmails(): Promise<string[]> {
  const rows = await sql`
    select email from app_users
    where active and is_reviewer and email <> '' order by email`;
  return rows.map((r) => String(r.email));
}

export async function findAppUserByEmail(email: string) {
  const rows = await sql`select * from app_users where email = ${email.toLowerCase()}`;
  return rows.length ? AppUserRow.parse(rows[0]) : null;
}

/**
 * Called on every sign-in, by both auth routes.
 *
 * Two different people arrive here and they must not be treated the same:
 *
 *   **Someone an admin invited.** Their row already exists, with the
 *   capabilities the admin chose at invite time. Signing in activates them.
 *   The admin already made the access decision — asking them to come back
 *   and tick a second box afterwards is a second gate with no decision in
 *   it, and in practice it means an invited person sits locked out until
 *   someone notices.
 *
 *   **Someone who signed themselves in.** Supabase Auth will mint a session
 *   for ANY email that asks for a magic link, so this path must never grant
 *   anything. They get a pending row with no capabilities and reach nothing
 *   until an admin says otherwise. That is the whole point of the allowlist.
 *
 * `invited_at is not null` is what separates them — set only by
 * upsertInvitedUser, which only an admin can reach. The capability check
 * alongside it matters too: the database refuses an active row with no
 * capabilities, so activating one would fail the CHECK constraint and take
 * the whole sign-in down with it.
 */
export async function upsertSignedInUser(id: string, email: string) {
  const rows = await sql`
    insert into app_users (id, email, active, is_creator, first_signed_in_at)
    values (${id}, ${email.toLowerCase()}, false, false, now())
    on conflict (id) do update set
      first_signed_in_at = coalesce(app_users.first_signed_in_at, now()),
      active = case
        when app_users.invited_at is not null
         and (app_users.is_creator or app_users.is_reviewer
              or app_users.is_publisher or app_users.is_admin)
        then true
        else app_users.active
      end
    returning *`;
  return AppUserRow.parse(rows[0]);
}

/**
 * Create (or refresh) a PENDING row for someone an admin has invited.
 *
 * The capabilities chosen at invite time are stored now, so activating them
 * later is one tick rather than a second round of decisions. `active` stays
 * false regardless: an invite is permission to sign in, never access itself.
 *
 * Returns null if the person is already active — the caller turns that into
 * "they already have access, change their capabilities instead" rather than
 * silently demoting a working account back to pending.
 */
export async function upsertInvitedUser(u: {
  id: string;
  email: string;
  fullName: string;
  isCreator: boolean;
  isReviewer: boolean;
  isPublisher: boolean;
  isAdmin: boolean;
  invitedBy: string;
}) {
  const rows = await sql`
    insert into app_users (
      id, email, full_name, is_creator, is_reviewer, is_publisher, is_admin,
      active, invited_at, invited_by
    ) values (
      ${u.id}, ${u.email.toLowerCase()}, ${u.fullName}, ${u.isCreator}, ${u.isReviewer},
      ${u.isPublisher}, ${u.isAdmin}, false, now(), ${u.invitedBy}
    )
    on conflict (id) do update set
      full_name    = excluded.full_name,
      is_creator   = excluded.is_creator,
      is_reviewer  = excluded.is_reviewer,
      is_publisher = excluded.is_publisher,
      is_admin     = excluded.is_admin,
      invited_at   = now(),
      invited_by   = excluded.invited_by
    where app_users.active = false
    returning *`;
  return rows.length ? AppUserRow.parse(rows[0]) : null;
}

export async function listAppUsers() {
  const rows = await sql`select * from app_users order by created_at`;
  return rows.map((r) => AppUserRow.parse(r));
}

export async function setCapabilities(
  id: string,
  caps: {
    is_creator: boolean;
    is_reviewer: boolean;
    is_publisher: boolean;
    is_admin: boolean;
    active: boolean;
  },
) {
  const rows = await sql`
    update app_users set
      is_creator = ${caps.is_creator}, is_reviewer = ${caps.is_reviewer},
      is_publisher = ${caps.is_publisher}, is_admin = ${caps.is_admin},
      active = ${caps.active}
    where id = ${id}
    returning *`;
  if (!rows.length) throw new ConflictError('No such user.');
  return AppUserRow.parse(rows[0]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Events — the append-only narrative log
   ═══════════════════════════════════════════════════════════════════════════ */

export async function logEvent(e: {
  requestId: string | null;
  actor: string;
  stage?: PipelineStage | null;
  step: string;
  ok: boolean;
  durationMs?: number;
  detail?: Record<string, unknown>;
}) {
  await sql`
    insert into events (request_id, actor, stage, step, ok, duration_ms, detail)
    values (${e.requestId}, ${e.actor}, ${e.stage ?? null}, ${e.step}, ${e.ok},
            ${e.durationMs ?? null}, ${sql.json((e.detail ?? {}) as never)})`;
}

export async function getEvents(requestId: string) {
  const rows = await sql`
    select * from events where request_id = ${requestId} order by id desc limit 500`;
  return rows.map((r) => EventRow.parse(r));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Requests
   ═══════════════════════════════════════════════════════════════════════════ */

export interface NewRequest {
  raw_idea: string;
  target_audience: string;
  source_url: string | null;
  supporting_notes: string;
  title_hint: string;
  primary_keyword: string;
  secondary_keywords: string[];
  desired_tone: string;
  word_count_target: number | null;
  channels_wanted: Channel[];
  option_count: number;
  research_depth: 'quick' | 'standard' | 'deep';
  deadline_at: string | null;
  intake_hash: string;
  author_id: string;
}

export async function createRequest(r: NewRequest) {
  const rows = await sql`
    insert into content_requests (
      raw_idea, target_audience, source_url, supporting_notes, title_hint,
      primary_keyword, secondary_keywords, desired_tone, word_count_target,
      channels_wanted, option_count, research_depth, deadline_at, intake_hash, author_id
    ) values (
      ${r.raw_idea}, ${r.target_audience}, ${r.source_url}, ${r.supporting_notes},
      ${r.title_hint}, ${r.primary_keyword}, ${r.secondary_keywords as unknown as string[]},
      ${r.desired_tone}, ${r.word_count_target},
      ${r.channels_wanted as unknown as string[]}::channel[], ${r.option_count},
      ${r.research_depth}, ${r.deadline_at}, ${r.intake_hash}, ${r.author_id}
    ) returning *`;
  return ContentRequestRow.parse(rows[0]);
}

export async function getRequest(id: string) {
  const rows = await sql`
    select * from content_requests where id = ${id} and deleted_at is null`;
  return rows.length ? ContentRequestRow.parse(rows[0]) : null;
}

export async function listRequests(
  opts: { authorId?: string; status?: string; limit?: number } = {},
) {
  // Filtering happens in the WHERE clause, not in TypeScript afterwards. The
  // list is capped, so filtering a capped page would quietly show a subset of
  // a subset — "3 failed" in the tab and one of them missing from the list.
  const limit = opts.limit ?? 100;
  const rows = await sql`
    select * from content_requests
    where deleted_at is null
      ${opts.authorId ? sql`and author_id = ${opts.authorId}` : sql``}
      ${opts.status ? sql`and status = ${opts.status}::request_status` : sql``}
    order by updated_at desc
    limit ${limit}`;
  return rows.map((r) => ContentRequestRow.parse(r));
}

/**
 * How many requests sit at each status.
 *
 * Counted in the database rather than over the rows the page happens to have
 * loaded, because that list is capped at 100. Tallying in TypeScript would
 * make the filter counts silently wrong at exactly the point they start being
 * useful — the moment there is more work than fits on one page.
 */
export async function countRequestsByStatus(
  opts: { authorId?: string } = {},
): Promise<Record<string, number>> {
  const rows = await sql`
    select status, count(*)::int as n from content_requests
    where deleted_at is null
      ${opts.authorId ? sql`and author_id = ${opts.authorId}` : sql``}
    group by status`;
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.status)] = Number(r.n);
  return out;
}

/** Requests sitting at the human gate — what the review queue shows. */
export async function listAwaitingReview() {
  const rows = await sql`
    select * from content_requests
    where deleted_at is null and status = 'awaiting_review'
    order by coalesce(deadline_at, updated_at) asc`;
  return rows.map((r) => ContentRequestRow.parse(r));
}

export async function saveAudit(
  id: string,
  audit: {
    readiness: 'ready' | 'thin' | 'blocked';
    raw: unknown;
    suggestedKeyword: string | null;
    suggestedSecondary: string[];
  },
) {
  const rows = await sql`
    update content_requests set
      readiness = ${audit.readiness},
      audit_json = ${sql.json(audit.raw as never)},
      primary_keyword = case when primary_keyword = ''
        then coalesce(${audit.suggestedKeyword}, '') else primary_keyword end,
      secondary_keywords = case when cardinality(secondary_keywords) = 0
        then ${audit.suggestedSecondary as unknown as string[]} else secondary_keywords end,
      status = ${audit.readiness === 'blocked' ? 'blocked' : 'draft'}::request_status,
      version = version + 1
    where id = ${id} and status in ('draft','blocked')
    returning *`;
  if (!rows.length) throw new ConflictError('This request has already moved past its audit.');
  return ContentRequestRow.parse(rows[0]);
}

export async function softDeleteRequest(id: string) {
  await sql`update content_requests set deleted_at = now() where id = ${id}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Stage runs — one row per attempt, never overwritten
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Claim the next attempt at a stage. The attempt number comes from a
 * subquery rather than from a read-then-write in TypeScript, so two
 * concurrent runs of the same stage collide on the unique
 * (request_id, stage, attempt) index instead of silently sharing a number.
 */
export async function startStageRun(requestId: string, stage: PipelineStage) {
  const rows = await sql`
    insert into stage_runs (request_id, stage, attempt, status)
    values (
      ${requestId}, ${stage}::pipeline_stage,
      (select coalesce(max(attempt), 0) + 1 from stage_runs
        where request_id = ${requestId} and stage = ${stage}::pipeline_stage),
      'running'
    ) returning *`;
  return StageRunRow.parse(rows[0]);
}

/**
 * Close out stage runs that were left saying `running` by a process that died.
 *
 * A driver killed mid-stage — the platform's function limit, a crash, a
 * redeploy — never reaches the code that records an outcome. The row keeps
 * saying `running` forever, which is worse than saying nothing: the pipeline
 * view reports "selection — running…" indefinitely and every human reading it
 * concludes the system is working. A stage that has been "running" for longer
 * than any stage takes did not survive, and saying so is the whole point of
 * having a stage table.
 *
 * Called when a driver claims the lock, so the run that takes over cleans up
 * after the one that did not come back. Scoped to one request and to rows
 * older than the cutoff, so it can never close a stage that is genuinely in
 * flight — including its own, which it starts afterwards.
 *
 * Returns what it reaped, so the caller can log it rather than fix it quietly.
 */
/**
 * Is a stage actually in flight for this request?
 *
 * The one signal that separates a slow stage from a wedged driver. Research
 * has been measured completing successfully at 657 seconds; a driver that has
 * hung has no stage row at all, because runStage writes the row before it
 * makes the call. Elapsed time alone cannot tell those apart, and guessing
 * wrong in one direction abandons work that was about to finish.
 */
export async function hasRunningStage(requestId: string): Promise<boolean> {
  const rows = await sql`
    select 1 from stage_runs
    where request_id = ${requestId} and status = 'running' limit 1`;
  return rows.length > 0;
}

export async function reapStaleStageRuns(requestId: string, olderThan = '15 minutes') {
  const rows = await sql`
    update stage_runs
       set status = 'failed',
           finished_at = now(),
           -- duration_ms stays NULL on purpose. The obvious thing is to record
           -- now() - started_at, and that is WRONG: it measures how long the
           -- row sat abandoned before somebody noticed, not how long the work
           -- took. Doing it that way logged a 300-second stage as 1,620s and
           -- 5,011s, which read as "revision is catastrophically slow" — and
           -- those fabricated numbers went straight into the table the run
           -- budget's per-stage reserves are derived from. A duration we do
           -- not know is better left unknown than invented.
           duration_ms = null,
           failure_reason = 'internal',
           error = 'The run driving this stage stopped without reporting an outcome '
                || '(most likely killed at the platform time limit). No result was '
                || 'recorded. Noticed after '
                || round(extract(epoch from (now() - started_at)))::text || 's.'
     where request_id = ${requestId}
       and status = 'running'
       and started_at < now() - ${olderThan}::interval
    returning id, stage, attempt`;
  return rows.map((r) => ({
    id: String(r.id),
    stage: String(r.stage),
    attempt: Number(r.attempt),
  }));
}

export type StageOutcome =
  | {
      ok: true;
      model?: string | null;
      claudeRequestId?: string | null;
      effort?: string | null;
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      detail?: Record<string, unknown>;
    }
  | {
      ok: false;
      failureReason:
        | 'refusal'
        | 'rate_limit'
        | 'invalid_response'
        | 'api_error'
        | 'validation'
        | 'internal';
      error: string;
      claudeRequestId?: string | null;
      durationMs: number;
      detail?: Record<string, unknown>;
    };

export async function finishStageRun(id: string, outcome: StageOutcome) {
  const rows = await sql`
    update stage_runs set
      status = ${outcome.ok ? 'ok' : 'failed'}::run_status,
      finished_at = now(),
      duration_ms = ${outcome.durationMs},
      model = ${outcome.ok ? (outcome.model ?? null) : null},
      claude_request_id = ${outcome.claudeRequestId ?? null},
      effort = ${outcome.ok ? (outcome.effort ?? null) : null},
      input_tokens = ${outcome.ok ? (outcome.inputTokens ?? null) : null},
      output_tokens = ${outcome.ok ? (outcome.outputTokens ?? null) : null},
      cache_read_tokens = ${outcome.ok ? (outcome.cacheReadTokens ?? null) : null},
      cache_write_tokens = ${outcome.ok ? (outcome.cacheWriteTokens ?? null) : null},
      failure_reason = ${outcome.ok ? null : outcome.failureReason},
      error = ${outcome.ok ? null : outcome.error},
      detail = ${sql.json((outcome.detail ?? {}) as never)}
    where id = ${id}
    returning *`;
  return StageRunRow.parse(rows[0]);
}

export async function getStageRuns(requestId: string) {
  const rows = await sql`
    select * from stage_runs where request_id = ${requestId}
    order by started_at asc, attempt asc`;
  return rows.map((r) => StageRunRow.parse(r));
}

/** Move the request into a machine stage's in-progress status. */
export async function setStatus(
  id: string,
  to: RequestStatus,
  from: RequestStatus[],
): Promise<ContentRequestRow> {
  const rows = await sql`
    update content_requests set status = ${to}::request_status, version = version + 1
    where id = ${id} and status = any(${from as unknown as string[]}::request_status[])
    returning *`;
  if (!rows.length) {
    const current = await getRequest(id);
    throw new ConflictError(
      `Cannot move to '${to}' from '${current?.status ?? 'unknown'}'. Expected one of: ${from.join(', ')}.`,
    );
  }
  return ContentRequestRow.parse(rows[0]);
}

/**
 * Move to 'revising' AND spend one unit of the auto-revision budget, in the
 * same statement. This is the ONLY place that increments revision_round for
 * the machine loop — a request a human sends back with 'revise' bumps it
 * too (recordReview() below), which is intentional: the budget is shared,
 * so a request a reviewer has already iterated on several times escalates
 * back to them sooner rather than the machine looping past that.
 *
 * Regression this exists to prevent: runEvaluation() (lib/pipeline.ts)
 * decides whether to loop again by comparing revision_round against
 * max_revision_rounds, but if nothing ever increments the counter on the
 * machine path, that comparison is always true and the evaluate → revise →
 * evaluate → revise cycle never ends — it never reaches a human, and it
 * never stops spending API calls.
 */
export async function startAutoRevision(id: string): Promise<ContentRequestRow> {
  const rows = await sql`
    update content_requests set
      status = 'revising'::request_status,
      revision_round = revision_round + 1,
      version = version + 1
    where id = ${id} and status = 'evaluating'
    returning *`;
  if (!rows.length) {
    const current = await getRequest(id);
    throw new ConflictError(
      `Cannot start an auto-revision from '${current?.status ?? 'unknown'}'. Expected 'evaluating'.`,
    );
  }
  return ContentRequestRow.parse(rows[0]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   The pipeline lock — exactly one driver per request
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * How long a lock may go without a heartbeat before another driver may take
 * it.
 *
 * Three minutes, because the driver now heartbeats every twenty seconds
 * WHILE a stage runs, not only between stages. That is nine missed beats
 * before anyone touches the lock, so a slow-but-healthy run is never
 * reclaimed underneath itself — the duplicate-spend problem this lock exists
 * to prevent.
 *
 * It used to be twenty minutes, and it had to be: with no heartbeat during a
 * stage, a run doing five minutes of honest web research looked exactly like
 * a run whose process had died. The cost was paid by the dead ones — a driver
 * killed by a deploy, or by a dev server recompiling mid-run, left its
 * request locked and unresumable for the full twenty minutes with nothing
 * wrong with it.
 */
const LOCK_STALE_AFTER_MS = 3 * 60 * 1000;

/**
 * The same window, in the form Postgres wants.
 *
 * Derived rather than written twice. It WAS written twice, and the two copies
 * drifted: this was tightened from twenty minutes to three, and lockIsLive()
 * — the JavaScript the delete guard, the reset guard and the "Running…" badge
 * all use — kept its own hardcoded twenty. So the database would let a new
 * driver reclaim a lock while the interface still insisted the pipeline was
 * running on it, and a request could not be deleted or reset for another
 * seventeen minutes after it was already fair game.
 */
const LOCK_STALE_AFTER = `${LOCK_STALE_AFTER_MS} milliseconds`;

/**
 * Take ownership of a request's pipeline, or return null if someone already
 * has it.
 *
 * The WHERE clause is the mutual exclusion: two concurrent claims both run
 * this UPDATE, Postgres serialises them on the row, and the second one
 * matches zero rows because the first has already set pipeline_lock_at. No
 * advisory lock, no read-then-write window.
 */
export async function claimPipelineLock(id: string, actor: string) {
  const rows = await sql`
    update content_requests set
      pipeline_lock_at = now(),
      pipeline_lock_by = ${actor},
      pipeline_heartbeat_at = now()
    where id = ${id}
      and deleted_at is null
      and (
        pipeline_lock_at is null
        or pipeline_heartbeat_at < now() - ${LOCK_STALE_AFTER}::interval
      )
    returning *`;
  return rows.length ? ContentRequestRow.parse(rows[0]) : null;
}

/** Called between stages so a long run is not mistaken for a dead one. */
/**
 * Say we are still working — and find out whether we are still allowed to.
 *
 * Returns false when the lock has moved on. That is the ONLY cheap way a
 * driver learns it has been superseded: its stage calls succeed, its writes
 * look fine, and nothing else tells it that another driver reclaimed the
 * request twenty minutes ago and is four stages further along.
 *
 * The owner check is the whole point. Without it a zombie kept refreshing a
 * lock it no longer held, which made the rightful owner's lock look eternally
 * fresh while the zombie carried on working in parallel.
 */
export async function heartbeatPipelineLock(id: string, owner?: string): Promise<boolean> {
  const rows = owner
    ? await sql`
        update content_requests set pipeline_heartbeat_at = now()
        where id = ${id} and pipeline_lock_by = ${owner}
        returning 1 as ok`
    : await sql`
        update content_requests set pipeline_heartbeat_at = now()
        where id = ${id} and pipeline_lock_at is not null
        returning 1 as ok`;
  return rows.length > 0;
}

/**
 * Requests sitting in a machine status with nobody working on them.
 *
 * Two shapes, both stalled: a lock whose heartbeat has gone quiet (the driver
 * was killed mid-run), and no lock at all (a run that never started, or one
 * whose process died before it could even claim). Both need the same thing —
 * someone to pick the work back up.
 *
 * Deliberately excludes the human statuses: awaiting_review, rejected and
 * blocked are not stalled, they are waiting, and restarting them would take
 * the decision away from the person it belongs to.
 */
export async function findStalledPipelines(limit = 5) {
  const rows = await sql`
    select * from content_requests
    where deleted_at is null
      and status in ('researching','retrieving','selecting','planning',
                     'generating','evaluating','revising','packaging')
      and (
        pipeline_lock_at is null
        or pipeline_heartbeat_at < now() - ${LOCK_STALE_AFTER}::interval
      )
      -- Give a request a moment to be picked up normally before treating a
      -- missing lock as a stall; a start request that has just been accepted
      -- is briefly in exactly this state.
      and updated_at < now() - interval '2 minutes'
    order by updated_at
    limit ${limit}`;
  return rows.map((r) => ContentRequestRow.parse(r));
}

/**
 * Let go of the lock — but only if it is still ours.
 *
 * It used to release unconditionally, on id alone, and that single missing
 * clause produced a lock-stealing cascade. A driver that hung long enough for
 * its lock to go stale would be superseded by a second driver; when the first
 * one finally returned, its own `finally` stripped the lock out from under the
 * second. That driver then worked with no lock at all, so a third could claim
 * the same request — and a late arrival could fail a run that four stages of
 * healthy work had gone into.
 *
 * Releasing something you do not hold is not cleanup, it is interference.
 */
export async function releasePipelineLock(id: string, owner?: string): Promise<boolean> {
  const rows = owner
    ? await sql`
        update content_requests set
          pipeline_lock_at = null, pipeline_lock_by = null, pipeline_heartbeat_at = null
        where id = ${id} and pipeline_lock_by = ${owner}
        returning 1 as ok`
    : await sql`
        update content_requests set
          pipeline_lock_at = null, pipeline_lock_by = null, pipeline_heartbeat_at = null
        where id = ${id}
        returning 1 as ok`;
  return rows.length > 0;
}

/**
 * How long after a request last moved we still assume somebody is on it.
 *
 * A hand-off between slices has a real gap: the finishing driver releases its
 * lock, calls the continue endpoint, and the next driver claims it. Measured
 * on live runs that gap is two to three seconds — and the page polls every
 * five, so a poll landing inside it saw no lock and told the user the pipeline
 * had stopped, offering Resume for work that was already carrying on.
 *
 * Thirty seconds is ten times the observed gap. A genuine stall is still
 * surfaced, just half a minute later — a trade worth making, because an
 * indicator that cries stall during normal operation is one nobody believes
 * when it matters.
 */
const HANDOFF_GRACE_MS = 30_000;

/**
 * Is work in flight on this request — including between slices?
 *
 * `lockIsLive` answers "is a lock held right now", which is the right question
 * for deciding whether a NEW driver may start. It is the wrong question for
 * telling a person whether anything is happening, because it says no during
 * every hand-off.
 */
export function workInFlight(r: {
  status: string;
  pipeline_lock_at: Date | null;
  pipeline_heartbeat_at: Date | null;
  updated_at: Date;
}): boolean {
  if (lockIsLive(r)) return true;
  if (!MACHINE_STATUSES.has(r.status)) return false;
  return Date.now() - r.updated_at.getTime() < HANDOFF_GRACE_MS;
}

/** Statuses where the machine, not a person, is expected to move things on. */
const MACHINE_STATUSES = new Set([
  'researching',
  'retrieving',
  'selecting',
  'planning',
  'generating',
  'evaluating',
  'revising',
  'packaging',
]);

/** Is a driver currently working on this, and does it still look alive? */
export function lockIsLive(r: {
  pipeline_lock_at: Date | null;
  pipeline_heartbeat_at: Date | null;
}): boolean {
  if (!r.pipeline_lock_at) return false;
  const beat = r.pipeline_heartbeat_at ?? r.pipeline_lock_at;
  // The same window the database reclaims on — see LOCK_STALE_AFTER_MS. These
  // must agree: if this is the more generous of the two, the interface calls a
  // request busy that another driver is already allowed to take.
  return Date.now() - beat.getTime() < LOCK_STALE_AFTER_MS;
}

/**
 * Advance the status, treating "already there" as success rather than as a
 * conflict.
 *
 * setStatus() is strict on purpose — it is what stops a stage advancing a
 * request that has moved on underneath it. But at the END of a stage, strict
 * is wrong: a request that is already in the target status has, by
 * definition, already had this exact transition applied, and throwing there
 * turned a harmless race into a hard failure. One real incident: two
 * revision runs seven seconds apart, the second finishing its work fine and
 * then dying on "Cannot move to 'evaluating' from 'evaluating'", which
 * marked the whole request failed.
 */
export async function advanceStatus(
  id: string,
  to: RequestStatus,
  from: RequestStatus[],
): Promise<ContentRequestRow> {
  const rows = await sql`
    update content_requests set status = ${to}::request_status, version = version + 1
    where id = ${id} and status = any(${[...from, to] as unknown as string[]}::request_status[])
    returning *`;
  if (!rows.length) {
    const current = await getRequest(id);
    throw new ConflictError(
      `Cannot move to '${to}' from '${current?.status ?? 'unknown'}'. Expected one of: ${from.join(', ')}.`,
    );
  }
  return ContentRequestRow.parse(rows[0]);
}

/**
 * The status a request is in while a given stage is its current work.
 *
 * Used to make failing a stage conditional: a stage may only fail the request
 * it was actually working on.
 */
const STATUS_WHILE_RUNNING: Partial<Record<PipelineStage, string[]>> = {
  audit: ['draft'],
  research: ['researching'],
  retrieval: ['retrieving'],
  selection: ['selecting'],
  planning: ['planning'],
  generation: ['generating'],
  evaluation: ['evaluating'],
  revision: ['revising'],
  packaging: ['packaging', 'approved'],
};

/**
 * Fail the request — but only if it is still on this stage.
 *
 * It used to update on id alone, which let a driver fail a request it no
 * longer had anything to do with. That is not hypothetical: a research call
 * failed twelve minutes after a second driver had taken the request over and
 * carried it to generation, and the late failure marked the whole healthy run
 * failed. The next stage then failed too, because the request it was working
 * on had just been failed underneath it.
 *
 * The ConflictError path covers a superseded driver whose status WRITE is
 * rejected. This covers the other half: a superseded driver whose Claude call
 * simply failed on its own terms, which never touches a status transition and
 * so was never caught by it.
 *
 * Returns whether it actually failed anything, so a caller can tell the
 * difference between "this request is now failed" and "this request moved on
 * without me".
 */
export async function markStageFailed(
  id: string,
  stage: PipelineStage,
  reason: string,
): Promise<boolean> {
  const allowed = STATUS_WHILE_RUNNING[stage];
  const rows = allowed
    ? await sql`
        update content_requests set
          status = 'failed', failed_stage = ${stage}::pipeline_stage,
          failed_reason = ${reason}, version = version + 1
        where id = ${id} and status = any(${allowed}::request_status[])
        returning 1 as ok`
    : await sql`
        update content_requests set
          status = 'failed', failed_stage = ${stage}::pipeline_stage,
          failed_reason = ${reason}, version = version + 1
        where id = ${id}
        returning 1 as ok`;
  return rows.length > 0;
}

/**
 * Park a request for a human instead of failing it.
 *
 * The difference is not cosmetic. `failed` means the machine broke and the
 * cure is a retry; `blocked` means the machine worked correctly and cannot
 * proceed until a person supplies something. Research that finds thirteen
 * real sources and cannot read any of them is the second case — nothing went
 * wrong, the open web simply did not cooperate — and calling it `failed` sent
 * people to a retry button that was never going to help.
 *
 * `failed_stage` still records where it stopped, so the resume path knows
 * what to re-run; `nextStage()` returns null for 'blocked', so the driver
 * stops here rather than looping.
 */
export async function parkForHuman(
  id: string,
  stage: PipelineStage,
  reason: string,
  from: RequestStatus[],
): Promise<ContentRequestRow> {
  const rows = await sql`
    update content_requests set
      status = 'blocked', failed_stage = ${stage}::pipeline_stage,
      failed_reason = ${reason}, version = version + 1
    where id = ${id} and status = any(${from as unknown as string[]}::request_status[])
    returning *`;
  if (!rows.length) {
    const current = await getRequest(id);
    throw new ConflictError(
      `Cannot park from '${current?.status ?? 'unknown'}'. Expected one of: ${from.join(', ')}.`,
    );
  }
  return ContentRequestRow.parse(rows[0]);
}

/**
 * A person has supplied source text by hand. Clear the block and send the
 * request back into retrieval, which is the stage that turns raw text into
 * quotable excerpts — the same path an automatically fetched page takes, so
 * a pasted source grounds claims exactly as strictly as a fetched one.
 */
export async function resumeWithPastedSource(id: string): Promise<ContentRequestRow> {
  const rows = await sql`
    update content_requests set
      status = 'retrieving', failed_stage = null, failed_reason = null,
      version = version + 1
    where id = ${id} and status in ('blocked','failed')
    returning *`;
  if (!rows.length) {
    const current = await getRequest(id);
    throw new ConflictError(
      `Only a blocked or failed request can be resumed this way; this one is '${current?.status ?? 'unknown'}'.`,
    );
  }
  return ContentRequestRow.parse(rows[0]);
}

export async function clearFailure(id: string) {
  await sql`
    update content_requests set failed_stage = null, failed_reason = null
    where id = ${id}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Sources and excerpts
   ═══════════════════════════════════════════════════════════════════════════ */

export async function upsertSource(s: {
  requestId: string;
  kind: 'web' | 'upload' | 'pasted';
  url: string | null;
  title: string;
  discoveredBy: string | null;
  rawText?: string | null;
  status?: string;
}) {
  const domain = s.url ? safeDomain(s.url) : null;
  const rows = await sql`
    insert into sources (request_id, kind, url, domain, title, discovered_by, raw_text, status, fetched_at)
    values (${s.requestId}, ${s.kind}::source_kind, ${s.url}, ${domain}, ${s.title},
            ${s.discoveredBy}, ${s.rawText ?? null}, ${s.status ?? 'discovered'},
            ${s.rawText ? new Date() : null})
    on conflict (request_id, url) do update set
      title = excluded.title,
      raw_text = coalesce(excluded.raw_text, sources.raw_text),
      status = excluded.status
    returning *`;
  return SourceRow.parse(rows[0]);
}

function safeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export async function saveDigest(sourceId: string, digest: { digestMd: string; citations: unknown }) {
  const rows = await sql`
    update sources set digest_md = ${digest.digestMd},
      citations_json = ${sql.json(digest.citations as never)},
      status = 'digested'
    where id = ${sourceId} returning *`;
  return SourceRow.parse(rows[0]);
}

/**
 * Record why a source did not contribute quotes, without calling it a
 * failure when it isn't one.
 *
 *   'discovered' — found in search, never opened. Routine: publishers and
 *                  aggregators block automated fetching all the time. Still
 *                  valid attribution; just cannot be quoted.
 *   'rejected'   — opened, and what came back was not the page (a bot
 *                  challenge, a paywall, a login wall).
 */
export async function setSourceOutcome(
  sourceId: string,
  status: 'discovered' | 'rejected',
  reason: string,
) {
  await sql`
    update sources set status = ${status}, error = ${reason} where id = ${sourceId}`;
}

export async function markSourceFailed(sourceId: string, error: string) {
  await sql`update sources set status = 'failed', error = ${error} where id = ${sourceId}`;
}

export async function getSources(requestId: string) {
  const rows = await sql`
    select * from sources where request_id = ${requestId} order by created_at`;
  return rows.map((r) => SourceRow.parse(r));
}

export async function insertExcerpts(
  requestId: string,
  sourceId: string,
  excerpts: { quote: string; gist: string; locator: unknown }[],
) {
  if (!excerpts.length) return [];
  const rows = await sql`
    insert into source_excerpts ${sql(
      excerpts.map((e, i) => ({
        request_id: requestId,
        source_id: sourceId,
        ordinal: i + 1,
        quote: e.quote,
        gist: e.gist,
        locator: sql.json((e.locator ?? {}) as never),
      })),
      'request_id',
      'source_id',
      'ordinal',
      'quote',
      'gist',
      'locator',
    )}
    on conflict (source_id, ordinal) do nothing
    returning *`;
  return rows.map((r) => SourceExcerptRow.parse(r));
}

export async function getExcerpts(requestId: string, onlySelected = false) {
  const rows = onlySelected
    ? await sql`
        select * from source_excerpts
        where request_id = ${requestId} and selected is true
        order by relevance desc nulls last, id`
    : await sql`
        select * from source_excerpts where request_id = ${requestId}
        order by source_id, ordinal`;
  return rows.map((r) => SourceExcerptRow.parse(r));
}

export async function applySelection(
  stageRunId: string,
  selections: { excerpt_id: string; keep: boolean; relevance: number; reason: string }[],
) {
  for (const s of selections) {
    await sql`
      update source_excerpts set
        selected = ${s.keep},
        relevance = ${clamp01(s.relevance)},
        selection_reason = ${s.reason},
        selected_by = ${stageRunId}
      where id = ${s.excerpt_id}`;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Excerpts in the shape every prompt wants them. */
export async function getSelectedForPrompt(requestId: string) {
  const rows = await sql`
    select e.id, e.quote, e.gist, s.title as source_title, s.url
    from source_excerpts e join sources s on s.id = e.source_id
    where e.request_id = ${requestId} and e.selected is true
    order by e.relevance desc nulls last, e.id`;
  return rows.map((r) => ({
    id: String(r.id),
    quote: String(r.quote),
    gist: String(r.gist),
    source_title: String(r.source_title),
    url: r.url === null ? null : String(r.url),
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Plans
   ═══════════════════════════════════════════════════════════════════════════ */

export async function insertPlan(p: {
  requestId: string;
  stageRunId: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  thesis: string;
  outline: unknown;
  angles: unknown;
  linkTargets: unknown;
}) {
  const rows = await sql`
    insert into content_plans (
      request_id, plan_no, stage_run_id, primary_keyword, secondary_keywords,
      thesis, outline_json, angles_json, link_targets_json
    ) values (
      ${p.requestId},
      (select coalesce(max(plan_no), 0) + 1 from content_plans where request_id = ${p.requestId}),
      ${p.stageRunId}, ${p.primaryKeyword}, ${p.secondaryKeywords as unknown as string[]},
      ${p.thesis}, ${sql.json(p.outline as never)}, ${sql.json(p.angles as never)},
      ${sql.json(p.linkTargets as never)}
    ) returning *`;
  return ContentPlanRow.parse(rows[0]);
}

export async function getLatestPlan(requestId: string) {
  const rows = await sql`
    select * from content_plans where request_id = ${requestId}
    order by plan_no desc limit 1`;
  return rows.length ? ContentPlanRow.parse(rows[0]) : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Articles and versions
   ═══════════════════════════════════════════════════════════════════════════ */

export async function upsertArticle(a: {
  requestId: string;
  optionIndex: number;
  angle: string;
  planId: string;
}) {
  const rows = await sql`
    insert into articles (request_id, option_index, angle, plan_id)
    values (${a.requestId}, ${a.optionIndex}, ${a.angle}, ${a.planId})
    on conflict (request_id, option_index) do update set
      angle = excluded.angle, plan_id = excluded.plan_id
    returning *`;
  return ArticleRow.parse(rows[0]);
}

export async function getArticles(requestId: string) {
  const rows = await sql`
    select * from articles where request_id = ${requestId} order by option_index`;
  return rows.map((r) => ArticleRow.parse(r));
}

/**
 * Write a new version and point the article at it.
 *
 * Never an UPDATE of prose — article_versions is append-only, enforced by
 * sql/02-triggers.sql. `app.actor` is set on the connection first so the
 * revoke-approval trigger can attribute the event it writes.
 */
export async function insertVersion(v: {
  requestId: string;
  articleId: string;
  parentVersionId: string | null;
  origin: 'generated' | 'auto_revised' | 'human_revised' | 'human_edited';
  revisionInstruction: string | null;
  evaluationId: string | null;
  title: string;
  slug: string;
  dek: string;
  bodyMd: string;
  wordCount: number;
  readingTimeS: number;
  seoJson: unknown;
  seoPass: boolean;
  assumptions: string[];
  gaps: string[];
  model: string | null;
  claudeRequestId: string | null;
  stageRunId: string | null;
  createdBy: string | null;
  actor: string;
}) {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.actor', ${v.actor}, true)`;

    const rows = await tx`
      insert into article_versions (
        article_id, request_id, revision_no, parent_version_id, origin,
        revision_instruction, evaluation_id, title, slug, dek, body_md,
        word_count, reading_time_s, seo_json, seo_pass, assumptions, gaps,
        content_hash, model, claude_request_id, stage_run_id, created_by
      ) values (
        ${v.articleId}, ${v.requestId},
        (select coalesce(max(revision_no), 0) + 1 from article_versions
          where article_id = ${v.articleId}),
        ${v.parentVersionId}, ${v.origin}, ${v.revisionInstruction}, ${v.evaluationId},
        ${v.title}, ${v.slug}, ${v.dek}, ${v.bodyMd}, ${v.wordCount}, ${v.readingTimeS},
        ${tx.json(v.seoJson as never)}, ${v.seoPass},
        ${tx.json(v.assumptions as never)}, ${tx.json(v.gaps as never)},
        ${contentFingerprint(v.title, v.bodyMd)}, ${v.model}, ${v.claudeRequestId},
        ${v.stageRunId}, ${v.createdBy}
      ) returning *`;

    const version = ArticleVersionRow.parse(rows[0]);
    await tx`update articles set current_version_id = ${version.id} where id = ${v.articleId}`;
    return version;
  });
}

/**
 * The fingerprint recorded at approval and re-checked before publishing. The
 * separator is a character that cannot appear in either field, so a title
 * ending where a body begins cannot collide with a different split.
 */
export function contentFingerprint(title: string, bodyMd: string): string {
  return sha256([title, bodyMd].join('\u0000'));
}

export async function insertClaims(
  versionId: string,
  claims: { claim_text: string; section_key: string; support: string; excerpt_ids: string[] }[],
) {
  if (!claims.length) return;

  await sql.begin(async (tx) => {
    for (const [i, c] of claims.entries()) {
      const rows = await tx`
        insert into article_claims (version_id, ordinal, claim_text, section_key, support)
        values (${versionId}, ${i + 1}, ${c.claim_text}, ${c.section_key},
                ${c.support}::claim_support)
        returning id`;
      const claimId = String(rows[0].id);

      for (const excerptId of c.excerpt_ids) {
        // The excerpt must belong to this request AND have been selected —
        // a citation of a dropped or foreign excerpt is not a citation.
        await tx`
          insert into claim_citations (claim_id, excerpt_id, source_id, quote)
          select ${claimId}, e.id, e.source_id, e.quote
          from source_excerpts e
          where e.id = ${excerptId} and e.selected is true
          on conflict do nothing`;
      }
    }

    // The rollup the "sources that informed this" UI reads.
    await tx`
      insert into article_version_sources (version_id, source_id, claim_count)
      select ${versionId}, cc.source_id, count(*)
      from claim_citations cc join article_claims ac on ac.id = cc.claim_id
      where ac.version_id = ${versionId}
      group by cc.source_id
      on conflict (version_id, source_id) do update set claim_count = excluded.claim_count`;
  });
}

export async function getVersion(id: string) {
  const rows = await sql`select * from article_versions where id = ${id}`;
  return rows.length ? ArticleVersionRow.parse(rows[0]) : null;
}

export async function getCurrentVersions(requestId: string) {
  const rows = await sql`
    select v.* from article_versions v
    join articles a on a.current_version_id = v.id
    where a.request_id = ${requestId} and a.discarded_at is null
    order by a.option_index`;
  return rows.map((r) => ArticleVersionRow.parse(r));
}

/** The full history for one option — what "preserve the review history" means. */
export async function getVersionHistory(articleId: string) {
  const rows = await sql`
    select * from article_versions where article_id = ${articleId} order by revision_no`;
  return rows.map((r) => ArticleVersionRow.parse(r));
}

export async function getClaims(versionId: string) {
  const rows = await sql`
    select * from article_claims where version_id = ${versionId} order by ordinal`;
  return rows.map((r) => ArticleClaimRow.parse(r));
}

/** The source list that must accompany every output. */
export async function getVersionSources(versionId: string) {
  const rows = await sql`
    select s.id, s.title, s.url, s.domain, avs.claim_count
    from article_version_sources avs join sources s on s.id = avs.source_id
    where avs.version_id = ${versionId}
    order by avs.claim_count desc, s.title`;
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    url: r.url === null ? null : String(r.url),
    domain: r.domain === null ? null : String(r.domain),
    claim_count: Number(r.claim_count),
  }));
}


/* ═══════════════════════════════════════════════════════════════════════════
   Evaluations
   ═══════════════════════════════════════════════════════════════════════════ */

export async function insertEvaluation(e: {
  versionId: string;
  requestId: string;
  status: 'pass' | 'revise' | 'reject';
  overallScore: number;
  summary: string;
  unsupportedClaims: unknown;
  sectionsNeedingRevision: unknown;
  recommendedChanges: unknown;
  raw: unknown;
  scores: { criterion: string; score: number; note: string }[];
  model: string | null;
  claudeRequestId: string | null;
  stageRunId: string | null;
}) {
  return sql.begin(async (tx) => {
    const rows = await tx`
      insert into evaluations (
        version_id, request_id, status, overall_score, summary,
        unsupported_claims, sections_needing_revision, recommended_changes,
        raw_json, model, claude_request_id, stage_run_id
      ) values (
        ${e.versionId}, ${e.requestId}, ${e.status}::eval_status, ${e.overallScore},
        ${e.summary}, ${tx.json(e.unsupportedClaims as never)},
        ${tx.json(e.sectionsNeedingRevision as never)},
        ${tx.json(e.recommendedChanges as never)}, ${tx.json(e.raw as never)},
        ${e.model}, ${e.claudeRequestId}, ${e.stageRunId}
      ) returning *`;
    const evaluation = EvaluationRow.parse(rows[0]);

    for (const s of e.scores) {
      await tx`
        insert into evaluation_scores (evaluation_id, criterion, score, note)
        values (${evaluation.id}, ${s.criterion}::rubric_criterion,
                ${Math.min(5, Math.max(1, Math.round(s.score)))}, ${s.note})
        on conflict (evaluation_id, criterion) do nothing`;
    }
    return evaluation;
  });
}

export async function getEvaluationFor(versionId: string) {
  const rows = await sql`select * from evaluations where version_id = ${versionId}`;
  if (!rows.length) return null;
  const evaluation = EvaluationRow.parse(rows[0]);
  const scoreRows = await sql`
    select * from evaluation_scores where evaluation_id = ${evaluation.id}`;
  return { ...evaluation, scores: scoreRows.map((r) => EvaluationScoreRow.parse(r)) };
}


/* ═══════════════════════════════════════════════════════════════════════════
   The human gate
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Record a review action and move the request, in one transaction.
 *
 * `expectedVersion` in the WHERE clause is what makes two reviewers clicking
 * at once safe: the second one gets zero rows and a 409, rather than
 * overwriting the first one's decision.
 *
 * Note what this function does NOT check: that approving is legal from the
 * current status, that an approval names a selected article, that it records
 * a version and a hash. Those are enforced by guard_content_approval() in
 * sql/02-triggers.sql, so they hold for every writer, including psql.
 */
export async function recordReview(r: {
  requestId: string;
  reviewerId: string;
  action: 'approve' | 'reject' | 'revise' | 'select';
  articleId: string | null;
  versionId: string | null;
  note: string;
  instruction: string | null;
  expectedVersion: number;
  /** Where the request should end up. Computed by the caller from the action. */
  toStatus: RequestStatus;
  approvedContentHash?: string | null;
}) {
  return sql.begin(async (tx) => {
    const before = await tx`
      select * from content_requests
      where id = ${r.requestId} and deleted_at is null`;
    if (!before.length) throw new ConflictError('No such request.');
    const current = ContentRequestRow.parse(before[0]);

    if (current.version !== r.expectedVersion) {
      throw new VersionConflictError(undefined, current.version);
    }

    const isApprove = r.action === 'approve';
    const isSelect = r.action === 'select';

    const updated = await tx`
      update content_requests set
        status = ${r.toStatus}::request_status,
        reviewer_id = ${r.reviewerId},
        selected_article_id = ${
          isSelect || isApprove ? r.articleId : current.selected_article_id
        },
        approved_at = ${isApprove ? new Date() : null},
        approved_version_id = ${isApprove ? r.versionId : null},
        approved_content_hash = ${isApprove ? (r.approvedContentHash ?? null) : null},
        rejected_reason = ${r.action === 'reject' ? r.note : null},
        revision_round = ${
          r.action === 'revise' ? current.revision_round + 1 : current.revision_round
        },
        version = version + 1
      where id = ${r.requestId} and version = ${r.expectedVersion}
      returning *`;
    if (!updated.length) throw new VersionConflictError();

    const reviewRows = await tx`
      insert into reviews (
        request_id, version_id, article_id, action, note, instruction,
        reviewer_id, from_status, to_status
      ) values (
        ${r.requestId}, ${r.versionId}, ${r.articleId}, ${r.action}::review_action,
        ${r.note}, ${r.instruction}, ${r.reviewerId},
        ${current.status}::request_status, ${r.toStatus}::request_status
      ) returning *`;

    return {
      request: ContentRequestRow.parse(updated[0]),
      review: ReviewRow.parse(reviewRows[0]),
    };
  });
}

export async function getReviews(requestId: string) {
  // Joined rather than looked up afterwards: "who decided this" is the first
  // question anyone brings to a review trail, and a reviewer_id uuid does not
  // answer it.
  const rows = await sql`
    select r.*, u.email as reviewer_email, u.full_name as reviewer_name
    from reviews r
    left join app_users u on u.id = r.reviewer_id
    where r.request_id = ${requestId}
    order by r.id asc`;
  return rows.map((r) => ({
    ...ReviewRow.parse(r),
    reviewer_email: r.reviewer_email ? String(r.reviewer_email) : null,
    reviewer_name: r.reviewer_name ? String(r.reviewer_name) : null,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Channel assets
   ═══════════════════════════════════════════════════════════════════════════ */

export async function insertChannelAsset(a: {
  requestId: string;
  versionId: string;
  channel: Channel;
  body: string;
  subject: string | null;
  preheader: string | null;
  cta: string;
  hashtags: string[];
  payload: unknown;
  rules: unknown;
  rulesPass: boolean;
  model: string | null;
  claudeRequestId: string | null;
  stageRunId: string | null;
  editedBy?: string | null;
}) {
  const rows = await sql`
    insert into channel_assets (
      request_id, version_id, channel, asset_no, body, subject, preheader, cta,
      hashtags, payload_json, rules_json, rules_pass, model, claude_request_id,
      stage_run_id, edited_by
    ) values (
      ${a.requestId}, ${a.versionId}, ${a.channel}::channel,
      (select coalesce(max(asset_no), 0) + 1 from channel_assets
        where request_id = ${a.requestId} and channel = ${a.channel}::channel),
      ${a.body}, ${a.subject}, ${a.preheader}, ${a.cta},
      ${a.hashtags as unknown as string[]}, ${sql.json(a.payload as never)},
      ${sql.json(a.rules as never)}, ${a.rulesPass}, ${a.model},
      ${a.claudeRequestId}, ${a.stageRunId}, ${a.editedBy ?? null}
    ) returning *`;
  return ChannelAssetRow.parse(rows[0]);
}

/** The newest asset for each channel — what the queue and the UI show. */
export async function getLatestAssets(requestId: string) {
  const rows = await sql`
    select distinct on (channel) * from channel_assets
    where request_id = ${requestId}
    order by channel, asset_no desc`;
  return rows.map((r) => ChannelAssetRow.parse(r));
}

export async function getAsset(id: string) {
  const rows = await sql`select * from channel_assets where id = ${id}`;
  return rows.length ? ChannelAssetRow.parse(rows[0]) : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Publishing queue
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Queue an approved asset. Both guards that matter live in the database:
 * guard_publication_insert() refuses an asset that does not derive from the
 * approved version, and publications_one_live_per_channel refuses a second
 * live row for the same channel.
 */
export async function queuePublication(p: {
  requestId: string;
  assetId: string;
  channel: Channel;
  scheduledFor: Date | null;
  queuedBy: string;
  /** Newsletter only — the list this send resolves against at release. */
  emailGroupId?: string | null;
  /** X and LinkedIn only — accounts to mention in the post. */
  tagHandles?: string[];
}) {
  try {
    const rows = await sql`
      insert into publications
        (request_id, asset_id, channel, state, scheduled_for, queued_by, email_group_id, tag_handles)
      values (${p.requestId}, ${p.assetId}, ${p.channel}::channel,
              ${p.scheduledFor ? 'scheduled' : 'queued'}::publication_state,
              ${p.scheduledFor}, ${p.queuedBy},
              ${p.emailGroupId ?? null},
              ${(p.tagHandles ?? []) as unknown as string[]})
      returning *`;
    return PublicationRow.parse(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('publications_one_live_per_channel')) {
      throw new ConflictError(
        `There is already a live ${p.channel} publication for this request. Cancel it first.`,
      );
    }
    if (message.includes('publications_group_is_newsletter_only')) {
      throw new ConflictError('A recipient list can only be attached to the newsletter.');
    }
    if (message.includes('publications_tags_are_social_only')) {
      throw new ConflictError('Accounts can only be tagged on X and LinkedIn.');
    }
    throw err;
  }
}

/** What a send actually went to, written at release rather than at queue time. */
export async function recordRecipients(
  publicationId: string,
  recipients: { email: string; name: string }[],
) {
  await sql`
    update publications
    set recipients_json = ${sql.json({ count: recipients.length, recipients } as never)}
    where id = ${publicationId}`;
}

export async function getPublications(requestId: string) {
  const rows = await sql`
    select * from publications where request_id = ${requestId} order by queued_at`;
  return rows.map((r) => PublicationRow.parse(r));
}

export async function listQueue(limit = 200) {
  const rows = await sql`
    select p.*, r.title_hint, r.raw_idea, g.name as email_group_name,
           (select count(*) from email_group_members m
             where m.group_id = p.email_group_id and m.unsubscribed_at is null)::int
             as email_group_size
    from publications p
    join content_requests r on r.id = p.request_id
    left join email_groups g on g.id = p.email_group_id
    where p.state in ('queued','scheduled','publishing','failed')
    order by p.scheduled_for nulls first, p.queued_at
    limit ${limit}`;
  return rows.map((r) => ({
    ...PublicationRow.parse(r),
    title_hint: String(r.title_hint ?? ''),
    raw_idea: String(r.raw_idea ?? ''),
    email_group_name: r.email_group_name ? String(r.email_group_name) : null,
    // The size RIGHT NOW, not at queue time — this is a preview of what the
    // send will resolve to, so a list that has emptied since shows as 0 here
    // rather than looking fine until it fails at release.
    email_group_size: r.email_group_id ? Number(r.email_group_size) : null,
  }));
}

/**
 * Claim due work for the cron worker.
 *
 * FOR UPDATE SKIP LOCKED plus the state flip means two concurrent ticks take
 * disjoint sets of rows — a second worker skips what the first has locked
 * rather than waiting for it and then publishing the same thing again.
 */
export async function claimDuePublications(limit = 10) {
  const rows = await sql`
    update publications set
      state = 'publishing', locked_at = now(), attempts = attempts + 1
    where id in (
      select id from publications
      where state in ('queued','scheduled')
        and (scheduled_for is null or scheduled_for <= now())
      order by scheduled_for nulls first, queued_at
      for update skip locked
      limit ${limit}
    )
    returning *`;
  return rows.map((r) => PublicationRow.parse(r));
}

export async function markPublished(
  id: string,
  result: { provider: string; providerId: string | null; externalUrl: string | null },
) {
  const rows = await sql`
    update publications set
      state = 'published', published_at = now(), locked_at = null,
      provider = ${result.provider}, provider_id = ${result.providerId},
      external_url = ${result.externalUrl}, last_error = null
    where id = ${id} and state = 'publishing'
    returning *`;
  if (!rows.length) throw new ConflictError('That publication is no longer being published.');
  return PublicationRow.parse(rows[0]);
}

/**
 * A failed attempt goes back to 'queued' so the next tick retries it — until
 * it has burned enough attempts that retrying is just noise, at which point
 * it rests in 'failed' for a human to look at.
 */
export const MAX_PUBLISH_ATTEMPTS = 3;

/**
 * Record a failed release.
 *
 * `retryable` is the publisher's own verdict, and it is honoured rather than
 * logged and forgotten. A revoked token, a malformed post or an account out
 * of API credits will fail identically on every future tick — putting those
 * back in the queue burns the attempt budget against a wall and then marks
 * them permanently failed, which reads as "we tried" when nothing was ever
 * going to work. They go straight to 'failed', where a person can fix the
 * cause and publish again.
 *
 * Transient failures keep the old behaviour: back to 'queued' until the
 * attempt budget is spent.
 */
export async function markPublishFailed(id: string, error: string, retryable = true) {
  const rows = await sql`
    update publications set
      state = case when ${!retryable} or attempts >= ${MAX_PUBLISH_ATTEMPTS}
                then 'failed' else 'queued' end::publication_state,
      locked_at = null, last_error = ${error}
    where id = ${id}
    returning *`;
  return PublicationRow.parse(rows[0]);
}

export async function cancelPublication(id: string, reason: string) {
  const rows = await sql`
    update publications set state = 'canceled', canceled_at = now(), cancel_reason = ${reason}
    where id = ${id} and state in ('queued','scheduled','failed')
    returning *`;
  if (!rows.length) throw new ConflictError('That publication cannot be cancelled now.');
  return PublicationRow.parse(rows[0]);
}

/**
 * Roll the request's own status up from its publications. Called after every
 * queue write, so `queued` and `published` on the request always reflect what
 * the publications table actually says.
 */
export async function syncPublishStatus(requestId: string) {
  const rows = await sql`
    update content_requests r set
      status = case
        when not exists (select 1 from publications p
                         where p.request_id = r.id and p.state <> 'canceled')
          then 'ready'
        when not exists (select 1 from publications p
                         where p.request_id = r.id
                           and p.state in ('queued','scheduled','publishing'))
          then 'published'
        else 'queued'
      end::request_status,
      version = version + 1
    where r.id = ${requestId}
      and r.status in ('ready','queued','published')
    returning *`;
  return rows.length ? ContentRequestRow.parse(rows[0]) : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Email groups — who a newsletter goes to
   ═══════════════════════════════════════════════════════════════════════════ */

/** Live groups with their current subscribed-member count, for pickers. */
export async function listEmailGroups(includeArchived = false) {
  const rows = await sql`
    select g.*,
           count(m.id) filter (where m.unsubscribed_at is null)::int as member_count,
           count(m.id) filter (where m.unsubscribed_at is not null)::int as unsubscribed_count
    from email_groups g
    left join email_group_members m on m.group_id = g.id
    where ${includeArchived ? sql`true` : sql`g.archived_at is null`}
    group by g.id
    order by g.archived_at nulls first, lower(g.name)`;
  return rows.map((r) => ({
    ...EmailGroupRow.parse(r),
    member_count: Number(r.member_count),
    unsubscribed_count: Number(r.unsubscribed_count),
  }));
}

export async function getEmailGroup(id: string) {
  const rows = await sql`select * from email_groups where id = ${id}`;
  return rows.length ? EmailGroupRow.parse(rows[0]) : null;
}

export async function listGroupMembers(groupId: string) {
  const rows = await sql`
    select * from email_group_members
    where group_id = ${groupId}
    order by unsubscribed_at nulls first, email`;
  return rows.map((r) => EmailGroupMemberRow.parse(r));
}

export async function createEmailGroup(g: {
  name: string;
  description: string;
  createdBy: string;
}) {
  try {
    const rows = await sql`
      insert into email_groups (name, description, created_by)
      values (${g.name.trim()}, ${g.description.trim()}, ${g.createdBy})
      returning *`;
    return EmailGroupRow.parse(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('email_groups_live_name_idx')) {
      throw new ConflictError(`There is already a group called "${g.name.trim()}".`);
    }
    throw err;
  }
}

export async function renameEmailGroup(id: string, name: string, description: string) {
  try {
    const rows = await sql`
      update email_groups set name = ${name.trim()}, description = ${description.trim()}
      where id = ${id} and archived_at is null
      returning *`;
    if (!rows.length) throw new ConflictError('That group no longer exists, or has been archived.');
    return EmailGroupRow.parse(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('email_groups_live_name_idx')) {
      throw new ConflictError(`There is already a group called "${name.trim()}".`);
    }
    throw err;
  }
}

/**
 * Archive rather than delete.
 *
 * A group that has been sent to is part of the record of who received what,
 * and publications point at it by id. Refused while anything is still queued
 * against it — archiving a list a scheduled send is about to resolve would
 * turn a working schedule into a failure at release time, hours later, with
 * nobody watching.
 */
export async function archiveEmailGroup(id: string) {
  const [pending] = await sql`
    select count(*)::int as n from publications
    where email_group_id = ${id} and state in ('queued','scheduled','publishing')`;
  if (Number(pending!.n) > 0) {
    throw new ConflictError(
      `That group has ${pending!.n} publication${Number(pending!.n) === 1 ? '' : 's'} still queued against it. Cancel or release those first.`,
    );
  }
  const rows = await sql`
    update email_groups set archived_at = now()
    where id = ${id} and archived_at is null
    returning *`;
  if (!rows.length) throw new ConflictError('That group is already archived.');
  return EmailGroupRow.parse(rows[0]);
}

export async function restoreEmailGroup(id: string) {
  try {
    const rows = await sql`
      update email_groups set archived_at = null
      where id = ${id} and archived_at is not null
      returning *`;
    if (!rows.length) throw new ConflictError('That group is not archived.');
    return EmailGroupRow.parse(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('email_groups_live_name_idx')) {
      throw new ConflictError(
        'A live group has taken that name since this one was archived. Rename one of them.',
      );
    }
    throw err;
  }
}

/**
 * Add addresses to a group, skipping ones already in it.
 *
 * `do nothing` rather than `do update`: re-pasting a list must not resurrect
 * someone who unsubscribed, and it must not overwrite a name that was typed
 * carefully with a blank from a bulk paste.
 */
export async function addGroupMembers(
  groupId: string,
  members: { email: string; name: string }[],
  addedBy: string,
) {
  if (!members.length) return { added: 0, skipped: 0 };
  const rows = await sql`
    insert into email_group_members ${sql(
      members.map((m) => ({
        group_id: groupId,
        email: m.email.trim().toLowerCase(),
        name: m.name.trim(),
        added_by: addedBy,
      })),
    )}
    on conflict (group_id, email) do nothing
    returning id`;
  return { added: rows.length, skipped: members.length - rows.length };
}

export async function removeGroupMember(groupId: string, memberId: string) {
  const rows = await sql`
    delete from email_group_members where group_id = ${groupId} and id = ${memberId}
    returning *`;
  if (!rows.length) throw new ConflictError('That address is not in this group.');
  return EmailGroupMemberRow.parse(rows[0]);
}

/**
 * Unsubscribing is not removal. Kept as a tombstone so a later bulk import
 * cannot silently put them back on the list.
 */
export async function setMemberSubscribed(groupId: string, memberId: string, subscribed: boolean) {
  const rows = await sql`
    update email_group_members
    set unsubscribed_at = ${subscribed ? null : new Date()}
    where group_id = ${groupId} and id = ${memberId}
    returning *`;
  if (!rows.length) throw new ConflictError('That address is not in this group.');
  return EmailGroupMemberRow.parse(rows[0]);
}

/** The addresses a send would actually go to, right now. */
export async function recipientsOf(groupId: string) {
  const rows = await sql`
    select email, name from email_group_members
    where group_id = ${groupId} and unsubscribed_at is null
    order by email`;
  return rows.map((r) => ({ email: String(r.email), name: String(r.name) }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   Channel credentials — the tokens that let this app post as you

   Tokens are encrypted before they reach the database and decrypted only at
   the point of use. Nothing in here is ever passed to logEvent: `events` is
   append-only by trigger, so a token written there could never be removed.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface ChannelConnection {
  channel: Channel;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  accountLabel: string;
  authorUrn: string | null;
  invalidSince: Date | null;
  lastError: string | null;
  connectedAt: Date;
}

/** Everything about a connection EXCEPT the tokens — safe to send to a page. */
export interface ChannelConnectionSummary {
  channel: Channel;
  accountLabel: string;
  authorUrn: string | null;
  scopes: string[];
  connectedAt: string;
  expiresAt: string | null;
  invalidSince: string | null;
  lastError: string | null;
}

export async function getChannelConnection(channel: Channel): Promise<ChannelConnection | null> {
  const rows = await sql`select * from channel_credentials where channel = ${channel}::channel`;
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    channel,
    accessToken: decryptSecret(String(r.access_token_enc)),
    refreshToken: r.refresh_token_enc ? decryptSecret(String(r.refresh_token_enc)) : null,
    expiresAt: r.expires_at ? new Date(String(r.expires_at)) : null,
    scopes: (r.scopes as string[]) ?? [],
    accountLabel: String(r.account_label ?? ''),
    authorUrn: r.author_urn ? String(r.author_urn) : null,
    invalidSince: r.invalid_since ? new Date(String(r.invalid_since)) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    connectedAt: new Date(String(r.connected_at)),
  };
}

/**
 * Every connection, with the tokens left behind.
 *
 * A separate function rather than a filter over getChannelConnection, so that
 * the shape that reaches a React page cannot accidentally carry a token: the
 * only way to get one is to ask for it by name.
 */
export async function listChannelConnections(): Promise<ChannelConnectionSummary[]> {
  const rows = await sql`
    select channel, account_label, author_urn, scopes, connected_at, expires_at,
           invalid_since, last_error
    from channel_credentials order by channel`;
  return rows.map((r) => ({
    channel: String(r.channel) as Channel,
    accountLabel: String(r.account_label ?? ''),
    authorUrn: r.author_urn ? String(r.author_urn) : null,
    scopes: (r.scopes as string[]) ?? [],
    connectedAt: new Date(String(r.connected_at)).toISOString(),
    expiresAt: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null,
    invalidSince: r.invalid_since ? new Date(String(r.invalid_since)).toISOString() : null,
    lastError: r.last_error ? String(r.last_error) : null,
  }));
}

export async function saveChannelConnection(c: {
  channel: Channel;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  accountLabel: string;
  authorUrn: string | null;
  connectedBy: string | null;
}): Promise<void> {
  await sql`
    insert into channel_credentials
      (channel, access_token_enc, refresh_token_enc, expires_at, scopes,
       account_label, author_urn, connected_by, connected_at, invalid_since, last_error)
    values (
      ${c.channel}::channel, ${encryptSecret(c.accessToken)},
      ${c.refreshToken ? encryptSecret(c.refreshToken) : null},
      ${c.expiresAt}, ${c.scopes as unknown as string[]},
      ${c.accountLabel}, ${c.authorUrn}, ${c.connectedBy}, now(), null, null)
    on conflict (channel) do update set
      access_token_enc  = excluded.access_token_enc,
      -- A refresh response often omits the refresh token, meaning "keep the
      -- one you have". Overwriting it with null there would break the next
      -- refresh and look like a random expiry days later.
      refresh_token_enc = coalesce(excluded.refresh_token_enc, channel_credentials.refresh_token_enc),
      expires_at        = excluded.expires_at,
      scopes            = excluded.scopes,
      account_label     = excluded.account_label,
      author_urn        = excluded.author_urn,
      connected_by      = coalesce(excluded.connected_by, channel_credentials.connected_by),
      connected_at      = now(),
      invalid_since     = null,
      last_error        = null`;
}

/** Only the token half, for a refresh that must not disturb the account label. */
export async function updateChannelTokens(
  channel: Channel,
  t: { accessToken: string; refreshToken: string | null; expiresAt: Date | null },
): Promise<void> {
  await sql`
    update channel_credentials set
      access_token_enc  = ${encryptSecret(t.accessToken)},
      refresh_token_enc = coalesce(${t.refreshToken ? encryptSecret(t.refreshToken) : null},
                                   refresh_token_enc),
      expires_at        = ${t.expiresAt},
      invalid_since     = null,
      last_error        = null
    where channel = ${channel}::channel`;
}

/**
 * Mark a connection as needing attention.
 *
 * Kept rather than deleted: the row is what the admin page reads to say
 * "reconnect X", and deleting it would make a revoked token indistinguishable
 * from one that was never set up.
 */
export async function markChannelInvalid(channel: Channel, reason: string): Promise<void> {
  await sql`
    update channel_credentials
    set invalid_since = coalesce(invalid_since, now()), last_error = ${reason.slice(0, 500)}
    where channel = ${channel}::channel`;
}

export async function disconnectChannel(channel: Channel): Promise<boolean> {
  const rows = await sql`
    delete from channel_credentials where channel = ${channel}::channel returning channel`;
  return rows.length > 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Usage and cost — what the pipeline actually spent
   ═══════════════════════════════════════════════════════════════════════════ */

export interface UsageRow {
  model: string | null;
  stage: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Token usage grouped by model and stage.
 *
 * Only OK runs. A failed stage that never got a reply cost nothing, and
 * including its zeroed columns would inflate the call count without moving
 * the total — making the per-call average lie.
 */
export async function usageByStage(sinceDays: number | null = null): Promise<UsageRow[]> {
  const rows = await sql`
    select model, stage::text as stage,
           count(*)::int                       as calls,
           coalesce(sum(input_tokens), 0)::bigint       as input_tokens,
           coalesce(sum(output_tokens), 0)::bigint      as output_tokens,
           coalesce(sum(cache_read_tokens), 0)::bigint  as cache_read_tokens,
           coalesce(sum(cache_write_tokens), 0)::bigint as cache_write_tokens
    from stage_runs
    where status = 'ok'
      and ${sinceDays === null ? sql`true` : sql`started_at > now() - make_interval(days => ${sinceDays})`}
    group by model, stage
    order by sum(coalesce(output_tokens, 0)) desc`;
  return rows.map((r) => ({
    model: r.model ? String(r.model) : null,
    stage: String(r.stage),
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
  }));
}

export interface RequestUsageRow extends UsageRow {
  requestId: string;
  title: string;
  status: string;
  updatedAt: Date;
}

/** The most expensive recent requests, so a runaway one is visible. */
export async function usageByRequest(limit = 10): Promise<RequestUsageRow[]> {
  const rows = await sql`
    select r.id, r.status::text as status, r.updated_at,
           coalesce(nullif(r.title_hint, ''), left(r.raw_idea, 70)) as title,
           max(s.model)                                 as model,
           count(*)::int                                as calls,
           coalesce(sum(s.input_tokens), 0)::bigint        as input_tokens,
           coalesce(sum(s.output_tokens), 0)::bigint       as output_tokens,
           coalesce(sum(s.cache_read_tokens), 0)::bigint   as cache_read_tokens,
           coalesce(sum(s.cache_write_tokens), 0)::bigint  as cache_write_tokens
    from stage_runs s
    join content_requests r on r.id = s.request_id
    where s.status = 'ok' and r.deleted_at is null
    group by r.id
    order by sum(coalesce(s.output_tokens, 0)) desc
    limit ${limit}`;
  return rows.map((r) => ({
    requestId: String(r.id),
    title: String(r.title ?? ''),
    status: String(r.status),
    updatedAt: new Date(String(r.updated_at)),
    stage: 'all',
    model: r.model ? String(r.model) : null,
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
  }));
}

/** How many requests the spend is spread across, for a per-request average. */
export async function countRequestsWithUsage(): Promise<number> {
  const [row] = await sql`
    select count(distinct request_id)::int as n from stage_runs where status = 'ok'`;
  return Number(row!.n);
}

/**
 * Wipe a request back to a freshly audited draft.
 *
 * Everything the pipeline produced is DELETED — sources and their excerpts,
 * the plan, every article option and every draft of it, claims, citations,
 * evaluations, channel assets, publications, reviews, and the stage runs that
 * made them. What survives is the intake the person typed and the audit
 * verdict on it, so the request is exactly what it was the moment before
 * research first ran.
 *
 * This deliberately breaks the append-only guarantee, which is worth being
 * plain about. `article_versions`, `reviews` and `evaluations` reject DELETE
 * by trigger so that "which text was approved, and by whom" outlives anyone
 * tidying up; sql/09-reset.sql opens a hole for this one operation, scoped to
 * a single transaction. The trade is deliberate: a reset request should look
 * new, not look new while carrying the last run's drafts underneath.
 *
 * Two things still survive it, on purpose:
 *   • `events` — the narrative log, including the reset itself and a count of
 *     what it removed. It is the only remaining answer to "where did the
 *     previous run go", and it holds no generated content.
 *   • Anything already published. Refused outright, because nothing here can
 *     unpublish a post that has gone out.
 *
 * One transaction, so a failure part-way leaves the request as it was rather
 * than half-erased.
 */
export async function resetRequest(
  id: string,
  _actor: string,
): Promise<{ request: ContentRequestRow; deleted: Record<string, number> }> {
  const current = await getRequest(id);
  if (!current) throw new ConflictError('That request no longer exists.');

  if (current.status === 'published') {
    throw new ConflictError(
      'This has already been published, and resetting cannot unpublish it. Create a new request instead.',
    );
  }

  // The status check above is not enough on its own. A request only becomes
  // 'published' once EVERY channel has gone out (see syncPublishStatus), so
  // one with X already posted and the newsletter still queued sits at
  // 'queued' — and a reset would then delete the row recording that the X
  // post went live, along with who a sent newsletter reached. Deleting the
  // evidence of something that is out in the world is not a reset.
  const [sent] = await sql`
    select count(*)::int as n, string_agg(distinct channel::text, ', ') as channels
    from publications where request_id = ${id} and state = 'published'`;
  if (Number(sent!.n) > 0) {
    throw new ConflictError(
      `Already published to ${sent!.channels}. Resetting would delete the record of that, ` +
        'and cannot unpublish it. Create a new request instead.',
    );
  }

  if (lockIsLive(current)) {
    throw new ConflictError(
      `The pipeline is running right now (started by ${current.pipeline_lock_by ?? 'someone'}). Wait for it to finish or stall.`,
    );
  }

  return sql.begin(async (tx) => {
    // Transaction-local: this dies with the transaction and cannot leak onto
    // the next query to borrow this pooled connection.
    await tx`select set_config('app.resetting', 'on', true)`;

    // The request points AT content that is about to go. Null the references
    // first, or the deletes below hit a foreign key that is still in use.
    await tx`
      update content_requests set
        selected_article_id = null, approved_version_id = null,
        approved_content_hash = null, approved_at = null, reviewer_id = null
      where id = ${id}`;

    // Deleted leaf-first. Several of these would cascade anyway, but doing it
    // explicitly means the counts below are real rather than whatever the
    // database happened to take with it.
    const counts: Record<string, number> = {};
    const wipe = async (label: string, run: Promise<readonly unknown[]>) => {
      counts[label] = (await run).length;
    };

    await wipe('publications', tx`delete from publications where request_id = ${id} returning id`);
    await wipe('channel_assets', tx`delete from channel_assets where request_id = ${id} returning id`);
    await wipe(
      'claim_citations',
      tx`delete from claim_citations c using article_claims ac, article_versions av, articles a
         where c.claim_id = ac.id and ac.version_id = av.id and av.article_id = a.id
           and a.request_id = ${id} returning c.claim_id`,
    );
    await wipe(
      'article_claims',
      tx`delete from article_claims ac using article_versions av, articles a
         where ac.version_id = av.id and av.article_id = a.id and a.request_id = ${id}
         returning ac.id`,
    );
    await wipe(
      'article_version_sources',
      tx`delete from article_version_sources vs using article_versions av, articles a
         where vs.version_id = av.id and av.article_id = a.id and a.request_id = ${id}
         returning vs.version_id`,
    );
    await wipe(
      'evaluation_scores',
      tx`delete from evaluation_scores es using evaluations e, article_versions av, articles a
         where es.evaluation_id = e.id and e.version_id = av.id and av.article_id = a.id
           and a.request_id = ${id} returning es.evaluation_id`,
    );
    await wipe(
      'evaluations',
      tx`delete from evaluations e using article_versions av, articles a
         where e.version_id = av.id and av.article_id = a.id and a.request_id = ${id}
         returning e.id`,
    );
    await wipe('reviews', tx`delete from reviews where request_id = ${id} returning id`);

    // An article points at its own current version, so that has to let go
    // before the versions can be removed.
    await tx`update articles set current_version_id = null where request_id = ${id}`;
    await wipe(
      'article_versions',
      tx`delete from article_versions av using articles a
         where av.article_id = a.id and a.request_id = ${id} returning av.id`,
    );
    await wipe('articles', tx`delete from articles where request_id = ${id} returning id`);
    await wipe('content_plans', tx`delete from content_plans where request_id = ${id} returning id`);
    await wipe(
      'source_excerpts',
      tx`delete from source_excerpts e using sources s
         where e.source_id = s.id and s.request_id = ${id} returning e.id`,
    );
    await wipe('sources', tx`delete from sources where request_id = ${id} returning id`);
    // Last: everything above referenced these.
    await wipe('stage_runs', tx`delete from stage_runs where request_id = ${id} returning id`);

    const rows = await tx`
      update content_requests set
        status = 'draft',
        revision_round = 0,
        failed_stage = null,
        failed_reason = null,
        pipeline_lock_at = null,
        pipeline_lock_by = null,
        pipeline_heartbeat_at = null,
        version = version + 1
      where id = ${id} and status <> 'published'
      returning *`;
    if (!rows.length) throw new ConflictError('That request could not be reset.');

    return {
      request: ContentRequestRow.parse(rows[0]),
      deleted: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0)),
    };
  });
}


/**
 * Claim ONE publication for immediate release.
 *
 * The same conditional-UPDATE claim the cron worker uses, narrowed to a single
 * row: `state in ('queued','scheduled')` is the guard, so a row the worker has
 * already taken returns nothing here and the button reports "already going
 * out" rather than sending it a second time.
 *
 * Note it ignores `scheduled_for`. That is the point of Publish now — the
 * schedule is what you are overriding.
 */
export async function claimPublicationNow(id: string): Promise<PublicationRow | null> {
  const rows = await sql`
    update publications set
      state = 'publishing', locked_at = now(), attempts = attempts + 1
    where id = ${id} and state in ('queued','scheduled')
    returning *`;
  return rows.length ? PublicationRow.parse(rows[0]) : null;
}

/** One publication with the request it belongs to, for permission checks. */
export async function getPublication(id: string) {
  const rows = await sql`select * from publications where id = ${id}`;
  return rows.length ? PublicationRow.parse(rows[0]) : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The public article — the one page with no sign-in
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The address a published article is readable at, minted on first use.
 *
 * 128 bits of randomness, base64url. Not the request id: that is handed out in
 * internal URLs all day and would let anyone holding one read the article —
 * and, worse, let them guess neighbours. This token exists only for requests
 * that have been approved, so unapproved work has no public address at all.
 */
export async function ensurePublicToken(requestId: string): Promise<string | null> {
  const rows = await sql`
    update content_requests
    set public_token = coalesce(public_token, encode(gen_random_bytes(16), 'base64'))
    where id = ${requestId} and approved_version_id is not null
    returning public_token`;
  if (!rows.length) return null;
  // base64 from Postgres, made URL-safe here rather than in SQL so the
  // alphabet is obvious at the point it matters.
  const raw = String(rows[0]!.public_token);
  const safe = raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (safe !== raw) {
    await sql`update content_requests set public_token = ${safe} where id = ${requestId}`;
  }
  return safe;
}

export interface PublicArticle {
  requestId: string;
  title: string;
  dek: string;
  bodyMd: string;
  versionId: string;
  wordCount: number;
  publishedAt: Date | null;
}

/**
 * The article behind a public token.
 *
 * Returns the APPROVED version and nothing else — no options, no evaluations,
 * no sources, no author. The page it feeds is the only unauthenticated surface
 * in the app, so the query is the boundary: what it does not select cannot be
 * rendered by mistake.
 */
export async function getPublicArticle(token: string): Promise<PublicArticle | null> {
  const rows = await sql`
    select r.id as request_id, av.id as version_id, av.title, av.dek, av.body_md,
           av.word_count, r.approved_at
    from content_requests r
    join article_versions av on av.id = r.approved_version_id
    where r.public_token = ${token} and r.deleted_at is null`;
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    requestId: String(r.request_id),
    versionId: String(r.version_id),
    title: String(r.title),
    dek: String(r.dek ?? ''),
    bodyMd: String(r.body_md),
    wordCount: Number(r.word_count ?? 0),
    publishedAt: r.approved_at ? new Date(String(r.approved_at)) : null,
  };
}

/**
 * Count a read, at most once per reader per day.
 *
 * The unique index does the deduplication, so a refresh is not a reader and
 * two people behind one office NAT are one reader — imperfect, and honest
 * about it, which beats a number inflated by every reload.
 */
export async function recordArticleView(v: {
  requestId: string;
  versionId: string;
  visitorDay: string;
  referrer: string | null;
}): Promise<void> {
  await sql`
    insert into article_views (request_id, version_id, visitor_day, referrer)
    values (${v.requestId}, ${v.versionId}, ${v.visitorDay}, ${v.referrer})
    on conflict (request_id, visitor_day) do nothing`;
}

export interface ViewStats {
  total: number;
  last7: number;
  lastViewedAt: Date | null;
}

export async function articleViewStats(requestId: string): Promise<ViewStats> {
  const [row] = await sql`
    select count(*)::int as total,
           count(*) filter (where viewed_at > now() - interval '7 days')::int as last7,
           max(viewed_at) as last_viewed
    from article_views where request_id = ${requestId}`;
  return {
    total: Number(row!.total),
    last7: Number(row!.last7),
    lastViewedAt: row!.last_viewed ? new Date(String(row!.last_viewed)) : null,
  };
}
