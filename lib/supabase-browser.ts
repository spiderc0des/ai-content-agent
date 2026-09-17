'use client';
import { createBrowserClient } from '@supabase/ssr';

/**
 * The browser-side Supabase client — used ONLY for auth.signInWithOtp(),
 * which needs no data access at all. It reads the public anon key directly
 * (not from lib/env.ts, which is marked 'server-only' and cannot be
 * imported here); Next.js inlines NEXT_PUBLIC_* vars into the client bundle
 * at build time.
 */
export function supabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
