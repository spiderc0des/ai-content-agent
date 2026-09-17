import 'server-only';
import postgres from 'postgres';
import { env } from './env';

/**
 * The one Postgres client for the whole app.
 *
 * Always the service role's connection: every query here runs with full
 * access, so every route that calls it MUST check who is asking and what
 * they're allowed to do before it does — authorisation lives in the route
 * handlers, not in Postgres row-level-security policies.
 *
 * Cached on `globalThis` in development. `next dev`'s Fast Refresh
 * re-evaluates this module on nearly every save to any server-side file,
 * and a plain `postgres(...)` call opens a NEW pool each time — the old
 * one is never explicitly closed, so its connections just sit there until
 * Supabase's own idle-connection cleanup gets to them. Over a long editing
 * session that reliably exhausts the pooler's connection limit (observed:
 * "max client connections reached, limit: 200") and takes the whole app
 * down with unrelated-looking 500s. Caching the instance means Fast
 * Refresh reuses the same pool instead of leaking a new one per edit — in
 * production this module only ever evaluates once, so the cache is a
 * no-op there.
 */
function createClient() {
  return postgres(...parseConnectionString(env.DATABASE_URL), {
    // Supabase's pooled connection (port 6543) is a transaction pooler —
    // named prepared statements don't survive across pooled connections.
    prepare: false,
  });
}

const globalForSql = globalThis as unknown as { __sql?: ReturnType<typeof createClient> };

export const sql = globalForSql.__sql ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForSql.__sql = sql;
}

/**
 * postgres.js parses `DATABASE_URL` with the browser's URL parser, which
 * calls `decodeURIComponent` on the password. A password copied verbatim
 * from Supabase's connection-string screen is NOT pre-encoded — if it
 * contains `@`, `%`, `#`, `/`, `:`, or `?`, the parse throws a bare
 * "URI malformed" with a stack trace pointing at a dependency, not at the
 * actual problem. This turns that into a message that says what to fix.
 */
function parseConnectionString(url: string): [string] {
  try {
    decodeURIComponent(url);
    return [url];
  } catch {
    throw new Error(
      `DATABASE_URL is not a valid connection string — its password contains a ` +
        `character (one of @ % # / : ?) that needs percent-encoding.\n\n` +
        `Fix: encode just the password portion (between the ':' after your username ` +
        `and the '@' before the host). For example, '%' becomes '%25', '@' becomes ` +
        `'%40', '#' becomes '%23'.`,
    );
  }
}
