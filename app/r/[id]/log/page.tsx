import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { requireUser, AuthError, canViewRequest } from '@/lib/auth';
import { getRequest, getStageRuns, getEvents } from '@/lib/queries';
import NotAuthorized from '../../../NotAuthorized';

export const dynamic = 'force-dynamic';

/**
 * The debugging surface the brief's failure-handling requirement asks for.
 *
 * stage_runs is the important half: per attempt, it carries the model, the
 * Claude request id, the effort, the token counts, and the exact error. With
 * a request id you can look a single call up on Anthropic's side; without one
 * you are guessing.
 */
export default async function LogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) redirect('/login');
    if (err instanceof AuthError) return <NotAuthorized message={err.message} />;
    throw err;
  }

  const request = await getRequest(id);
  if (!request) notFound();
  if (!canViewRequest(user, request)) {
    return <NotAuthorized message="This request belongs to someone else." />;
  }

  const [runs, events] = await Promise.all([getStageRuns(id), getEvents(id)]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Run log</h1>
        <Link href={`/r/${id}`} className="btn btn-sm">Back to the request</Link>
      </div>

      <section className="mb-8">
        <h2 className="mb-3 font-semibold">Stage runs</h2>
        {runs.length === 0 ? (
          <div className="card text-sm" style={{ color: 'var(--ink-soft)' }}>
            Nothing has run yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--ink-faint)' }}>
                  <Th>Stage</Th>
                  <Th>Try</Th>
                  <Th>Result</Th>
                  <Th>Model</Th>
                  <Th>Effort</Th>
                  <Th>Tokens</Th>
                  <Th>Time</Th>
                  <Th>Request id</Th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--rule)' }}>
                    <Td>{r.stage}</Td>
                    <Td>{r.attempt}</Td>
                    <Td>
                      <span
                        className={
                          r.status === 'ok'
                            ? 'badge badge-success'
                            : r.status === 'failed'
                              ? 'badge badge-danger'
                              : 'badge'
                        }
                      >
                        {r.status}
                      </span>
                      {r.failure_reason && (
                        <div style={{ color: 'var(--danger)' }}>{r.failure_reason}</div>
                      )}
                      {r.error && (
                        <div className="max-w-md" style={{ color: 'var(--ink-soft)' }}>{r.error}</div>
                      )}
                    </Td>
                    <Td>{r.model ?? '—'}</Td>
                    <Td>{r.effort ?? '—'}</Td>
                    <Td>
                      {r.input_tokens !== null
                        ? `${r.input_tokens} in / ${r.output_tokens} out`
                        : '—'}
                      {r.cache_read_tokens ? (
                        <div style={{ color: 'var(--ink-faint)' }}>{r.cache_read_tokens} cached</div>
                      ) : null}
                    </Td>
                    <Td>{r.duration_ms !== null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</Td>
                    <Td>
                      <code className="text-xs">{r.claude_request_id ?? '—'}</code>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Events</h2>
          <p className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            {events.length} entr{events.length === 1 ? 'y' : 'ies'}, newest first
          </p>
        </div>

        {events.length === 0 ? (
          <div className="card text-sm" style={{ color: 'var(--ink-soft)' }}>
            Nothing has been recorded yet.
          </div>
        ) : (
          <ol className="card" style={{ paddingBlock: '0.25rem' }}>
            {events.map((e, i) => (
              <EventRow
                key={e.id}
                event={e}
                // Newest first (getEvents orders by id desc), so the entry
                // BELOW this one in the list is the older one — that is the
                // gap worth showing.
                previousAt={events[i + 1]?.at ?? null}
                last={i === events.length - 1}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-2 text-left text-xs font-semibold">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-2 py-2 align-top">{children}</td>;
}

/**
 * One line of the narrative log.
 *
 * The old version put a status badge, a step name, an actor, a timestamp and
 * a blob of `JSON.stringify(detail)` on one flex row, which wrapped into an
 * unreadable paragraph the moment the detail had more than two keys — and the
 * detail is the part you actually came here to read.
 *
 * So it is a timeline instead: a rail down the left carrying a dot per event,
 * one line of "what happened / who / when", and the detail broken out as
 * labelled pairs. Failures are the only thing that gets colour, because in a
 * log of forty rows where thirty-nine are fine, the one that is not should be
 * findable without reading any of the others.
 */
function EventRow({
  event,
  previousAt,
  last,
}: {
  event: Awaited<ReturnType<typeof getEvents>>[number];
  previousAt: Date | null;
  last: boolean;
}) {
  const pairs = Object.entries(event.detail).filter(
    ([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
  );
  // The gap since the previous event, which is what makes a stall visible.
  // An absolute timestamp on every row cannot show it; you have to subtract.
  const gapMs = previousAt ? event.at.getTime() - previousAt.getTime() : 0;

  return (
    <li className="relative flex gap-3 py-2.5 pl-1" style={{ listStyle: 'none' }}>
      {/* The rail. Stops at the last dot rather than running past it. */}
      {!last && (
        <span
          aria-hidden
          className="absolute left-[9px] top-6 bottom-0 w-px"
          style={{ background: 'var(--rule)' }}
        />
      )}
      <span
        aria-hidden
        className="relative z-10 mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full"
        style={{
          background: event.ok ? 'var(--success)' : 'var(--danger)',
          boxShadow: '0 0 0 3px var(--card)',
        }}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium" style={{ color: event.ok ? 'var(--ink)' : 'var(--danger)' }}>
            {humanStep(event.step)}
          </span>
          {!event.ok && <span className="badge badge-danger">failed</span>}
          {event.stage && event.stage !== stageOfStep(event.step) && (
            <span className="badge">{event.stage}</span>
          )}
          <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>
            {event.actor}
            {' · '}
            {event.at.toLocaleTimeString()}
            {event.duration_ms !== null && ` · took ${formatMs(event.duration_ms)}`}
            {gapMs > 60_000 && ` · ${formatMs(gapMs)} after the last`}
          </span>
        </div>

        {pairs.length > 0 && (
          <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {pairs.map(([key, value]) => (
              <div key={key} className="flex min-w-0 max-w-full gap-1.5">
                <dt style={{ color: 'var(--ink-faint)' }}>{key.replace(/_/g, ' ')}</dt>
                <dd className="min-w-0 break-words font-medium" style={{ color: 'var(--ink-soft)' }}>
                  {formatValue(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

/** `queue_publications` → `Queue publications`. The table stores a key; a
 *  person reads a sentence. */
function humanStep(step: string): string {
  const withoutStage = step.includes(':') ? step.slice(step.indexOf(':') + 1) : step;
  const words = withoutStage.replace(/[_:]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Avoids printing `research` twice when the step already names the stage. */
function stageOfStep(step: string): string {
  return step.split(/[_:]/)[0] ?? '';
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

/**
 * A detail value as one short readable string.
 *
 * Arrays and objects still end up as JSON — but scoped to the one value
 * rather than the whole detail blob, so a long `failures` array does not push
 * the five useful scalars off the row.
 */
function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'string' || typeof v === 'number')
      ? value.join(', ')
      : JSON.stringify(value);
  }
  return JSON.stringify(value);
}
