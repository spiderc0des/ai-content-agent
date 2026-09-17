import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import {
  getEmailGroup,
  listGroupMembers,
  renameEmailGroup,
  archiveEmailGroup,
  restoreEmailGroup,
} from '@/lib/queries';
import { errorResponse, withEventLog } from '@/lib/api-helpers';
import { requiredText, optionalText, firstIssue } from '@/lib/validation';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: requiredText('A name for the group', 2, 80).optional(),
  description: optionalText(300),
  /** false archives (soft delete), true brings it back. */
  active: z.boolean().optional(),
});

export async function GET(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireUser();
    const group = await getEmailGroup(id);
    if (!group) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ group, members: await listGroupMembers(id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser();
    if (!user.is_admin) {
      return NextResponse.json({ error: 'Only an admin can change groups.' }, { status: 403 });
    }
    const existing = await getEmailGroup(id);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    }
    const { name, description, active } = parsed.data;

    const group = await withEventLog(
      null,
      user.email,
      active === false ? 'email_group_archived' : 'email_group_updated',
      async () => {
        if (active === false) return archiveEmailGroup(id);
        if (active === true) return restoreEmailGroup(id);
        return renameEmailGroup(id, name ?? existing.name, description ?? existing.description);
      },
      { successDetail: (g) => ({ group_id: g.id, name: g.name }) },
    );

    return NextResponse.json({ group });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE archives. There is no hard delete: publications point at a group by
 * id, and a send that already happened has to stay answerable for who it went
 * to. See archiveEmailGroup.
 */
export async function DELETE(_r: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser();
    if (!user.is_admin) {
      return NextResponse.json({ error: 'Only an admin can archive groups.' }, { status: 403 });
    }
    const group = await withEventLog(
      null,
      user.email,
      'email_group_archived',
      () => archiveEmailGroup(id),
      { successDetail: (g) => ({ group_id: g.id, name: g.name }) },
    );
    return NextResponse.json({ group });
  } catch (err) {
    return errorResponse(err);
  }
}
