/**
 * Header names carrying the identity middleware.ts already verified with
 * Supabase's Auth server, forward to lib/auth.ts's requireUser() so it
 * doesn't have to ask the same question again.
 *
 * Deliberately its own file, imported by both middleware.ts (an Edge-capable
 * Next.js convention entry point) and lib/auth.ts (plain Node server code) —
 * neither should import application code from the other. This file is
 * nothing but two string constants: safe in either runtime, no side effects.
 */
export const VERIFIED_USER_ID_HEADER = 'x-koya-verified-user-id';
export const VERIFIED_USER_EMAIL_HEADER = 'x-koya-verified-user-email';
