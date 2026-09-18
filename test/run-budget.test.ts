import { describe, it, expect } from 'vitest';
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

  it('reserves for research by depth, since depth is what sets its length', () => {
    expect(reserveFor('research', 'quick')).toBeLessThan(reserveFor('research', 'standard'));
    expect(reserveFor('research', 'standard')).toBeLessThanOrEqual(reserveFor('research', 'deep'));
    // Quick research has to be able to follow the audit in the same slice.
    expect(20_000 + reserveFor('research', 'quick')).toBeLessThanOrEqual(RUN_BUDGET_MS);
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
