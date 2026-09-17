import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { listEmailGroups, createEmailGroup } from '@/lib/queries';
import { errorResponse, withEventLog } from '@/lib/api-helpers';
import { requiredText, optionalText, firstIssue } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: requiredText('A name for the group', 2, 80),
  description: optionalText(300),
});

/**
 * GET is open to any active user; POST is admin-only.
 *
 * Deliberately different: a publisher has to be able to SEE the lists to pick
 * one when queueing a newsletter, but deciding who is on a list is an admin's
 * job. Reading a group name is not the same privilege as editing one.
 */
export async function GET() {
  try {
    await requireUser();
    return NextResponse.json({ groups: await listEmailGroups(true) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUser();
    if (!user.is_admin) {
      return NextResponse.json({ error: 'Only an admin can create groups.' }, { status: 403 });
    }
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    }

    const group = await withEventLog(
      null,
      user.email,
      'email_group_created',
      () =>
        createEmailGroup({
          name: parsed.data.name,
          description: parsed.data.description ?? '',
          createdBy: user.id,
        }),
      { successDetail: (g) => ({ group_id: g.id, name: g.name }) },
    );

    return NextResponse.json({ group }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
