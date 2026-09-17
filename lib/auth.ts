import 'server-only';
import { headers } from 'next/headers';
import { supabaseServerClient } from './supabase-server';
import { findAppUser } from './queries';
import type { AppUserRow } from './db-schemas';
import { capabilityLabel, hasCapability, type Capability } from './permissions';
import { VERIFIED_USER_ID_HEADER, VERIFIED_USER_EMAIL_HEADER } from './verified-identity';

export {
  capabilityLabel,
  canViewRequest,
  canRunPipeline,
  isPipelineRunnable,
  canReview,
} from './permissions';
export type { Capability } from './permissions';

/**
 * The one function every route starts with. Two checks, not one:
 *
 *   1. Authentication (Supabase) — is there a valid session at all?
 *   2. Authorisation (our own app_users table) — is this person on the
 *      allowlist, and do they have the capability the action needs?
 *
 * Supabase Auth's default is OPEN SIGNUP: it will create a session for any
 * email address that requests a magic link. Skipping step 2 means anyone
 * with an inbox can use the app — `app_users` is the allowlist that
 * actually gates access.
 *
 * Capabilities (is_creator / is_reviewer / is_publisher / is_admin) are
 * independent flags, not one exclusive role — a person can hold any
 * combination. is_admin bypasses per-request ownership checks and always
 * satisfies any capability check here.
 */
export class AuthError extends Error {
  constructor(
    public status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * The identity middleware.ts already verified this exact request with
 * Supabase's Auth server, if it ran and found a session — which it does for
 * every route reachable through the app (see middleware.ts's matcher).
 *
 * Reading this instead of calling supabase.auth.getUser() again is what
 * removes the redundant round trip: getUser() deliberately always revalidates
 * over the network rather than trusting the local cookie, so calling it twice
 * per request paid that cost twice for an answer already known. Falling back
 * to the real check when the headers are absent means nothing here can
 * possibly be LESS strict than before — a route middleware doesn't cover (if
 * one is ever added) degrades gracefully to exactly today's behaviour rather
 * than silently trusting nothing.
 */
async function verifiedFromMiddleware(): Promise<{ id: string; email: string } | null> {
  const h = await headers();
  const id = h.get(VERIFIED_USER_ID_HEADER);
  const email = h.get(VERIFIED_USER_EMAIL_HEADER);
  return id && email ? { id, email } : null;
}

export async function currentUser(): Promise<AppUserRow | null> {
  const verified = await verifiedFromMiddleware();
  if (verified) return findAppUser(verified.id);

  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return findAppUser(data.user.id);
}

/**
 * A session existing and a session being authorized are different
 * questions. This answers only the first one, cheaply, for UI that needs to
 * know whether to show a "sign out" control at all: someone signed in but
 * not on the allowlist still has a session, and is exactly who most needs a
 * visible way to sign out and try a different account.
 */
export async function sessionEmail(): Promise<string | null> {
  const verified = await verifiedFromMiddleware();
  if (verified) return verified.email;

  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.email ?? null;
}

/**
 * Deliberately does NOT call currentUser() — that collapses "no session"
 * and "session but not on the allowlist" into the same null, which makes
 * both throw the same 401. The two cases are genuinely different:
 *
 *   - 401 no Supabase session at all → the caller should redirect to /login
 *   - 403 has a session, but no app_users row, inactive, or missing the
 *     required capability → the caller must NOT redirect to /login (they're
 *     already signed in); show the message, which names the actual problem.
 */
export async function requireUser(capability?: Capability): Promise<AppUserRow> {
  const verified = await verifiedFromMiddleware();

  let userId: string;
  if (verified) {
    userId = verified.id;
  } else {
    const supabase = await supabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new AuthError(401, 'Sign in to continue.');
    userId = data.user.id;
  }

  const user = await findAppUser(userId);
  if (!user) {
    throw new AuthError(
      403,
      "You're signed in, but this account isn't on the approved list yet. " +
        'Ask an admin to add you.',
    );
  }
  if (!hasCapability(user, capability)) {
    throw new AuthError(
      403,
      `This action requires the '${capability}' capability. You're signed in as '${capabilityLabel(user)}'.`,
    );
  }
  return user;
}
