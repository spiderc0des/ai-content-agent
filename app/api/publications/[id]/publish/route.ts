import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { claimPublicationNow, getPublication, syncPublishStatus } from '@/lib/queries';
import { releasePublication } from '@/lib/release';
import { errorResponse } from '@/lib/api-helpers';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

/**
 * POST /api/publications/:id/publish — send it now, without waiting.
 *
 * The queue exists because releasing on a schedule is the normal case. This is
 * the override, and it matters more than it would on a paid plan: the worker
 * runs every half hour at best here, so "queued" can mean a half-hour wait for
 * something a person is watching.
 *
 * It runs the SAME path the worker does (lib/release.ts) — a second
 * implementation would be one that forgets to record recipients, or leaves a
 * claimed row stuck in 'publishing'.
 *
 * Concurrency is the claim, not a check-then-act: claimPublicationNow flips
 * the row to 'publishing' only from 'queued' or 'scheduled', in one statement.
 * A row the worker took a moment ago returns nothing here, and this answers
 * "already going out" rather than sending it twice.
 */
export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser('publisher');

    const existing = await getPublication(id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (existing.state === 'published') {
      return NextResponse.json({ error: 'This has already gone out.' }, { status: 409 });
    }
    if (existing.state === 'canceled') {
      return NextResponse.json(
        { error: 'This was cancelled. Queue it again from the request.' },
        { status: 409 },
      );
    }

    const claimed = await claimPublicationNow(id);
    if (!claimed) {
      return NextResponse.json(
        { error: 'It is already being released — the worker got there first.' },
        { status: 409 },
      );
    }

    const outcome = await releasePublication(claimed, user.email);
    await syncPublishStatus(claimed.request_id).catch(() => {});

    if (!outcome.ok) {
      // A 200 with ok:false, not a 500: the release genuinely ran and the row
      // records what happened. The queue will show it as failed either way,
      // and the reason is more useful than a status code.
      return NextResponse.json({ ok: false, error: outcome.error }, { status: 200 });
    }

    return NextResponse.json({
      ok: true,
      channel: outcome.channel,
      note: outcome.note,
      externalUrl: outcome.externalUrl,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
