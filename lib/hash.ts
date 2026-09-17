import { createHash } from 'node:crypto';

/**
 * A short fingerprint of some text. The same text always gives the same
 * fingerprint; change one character and it changes completely.
 *
 * Used for two things:
 *  • intake_hash — did the salesperson change the inputs after generating?
 *  • approved_content_hash — did anyone change the text after approval?
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Fingerprint an object regardless of key order, so `{a:1,b:2}` and
 * `{b:2,a:1}` agree. Key order is not meaningful and must not change the hash.
 */
export function hashObject(obj: Record<string, unknown>): string {
  const ordered = Object.keys(obj)
    .sort()
    .map((k) => `${k}=${String(obj[k] ?? '')}`)
    .join('\n');
  return sha256(ordered);
}

/**
 * The fingerprint of "what was approved" / "what would be sent now".
 *
 * Computed identically at approval time and at send time — see
 * lib/queries.ts decideApproval() and checkSendPreconditions(). If a section
 * is edited in between, this hash changes and the send is refused.
 */
export function contentHash(sections: { section_key: string; body_md: string }[]): string {
  const ordered = [...sections]
    .sort((a, b) => a.section_key.localeCompare(b.section_key))
    .map((s) => `${s.section_key}\u0000${s.body_md}`)
    .join('\u0001');
  return sha256(ordered);
}

/** An unguessable URL-safe token for the client-facing share link. */
export function shareToken(): string {
  // 32 bytes of randomness, base64url — no ambiguous characters in a URL.
  return createHash('sha256')
    .update(crypto.getRandomValues(new Uint8Array(32)))
    .digest('base64url');
}
