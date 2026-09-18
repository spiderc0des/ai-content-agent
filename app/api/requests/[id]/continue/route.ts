import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { cronEnabled } from '@/lib/env';
import { isAuthorisedCronRequest } from '@/lib/cron-auth';
import { claimPipelineLock, getRequest, lockIsLive } from '@/lib/queries';
import { nextStage } from '@/lib/pipeline';
import { driveAndContinue, HOP_HEADER } from '@/lib/continue-run';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/requests/:id/continue — pick up a run that ran out of time.
 *
 * Called by the app itself, never by a browser. A pipeline takes about
 * thirteen minutes and a function is killed at five, so a run hands off to
 * this endpoint to carry on, and this one hands off again if it has to. That
 * is what makes the pipeline finish without a cron or an open tab.
 *
 * Authenticated with CRON_SECRET, the same bearer the scheduled worker uses:
 * this starts paid work, so it is not something to leave open.
 *
 * Answers immediately and drives in `after()`, exactly like /start — so the
 * calling slice is not held open for the length of this one, which would
 * defeat the point of splitting them.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!cronEnabled) {
    return NextResponse.json({ error: 'CRON_SECRET is not set.' }, { status: 503 });
  }
  if (!isAuthorisedCronRequest(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const hop = Number(request.headers.get(HOP_HEADER) ?? 0) || 0;
  // The chain keeps calling the origin it is already being served on.
  const origin = new URL(request.url).origin;

  const row = await getRequest(id);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Nothing left to do, or something else is already doing it. Both are
  // normal ends to a chain rather than errors.
  if (!nextStage(row)) {
    return NextResponse.json({ continued: false, reason: `nothing to run from '${row.status}'` });
  }
  if (lockIsLive(row)) {
    return NextResponse.json({ continued: false, reason: 'another driver already has it' });
  }

  const lockOwner = `continue:hop-${hop}`;
  const claimed = await claimPipelineLock(id, lockOwner);
  if (!claimed) {
    return NextResponse.json({ continued: false, reason: 'another driver claimed it first' });
  }

  after(async () => {
    await driveAndContinue(id, 'pipeline', hop, origin, lockOwner);
  });

  return NextResponse.json({ continued: true, hop }, { status: 202 });
}
