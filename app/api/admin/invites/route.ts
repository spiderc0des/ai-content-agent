import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { findAppUserByEmail, upsertInvitedUser, logEvent } from '@/lib/queries';
import { env, emailEnabled } from '@/lib/env';
import { sendInvite } from '@/lib/email';
import { errorResponse } from '@/lib/api-helpers';
import { email as emailField, requiredText, firstIssue } from '@/lib/validation';

/**
 * POST /api/admin/invites — invite a person by email.
 *
 * generateLink(), not Supabase's inviteUserByEmail(): the SDK is explicit
 * that "PKCE is not supported when using inviteUserByEmail", and this app's
 * sign-in is PKCE (app/auth/callback exchanges a `code`). Their invite email
 * would land the person with tokens in a URL fragment no route here reads.
 * generateLink() creates the account and hands BACK the link without sending
 * anything.
 *
 * The link is emailed when SMTP is configured, and ALSO returned to the admin
 * either way. Not redundancy for its own sake: an invite that silently fails
 * to send strands the person until somebody notices, and the admin holding a
 * copy is what makes that recoverable. The link signs the holder in, so the
 * response says so plainly and it is never written to the events table.
 *
 * The invited person is PENDING. An invite is permission to sign in, never
 * access itself; an admin activates them afterwards.
 */
const Body = z
  .object({
    email: emailField(),
    full_name: requiredText('Their name', 1, 120),
    is_creator: z.boolean(),
    is_reviewer: z.boolean(),
    is_publisher: z.boolean(),
    is_admin: z.boolean(),
  })
  .refine((b) => b.is_creator || b.is_reviewer || b.is_publisher || b.is_admin, {
    message: 'Choose at least one capability — an account with none can sign in and reach nothing.',
    path: ['is_creator'],
  });

function alreadyRegistered(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === 'email_exists' ||
    err.code === 'user_already_exists' ||
    /already (been )?registered/i.test(err.message ?? '')
  );
}

export async function POST(request: NextRequest) {
  try {
    const admin = await requireUser();
    if (!admin.is_admin) {
      return NextResponse.json({ error: 'Only an admin can invite people.' }, { status: 403 });
    }

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    }
    const body = parsed.data;

    const existing = await findAppUserByEmail(body.email);
    if (existing?.active) {
      return NextResponse.json(
        {
          error: `${body.email} already has access. Change their capabilities in the list below instead.`,
        },
        { status: 409 },
      );
    }

    // 'invite' creates the account. If one already exists — a pending row
    // being re-invited, or someone who started signing in once and never
    // finished — Supabase refuses 'invite', and 'magiclink' produces an
    // equivalent sign-in link for the account that is already there.
    let result = await supabaseAdmin.auth.admin.generateLink({
      type: 'invite',
      email: body.email,
    });
    if (alreadyRegistered(result.error)) {
      result = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email: body.email,
      });
    }
    if (result.error || !result.data.user || !result.data.properties) {
      return NextResponse.json(
        { error: `Could not create the invitation: ${result.error?.message ?? 'no link returned'}` },
        { status: 502 },
      );
    }

    const { user, properties } = result.data;
    const link =
      `${env.APP_URL}/auth/confirm` +
      `?token_hash=${encodeURIComponent(properties.hashed_token)}` +
      `&type=${encodeURIComponent(properties.verification_type)}`;

    const row = await upsertInvitedUser({
      id: user.id,
      email: body.email,
      fullName: body.full_name,
      isCreator: body.is_creator,
      isReviewer: body.is_reviewer,
      isPublisher: body.is_publisher,
      isAdmin: body.is_admin,
      invitedBy: admin.email,
    });
    if (!row) {
      // Became active between the check above and this write.
      return NextResponse.json({ error: `${body.email} already has access.` }, { status: 409 });
    }

    // Best-effort, and deliberately after the row is written: the account and
    // its capabilities are the durable part, and a mail server having a bad
    // minute must not undo an invitation that already exists. The admin still
    // gets the link back, so a failure here is inconvenient, not blocking.
    const mail = await sendInvite({
      toEmail: body.email,
      fullName: body.full_name,
      invitedBy: admin.email,
      link,
    });

    // The link is deliberately absent from this row. It signs a person in,
    // and `events` is append-only — a credential written here could never be
    // removed again. The same reason it is absent from `mail` below: only
    // whether it sent, never what was sent.
    await logEvent({
      requestId: null,
      actor: admin.email,
      step: existing ? 'admin:reinvite' : 'admin:invite',
      ok: true,
      detail: {
        target_email: body.email,
        full_name: body.full_name,
        is_creator: body.is_creator,
        is_reviewer: body.is_reviewer,
        is_publisher: body.is_publisher,
        is_admin: body.is_admin,
        emailed: mail.sent,
        email_skipped: !mail.sent && mail.skipped ? true : undefined,
      },
    });

    return NextResponse.json({
      ok: true,
      user: row,
      resent: Boolean(existing),
      link,
      emailed: mail.sent,
      email_error: mail.sent ? undefined : emailEnabled ? mail.reason : undefined,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
