import 'server-only';
import { cookies } from 'next/headers';
import type { OAuthChannel } from './providers';

/**
 * The half-finished OAuth handshake, parked between the two requests.
 *
 * It holds the PKCE verifier and the CSRF state, and it lives in an httpOnly
 * cookie rather than in the database or in the URL:
 *
 *   • The verifier is a secret. Anything the page's JavaScript can read, an
 *     injected script can read, and with the verifier plus an intercepted
 *     code an attacker completes the exchange instead of us.
 *   • `state` only defends against CSRF if the callback compares against a
 *     value the caller could not choose. A cookie the browser sends back is
 *     exactly that; a hidden field is not.
 *   • Ten minutes, because a handshake that outlives the tab it started in is
 *     a credential sitting around for no reason. X's authorization codes
 *     expire in thirty seconds anyway.
 */

const MAX_AGE_SECONDS = 600;

const cookieName = (channel: OAuthChannel) => `koya_oauth_${channel}`;

export interface Handshake {
  state: string;
  verifier: string;
}

export async function setOAuthHandshake(channel: OAuthChannel, h: Handshake): Promise<void> {
  const jar = await cookies();
  jar.set(cookieName(channel), JSON.stringify(h), {
    httpOnly: true,
    sameSite: 'lax', // the provider redirects back across sites, so not 'strict'
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function readOAuthHandshake(channel: OAuthChannel): Promise<Handshake | null> {
  const jar = await cookies();
  const raw = jar.get(cookieName(channel))?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Handshake>;
    return parsed.state && parsed.verifier
      ? { state: parsed.state, verifier: parsed.verifier }
      : null;
  } catch {
    return null;
  }
}

export async function clearOAuthHandshake(channel: OAuthChannel): Promise<void> {
  const jar = await cookies();
  jar.delete(cookieName(channel));
}
