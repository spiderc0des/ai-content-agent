import postgres from 'postgres';
import { describe, it, expect, afterAll, vi } from 'vitest';

/**
 * Every test here makes several round trips to a database in another region,
 * and vitest's 5-second default is too tight for that — these have failed on
 * latency alone, reporting a slow network as a broken query. A generous
 * ceiling costs a passing run nothing.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A real-database regression test — the one kind a unit test cannot be.
 *
 * `npm test` is otherwise fully offline (see README / TEST_EVIDENCE — no
 * API key, no network, no database). This file is the deliberate exception,
 * and it exists for a specific reason: a JS-driver serialization bug is
 * invisible to every layer that doesn't touch the real driver.
 *
 * What happened: `insertExcerpts()` pre-serialized `locator` with
 * `JSON.stringify()` before handing it to postgres.js's bulk `sql(array,
 * ...cols)` insert helper. That helper already serializes plain objects for
 * jsonb columns on its own — so the pre-stringified value got serialized a
 * SECOND time, and Postgres stored a jsonb STRING containing escaped JSON
 * text instead of the object. The insert never errored (a quoted string is
 * valid JSON), so this only surfaced later, as a ZodError, at read time, in
 * unrelated application code (`SourceExcerptRow.parse` expecting a record).
 * 82 mock-backed unit tests and the full scenario harness ran green through
 * all of it, because none of them touch postgres.js at all.
 *
 * This test calls the real `insertExcerpts()` — the exact function and code
 * path that broke — against a live Postgres, and asserts the round trip
 * comes back as an object. Skipped automatically when DATABASE_URL is the
 * shipped placeholder or unset, so a fresh clone with only `.env.example`
 * copied over still gets a full green `npm test`.
 */

const DB_URL = process.env.DATABASE_URL ?? '';
const hasRealDatabase = DB_URL.length > 0 && !DB_URL.includes('placeholder');

describe.skipIf(!hasRealDatabase)('insertExcerpts against a real database', () => {
  const cleanup: (() => Promise<void>)[] = [];

  afterAll(async () => {
    // Reverse order: content_requests cascades sources and source_excerpts
    // away on delete, but app_users has nothing cascading into it.
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  });

  it('round-trips a jsonb locator as an object, not a JSON-encoded string', async () => {
    const { sql } = await import('../lib/db');
    const { createRequest, upsertSource, insertExcerpts, getExcerpts } = await import(
      '../lib/queries'
    );

    const userId = crypto.randomUUID();
    await sql`
      insert into app_users (id, email, full_name, is_creator, active)
      values (${userId}, ${`test-${userId}@example.invalid`}, 'Integration Test', true, true)`;
    cleanup.push(() => sql`delete from app_users where id = ${userId}`.then(() => {}));

    const request = await createRequest({
      raw_idea: 'an integration test request',
      target_audience: 'testers',
      source_url: null,
      supporting_notes: '',
      title_hint: '',
      primary_keyword: '',
      secondary_keywords: [],
      desired_tone: '',
      word_count_target: null,
      channels_wanted: ['x'],
      option_count: 1,
    research_depth: 'standard' as const,
      deadline_at: null,
      intake_hash: 'integration-test-hash',
      author_id: userId,
    });
    // content_requests → sources → source_excerpts all cascade from here.
    cleanup.push(() => sql`delete from content_requests where id = ${request.id}`.then(() => {}));

    const source = await upsertSource({
      requestId: request.id,
      kind: 'web',
      url: 'https://example.invalid/integration-test',
      title: 'An integration test source',
      discoveredBy: null,
    });

    const locator = {
      type: 'char_location',
      cited_text: 'the exact quoted sentence',
      start_char_index: 0,
      end_char_index: 26,
    };

    await insertExcerpts(request.id, source.id, [
      { quote: 'the exact quoted sentence', gist: 'why it matters', locator },
    ]);

    // The regression manifested here: SourceExcerptRow.parse() (inside
    // getExcerpts) threw a ZodError because `locator` came back as a string.
    const excerpts = await getExcerpts(request.id);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].locator).toEqual(locator);

    // And directly, so a future regression names itself precisely rather
    // than surfacing as "some Zod error somewhere".
    const [{ kind }] = await sql<{ kind: string }[]>`
      select jsonb_typeof(locator) as kind from source_excerpts where source_id = ${source.id}`;
    expect(kind).toBe('object');
  });
});

describe.skipIf(!hasRealDatabase)('startAutoRevision against a real database', () => {
  const cleanup: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  });

  /**
   * The companion regression to the one above, and the one that actually
   * caused a live request to cycle evaluate → revise → evaluate → revise
   * for over an hour: nextAfterEvaluation() (lib/permissions.ts) decides
   * correctly, but nothing was incrementing revision_round on the machine
   * path, so its "budget left" check read 0 forever. test/permissions.test.ts
   * proves the decision logic terminates in isolation; this proves the
   * write that is supposed to make that true in the database actually does.
   */
  it('spends one unit of the revision budget per call, atomically with the status move', async () => {
    const { sql } = await import('../lib/db');
    const { createRequest, startAutoRevision, ConflictError } = await import('../lib/queries');

    const userId = crypto.randomUUID();
    await sql`
      insert into app_users (id, email, full_name, is_creator, active)
      values (${userId}, ${`test-${userId}@example.invalid`}, 'Integration Test', true, true)`;
    cleanup.push(() => sql`delete from app_users where id = ${userId}`.then(() => {}));

    const request = await createRequest({
      raw_idea: 'a revision budget integration test',
      target_audience: 'testers',
      source_url: null,
      supporting_notes: '',
      title_hint: '',
      primary_keyword: '',
      secondary_keywords: [],
      desired_tone: '',
      word_count_target: null,
      channels_wanted: ['x'],
      option_count: 1,
    research_depth: 'standard' as const,
      deadline_at: null,
      intake_hash: 'integration-test-revision-budget',
      author_id: userId,
    });
    cleanup.push(() => sql`delete from content_requests where id = ${request.id}`.then(() => {}));

    // startAutoRevision only fires from 'evaluating' — createRequest starts
    // a request at 'draft', so put it where runEvaluation would find it.
    await sql`update content_requests set status = 'evaluating' where id = ${request.id}`;

    const afterFirst = await startAutoRevision(request.id);
    expect(afterFirst.status).toBe('revising');
    expect(afterFirst.revision_round).toBe(1);

    // The real loop re-evaluates before revising again — simulate that
    // status hop rather than calling startAutoRevision twice from
    // 'revising', which its own WHERE clause correctly refuses.
    await sql`update content_requests set status = 'evaluating' where id = ${request.id}`;
    const afterSecond = await startAutoRevision(request.id);
    expect(afterSecond.revision_round).toBe(2);

    // And the WHERE clause is the actual guard, not just a convention:
    // calling it again from 'revising' (not 'evaluating') is refused rather
    // than silently spending a third round.
    await expect(startAutoRevision(request.id)).rejects.toThrow(ConflictError);

    const [{ revision_round }] = await sql<{ revision_round: number }[]>`
      select revision_round from content_requests where id = ${request.id}`;
    expect(revision_round).toBe(2);
  });
});

describe.skipIf(!hasRealDatabase)('the pipeline lock', () => {
  const cleanup: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  });

  /**
   * The regression this guards: two clicks seven seconds apart started two
   * pipelines over the same request. Both spent ~9 minutes of real Claude
   * calls doing identical work, and the loser then died on a status
   * transition the winner had already made — marking the whole request
   * failed. Nothing in the code prevented a second run from starting.
   */
  it('lets exactly one driver claim a request, and releases cleanly', async () => {
    const { sql } = await import('../lib/db');
    const { createRequest, claimPipelineLock, releasePipelineLock, lockIsLive, getRequest } =
      await import('../lib/queries');

    const userId = crypto.randomUUID();
    await sql`
      insert into app_users (id, email, full_name, is_creator, active)
      values (${userId}, ${`test-${userId}@example.invalid`}, 'Lock Test', true, true)`;
    cleanup.push(() => sql`delete from app_users where id = ${userId}`.then(() => {}));

    const request = await createRequest({
      raw_idea: 'a pipeline lock integration test',
      target_audience: 'testers',
      source_url: null,
      supporting_notes: '',
      title_hint: '',
      primary_keyword: '',
      secondary_keywords: [],
      desired_tone: '',
      word_count_target: null,
      channels_wanted: ['x'],
      option_count: 1,
    research_depth: 'standard' as const,
      deadline_at: null,
      intake_hash: 'lock-test',
      author_id: userId,
    });
    cleanup.push(() => sql`delete from content_requests where id = ${request.id}`.then(() => {}));

    const first = await claimPipelineLock(request.id, 'driver-one');
    expect(first).not.toBeNull();
    expect(first!.pipeline_lock_by).toBe('driver-one');

    // The whole point: a second claim while the first is live gets nothing.
    const second = await claimPipelineLock(request.id, 'driver-two');
    expect(second).toBeNull();

    const held = await getRequest(request.id);
    expect(lockIsLive(held!)).toBe(true);
    expect(held!.pipeline_lock_by).toBe('driver-one');

    await releasePipelineLock(request.id);
    const freed = await getRequest(request.id);
    expect(lockIsLive(freed!)).toBe(false);

    // And once released, the next driver can take it.
    const third = await claimPipelineLock(request.id, 'driver-three');
    expect(third).not.toBeNull();
    expect(third!.pipeline_lock_by).toBe('driver-three');
    await releasePipelineLock(request.id);
  });

  it('reclaims a lock whose driver died, but not one that is merely slow', async () => {
    const { sql } = await import('../lib/db');
    const { createRequest, claimPipelineLock, releasePipelineLock } = await import('../lib/queries');

    const userId = crypto.randomUUID();
    await sql`
      insert into app_users (id, email, full_name, is_creator, active)
      values (${userId}, ${`test-${userId}@example.invalid`}, 'Stale Lock Test', true, true)`;
    cleanup.push(() => sql`delete from app_users where id = ${userId}`.then(() => {}));

    const request = await createRequest({
      raw_idea: 'a stale lock integration test',
      target_audience: 'testers',
      source_url: null,
      supporting_notes: '',
      title_hint: '',
      primary_keyword: '',
      secondary_keywords: [],
      desired_tone: '',
      word_count_target: null,
      channels_wanted: ['x'],
      option_count: 1,
    research_depth: 'standard' as const,
      deadline_at: null,
      intake_hash: 'stale-lock-test',
      author_id: userId,
    });
    cleanup.push(() => sql`delete from content_requests where id = ${request.id}`.then(() => {}));

    await claimPipelineLock(request.id, 'driver-that-will-die');

    // A heartbeat from five minutes ago: slow, not dead. A stage can
    // legitimately run this long, so taking it would restart live work.
    await sql`
      update content_requests set pipeline_heartbeat_at = now() - interval '5 minutes'
      where id = ${request.id}`;
    expect(await claimPipelineLock(request.id, 'impatient')).toBeNull();

    // Half an hour: the driver is gone. This is what the resume cron relies on.
    await sql`
      update content_requests set pipeline_heartbeat_at = now() - interval '30 minutes'
      where id = ${request.id}`;
    const reclaimed = await claimPipelineLock(request.id, 'cron:resume');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.pipeline_lock_by).toBe('cron:resume');

    await releasePipelineLock(request.id);
  });

  /**
   * advanceStatus exists because setStatus threw on a transition that had
   * already happened, which turned a harmless race into a failed request.
   */
  it('advanceStatus treats already-being-at-the-target as success', async () => {
    const { sql } = await import('../lib/db');
    const { createRequest, advanceStatus, ConflictError } = await import('../lib/queries');

    const userId = crypto.randomUUID();
    await sql`
      insert into app_users (id, email, full_name, is_creator, active)
      values (${userId}, ${`test-${userId}@example.invalid`}, 'Advance Test', true, true)`;
    cleanup.push(() => sql`delete from app_users where id = ${userId}`.then(() => {}));

    const request = await createRequest({
      raw_idea: 'an advanceStatus integration test',
      target_audience: 'testers',
      source_url: null,
      supporting_notes: '',
      title_hint: '',
      primary_keyword: '',
      secondary_keywords: [],
      desired_tone: '',
      word_count_target: null,
      channels_wanted: ['x'],
      option_count: 1,
    research_depth: 'standard' as const,
      deadline_at: null,
      intake_hash: 'advance-test',
      author_id: userId,
    });
    cleanup.push(() => sql`delete from content_requests where id = ${request.id}`.then(() => {}));

    await sql`update content_requests set status = 'revising' where id = ${request.id}`;

    const once = await advanceStatus(request.id, 'evaluating', ['revising']);
    expect(once.status).toBe('evaluating');

    // The second caller — the one that used to take the request down with it.
    const twice = await advanceStatus(request.id, 'evaluating', ['revising']);
    expect(twice.status).toBe('evaluating');

    // Still strict about genuinely wrong transitions, though.
    await expect(advanceStatus(request.id, 'ready', ['packaging'])).rejects.toThrow(ConflictError);
  });
});

/**
 * The append-only guarantee, and the single hole reset opens in it.
 *
 * sql/09-reset.sql lets reset DELETE from three otherwise-immutable tables so
 * a restarted request looks genuinely new. That is a real weakening of the
 * property this schema is built around, so the exact shape of the hole is
 * asserted rather than assumed — a later edit to those trigger functions that
 * widened it would otherwise pass every other test in the suite.
 *
 * Four properties, all of which must hold:
 *   1. Without the flag, nothing can be deleted or updated.
 *   2. With it, DELETE is permitted — that is what reset needs.
 *   3. With it, UPDATE is STILL refused. Prose is never rewritten in place;
 *      reset removes rows, it does not alter them.
 *   4. `events` is never deletable, flag or no flag. The narrative log
 *      outlives the content it describes, including the reset itself.
 */
describe.skipIf(!hasRealDatabase)('append-only triggers and the reset hole', () => {
  const sql = postgres(DB_URL, { prepare: false });
  afterAll(async () => { await sql.end(); });

  /** Runs `body` against a real row and always rolls back. */
  const attempt = async (body: (tx: postgres.TransactionSql) => Promise<unknown>) => {
    try {
      await sql.begin(async (tx) => {
        await body(tx);
        throw new Error('__rollback__');
      });
      return { allowed: true, message: '' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return message === '__rollback__'
        ? { allowed: true, message: '' }
        : { allowed: false, message };
    }
  };

  const setFlag = (tx: postgres.TransactionSql) =>
    tx`select set_config('app.resetting', 'on', true)`;

  it('refuses every delete and update when no reset is in progress', async () => {
    const [version] = await sql`select id from article_versions limit 1`;
    const [event] = await sql`select id from events limit 1`;
    if (!version || !event) return;

    // A real row id, or the row-level trigger never fires and the test passes
    // for the wrong reason.
    const del = await attempt((tx) => tx`delete from article_versions where id = ${version.id}`);
    expect(del.allowed, del.message).toBe(false);
    expect(del.message).toContain('append-only');

    const upd = await attempt(
      (tx) => tx`update article_versions set title = 'x' where id = ${version.id}`,
    );
    expect(upd.allowed).toBe(false);

    const ev = await attempt((tx) => tx`delete from events where id = ${event.id}`);
    expect(ev.allowed).toBe(false);
  });

  it('permits delete during a reset, but never update', async () => {
    const [evaluation] = await sql`select id from evaluations limit 1`;
    const [version] = await sql`select id from article_versions limit 1`;
    if (!evaluation || !version) return;

    const del = await attempt(async (tx) => {
      await setFlag(tx);
      await tx`delete from evaluations where id = ${evaluation.id}`;
    });
    expect(del.allowed, del.message).toBe(true);

    // The line that matters most: the hole is DELETE-only.
    const upd = await attempt(async (tx) => {
      await setFlag(tx);
      await tx`update article_versions set title = 'x' where id = ${version.id}`;
    });
    expect(upd.allowed).toBe(false);
    expect(upd.message).toContain('append-only');
  });

  it('never lets the narrative log be deleted, reset or not', async () => {
    const [event] = await sql`select id from events limit 1`;
    if (!event) return;
    const ev = await attempt(async (tx) => {
      await setFlag(tx);
      await tx`delete from events where id = ${event.id}`;
    });
    expect(ev.allowed).toBe(false);
    expect(ev.message).toContain('append-only');
  });

  it('does not leak the flag past its own transaction', async () => {
    const [version] = await sql`select id from article_versions limit 1`;
    if (!version) return;
    // set_config(..., true) is transaction-local. If it were session-local it
    // would stay set on a pooled connection and silently disarm the trigger
    // for whatever query borrowed that connection next.
    await sql.begin(async (tx) => {
      await setFlag(tx);
    });
    const after = await attempt((tx) => tx`delete from article_versions where id = ${version.id}`);
    expect(after.allowed).toBe(false);
    expect(after.message).toContain('append-only');
  });
});
