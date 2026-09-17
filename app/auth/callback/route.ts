import { NextRequest, NextResponse } from 'next/server';
import { supabaseServerClient } from '@/lib/supabase-server';
import { upsertSignedInUser } from '@/lib/queries';

/**
 * Where a magic link lands: exchange the code for a session cookie, then make
 * sure this person has an app_users row — created PENDING (active = false) if
 * this is their first time.
 *
 * A pending row grants nothing. findAppUser() only matches active = true, so
 * requireUser() still 403s until an admin activates them. This only removes
 * the "somebody has to copy a UUID out of the Supabase dashboard before a new
 * person can even be considered" friction; it does not weaken the allowlist.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (code) {
    const supabase = await supabaseServerClient();
    const { data } = await supabase.auth.exchangeCodeForSession(code);
    if (data.user?.email) {
      await upsertSignedInUser(data.user.id, data.user.email);
    }
  }
  return NextResponse.redirect(new URL('/requests', request.url));
}
