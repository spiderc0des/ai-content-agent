import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/crypto';

/**
 * OAuth tokens let the holder post as the agency until someone notices and
 * revokes them. These pin the properties that make storing them defensible.
 */
describe('token encryption', () => {
  it('round-trips a token', () => {
    const token = 'x-token-abc123.def456-refresh';
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it('never stores the token in readable form', () => {
    const token = 'super-secret-access-token';
    const stored = encryptSecret(token);
    expect(stored).not.toContain(token);
    expect(Buffer.from(stored, 'utf8').toString()).not.toContain('secret');
  });

  it('produces different ciphertext each time, so equal tokens are not obviously equal', () => {
    // A deterministic scheme would let anyone with read access see that two
    // channels share a token, or that a token was unchanged by a "rotation".
    const a = encryptSecret('same-token');
    const b = encryptSecret('same-token');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('refuses tampered ciphertext instead of returning something else', () => {
    // GCM authenticates. Without that, a flipped bit decrypts to garbage that
    // would then be sent to a provider as if it were a token.
    const stored = encryptSecret('a-token');
    const parts = stored.split('.');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]!.slice(0, -2)}AA`].join('.');
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('refuses anything that is not in its own format', () => {
    for (const bad of ['', 'plaintext', 'v2.a.b.c', 'v1.only-two.parts']) {
      expect(() => decryptSecret(bad), bad).toThrow();
    }
  });

  it('handles a long token and an empty one', () => {
    const long = 'y'.repeat(4000);
    expect(decryptSecret(encryptSecret(long))).toBe(long);
    expect(decryptSecret(encryptSecret(''))).toBe('');
  });

  it('masks a token down to something safe to show', () => {
    expect(maskSecret('abcdefghijkl')).toBe('••••ijkl');
    expect(maskSecret('ab')).toBe('••••');
  });
});
