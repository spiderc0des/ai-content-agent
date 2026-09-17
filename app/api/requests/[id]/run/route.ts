import { NextRequest, NextResponse } from 'next/server';
import { requireUser, canRunPipeline, isPipelineRunnable } from '@/lib/auth';
import { getRequest, lockIsLive } from '@/lib/queries';
import { nextStage, STAGE_RUNNERS, runRevision, type RunnableStage } from '@/lib/pipeline';
import { errorResponse, withEventLog } from '@/lib/api-helpers';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/requests/:id/run — run whichever stage is next.
 *
 * The client calls this in a loop, one stage per request, until it gets back
 * `next: null` (the pipeline is waiting on a human or is finished) or a
 * failure. That keeps every stage inside its own timeout budget and makes the
 * progress visible as it happens, rather than after five minutes of nothing.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const user = await requireUser('creator');
    const row = await getRequest(id);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canRunPipeline(user, row)) {
      return NextResponse.json(
        { error: 'Only the author (or an admin) can run this pipeline.' },
        { status: 403 },
      );
    }
    if (!isPipelineRunnable(row)) {
      return NextResponse.json(
        { error: `This request is '${row.status}'. The pipeline cannot be run from there.` },
        { status: 409 },
      );
    }

    // Refuse to run a stage by hand while a driver owns this request. These
    // endpoints exist for debugging and targeted retries; running one against
    // a request that a driver is already advancing is how two pipelines end up
    // working over the same rows, which has happened and cost real money.
    if (lockIsLive(row)) {
      return NextResponse.json(
        {
          error: `The pipeline is already running (started by ${row.pipeline_lock_by ?? 'someone'}). Wait for it to finish, or let it fail out.`,
        },
        { status: 409 },
      );
    }

    const stage = nextStage(row);
    if (!stage) {
      return NextResponse.json({
        stage: null,
        ok: true,
        status: row.status,
        message:
          row.status === 'blocked'
            ? 'This request is blocked. Edit the idea and resubmit.'
            : 'Nothing to run — this request is waiting on a person.',
        next: null,
      });
    }

    const result = await withEventLog(id, user.email, `run_${stage}`, async () =>
      stage === 'revision'
        ? runRevision(row, { actor: user.email, createdBy: user.id })
        : STAGE_RUNNERS[stage as RunnableStage](row),
    );

    const after = await getRequest(id);
    return NextResponse.json({
      ...result,
      next: result.ok && after ? nextStage(after) : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
