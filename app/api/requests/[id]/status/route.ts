import { NextRequest, NextResponse } from 'next/server';
import { requireUser, canViewRequest } from '@/lib/auth';
import { getRequest, getStageRuns, workInFlight } from '@/lib/queries';
import { nextStage, progressOf } from '@/lib/pipeline';
import { errorResponse } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/requests/:id/status — what the page polls while the pipeline runs.
 *
 * Deliberately small: two queries, no article bodies, no evaluations. It is
 * hit every few seconds by any open tab, so it answers only "where is this
 * and is anything actually happening", and the page does a full reload of the
 * real data when the answer changes.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    // Three remote round trips — the auth check and two queries — run
    // together rather than in sequence. They were sequential, and against a
    // database in another region that is most of this route's latency; the
    // page polls it, so it is also the most frequently paid latency in the
    // app. Nothing here depends on anything else here.
    const [user, row, runs] = await Promise.all([
      requireUser(),
      getRequest(id),
      getStageRuns(id),
    ]);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canViewRequest(user, row)) {
      return NextResponse.json({ error: 'Not yours.' }, { status: 403 });
    }

    const last = runs[runs.length - 1] ?? null;
    const running = workInFlight(row);

    return NextResponse.json({
      status: row.status,
      version: row.version,
      progress: progressOf(row.status),
      // Whether a driver currently owns this, which is a different question
      // from the status: 'generating' with no live lock means a run died
      // partway and nothing is working on it right now.
      running,
      runningSince: running ? row.pipeline_lock_at?.toISOString() : null,
      nextStage: nextStage(row),
      needsReview: row.status === 'awaiting_review',
      failedStage: row.failed_stage,
      failedReason: row.failed_reason,
      revisionRound: row.revision_round,
      maxRevisionRounds: row.max_revision_rounds,
      lastRun: last
        ? {
            stage: last.stage,
            attempt: last.attempt,
            status: last.status,
            startedAt: last.started_at.toISOString(),
            finishedAt: last.finished_at?.toISOString() ?? null,
            error: last.error,
          }
        : null,
      // Every stage attempt so far, so the page can show the run as a list
      // rather than a single spinner.
      stages: runs.map((r) => ({
        stage: r.stage,
        attempt: r.attempt,
        status: r.status,
        seconds: r.duration_ms !== null ? Math.round(r.duration_ms / 1000) : null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
