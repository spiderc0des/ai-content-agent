import { describe, it, expect, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const DB_URL = process.env.DATABASE_URL ?? '';
const hasRealDatabase = DB_URL.length > 0 && !DB_URL.includes('placeholder');

/**
 * A driver may only touch the lock it actually holds.
 *
 * releasePipelineLock used to release on id alone, and that one missing
 * clause produced a lock-stealing cascade: a driver that hung long enough to
 * be superseded would, on finally returning, strip the lock from the driver
 * that had legitimately taken over. That driver then worked unlocked, so a
 * third could claim the same request — and a late arrival failed a run that
 * four stages of healthy work had gone into.
 */
describe.skipIf(!hasRealDatabase)('lock ownership against a real database', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  });

  async function aRequest() {
    const { sql } = await import('../lib/db');
    const q = await import('../lib/queries');
    const userId = crypto.randomUUID();
    await sql`insert into app_users (id, email, full_name, is_creator, active)
      values (${userId}, ${`lock-${userId}@example.invalid`}, 'Lock Test', true, true)`;
    cleanup.push(() => sql`delete from app_users where id = ${userId}`.then(() => {}));
    const request = await q.createRequest({
      raw_idea: 'a lock ownership test', target_audience: 'testers', source_url: null,
      supporting_notes: '', title_hint: '', primary_keyword: '', secondary_keywords: [],
      desired_tone: '', word_count_target: null, channels_wanted: ['x'], option_count: 1,
      research_depth: 'standard' as const, deadline_at: null,
      intake_hash: `lock-${userId}`, author_id: userId,
    });
    cleanup.push(() => sql`delete from content_requests where id = ${request.id}`.then(() => {}));
    return { request, q, sql };
  }

  it('refuses to let a superseded driver release the new owner’s lock', async () => {
    const { request, q, sql } = await aRequest();

    // Driver A claims, then hangs long enough to go stale.
    expect(await q.claimPipelineLock(request.id, 'driver-A')).not.toBeNull();
    await sql`update content_requests set pipeline_heartbeat_at = now() - interval '10 minutes'
      where id = ${request.id}`;

    // Driver B legitimately takes over.
    const b = await q.claimPipelineLock(request.id, 'driver-B');
    expect(b).not.toBeNull();
    expect(b!.pipeline_lock_by).toBe('driver-B');

    // Driver A finally returns and runs its finally block. It must not strip B.
    expect(await q.releasePipelineLock(request.id, 'driver-A')).toBe(false);

    const [after] = await sql`select pipeline_lock_by from content_requests where id = ${request.id}`;
    expect(after.pipeline_lock_by).toBe('driver-B');
  });

  it('tells a superseded driver it has lost the lock, via the heartbeat', async () => {
    const { request, q } = await aRequest();

    expect(await q.claimPipelineLock(request.id, 'driver-A')).not.toBeNull();
    expect(await q.heartbeatPipelineLock(request.id, 'driver-A')).toBe(true);

    // Someone else now holds it.
    const { sql } = await import('../lib/db');
    await sql`update content_requests set pipeline_lock_by = 'driver-B' where id = ${request.id}`;

    // A's heartbeat is how it finds out — nothing else would tell it.
    expect(await q.heartbeatPipelineLock(request.id, 'driver-A')).toBe(false);
  });

  it('still lets the rightful owner release its own lock', async () => {
    const { request, q, sql } = await aRequest();
    expect(await q.claimPipelineLock(request.id, 'driver-A')).not.toBeNull();
    expect(await q.releasePipelineLock(request.id, 'driver-A')).toBe(true);
    const [after] = await sql`select pipeline_lock_by from content_requests where id = ${request.id}`;
    expect(after.pipeline_lock_by).toBeNull();
  });
});

/**
 * Source-level companions to the database tests above: the call sites must
 * actually pass an owner, or the ownership clause never runs.
 */
describe('every lock operation names its owner', () => {
  const PIPELINE = readFileSync(join(process.cwd(), 'lib', 'pipeline.ts'), 'utf8');
  const CONTINUE = readFileSync(join(process.cwd(), 'lib', 'continue-run.ts'), 'utf8');
  const ROUTE = readFileSync(
    join(process.cwd(), 'app', 'api', 'requests', '[id]', 'continue', 'route.ts'),
    'utf8',
  );

  it('releases and heartbeats with the lock owner, never bare', () => {
    for (const call of PIPELINE.match(/releasePipelineLock\([^)]*\)/g) ?? []) {
      expect(call, 'a bare release can strip another driver’s lock').toContain('lockOwner');
    }
    for (const call of PIPELINE.match(/heartbeatPipelineLock\([^)]*\)/g) ?? []) {
      expect(call, 'a bare heartbeat refreshes a lock that may not be ours').toContain('lockOwner');
    }
  });

  it('carries the owner from the route that claims under a different name', () => {
    // The continue endpoint claims as `continue:hop-N` but drives as
    // `pipeline`. Assuming those matched is what made the driver operate on a
    // lock that was never its own.
    expect(ROUTE).toContain('const lockOwner = `continue:hop-${hop}`');
    expect(ROUTE).toMatch(/driveAndContinue\(id, 'pipeline', hop, origin, lockOwner\)/);
    expect(CONTINUE).toMatch(/drivePipeline\(requestId, actor, lockOwner \?\? actor\)/);
  });

  it('stops driving the moment the heartbeat says the lock is gone', () => {
    expect(PIPELINE).toMatch(/superseded = true/);
    expect(PIPELINE).toMatch(/stoppedBecause: 'lock_lost'/);
  });
});

/**
 * The other half of the same bug. The ConflictError path covers a superseded
 * driver whose status WRITE is rejected; this covers a superseded driver
 * whose Claude call simply failed on its own terms, which never touches a
 * status transition and so was never caught by it.
 */
describe.skipIf(!hasRealDatabase)('failing a stage cannot fail somebody else’s run', () => {
  it('refuses to fail a request that has moved past this stage', async () => {
    const { sql } = await import('../lib/db');
    const q = await import('../lib/queries');

    const userId = crypto.randomUUID();
    await sql`insert into app_users (id, email, full_name, is_creator, active)
      values (${userId}, ${`fail-${userId}@example.invalid`}, 'Fail Test', true, true)`;
    const request = await q.createRequest({
      raw_idea: 'a late failure test', target_audience: 'testers', source_url: null,
      supporting_notes: '', title_hint: '', primary_keyword: '', secondary_keywords: [],
      desired_tone: '', word_count_target: null, channels_wanted: ['x'], option_count: 1,
      research_depth: 'standard' as const, deadline_at: null,
      intake_hash: `fail-${userId}`, author_id: userId,
    });

    try {
      // A second driver has carried this well past research.
      await sql`update content_requests set status = 'generating' where id = ${request.id}`;

      // The abandoned research call finally fails. It must not touch this.
      expect(await q.markStageFailed(request.id, 'research', 'a late failure')).toBe(false);
      const [after] = await sql`select status from content_requests where id = ${request.id}`;
      expect(after.status).toBe('generating');

      // And a stage failing on the request it IS working on still works.
      expect(await q.markStageFailed(request.id, 'generation', 'a real failure')).toBe(true);
      const [failed] = await sql`select status, failed_stage from content_requests where id = ${request.id}`;
      expect(failed.status).toBe('failed');
      expect(failed.failed_stage).toBe('generation');
    } finally {
      await sql`delete from content_requests where id = ${request.id}`;
      await sql`delete from app_users where id = ${userId}`;
    }
  });
});
