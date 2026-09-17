import { NextRequest, NextResponse } from 'next/server';
import { requireUser, canRunPipeline } from '@/lib/auth';
import { getRequest } from '@/lib/queries';
import { runPackaging } from '@/lib/pipeline';
import { errorResponse, withEventLog } from '@/lib/api-helpers';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** POST /api/requests/:id/package — produce the LinkedIn, X, and newsletter assets. */
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
      return NextResponse.json({ error: 'Only the author (or an admin) can package this.' }, { status: 403 });
    }
    if (!row.approved_version_id) {
      return NextResponse.json(
        { error: 'Nothing has been approved yet. Channel assets are only made from approved content.' },
        { status: 409 },
      );
    }

    const result = await withEventLog(id, user.email, 'package', async () => runPackaging(row), {
      stage: 'packaging',
    });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
