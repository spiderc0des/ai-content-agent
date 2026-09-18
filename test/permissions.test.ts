import { describe, it, expect } from 'vitest';
import {
  hasCapability,
  canViewRequest,
  canRunPipeline,
  canReview,
  capabilityLabel,
  checkReviewAction,
  checkQueueable,
  reviewTargetStatus,
  isPipelineRunnable,
  nextAfterEvaluation,
  shouldStopRepeating,
} from '../lib/permissions';
import type { AppUserRow } from '../lib/db-schemas';

const user = (over: Partial<AppUserRow> = {}) =>
  ({
    id: 'u1',
    email: 'a@b.c',
    full_name: '',
    is_creator: true,
    is_reviewer: false,
    is_publisher: false,
    is_admin: false,
    active: true,
    created_at: new Date(),
    invited_at: null,
    invited_by: null,
    first_signed_in_at: null,
    ...over,
  }) as AppUserRow;

describe('capabilities', () => {
  it('admin satisfies every capability', () => {
    const admin = user({ is_creator: false, is_admin: true });
    expect(hasCapability(admin, 'creator')).toBe(true);
    expect(hasCapability(admin, 'reviewer')).toBe(true);
    expect(hasCapability(admin, 'publisher')).toBe(true);
  });

  it('a capability the user lacks is refused', () => {
    expect(hasCapability(user(), 'reviewer')).toBe(false);
  });

  it('no requirement means anyone on the allowlist passes', () => {
    expect(hasCapability(user({ is_creator: false }))).toBe(true);
  });

  it('labels combinations', () => {
    expect(capabilityLabel(user({ is_reviewer: true }))).toBe('creator + reviewer');
    expect(capabilityLabel(user({ is_creator: false }))).toBe('no capabilities');
  });
});

describe('per-request access', () => {
  const request = { author_id: 'u1' };

  it('the author can view and run', () => {
    expect(canViewRequest(user(), request)).toBe(true);
    expect(canRunPipeline(user(), request)).toBe(true);
  });

  it('a reviewer can view someone else\'s request but not drive it', () => {
    const reviewer = user({ id: 'u2', is_creator: false, is_reviewer: true });
    expect(canViewRequest(reviewer, request)).toBe(true);
    expect(canRunPipeline(reviewer, request)).toBe(false);
  });

  it('an unrelated creator can do neither', () => {
    const other = user({ id: 'u2' });
    expect(canViewRequest(other, request)).toBe(false);
    expect(canRunPipeline(other, request)).toBe(false);
  });

  it('an admin can do both', () => {
    const admin = user({ id: 'u2', is_admin: true });
    expect(canViewRequest(admin, request)).toBe(true);
    expect(canRunPipeline(admin, request)).toBe(true);
  });
});

describe('the review gate', () => {
  const ok = {
    action: 'approve' as const,
    status: 'awaiting_review',
    hasSelectedArticle: true,
    hasVersion: true,
    note: '',
    instruction: '',
  };

  it('allows a complete approval at the gate', () => {
    expect(checkReviewAction(ok).ok).toBe(true);
  });

  it('refuses approval from anywhere else', () => {
    for (const status of ['draft', 'generating', 'evaluating', 'approved', 'ready', 'published']) {
      expect(checkReviewAction({ ...ok, status }).ok).toBe(false);
    }
  });

  it('allows a revise on a rejected request — the resubmit path', () => {
    expect(canReview({ status: 'rejected' }, 'revise')).toBe(true);
    expect(canReview({ status: 'rejected' }, 'approve')).toBe(false);
  });

  it('requires what each action needs', () => {
    expect(checkReviewAction({ ...ok, hasSelectedArticle: false }).ok).toBe(false);
    expect(checkReviewAction({ ...ok, hasVersion: false }).ok).toBe(false);
    expect(checkReviewAction({ ...ok, action: 'reject' }).ok).toBe(false);
    expect(checkReviewAction({ ...ok, action: 'reject', note: 'off topic' }).ok).toBe(true);
    expect(checkReviewAction({ ...ok, action: 'revise' }).ok).toBe(false);
    expect(checkReviewAction({ ...ok, action: 'revise', instruction: 'cut section 2' }).ok).toBe(true);
  });

  it('maps every action to a status', () => {
    expect(reviewTargetStatus('approve')).toBe('approved');
    expect(reviewTargetStatus('reject')).toBe('rejected');
    expect(reviewTargetStatus('revise')).toBe('revising');
    expect(reviewTargetStatus('select')).toBe('awaiting_review');
  });
});

describe('queue preconditions', () => {
  const ok = {
    status: 'ready',
    approvedVersionId: 'v1',
    assetVersionId: 'v1',
    assetRulesPass: true,
    alreadyLiveOnChannel: false,
  };

  it('allows an approved, rule-passing, unqueued asset', () => {
    expect(checkQueueable(ok).ok).toBe(true);
  });

  it('refuses without an approval', () => {
    expect(checkQueueable({ ...ok, approvedVersionId: null }).ok).toBe(false);
  });

  it('refuses an asset built from a different version', () => {
    expect(checkQueueable({ ...ok, assetVersionId: 'v2' }).ok).toBe(false);
  });

  it('refuses an asset that breaks its channel rules', () => {
    expect(checkQueueable({ ...ok, assetRulesPass: false }).ok).toBe(false);
  });

  it('refuses a duplicate on the same channel', () => {
    expect(checkQueueable({ ...ok, alreadyLiveOnChannel: true }).ok).toBe(false);
  });
});

describe('pipeline runnability', () => {
  it('blocks a published request from being re-run', () => {
    expect(isPipelineRunnable({ status: 'published' })).toBe(false);
    expect(isPipelineRunnable({ status: 'archived' })).toBe(false);
  });

  it('allows a run while approved, so the revoke-approval trigger can fire', () => {
    expect(isPipelineRunnable({ status: 'approved' })).toBe(true);
  });

  it('allows a retry after a failure', () => {
    expect(isPipelineRunnable({ status: 'failed' })).toBe(true);
  });
});

describe('the bounded auto-revision loop', () => {
  /**
   * A real production bug: nextAfterEvaluation's decision (lib/pipeline.ts)
   * was correct, but nothing ever incremented revisionRound on the machine
   * path — so budgetLeft was always true and the evaluate → revise →
   * evaluate → revise cycle never reached max_revision_rounds, never
   * escalated to a human, and never stopped. A live request cycled through
   * it for over an hour before this was caught, because the individual
   * stages all completed successfully — nothing failed, so nothing in the
   * unit or scenario suites (which check stage outcomes, not loop
   * termination) had a reason to catch it. This is what closes that gap.
   */
  it('keeps revising while budget remains and nothing passed', () => {
    expect(
      nextAfterEvaluation({ anyPassed: false, revisionRound: 0, maxRevisionRounds: 2 }),
    ).toBe('revising');
    expect(
      nextAfterEvaluation({ anyPassed: false, revisionRound: 1, maxRevisionRounds: 2 }),
    ).toBe('revising');
  });

  it('escalates to the human once the budget is spent, even with nothing passing', () => {
    expect(
      nextAfterEvaluation({ anyPassed: false, revisionRound: 2, maxRevisionRounds: 2 }),
    ).toBe('awaiting_review');
    // Never overshoots either — a round count past the cap is still refused,
    // not treated as "somehow still fine".
    expect(
      nextAfterEvaluation({ anyPassed: false, revisionRound: 5, maxRevisionRounds: 2 }),
    ).toBe('awaiting_review');
  });

  it('goes straight to the human the moment any option passes, budget or not', () => {
    expect(
      nextAfterEvaluation({ anyPassed: true, revisionRound: 0, maxRevisionRounds: 2 }),
    ).toBe('awaiting_review');
  });

  it('the loop terminates in at most maxRevisionRounds + 1 evaluations', () => {
    // Simulates the actual sequence runEvaluation drives: nothing ever
    // passes, and each 'revising' outcome is what spends the round (exactly
    // as startAutoRevision does in lib/queries.ts, atomically, only on this
    // branch) before the next evaluation is decided.
    const maxRevisionRounds = 2;
    let revisionRound = 0;
    let evaluations = 0;
    let outcome: 'revising' | 'awaiting_review';

    do {
      evaluations++;
      outcome = nextAfterEvaluation({ anyPassed: false, revisionRound, maxRevisionRounds });
      if (outcome === 'revising') revisionRound++;
    } while (outcome === 'revising' && evaluations < 100); // the 100 is a test-only safety net

    expect(outcome).toBe('awaiting_review');
    expect(evaluations).toBeLessThanOrEqual(maxRevisionRounds + 1);
    expect(evaluations).toBe(3); // round 0 → revise, round 1 → revise, round 2 → stop
  });
});

describe('the driver progress guard', () => {
  /**
   * The regression: packaging could not get the X post under 280 characters,
   * so it left the status at 'packaging'; nextStage() handed packaging
   * straight back; the driver regenerated EVERY channel each turn. One real
   * request ended up with 17 channel assets where 3 were wanted — eight X
   * posts — and every turn bumped the row version, which is what then broke
   * scheduling a publish with "this request changed while you were looking
   * at it".
   */
  const step = (
    stage: string,
    status: string,
    prev: { lastStage: string | null; lastStatus: string | null; repeats: number },
  ) => shouldStopRepeating({ stage, status, ...prev });

  it('allows one repeat — a retry is legitimate', () => {
    const first = step('packaging', 'packaging', { lastStage: null, lastStatus: null, repeats: 0 });
    expect(first.stop).toBe(false);

    const second = step('packaging', 'packaging', {
      lastStage: 'packaging',
      lastStatus: 'packaging',
      repeats: first.repeats,
    });
    expect(second.stop).toBe(false);
  });

  it('stops on the second repeat — that is a loop, not a retry', () => {
    let state = { lastStage: null as string | null, lastStatus: null as string | null, repeats: 0 };
    let stopped = false;

    for (let i = 0; i < 6; i++) {
      const r = step('packaging', 'packaging', state);
      if (r.stop) {
        stopped = true;
        expect(i).toBeLessThanOrEqual(2); // caught within three turns, not 24
        break;
      }
      state = { lastStage: 'packaging', lastStatus: 'packaging', repeats: r.repeats };
    }
    expect(stopped).toBe(true);
  });

  it('does not trip while the pipeline is actually progressing', () => {
    const sequence: [string, string][] = [
      ['research', 'researching'],
      ['retrieval', 'retrieving'],
      ['selection', 'selecting'],
      ['planning', 'planning'],
      ['generation', 'generating'],
      ['evaluation', 'evaluating'],
    ];
    let state = { lastStage: null as string | null, lastStatus: null as string | null, repeats: 0 };

    for (const [stage, status] of sequence) {
      const r = step(stage, status, state);
      expect(r.stop).toBe(false);
      state = { lastStage: stage, lastStatus: status, repeats: r.repeats };
    }
  });

  it('resets the count when the status moves, even on the same stage', () => {
    // evaluation → revising → evaluation is the normal revision loop: the same
    // stage recurs, but the status changes between, so it must not trip.
    let state = { lastStage: 'evaluation', lastStatus: 'evaluating', repeats: 1 };
    const moved = step('evaluation', 'revising', state);
    expect(moved.stop).toBe(false);
    expect(moved.repeats).toBe(0);
  });
});

/**
 * The revision loop is the most expensive thing in the pipeline: measured
 * across every completed run, evaluation and revision together were 52% of
 * all busy time, while research — the stage everyone assumes is the problem —
 * was 16%.
 *
 * It was also spending that time for very little. 53 of 55 evaluations came
 * back `revise`, so the loop ran to exhaustion on every single request and
 * the draft went to a human regardless. The rounds were never deciding the
 * destination, only how polished the draft was when it got there:
 *
 *   revision 1:  +0.40 average score, improved 19 of 19
 *   revision 2:  +0.13 average score, improved 10 of 16
 */
describe('nextAfterEvaluation — when to stop revising', () => {
  const base = { anyPassed: false, revisionRound: 1, maxRevisionRounds: 2 };

  it('always allows the first revision, with nothing to compare against yet', () => {
    expect(
      nextAfterEvaluation({ ...base, revisionRound: 0, bestScore: 3.4, previousBestScore: null }),
    ).toBe('revising');
  });

  it('keeps revising while the score is still climbing', () => {
    expect(nextAfterEvaluation({ ...base, bestScore: 3.8, previousBestScore: 3.4 })).toBe('revising');
  });

  it('stops when a revision produced no improvement', () => {
    // Another round costs a revision call and a re-evaluation to arrive at the
    // same place — a human reading it — with a draft that is no better.
    expect(nextAfterEvaluation({ ...base, bestScore: 3.6, previousBestScore: 3.6 })).toBe(
      'awaiting_review',
    );
  });

  it('stops when a revision made the draft worse', () => {
    expect(nextAfterEvaluation({ ...base, bestScore: 3.4, previousBestScore: 3.8 })).toBe(
      'awaiting_review',
    );
  });

  it('still goes straight to review the moment something passes', () => {
    expect(
      nextAfterEvaluation({ ...base, anyPassed: true, bestScore: 3.0, previousBestScore: 4.5 }),
    ).toBe('awaiting_review');
  });

  it('still honours a spent budget regardless of score movement', () => {
    expect(
      nextAfterEvaluation({
        ...base,
        revisionRound: 2,
        maxRevisionRounds: 2,
        bestScore: 4.9,
        previousBestScore: 3.0,
      }),
    ).toBe('awaiting_review');
  });
});
