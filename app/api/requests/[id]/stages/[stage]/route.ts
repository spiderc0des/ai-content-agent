import { NextRequest, NextResponse } from 'next/server';
import { requireUser, canRunPipeline, isPipelineRunnable } from '@/lib/auth';
import { getRequest, lockIsLive } from '@/lib/queries';
import { STAGE_RUNNERS, runRevision, type RunnableStage } from '@/lib/pipeline';
import { errorResponse, withEventLog } from '@/lib/api-helpers';
import type { PipelineStage } from '@/lib/db-schemas';

/**
 * Long enough for a research run with eight searches, or three article
 * generations in parallel. Each stage is its own request precisely so that no
 * single one has to fit the whole pipeline into one timeout.
 */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const RUNNABLE = new Set([...Object.keys(STAGE_RUNNERS), 'revision']);

/** POST /api/requests/:id/stages/:stage — run exactly one pipeline stage. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; stage: string }> },
) {
  const { id, stage } = await params;
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
    if (!RUNNABLE.has(stage)) {
      return NextResponse.json({ error: `Unknown stage '${stage}'.` }, { status: 400 });
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

    const result = await withEventLog(
      id,
      user.email,
      `run_${stage}`,
      async () =>
        stage === 'revision'
          ? runRevision(row, { actor: user.email, createdBy: user.id })
          : STAGE_RUNNERS[stage as RunnableStage](row),
      { stage: stage as PipelineStage, successDetail: (r) => ({ ok: r.ok, status: r.status }) },
    );

    // A stage that failed is a 200 with ok:false, not an HTTP error: the run
    // itself completed and produced a diagnosable record. The client renders
    // the message and offers a retry; an HTTP 500 would suggest the request
    // never reached the server.
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
