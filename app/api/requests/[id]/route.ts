import { NextRequest, NextResponse } from 'next/server';
import { requireUser, canRunPipeline } from '@/lib/auth';
import { getRequest, softDeleteRequest, lockIsLive } from '@/lib/queries';
import { errorResponse, withEventLog } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/requests/:id — remove a request from the lists.
 *
 * A SOFT delete: it sets deleted_at and nothing else. Nothing is actually
 * removed, on purpose. `events`, `reviews`, `article_versions` and
 * `evaluations` are all append-only by database trigger, and a hard delete
 * would either fail against them or take the audit trail with it — and the
 * audit trail is the thing that makes "who approved this, and what exactly
 * did they approve" answerable later. A published post is a real artefact in
 * the world; the record of how it got there should outlive someone tidying
 * up their list.
 *
 * Two things it refuses, both because deleting them would be a lie:
 *
 *   · anything already published — it exists on a channel whether or not the
 *     row is hidden, so hiding the row just loses the trail to it
 *   · anything the pipeline is actively working on — the driver would carry
 *     on spending money on a request the person believes is gone
 */
export async function DELETE(
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
        { error: 'Only the author (or an admin) can delete this request.' },
        { status: 403 },
      );
    }

    if (row.status === 'published') {
      return NextResponse.json(
        {
          error:
            'This has already been published. Hiding the request would not unpublish anything — it would only lose the record of how it got there.',
        },
        { status: 409 },
      );
    }

    if (lockIsLive(row)) {
      return NextResponse.json(
        {
          error: `The pipeline is still running on this request (started by ${row.pipeline_lock_by ?? 'someone'}). Wait for it to finish, then delete it.`,
        },
        { status: 409 },
      );
    }

    await withEventLog(id, user.email, 'delete_request', async () => {
      await softDeleteRequest(id);
      return { deleted: true };
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
