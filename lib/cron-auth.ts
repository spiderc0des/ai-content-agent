import { timingSafeEqual } from 'node:crypto';

/**
 * The whole authentication story for the scheduled job.
 *
 * Every other write in this app is behind a Supabase session; a scheduler
 * has no user, so a shared secret is all there is. That makes this the one
 * place worth being pedantic about — it lives in its own file rather than
 * inside the route so it can be unit tested, which a Next.js route file
 * (whose only permitted exports are the HTTP verbs and a few config
 * constants) cannot be.
 *
 * Two things it deliberately does NOT do:
 *   • fall back to "no secret set means allow" — an unauthenticated endpoint
 *     that emails clients is worse than a broken one, so no secret is a
 *     refusal, and the caller turns that into a 503.
 *   • compare with `===` — string equality short-circuits at the first
 *     differing byte, which leaks how much of a guess was right. Guessing a
 *     secret one byte at a time is a real attack on an endpoint anyone can
 *     hit; timingSafeEqual is the same price and doesn't have that property.
 */
export function isAuthorisedCronRequest(
  authorizationHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return false;

  const prefix = 'Bearer ';
  const header = authorizationHeader ?? '';
  if (!header.startsWith(prefix)) return false;

  const offered = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  // timingSafeEqual throws on a length mismatch, so length has to be
  // compared first. That leaks the secret's length and nothing else, which
  // is not a useful thing to learn.
  if (offered.length !== expected.length) return false;

  return timingSafeEqual(offered, expected);
}
