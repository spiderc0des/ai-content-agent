import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env';

/**
 * The two OAuth dances, written out rather than pulled from a library.
 *
 * A generic OAuth client would be more code than this, not less: there are
 * exactly two providers, each needs one authorize URL and two token calls, and
 * the interesting parts are the places where they DISAGREE — which is
 * precisely what a generic abstraction flattens. X requires PKCE and returns
 * JSON; LinkedIn requires a version header and returns the created id in a
 * response header. Those differences are the whole job.
 *
 * Endpoints and parameters are from the providers' own current docs:
 *   X        — https://docs.x.com/resources/fundamentals/authentication/oauth-2-0
 *   LinkedIn — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 */

export type OAuthChannel = 'x' | 'linkedin';

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Null when the provider did not say; the token is then refreshed on a 401. */
  expiresAt: Date | null;
  scopes: string[];
}

/* ─── PKCE ───────────────────────────────────────────────────────────────── */

export interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * X requires PKCE even for confidential clients. LinkedIn does not use it, and
 * sending it does no harm, so one code path covers both.
 */
export function createPkce(): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/* ─── Scopes ─────────────────────────────────────────────────────────────── */

/**
 * `offline.access` is what makes X issue a refresh token. Without it the
 * access token dies after two hours and every scheduled post after that fails
 * — which would look like a broken integration rather than a missing scope.
 */
const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

/**
 * `w_organization_social` posts as a company page and needs the signed-in
 * member to hold an admin role on it; `w_member_social` posts as the person.
 * Which one is asked for follows from LINKEDIN_AUTHOR_URN, so the scope and
 * the author can never disagree.
 *
 * `openid`/`profile` are there so the callback can name the connected account
 * without a second product entitlement.
 */
export function scopesForAuthor(authorUrn: string | null | undefined): string[] {
  const asOrganization = (authorUrn ?? '').startsWith('urn:li:organization:');
  return [asOrganization ? 'w_organization_social' : 'w_member_social', 'openid', 'profile'];
}

export function scopesFor(channel: OAuthChannel): string[] {
  return channel === 'x' ? X_SCOPES : scopesForAuthor(env.LINKEDIN_AUTHOR_URN);
}

/* ─── Authorize ──────────────────────────────────────────────────────────── */

export function redirectUri(channel: OAuthChannel): string {
  return `${env.APP_URL}/api/admin/channels/${channel}/callback`;
}

export function authorizeUrl(channel: OAuthChannel, state: string, pkce: Pkce): string {
  const common = {
    response_type: 'code',
    redirect_uri: redirectUri(channel),
    scope: scopesFor(channel).join(' '),
    state,
  };

  if (channel === 'x') {
    const params = new URLSearchParams({
      ...common,
      client_id: env.X_CLIENT_ID ?? '',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    return `https://x.com/i/oauth2/authorize?${params}`;
  }

  const params = new URLSearchParams({ ...common, client_id: env.LINKEDIN_CLIENT_ID ?? '' });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

/* ─── Token exchange and refresh ─────────────────────────────────────────── */

const TOKEN_URL: Record<OAuthChannel, string> = {
  x: 'https://api.x.com/2/oauth2/token',
  linkedin: 'https://www.linkedin.com/oauth/v2/accessToken',
};

function clientCredentials(channel: OAuthChannel): { id: string; secret: string } {
  return channel === 'x'
    ? { id: env.X_CLIENT_ID ?? '', secret: env.X_CLIENT_SECRET ?? '' }
    : { id: env.LINKEDIN_CLIENT_ID ?? '', secret: env.LINKEDIN_CLIENT_SECRET ?? '' };
}

async function tokenRequest(channel: OAuthChannel, body: URLSearchParams): Promise<TokenSet> {
  const { id, secret } = clientCredentials(channel);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };

  if (channel === 'x') {
    // X confidential clients authenticate with a Basic header. Putting the
    // secret in the body instead is accepted by some providers and rejected
    // by this one with an opaque 401.
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }

  const res = await fetch(TOKEN_URL[channel], { method: 'POST', headers, body });
  const text = await res.text();

  if (!res.ok) {
    // The body carries the provider's own reason — "invalid_grant" for an
    // expired code, "invalid_client" for bad credentials — and those are the
    // two mistakes that actually happen while wiring this up.
    throw new Error(`${channel} token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const json = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) throw new Error(`${channel} returned no access token`);

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    // LinkedIn returns scopes comma-separated, X space-separated.
    scopes: json.scope ? json.scope.split(/[\s,]+/).filter(Boolean) : scopesFor(channel),
  };
}

export function exchangeCode(
  channel: OAuthChannel,
  code: string,
  verifier: string,
): Promise<TokenSet> {
  return tokenRequest(
    channel,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(channel),
      code_verifier: verifier,
    }),
  );
}

export function refreshTokens(channel: OAuthChannel, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(
    channel,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
}

/* ─── Naming the connected account ───────────────────────────────────────── */

export interface ConnectedAccount {
  label: string;
  authorUrn: string | null;
}

/**
 * Who the tokens actually post as.
 *
 * Asked once at connect time and stored, so the queue can say "posts as
 * @koyatalent" without a lookup, and so a person can tell at a glance that
 * they authorised the wrong account — which is easy to do and otherwise only
 * discovered after something has already gone out under the wrong name.
 */
export async function identify(channel: OAuthChannel, accessToken: string): Promise<ConnectedAccount> {
  if (channel === 'x') {
    const res = await fetch('https://api.x.com/2/users/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { label: 'connected account', authorUrn: null };
    const json = (await res.json()) as { data?: { username?: string; name?: string } };
    return {
      label: json.data?.username ? `@${json.data.username}` : (json.data?.name ?? 'connected account'),
      authorUrn: null,
    };
  }

  // LinkedIn: an organization author is configured rather than discovered —
  // the token's owner is a person even when the posts are the company's.
  const configured = env.LINKEDIN_AUTHOR_URN;
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = res.ok ? ((await res.json()) as { sub?: string; name?: string }) : {};

  if (configured?.startsWith('urn:li:organization:')) {
    return {
      label: `${configured}${json.name ? ` (authorised by ${json.name})` : ''}`,
      authorUrn: configured,
    };
  }
  return {
    label: json.name ?? 'connected account',
    authorUrn: configured ?? (json.sub ? `urn:li:person:${json.sub}` : null),
  };
}
