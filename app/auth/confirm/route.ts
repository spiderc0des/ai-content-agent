import { NextRequest, NextResponse } from 'next/server';
import { supabaseServerClient } from '@/lib/supabase-server';
import { upsertSignedInUser } from '@/lib/queries';

/**
 * Where an invitation link lands (built by /api/admin/invites).
 *
 * A sibling of app/auth/callback, not a replacement: that route completes a
 * PKCE sign-in from /login by exchanging a `code`. An admin-generated link
 * carries a `token_hash` instead, which is verified here with verifyOtp().
 * Both end the same way — a session cookie, then a pending app_users row.
 *
 * For an invited person that last call creates nothing — their row already
 * exists, with the capabilities the admin chose — but it DOES activate them.
 * The admin made the access decision at invite time; making them come back
 * and tick a second box afterwards is a gate with no decision in it, and in
 * practice leaves the invited person locked out until someone notices.
 *
 * Self-serve sign-ins do not get this: upsertSignedInUser only activates a
 * row an admin explicitly invited.
 *
 * They land on /profile so their first screen says what they can now do,
 * rather than dropping them into a list with no explanation.
 */
/**
 * Every email OTP type Supabase can send a link for.
 *
 * `invite` and `magiclink` are the two this app actually triggers. The rest
 * are here so that the email templates in supabase/email-templates/ can all
 * use the same `token_hash` link: a template pointing at a type this route
 * rejects fails at the worst possible moment — after someone has clicked a
 * link in their inbox — and the failure looks identical to an expired one.
 *
 * `urn:supabase:mfa` is deliberately absent: reauthentication sends a code to
 * type in, not a link to follow.
 */
const ALLOWED_TYPES = new Set(['invite', 'magiclink', 'email', 'recovery', 'email_change']);

type EmailOtpType = 'invite' | 'magiclink' | 'email' | 'recovery' | 'email_change';

/**
 * Where to send them afterwards.
 *
 * `redirect_to` arrives from the email, which means it arrives from outside —
 * and a redirect target taken from a URL without checking is an open redirect,
 * the classic way a trusted domain gets used to launder a phishing link.
 * Only a same-origin path is honoured; anything else falls back to /profile.
 */
function safeRedirect(raw: string | null, base: string): string {
  if (!raw) return '/profile?welcome=1';
  try {
    const target = new URL(raw, base);
    return target.origin === new URL(base).origin ? `${target.pathname}${target.search}` : '/profile?welcome=1';
  } catch {
    return '/profile?welcome=1';
  }
}

export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get('token_hash');
  const type = request.nextUrl.searchParams.get('type');

  const fail = (reason: string) => {
    const url = new URL('/login', request.url);
    url.searchParams.set('error', reason);
    return NextResponse.redirect(url);
  };

  if (!tokenHash || !type || !ALLOWED_TYPES.has(type)) return fail('invalid_link');

  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: type as EmailOtpType,
  });

  // Expired and already-used look identical to the person holding the link,
  // and the remedy is the same for both — ask for a new invite.
  if (error || !data.user?.email) return fail('link_expired');

  await upsertSignedInUser(data.user.id, data.user.email);
  return NextResponse.redirect(
    new URL(safeRedirect(request.nextUrl.searchParams.get('redirect_to'), request.url), request.url),
  );
}
