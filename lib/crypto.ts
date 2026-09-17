import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { env } from './env';

/**
 * Encrypting OAuth tokens before they touch the database.
 *
 * A service-role key and a connection string are enough to read every row in
 * this project. For most of them that is fine — they hold content. For
 * `channel_credentials` it is not: those rows let the holder post as the
 * agency on LinkedIn and X until someone notices and revokes them.
 *
 * So the key lives in the environment and not in the database, and a database
 * dump on its own is inert. This is not a substitute for a managed secret
 * store, and it does not defend against someone who has both the dump and the
 * environment — it defends against the case that actually happens, which is a
 * backup, a log, or a read-replica going somewhere it should not.
 *
 * AES-256-GCM, so the ciphertext is authenticated: a tampered token fails to
 * decrypt rather than decrypting to something else.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the GCM standard
const VERSION = 'v1';

/**
 * The key, as 32 bytes.
 *
 * Accepts base64 (what the setup instructions generate) and falls back to
 * hashing whatever it was given, so a short or oddly-encoded key still
 * produces a valid AES key rather than throwing at the first send. It is
 * still checked for length at startup — a two-character key is a
 * misconfiguration, not a choice.
 */
function key(): Buffer {
  const raw = env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is not set, so OAuth tokens cannot be stored. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  return createHash('sha256').update(raw).digest();
}

/** Encrypt a token for storage. Returns `v1.<iv>.<tag>.<ciphertext>`, base64url parts. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(
    '.',
  );
}

/**
 * Decrypt a stored token.
 *
 * Throws on anything it cannot authenticate. Callers treat that as "this
 * connection is broken, reconnect it" rather than retrying — a token that
 * will not decrypt is not going to decrypt on the next tick either, and the
 * likeliest cause is that TOKEN_ENCRYPTION_KEY changed.
 */
export function decryptSecret(stored: string): string {
  const [version, ivPart, tagPart, dataPart] = stored.split('.');
  // `dataPart` is checked for PRESENCE, not truthiness: an empty string is a
  // legitimate ciphertext (it is what encrypting an empty value produces), and
  // rejecting it here made encrypt and decrypt disagree about their own format.
  if (version !== VERSION || !ivPart || !tagPart || dataPart === undefined) {
    throw new Error('stored credential is not in the expected format');
  }
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * A token rendered safe to show or log: `••••1a2b`.
 *
 * Exists so that "which token is this" can be answered in a UI or an error
 * without the token itself ending up anywhere it cannot be deleted from.
 */
export function maskSecret(plaintext: string): string {
  return plaintext.length <= 4 ? '••••' : `••••${plaintext.slice(-4)}`;
}
