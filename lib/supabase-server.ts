import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from './env';

/**
 * A Supabase client bound to the current request's cookies — used ONLY to
 * ask "who is this?" (supabase.auth.getUser()). It runs with the public
 * anon key, same as it would in the browser.
 *
 * This client never touches the database directly. All actual data access
 * goes through lib/db.ts with the service-role key — authorisation is not
 * delegated to Supabase Auth or to row-level security.
 */
export async function supabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render, where cookies cannot be
          // set. Harmless as long as middleware refreshes the session —
          // this app has no middleware yet, so a long-lived session may not
          // silently refresh. A known limitation, not papered over here.
        }
      },
    },
  });
}
