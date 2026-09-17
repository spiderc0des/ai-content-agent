import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { VERIFIED_USER_ID_HEADER, VERIFIED_USER_EMAIL_HEADER } from './lib/verified-identity';

/**
 * Refresh the Supabase session on every request, and hand the result
 * forward so downstream code doesn't re-verify it.
 *
 * Without the refresh: a Server Component that reads an expired access token
 * cannot write the refreshed cookie back (cookies are read-only during
 * render), so a long-lived session eventually starts 401ing even though the
 * refresh token is still perfectly valid — the user is bounced to /login for
 * no visible reason. Middleware runs before the render and CAN set cookies,
 * which is the only place this can be fixed.
 *
 * Without forwarding the result: requireUser() used to call
 * supabase.auth.getUser() again itself — and getUser() (unlike getSession())
 * deliberately always makes a network round trip to Supabase's Auth server
 * to revalidate the JWT, by design, rather than trusting the local cookie.
 * That meant every single navigation paid for that round trip TWICE — once
 * here, once in requireUser() — for a question already answered a moment
 * earlier in the same request. Measured against this app's database (a
 * comparable remote round trip): ~150ms each. Two of them on every click is
 * exactly the kind of cost that reads as "the UI takes a long time to
 * reflect a click" even though no page is doing anything slow itself.
 */
export async function middleware(request: NextRequest) {
  // Recorded, not applied immediately — setAll can fire mid-getUser() (when
  // Supabase decides the token needs refreshing), before this function knows
  // the identity headers it also needs to set. Building NextResponse.next()
  // more than once would silently drop whichever mutation happened first:
  // an earlier version of this function did exactly that, reconstructing
  // the response after setting headers and losing any cookie refresh in the
  // process. One response, built once, at the end, carrying both.
  let pendingCookies: { name: string; value: string; options: CookieOptions }[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          pendingCookies = cookiesToSet;
        },
      },
    },
  );

  // Touching getUser() is what performs the refresh AND is the one
  // revalidated answer to "who is this" for the whole request.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user?.email) {
    request.headers.set(VERIFIED_USER_ID_HEADER, user.id);
    request.headers.set(VERIFIED_USER_EMAIL_HEADER, user.email);
  } else {
    // Explicitly cleared, not just "not set" — if a client sent either
    // header itself, it must not survive to the other side of this line.
    request.headers.delete(VERIFIED_USER_ID_HEADER);
    request.headers.delete(VERIFIED_USER_EMAIL_HEADER);
  }

  // request now carries both the refreshed cookies (set on request.cookies
  // above, inside setAll) and the identity headers — build the one response
  // from it, then replay any Set-Cookie the refresh produced onto that same
  // response so the browser still receives it.
  const response = NextResponse.next({ request });
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, options);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and the auth callback, which must run
    // its code exchange without a competing refresh.
    '/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
