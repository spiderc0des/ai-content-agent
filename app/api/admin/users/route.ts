import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { listAppUsers, setCapabilities } from '@/lib/queries';
import { errorResponse, withEventLog } from '@/lib/api-helpers';
import { firstIssue } from '@/lib/validation';

const Body = z
  .object({
    id: z.string().uuid('That is not a valid user id.'),
    active: z.boolean(),
    is_creator: z.boolean(),
    is_reviewer: z.boolean(),
    is_publisher: z.boolean(),
    is_admin: z.boolean(),
  })
  // The database enforces this too (app_users_active_needs_a_capability).
  // Catching it here turns a raw constraint violation into a sentence that
  // says what to do about it.
  .refine(
    (b) => !b.active || b.is_creator || b.is_reviewer || b.is_publisher || b.is_admin,
    {
      message:
        'An active person needs at least one capability — otherwise they can sign in and reach nothing.',
      path: ['active'],
    },
  );

export async function GET() {
  try {
    await requireUser();
    const users = await listAppUsers();
    return NextResponse.json({ users });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const admin = await requireUser('creator');
    if (!admin.is_admin) {
      return NextResponse.json({ error: 'Only an admin can change access.' }, { status: 403 });
    }
    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    }
    const body = parsed.data;

    // Removing your own admin flag locks the last admin out of the app with
    // no way back except SQL. Refuse it rather than being clever.
    if (body.id === admin.id && !body.is_admin) {
      return NextResponse.json(
        { error: 'You cannot remove your own admin access.' },
        { status: 409 },
      );
    }

    const user = await withEventLog(null, admin.email, 'set_capabilities', async () =>
      setCapabilities(body.id, body),
    );
    return NextResponse.json({ user });
  } catch (err) {
    return errorResponse(err);
  }
}
