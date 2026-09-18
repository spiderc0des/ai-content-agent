import 'server-only';
import { env, cronEnabled } from './env';
import { drivePipeline, type DriveResult } from './pipeline';
import { logEvent } from './queries';

/**
 * Keeping a run going across the platform's function limit.
 *
 * Vercel kills a function at `maxDuration` — 300 seconds on Hobby — and a full
 * pipeline averages around thirteen minutes. No amount of tuning fits thirteen
 * minutes of work into five, so a run is ALWAYS cut short; the only question
 * is what happens next.
 *
 * It used to be "nothing, until a cron notices". That is why a request sat at
 * `generating` for nine hours with its planning stage finished, no lock held
 * and no error: the driver stopped politely at its budget and the thing meant
 * to resume it was not running.
 *
 * So a run now continues ITSELF. When the driver stops for time, it calls the
 * app's own continue endpoint, which claims the lock and drives the next
 * slice, which continues again. The chain ends when the pipeline reaches a
 * human, finishes, or fails — the same three ways a single run ends. No cron,
 * no external nudge, no open browser tab.
 *
 * The cron worker stays as a safety net for the case this cannot cover: a
 * function killed so abruptly that it never got to make the call.
 */

/**
 * How many times one run may hand off to itself.
 *
 * At roughly four minutes a slice this is about forty minutes of pipeline —
 * comfortably past the thirteen a full run takes, and short enough that a
 * genuine loop stops rather than billing all night. The stage cap and the
 * repeat guard inside drivePipeline are the first defences; this is the last.
 */
const MAX_HOPS = 10;

/** Set by the continue endpoint so each slice knows how far along the chain it is. */
export const HOP_HEADER = 'x-koya-hop';

/**
 * Drive one slice, then hand off if the work is unfinished.
 *
 * Returns the driver's own result, so the caller can log or respond with it.
 * The hand-off is awaited only as far as the next slice ACCEPTING the work —
 * that endpoint answers immediately and does its driving in `after()`, so this
 * does not nest one function's lifetime inside another's.
 */
export async function driveAndContinue(
  requestId: string,
  actor: string,
  hop = 0,
  /**
   * Where to reach this app, taken from the request being served.
   *
   * Preferred over APP_URL because it cannot be stale: APP_URL is a setting
   * someone has to remember to update, and when it is wrong here the app
   * calls a DIFFERENT app and the chain dies silently. That is not
   * hypothetical — pointed at localhost:3000 while running on 3010, the
   * handoff reached an unrelated project and got a 404.
   *
   * APP_URL remains the fallback for callers with no request in hand.
   */
  origin?: string,
): Promise<DriveResult> {
  const result = await drivePipeline(requestId, actor);

  if (result.stoppedBecause !== 'out_of_time') return result;

  if (hop >= MAX_HOPS) {
    // Not silent. A run that hits this has been going for forty minutes and
    // someone needs to look at it, so it says so where the request's own log
    // will show it.
    await logEvent({
      requestId,
      actor,
      stage: null,
      step: 'pipeline_handoff_limit',
      ok: false,
      detail: { hops: hop, status: result.finalStatus },
    }).catch(() => {});
    return result;
  }

  if (!cronEnabled) {
    // The continue endpoint authenticates with CRON_SECRET. Without one there
    // is no way to make an authenticated call to ourselves, and saying that
    // beats a chain that silently never starts.
    await logEvent({
      requestId,
      actor,
      stage: null,
      step: 'pipeline_handoff_unavailable',
      ok: false,
      detail: { reason: 'CRON_SECRET is not set, so the run cannot continue itself' },
    }).catch(() => {});
    return result;
  }

  try {
    const base = (origin ?? env.APP_URL).replace(/\/$/, '');
    await fetch(`${base}/api/requests/${requestId}/continue`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CRON_SECRET}`,
        [HOP_HEADER]: String(hop + 1),
      },
    });
  } catch (err) {
    // The chain is broken but the request is intact and unlocked, so the cron
    // safety net still picks it up. Recorded rather than thrown.
    await logEvent({
      requestId,
      actor,
      stage: null,
      step: 'pipeline_handoff_failed',
      ok: false,
      detail: { error: err instanceof Error ? err.message : String(err), hop },
    }).catch(() => {});
  }

  return result;
}
