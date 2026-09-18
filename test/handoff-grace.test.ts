import { describe, it, expect } from 'vitest';
import { workInFlight, lockIsLive } from '../lib/queries';

/**
 * A hand-off between slices is not a stall.
 *
 * The finishing driver releases its lock, calls the continue endpoint, and the
 * next driver claims it. Measured on live runs that gap is two to three
 * seconds — and the page polls every five, so a poll landing inside it saw no
 * lock and offered "Resume" for work that was already carrying on.
 *
 * Observed in the log:
 *   14:07:15  drive_planning
 *   14:07:18  pipeline_handoff   (+3s)
 *   14:07:18  drive_started      (+0s)
 *
 * The pipeline was right and the indicator was wrong, which is the worse way
 * round: it teaches people to disbelieve the one signal that tells them when
 * something has genuinely stopped.
 */
describe('a hand-off does not read as a stall', () => {
  const seconds = (n: number) => new Date(Date.now() - n * 1000);

  it('still reports work in flight during the gap between slices', () => {
    const midHandoff = {
      status: 'generating',
      pipeline_lock_at: null,
      pipeline_heartbeat_at: null,
      updated_at: seconds(3),
    };
    // No lock is held — correct, and the right answer for "may a new driver
    // start" — but the wrong answer for "is anything happening".
    expect(lockIsLive(midHandoff)).toBe(false);
    expect(workInFlight(midHandoff)).toBe(true);
  });

  it('reports a genuine stall once the grace has passed', () => {
    expect(
      workInFlight({
        status: 'generating',
        pipeline_lock_at: null,
        pipeline_heartbeat_at: null,
        updated_at: seconds(120),
      }),
    ).toBe(false);
  });

  it('does not extend the grace to statuses waiting on a person', () => {
    // awaiting_review has no driver by design. Showing it as running would be
    // a different lie in the same place.
    expect(
      workInFlight({
        status: 'awaiting_review',
        pipeline_lock_at: null,
        pipeline_heartbeat_at: null,
        updated_at: seconds(1),
      }),
    ).toBe(false);
  });

  it('reports a live lock as in flight regardless of the grace', () => {
    const now = new Date();
    expect(
      workInFlight({
        status: 'revising',
        pipeline_lock_at: now,
        pipeline_heartbeat_at: now,
        updated_at: seconds(600),
      }),
    ).toBe(true);
  });
});
