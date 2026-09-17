import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * A Supabase client holding the SERVICE-ROLE key — the only one in the app.
 *
 * It exists for exactly one job: the Auth admin API, which creates an invited
 * person's account before they have ever signed in. Nothing else may use it.
 * Data access still goes through lib/db.ts, and "who is this request?" still
 * goes through lib/supabase-server.ts with the anon key.
 *
 * `server-only` makes importing this from a Client Component a build error,
 * rather than something that ships the key to a browser and is noticed
 * later. No session is persisted or refreshed: this client acts as the
 * project, never as a user.
 */
export const supabaseAdmin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
