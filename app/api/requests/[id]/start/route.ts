import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { requireUser, canRunPipeline, isPipelineRunnable } from '@/lib/auth';
import { getRequest, claimPipelineLock, lockIsLive } from '@/lib/queries';
import { nextStage } from '@/lib/pipeline';
import { driveAndContinue } from '@/lib/continue-run';
import { errorResponse } from '@/lib/api-helpers';

// The response returns in milliseconds; the work carries on behind it via
// after(). maxDuration is what bounds that background work, not the response.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/requests/:id/start — the one button.
 *
 * Claims the pipeline lock, answers immediately, and runs every machine stage
 * server-side until the request needs a person. The client polls
 * GET /api/requests/:id/status for progress; it is not responsible for
 * advancing anything.
 *
 * This replaces a loop that used to live in the browser, doing one fetch per
 * stage. That design made the pipeline only as reliable as a single tab
 * staying open and connected for a quarter of an hour — and it wasn't. Every
 * "stuck" report in this project was the same thing: the server finishing a
 * stage correctly and the tab never asking for the next one.
 *
 * The lock is claimed HERE rather than inside the driver so that a second
 * click gets an honest "already running" instead of starting a duplicate run.
 * That happened for real: two clicks seven seconds apart ran two pipelines
 * over the same request, spent about nine minutes of duplicate Claude calls
 * each, and the loser then marked the whole request failed on a status
 * transition it had already lost.
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
    if (!nextStage(row)) {
      return NextResponse.json(
        {
          started: false,
          status: row.status,
          message:
            row.status === 'awaiting_review'
              ? 'This is already waiting for your review.'
              : `Nothing to run from '${row.status}'.`,
        },
        { status: 200 },
      );
    }

    const claimed = await claimPipelineLock(id, user.email);
    if (!claimed) {
      const holder = await getRequest(id);
      return NextResponse.json(
        {
          started: false,
          status: holder?.status ?? row.status,
          message:
            holder && lockIsLive(holder)
              ? `Already running (started by ${holder.pipeline_lock_by ?? 'someone'}).`
              : 'Already running.',
        },
        { status: 409 },
      );
    }

    // Runs after the response is flushed. The client gets its 202 in
    // milliseconds and starts polling; the pipeline keeps going regardless of
    // what the browser does next — closing the tab no longer stops it.
    after(async () => {
      // Drives, and hands off to itself if the platform's function limit cuts
      // the run short — see lib/continue-run.ts. A full pipeline is longer
      // than any single function is allowed to live.
      await driveAndContinue(id, user.email, 0, new URL(request.url).origin);
    });

    return NextResponse.json(
      {
        started: true,
        status: 'running',
        message: 'Running. This takes several minutes; you can close this tab.',
      },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
