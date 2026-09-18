import { describe, it, expect } from 'vitest';
import { RUN_BUDGET_MS, STAGE_RESERVE_MS, reserveFor } from '../lib/pipeline';

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

  it('refuses to start a stage it cannot finish — the exact stall that happened', () => {
    const elapsed = (6 + 164 + 66) * 1000; // audit + research + retrieval, measured
    expect(elapsed).toBeLessThan(RUN_BUDGET_MS); // the old check said "carry on"
    expect(wouldStart(elapsed, 'selection')).toBe(false); // the new one does not
  });

  it('still starts a stage when there is genuinely room', () => {
    expect(wouldStart(30_000, 'planning')).toBe(true);
  });

  it('reserves at least as long as each stage is known to take', () => {
    // Averages measured from this system's own stage_runs. A reserve below the
    // average means the driver expects to be killed half the time.
    const measuredAvgMs = {
      audit: 8_000,
      research: 244_000,
      retrieval: 80_000,
      selection: 92_000,
      planning: 48_000,
      generation: 99_000,
      evaluation: 89_000,
      revision: 165_000,
      packaging: 58_000,
    };
    for (const [stage, avg] of Object.entries(measuredAvgMs)) {
      expect(reserveFor(stage), stage).toBeGreaterThanOrEqual(avg);
    }
  });

  it('assumes the worst for a stage it has never heard of', () => {
    // A stage added later must not default to "plenty of time".
    expect(reserveFor('some_new_stage')).toBeGreaterThanOrEqual(
      Math.max(...Object.values(STAGE_RESERVE_MS)),
    );
  });

  it('lets the first stage of a slice run however long it needs', () => {
    // research reserves more than the whole budget, so it can only ever run as
    // the first stage of a slice — which is correct, and is why the check is
    // guarded by `stagesRun > 0`. Without that guard a fresh slice whose next
    // stage is research would hand off forever and never do any work.
    expect(reserveFor('research')).toBeGreaterThan(RUN_BUDGET_MS);
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
