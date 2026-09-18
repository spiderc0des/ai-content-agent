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
 * THREE, because the platform — not this code — is what limits it.
 *
 * Vercel refuses a deployment that invokes itself too deeply, and answers the
 * call with a plain `508 Loop Detected` from its proxy before any of our code
 * runs. That is not a hypothesis: hops 1 to 4 came back 202 from this app and
 * hop 5 came back a non-JSON 508, on a request whose every stage had
 * succeeded. The old value of 10 was never reachable, so the chain did not end
 * when it was told to — it ended when the platform cut it off, which looks
 * identical to a bug.
 *
 * Three keeps a comfortable margin under that ceiling. A chain that runs out
 * of hops stops cleanly and leaves the request unlocked in a machine status,
 * which is exactly the shape /api/cron/resume looks for — so the external
 * worker carries it on, and each of those ticks starts a fresh chain from
 * outside, at depth zero, with three more hops of its own.
 *
 * Self-continuation is therefore the fast path, not the only path. It was
 * always meant to be the thing that stops a request waiting on a scheduler;
 * it cannot also be the thing that runs an unbounded pipeline unaided.
 */
const MAX_HOPS = 3;

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

  const base = (origin ?? env.APP_URL).replace(/\/$/, '');
  const handoff = await callContinue(base, requestId, hop + 1);

  // A hand-off that was REFUSED because something else already holds the lock
  // is the one worth trying twice. It is a race with the slice that just
  // released it — rare, and entirely recoverable a second later. Every other
  // refusal is a real answer and retrying would only repeat it.
  const retried =
    handoff.outcome === 'refused' && /claimed it first|already has it/.test(handoff.reason ?? '')
      ? await (async () => {
          await new Promise((r) => setTimeout(r, 1500));
          return callContinue(base, requestId, hop + 1);
        })()
      : null;

  const final = retried ?? handoff;

  // Always logged, success included. The chain used to be invisible: the fetch
  // was awaited but its RESPONSE was never looked at, so a 401, a 404, or a
  // plain `continued: false` all resolved like a success and the run simply
  // stopped with nothing in the log to say why. A request sat at `evaluating`
  // with every stage green, no lock, no error, and no explanation — the whole
  // point of the hand-off is that it is the thing keeping the pipeline alive,
  // which makes it the last thing that should fail quietly.
  await logEvent({
    requestId,
    actor,
    stage: null,
    step: final.outcome === 'accepted' ? 'pipeline_handoff' : 'pipeline_handoff_failed',
    ok: final.outcome === 'accepted',
    detail: {
      hop: hop + 1,
      status: final.status ?? null,
      reason: final.reason ?? null,
      retried: retried !== null,
      from_status: result.finalStatus,
    },
  }).catch(() => {});

  return result;
}

export interface HandoffResult {
  /** accepted — the next slice took it. refused — it answered, but declined. */
  outcome: 'accepted' | 'refused' | 'unreachable';
  status?: number;
  reason?: string;
}

/**
 * Call the continue endpoint and find out what it actually said.
 *
 * `fetch` rejects only on a transport failure. An HTTP 401 or 503 resolves
 * perfectly happily, and so does a 200 carrying `continued: false` — so the
 * response has to be read, not merely awaited.
 */
async function callContinue(base: string, requestId: string, hop: number): Promise<HandoffResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/requests/${requestId}/continue`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CRON_SECRET}`,
        [HOP_HEADER]: String(hop),
      },
    });
  } catch (err) {
    return { outcome: 'unreachable', reason: err instanceof Error ? err.message : String(err) };
  }

  let body: ContinueBody | null = null;
  try {
    body = (await res.json()) as ContinueBody;
  } catch {
    body = null;
  }

  return interpretContinueResponse(res.ok, res.status, body);
}

export interface ContinueBody {
  continued?: boolean;
  reason?: string;
  error?: string;
}

/**
 * What the continue endpoint's answer actually means.
 *
 * Split out from the fetch so it can be tested without a server. The rule that
 * matters: a 200 is not success. The endpoint answers `continued: false` with
 * a perfectly healthy 200 when there is nothing to run or someone else has the
 * lock, and treating that as "handed off" is how a chain dies with every stage
 * green and nothing in the log.
 */
export function interpretContinueResponse(
  ok: boolean,
  status: number,
  body: ContinueBody | null,
): HandoffResult {
  // Not JSON at all is itself the diagnosis — most often an error page from
  // something that is not this application, which is what a stale APP_URL
  // produces.
  if (body === null) {
    // 508 is the one worth naming. It is the hosting platform refusing to let
    // a deployment invoke itself any deeper, returned by its proxy before this
    // application is reached — so it says nothing about the request and
    // everything about the chain. The run is fine; it just has to be carried
    // on from outside.
    if (status === 508) {
      return {
        outcome: 'refused',
        status,
        reason:
          'the platform refused the hand-off (508 loop detected) — the chain is too deep, ' +
          'so the scheduled resume worker takes it from here',
      };
    }
    return { outcome: 'refused', status, reason: `non-JSON response (${status})` };
  }
  if (!ok) {
    return { outcome: 'refused', status, reason: body.error ?? `HTTP ${status}` };
  }
  if (body.continued === false) {
    return { outcome: 'refused', status, reason: body.reason ?? 'declined' };
  }
  return { outcome: 'accepted', status };
}
