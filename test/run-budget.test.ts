import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_BUDGET_MS, STAGE_RESERVE_MS, RESEARCH_RESERVE_MS, reserveFor } from '../lib/pipeline';

/**
 * The driver has to stop between stages, never inside one.
 *
 * This is a regression test for a real stall. A request ran audit (6s),
 * research (164s) and retrieval (66s) — 236 seconds of a 240-second budget —
 * and the check, which asked only "have I run over?", said no. So the driver
 * started selection with four seconds left. The platform killed the function
 * mid-call, and because the process was gone it never reached the code that
 * records an outcome or hands off:
 *
 *   - the stage row said `running` for 17 minutes and counting
 *   - the lock stayed held, so nothing else could take over
 *   - no hand-off was made, so the chain that was supposed to make this
 *     self-healing never fired
 *
 * None of that shows up as an error. The pipeline view cheerfully reported
 * "selection — running…". Stopping one stage early costs one extra hop;
 * being killed mid-stage costs the stage, the lock, and the chain.
 */
describe('the run budget reserves time for the stage it is about to start', () => {
  /** The check as drivePipeline performs it. */
  const wouldStart = (elapsedMs: number, stage: string) =>
    elapsedMs + reserveFor(stage) <= RUN_BUDGET_MS;

  it('refuses to start a stage it cannot finish', () => {
    // 236s of a 270s budget, then a stage that needs 90. No room.
    expect(wouldStart(236_000, 'selection')).toBe(false);
  });

  it('fits a whole quick run into a handful of slices', () => {
    // The reserves were first set near each stage's maximum, which made the
    // arithmetic self-defeating: nothing fitted beside anything, so a run of
    // nine stages spent a hand-off on each and exhausted its hop budget with
    // seven minutes of work done. Replaying a real run's measured timings, a
    // slice must now carry several stages.
    const run: [string, number][] = [
      ['audit', 4], ['research', 44], ['retrieval', 57], ['selection', 53],
      ['planning', 39], ['generation', 66], ['evaluation', 55], ['revision', 99],
      ['evaluation', 55],
    ];
    let slices = 1;
    let elapsed = 0;
    let stagesInSlice = 0;
    for (const [stage, secs] of run) {
      if (stagesInSlice > 0 && elapsed + reserveFor(stage, 'quick') > RUN_BUDGET_MS) {
        slices++;
        elapsed = 0;
        stagesInSlice = 0;
      }
      elapsed += secs * 1000;
      stagesInSlice++;
    }
    // Slices minus the first one are hand-offs, and MAX_HOPS is 3.
    expect(slices - 1).toBeLessThanOrEqual(3);
  });

  it('still starts a stage when there is genuinely room', () => {
    expect(wouldStart(30_000, 'planning')).toBe(true);
  });

  it('reserves more than each stage typically takes', () => {
    // p50 from recent successful runs. A reserve below the median means the
    // driver expects to be killed more often than not; far above it means
    // nothing ever shares a slice. These sit between, at roughly p75.
    const measuredP50Ms = {
      audit: 6_000,
      retrieval: 58_000,
      selection: 57_000,
      planning: 48_000,
      generation: 76_000,
      evaluation: 65_000,
      revision: 118_000,
      packaging: 33_000,
    };
    for (const [stage, p50] of Object.entries(measuredP50Ms)) {
      expect(reserveFor(stage), stage).toBeGreaterThan(p50);
      // And not absurdly above it, which is the failure this replaced. A flat
      // floor alongside the ratio, because for a six-second stage like audit a
      // pure multiple is meaninglessly tight — 20s against 6s wastes nothing.
      expect(reserveFor(stage), stage).toBeLessThanOrEqual(Math.max(p50 * 3, p50 + 30_000));
    }
  });

  it('reserves research for the slow draw, at every depth', () => {
    // This used to assert that quick reserved less than standard, and that
    // quick research could follow the audit inside one slice. Both were wrong,
    // and the measurements say why: across quick runs doing identical work —
    // 6 sources, 4 readable, ~1,000 input tokens, ~4,000 output — the wall
    // clock ranged from 46s to 276s. Depth decides how much research READS and
    // WRITES; it does not decide how long the websites take to answer, and
    // that is what the clock is spent on.
    //
    // So research now owns its slice at any depth. Reserving too much costs a
    // hand-off; reserving too little costs the stage, its spend and the lock.
    for (const depth of ['quick', 'standard', 'deep']) {
      expect(reserveFor('research', depth), depth).toBeGreaterThanOrEqual(276_000);
    }
    expect(reserveFor('research', 'deep')).toBeGreaterThanOrEqual(reserveFor('research', 'standard'));
  });

  it('assumes the worst for a stage it has never heard of', () => {
    // A stage added later must not default to "plenty of time".
    expect(reserveFor('some_new_stage')).toBeGreaterThanOrEqual(
      Math.max(...Object.values(STAGE_RESERVE_MS), ...Object.values(RESEARCH_RESERVE_MS)),
    );
  });

  it('lets the first stage of a slice run however long it needs', () => {
    // Deep research reserves more than the whole budget, so at that depth it
    // can only ever run as the first stage of a slice — which is correct, and
    // is why the check is guarded by `stagesRun > 0`. Without that guard a
    // fresh slice whose next stage is research would hand off forever and
    // never do any work at all.
    expect(reserveFor('research', 'deep')).toBeGreaterThan(RUN_BUDGET_MS);
  });

  it('keeps the budget inside the platform limit, with room for an overrun', () => {
    // Vercel Hobby kills a function at 300s. A stage started at the last
    // permissible moment finishes at exactly RUN_BUDGET_MS if it takes its
    // reserve — so the gap between the budget and the platform limit is the
    // whole allowance for a stage running slower than its average. It has to
    // be a real margin, not a rounding error.
    const PLATFORM_LIMIT_MS = 300_000;
    const overrunAllowance = PLATFORM_LIMIT_MS - RUN_BUDGET_MS;
    expect(overrunAllowance).toBeGreaterThanOrEqual(30_000);
  });
});

/**
 * A heartbeat proves a PROCESS is alive. It does not prove the WORK is moving.
 *
 * Observed: a driver held the lock for 24 minutes, heartbeating every 20
 * seconds, having never written a stage row. The dev server had not been
 * restarted, no query was in flight, and every database call the stage makes
 * ran in under two seconds when tested directly. The run looked healthier than
 * one that had died, because a dead one at least goes quiet.
 *
 * So the heartbeat expires at the platform's own ceiling. Past 300 seconds a
 * drive either cannot exist (Vercel has killed the function) or is stuck
 * (locally, where nothing kills it) — either way it has stopped being evidence
 * of anything.
 */
describe('the heartbeat stops claiming a stuck drive is alive', () => {
  const PIPELINE = readFileSync(join(process.cwd(), 'lib', 'pipeline.ts'), 'utf8');

  it('expires at or before the platform function limit', () => {
    const m = /const MAX_DRIVE_MS = ([\d_]+);/.exec(PIPELINE);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ''))).toBeLessThanOrEqual(300_000);
  });

  it('gives a legitimate drive room to finish within its budget', () => {
    // The cap must never cut short a run that is behaving: the budget plus the
    // largest reserve a stage can overrun by still has to fit underneath it.
    const m = /const MAX_DRIVE_MS = ([\d_]+);/.exec(PIPELINE);
    expect(Number(m![1].replace(/_/g, ''))).toBeGreaterThan(RUN_BUDGET_MS);
  });

  it('checks the elapsed time inside the interval, not just at the start', () => {
    // Setting it once at drive time would not help: the whole failure is a
    // drive that never reaches the code that would clear it.
    const at = PIPELINE.indexOf('const heartbeat = setInterval');
    expect(at).toBeGreaterThan(-1);
    const body = PIPELINE.slice(at, at + 2600);
    expect(body).toContain('MAX_DRIVE_MS');
    expect(body).toContain('clearInterval(heartbeat)');
    // A wedged drive must let go of the lock, not merely go quiet — otherwise
    // it holds the request until a human notices.
    expect(body).toContain('releasePipelineLock');
    expect(body).toContain('drive_watchdog');
    // But only when nothing is actually in flight. Elapsed time alone fired
    // on a 657-second research call that was working perfectly.
    expect(body).toContain('hasRunningStage');
  });
});
