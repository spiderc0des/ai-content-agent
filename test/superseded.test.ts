import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PIPELINE = readFileSync(join(process.cwd(), 'lib', 'pipeline.ts'), 'utf8');

/**
 * A driver that has been superseded stands down. It does not fail the request.
 *
 * What happened: a research call hung for nearly five minutes, its lock was
 * reclaimed, and a second driver carried the request through research,
 * retrieval, selection, planning and generation. Then the original call
 * finally returned, tried to advance 'researching' → 'retrieving', found the
 * request at 'evaluating', and marked the whole healthy run failed. The next
 * stage failed too, because the request it was working on had just been
 * failed underneath it.
 *
 * A ConflictError on a status transition means somebody else moved this
 * request on. A driver with no standing to move it has no standing to fail it.
 */
describe('a superseded driver stands down', () => {
  it('has one place that decides what superseded means', () => {
    expect(PIPELINE).toContain('async function standDown(');
    const at = PIPELINE.indexOf('async function standDown(');
    const body = PIPELINE.slice(at, at + 1400);
    expect(body).toContain('ConflictError');
    // It records its own attempt, so the stage is visible in the log...
    expect(body).toContain('finishStageRun');
    expect(body).toContain('stage_superseded');
    // ...but never touches the request's status.
    expect(body).not.toContain('markStageFailed');
  });

  it('guards every stage-level failure path, not just one', () => {
    // Five stages catch their own errors and fail the request independently.
    // Missing one leaves exactly the bug this fixes.
    const guards = PIPELINE.match(/const superseded = await standDown\(/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(5);

    // And each guard must come BEFORE the call that fails the request.
    let from = 0;
    for (let i = 0; i < guards.length; i++) {
      const g = PIPELINE.indexOf('const superseded = await standDown(', from);
      const fail = PIPELINE.indexOf('markStageFailed', g);
      expect(g, `guard ${i + 1}`).toBeGreaterThan(-1);
      expect(fail - g, `guard ${i + 1} must precede markStageFailed`).toBeGreaterThan(0);
      expect(fail - g).toBeLessThan(600);
      from = g + 1;
    }
  });

  it('returns the request to the status it actually has', () => {
    // Reporting 'failed' would be the same lie in a different place.
    const at = PIPELINE.indexOf('async function standDown(');
    const body = PIPELINE.slice(at, at + 1400);
    expect(body).toContain('status: request.status');
  });
});

/**
 * The pipeline panel must not contradict itself.
 *
 * `running` is a claim a stage row makes, not a fact: the row says so until
 * something finishes it, and a driver that died never gets to. The stage list
 * checks the lock before saying "running"; the "Last activity" line did not.
 * The same panel could read "research — stopped, no driver" on one line and
 * "research is running, started just now" on the next.
 */
describe('the pipeline panel agrees with itself', () => {
  const WORKSPACE = readFileSync(join(process.cwd(), 'app', 'r', '[id]', 'Workspace.tsx'), 'utf8');

  it('asks whether a driver is alive before calling a stage running', () => {
    const at = WORKSPACE.indexOf('function statusWord(');
    expect(at).toBeGreaterThan(-1);
    const body = WORKSPACE.slice(at, at + 400);
    expect(body).toMatch(/driverAlive/);
    // Both branches exist: it must be able to say a stage stopped.
    expect(body).toMatch(/stopped/);
  });

  it('passes the live-driver flag in at the call site', () => {
    expect(WORKSPACE).toMatch(/statusWord\(request\.lastRun\.status,\s*running\)/);
  });
});
