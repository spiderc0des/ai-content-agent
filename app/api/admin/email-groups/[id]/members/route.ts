import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import {
  getEmailGroup,
  addGroupMembers,
  removeGroupMember,
  setMemberSubscribed,
  listGroupMembers,
} from '@/lib/queries';
import { errorResponse, withEventLog } from '@/lib/api-helpers';
import { firstIssue } from '@/lib/validation';
import { parseAddressList } from '@/lib/address-list';

export const dynamic = 'force-dynamic';

const AddBody = z.object({
  /**
   * One blob of text, not a parsed array.
   *
   * People add addresses by pasting a column out of a spreadsheet, a row of
   * comma-separated addresses, or a block copied from an email client with
   * names attached. Making the client split that correctly would put the
   * parsing in the one place it cannot be tested; the server takes the raw
   * text and reports exactly what it made of it.
   */
  text: z.string().min(1, 'Paste at least one email address.').max(100_000),
});

const EditBody = z.object({
  member_id: z.string().uuid(),
  action: z.enum(['remove', 'unsubscribe', 'resubscribe']),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser();
    if (!user.is_admin) {
      return NextResponse.json({ error: 'Only an admin can change groups.' }, { status: 403 });
    }
    const group = await getEmailGroup(id);
    if (!group) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (group.archived_at) {
      return NextResponse.json(
        { error: 'That group is archived. Restore it before adding addresses.' },
        { status: 409 },
      );
    }

    const parsed = AddBody.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    }

    const { valid, invalid } = parseAddressList(parsed.data.text);
    if (!valid.length) {
      return NextResponse.json(
        {
          error: invalid.length
            ? `None of those look like email addresses — for example "${invalid[0]}".`
            : 'No email addresses found in that.',
        },
        { status: 400 },
      );
    }

    const result = await withEventLog(
      null,
      user.email,
      'email_group_members_added',
      () => addGroupMembers(id, valid, user.id),
      { successDetail: (r) => ({ group_id: id, added: r.added, skipped: r.skipped }) },
    );

    return NextResponse.json({
      ...result,
      // Reported rather than rejected: pasting 200 addresses where two are
      // malformed should add the 198 and name the two, not refuse the lot.
      invalid,
      members: await listGroupMembers(id),
    });
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
    const parsed = EditBody.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    }
    const { member_id, action } = parsed.data;

    await withEventLog(
      null,
      user.email,
      `email_group_member_${action}d`,
      () =>
        action === 'remove'
          ? removeGroupMember(id, member_id)
          : setMemberSubscribed(id, member_id, action === 'resubscribe'),
      { successDetail: (m) => ({ group_id: id, email: m.email }) },
    );

    return NextResponse.json({ ok: true, members: await listGroupMembers(id) });
  } catch (err) {
    return errorResponse(err);
  }
}
