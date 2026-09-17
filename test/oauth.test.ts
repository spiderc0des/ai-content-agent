import { describe, it, expect, beforeAll } from 'vitest';

/**
 * The authorize URLs, checked against each provider's published contract.
 *
 * These cannot be verified by running them — that needs a registered app and
 * a human pressing Allow — so they are verified against the documented shape
 * instead. A wrong parameter here fails at the provider with an opaque error
 * screen, after someone has already gone through a consent flow.
 *
 * Credentials are injected before the module loads, because lib/env.ts reads
 * process.env once at import.
 */
let providers: typeof import('../lib/oauth/providers');

beforeAll(async () => {
  process.env.X_CLIENT_ID = 'test-x-client';
  process.env.X_CLIENT_SECRET = 'test-x-secret';
  process.env.LINKEDIN_CLIENT_ID = 'test-li-client';
  process.env.LINKEDIN_CLIENT_SECRET = 'test-li-secret';
  process.env.APP_URL = 'https://koya.example.com';
  providers = await import('../lib/oauth/providers');
});

describe('PKCE', () => {
  it('derives an S256 challenge from the verifier', async () => {
    const { createHash } = await import('node:crypto');
    const { verifier, challenge } = providers.createPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('is different every time', () => {
    expect(providers.createPkce().verifier).not.toBe(providers.createPkce().verifier);
  });

  it('is URL-safe, so it survives a query string intact', () => {
    const { verifier, challenge } = providers.createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('X authorize URL', () => {
  const build = () => new URL(providers.authorizeUrl('x', 'state-123', providers.createPkce()));

  it('points at the documented endpoint', () => {
    const u = build();
    expect(`${u.origin}${u.pathname}`).toBe('https://x.com/i/oauth2/authorize');
  });

  it('carries every parameter X requires, including PKCE', () => {
    const p = build().searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('test-x-client');
    expect(p.get('state')).toBe('state-123');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBeTruthy();
  });

  it('asks for offline.access, without which there is no refresh token', () => {
    // Omitting it gives a token that dies in two hours, so every scheduled
    // post after that fails — and it looks like a broken integration.
    const scopes = build().searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('offline.access');
    expect(scopes).toContain('tweet.write');
  });

  it('sends a redirect_uri matching the route that handles the callback', () => {
    expect(build().searchParams.get('redirect_uri')).toBe(
      'https://koya.example.com/api/admin/channels/x/callback',
    );
  });
});

describe('LinkedIn authorize URL', () => {
  const build = () =>
    new URL(providers.authorizeUrl('linkedin', 'state-456', providers.createPkce()));

  it('points at the documented endpoint', () => {
    const u = build();
    expect(`${u.origin}${u.pathname}`).toBe('https://www.linkedin.com/oauth/v2/authorization');
  });

  it('asks for the member scope when no organization is configured', () => {
    expect(build().searchParams.get('scope')).toContain('w_member_social');
  });

  it('sends its own callback, not X’s', () => {
    expect(build().searchParams.get('redirect_uri')).toBe(
      'https://koya.example.com/api/admin/channels/linkedin/callback',
    );
  });
});

/**
 * The scope and the author URN must agree. Asking for w_member_social and then
 * posting as an organization is a 403 — and it arrives AFTER someone has been
 * through the consent screen, which is the worst moment to find out.
 */
describe('scopesForAuthor', () => {
  it('asks for the organization scope when the author is a page', () => {
    const scopes = providers.scopesForAuthor('urn:li:organization:12345');
    expect(scopes).toContain('w_organization_social');
    expect(scopes).not.toContain('w_member_social');
  });

  it('asks for the member scope when the author is a person', () => {
    const scopes = providers.scopesForAuthor('urn:li:person:abc123');
    expect(scopes).toContain('w_member_social');
    expect(scopes).not.toContain('w_organization_social');
  });

  it('defaults to the member scope when nothing is configured', () => {
    // The connect flow then reads the signed-in member's own URN, so the
    // default and the fallback author agree.
    for (const value of [null, undefined, '']) {
      expect(providers.scopesForAuthor(value), String(value)).toContain('w_member_social');
    }
  });
});
