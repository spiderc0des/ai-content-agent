import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { IntakeSchema } from '@/lib/schemas';
import { createRequest, listRequests } from '@/lib/queries';
import { runAudit } from '@/lib/pipeline';
import { errorResponse, withEventLog } from '@/lib/api-helpers';
import { hashObject } from '@/lib/hash';

export const maxDuration = 60;

/**
 * POST /api/requests — create a content request and audit it immediately.
 *
 * The audit runs here rather than as a separate click because it is cheap and
 * it is the only thing standing between a one-line idea and an expensive
 * research run. A 'blocked' verdict comes back in this response so the form
 * can show the clarifying questions instead of navigating away.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUser('creator');
    const intake = IntakeSchema.parse(await request.json());

    const created = await withEventLog(null, user.email, 'create_request', async () =>
      createRequest({
        ...intake,
        intake_hash: hashObject({ ...intake, secondary_keywords: intake.secondary_keywords.join(',') , channels_wanted: intake.channels_wanted.join(',') }),
        author_id: user.id,
      }),
    );

    const audit = await runAudit(created);

    return NextResponse.json(
      { id: created.id, status: audit.status, audit },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET() {
  try {
    const user = await requireUser();
    // A reviewer or publisher needs to see everything; a creator sees theirs.
    const mine = !(user.is_reviewer || user.is_publisher || user.is_admin);
    const rows = await listRequests(mine ? { authorId: user.id } : {});
    return NextResponse.json({ requests: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
