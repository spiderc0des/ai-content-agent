import { NextRequest, NextResponse } from 'next/server';
import { requireUser, canRunPipeline } from '@/lib/auth';
import { getRequest, resetRequest } from '@/lib/queries';
import { errorResponse, withEventLog } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/requests/:id/reset — put a request back to draft so it can run again.
 *
 * Gated on canRunPipeline, the same rule that governs starting one: if you can
 * run this request, you can reset it. That is the author or an admin — not
 * admin-only, and not anyone who merely has the link.
 *
 * Deliberately does not start the pipeline afterwards. Reset is often reached
 * for because something went wrong, and the useful next step is sometimes to
 * edit the intake rather than immediately spend another run's worth of calls.
 *
 * This DELETES the previous run — see resetRequest. The event it writes is
 * what is left of it.
 */
export async function POST(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser('creator');
    const row = await getRequest(id);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (!canRunPipeline(user, row)) {
      return NextResponse.json(
        { error: 'Only the author (or an admin) can reset this request.' },
        { status: 403 },
      );
    }

    const result = await withEventLog(
      id,
      user.email,
      'request_reset',
      () => resetRequest(id, user.email),
      {
        successDetail: (r) => ({
          from_status: row.status,
          approval_revoked: Boolean(row.approved_version_id),
          // What was removed, by table. `events` survives the reset, so this
          // is the only remaining answer to "where did the previous run go".
          deleted: r.deleted,
        }),
      },
    );

    return NextResponse.json({
      ok: true,
      status: result.request.status,
      version: result.request.version,
      deleted: result.deleted,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
