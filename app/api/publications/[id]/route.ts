import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { cancelPublication, syncPublishStatus } from '@/lib/queries';
import { errorResponse, withEventLog } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

/** DELETE /api/publications/:id — cancel something before it goes out. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const user = await requireUser('publisher');
    const reason = request.nextUrl.searchParams.get('reason') || 'cancelled by a publisher';

    const publication = await cancelPublication(id, reason);
    await withEventLog(publication.request_id, user.email, 'cancel_publication', async () =>
      syncPublishStatus(publication.request_id),
    );

    return NextResponse.json({ publication });
  } catch (err) {
    return errorResponse(err);
  }
}
