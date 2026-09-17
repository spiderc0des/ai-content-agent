import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { cronEnabled } from '@/lib/env';
import { isAuthorisedCronRequest } from '@/lib/cron-auth';
import { findStalledPipelines, claimPipelineLock, logEvent } from '@/lib/queries';
import { drivePipeline } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/resume — restart pipelines whose driver died.
 *
 * A driver can be killed mid-run by something that has nothing to do with the
 * request: the dev server reloading on a file save, a deploy, a process
 * restart. When that happens the request is left in a machine status
 * ('retrieving', 'generating', …) with no one working on it, and nothing
 * would ever notice — which is precisely how a request in this project sat at
 * 'retrieving' for eight hours with a completed research stage behind it.
 *
 * Re-running a stage is safe by construction: every stage records a fresh
 * attempt in stage_runs rather than overwriting, and the end-of-stage
 * transitions tolerate already being at their target (advanceStatus). So the
 * worst case of resuming something that was actually fine is one duplicated
 * stage, not a corrupted request.
 */
export async function GET(request: NextRequest) {
  if (!cronEnabled) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not set, so the resume worker refuses to run.' },
      { status: 503 },
    );
  }
  if (!isAuthorisedCronRequest(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const stalled = await findStalledPipelines(5);
  const resumed: string[] = [];

  for (const row of stalled) {
    const claimed = await claimPipelineLock(row.id, 'cron:resume');
    if (!claimed) continue; // someone else got there first — leave it alone

    resumed.push(row.id);
    await logEvent({
      requestId: row.id,
      actor: 'cron:resume',
      step: 'resume_stalled_pipeline',
      ok: true,
      detail: { status: row.status, stalled_since: row.pipeline_heartbeat_at?.toISOString() ?? null },
    }).catch(() => {});

    after(async () => {
      await drivePipeline(row.id, 'cron:resume');
    });
  }

  return NextResponse.json({ stalled: stalled.length, resumed: resumed.length, ids: resumed });
}
