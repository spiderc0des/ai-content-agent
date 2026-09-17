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

    // ── Pool size ────────────────────────────────────────────────────────
    //
    // postgres.js defaults to 10, and that default cost three days of
    // misdiagnosis. A saturated postgres.js pool does not error and does not
    // time out: it QUEUES the query indefinitely. The query never reaches
    // Postgres, so `pg_stat_activity` shows nothing at all — no slow query,
    // no lock wait, nothing to find. The symptom is a pipeline stage that
    // hangs forever on an UPDATE that takes 300ms when run from anywhere
    // else, and the process looks perfectly healthy while it does it.
    //
    // Observed: the dev server holding exactly 10 sockets to the pooler, a
    // drive wedged in setStatus, and every one of those queries completing in
    // under 1.4s from a separate client.
    //
    // Demand is higher than it looks. One drive runs up to STAGE_CONCURRENCY
    // per-item Claude calls whose results are persisted — and insertExcerpts
    // opens a TRANSACTION, which holds its connection for the whole of it —
    // while the heartbeat ticks every 20s and every open page polls the
    // status endpoint. Ten is not a lot to share between those.
    max: Number(process.env.DATABASE_POOL_MAX ?? 20),

    // Hand connections back rather than holding every one ever opened. Without
    // this the pool only ever grows to its ceiling and stays there, so a burst
    // of concurrency permanently reserves capacity that nothing is using.
    idle_timeout: 30,

    // Recycle connections periodically. A connection wedged by a context that
    // was torn down mid-query — which is exactly what happens to an abandoned
    // `after()` callback — is otherwise held for the life of the process, and
    // the pool shrinks by one every time it happens.
    max_lifetime: 60 * 30,

    // Fail loudly instead of waiting forever for a connection that is not
    // coming. A typed error names the problem; an indefinite wait is the thing
    // that made this so hard to find.
    connect_timeout: 30,
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
