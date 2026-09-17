import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser, AuthError } from '@/lib/auth';
import { listQueue } from '@/lib/queries';
import NotAuthorized from '../NotAuthorized';
import CancelPublicationButton from './CancelPublicationButton';

export const dynamic = 'force-dynamic';

/** Everything approved and waiting to go out, across every request. */
export default async function QueuePage() {
  try {
    await requireUser('publisher');
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) redirect('/login');
    if (err instanceof AuthError) return <NotAuthorized message={err.message} />;
    throw err;
  }

  const queue = await listQueue();

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Publishing queue</h1>
      <p className="mb-6 text-sm" style={{ color: 'var(--ink-soft)' }}>
        Waiting to be released by the publishing worker.
      </p>

      {queue.length === 0 ? (
        <div className="card text-center" style={{ color: 'var(--ink-soft)' }}>
          Nothing queued.
        </div>
      ) : (
        <ul className="space-y-3">
          {queue.map((p) => (
            <li key={p.id} className="card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge">{p.channel === 'x' ? 'X' : p.channel}</span>
                <span
                  className={
                    p.state === 'failed' ? 'badge badge-danger' : 'badge badge-accent'
                  }
                >
                  {p.state}
                </span>
                <Link href={`/r/${p.request_id}`} className="font-medium no-underline hover:underline">
                  {p.title_hint || p.raw_idea.slice(0, 70)}
                </Link>
                {p.email_group_name && (
                  <span
                    className="text-sm"
                    style={{
                      // An empty list is the one thing worth flagging here: it
                      // will fail at release, and the time to notice is now.
                      color: p.email_group_size === 0 ? 'var(--warning)' : 'var(--ink-soft)',
                    }}
                  >
                    → {p.email_group_name} ({p.email_group_size} recipients)
                  </span>
                )}
                {p.tag_handles.length > 0 && (
                  <span className="text-sm" style={{ color: 'var(--ink-soft)' }}>
                    tagging {p.tag_handles.join(' ')}
                  </span>
                )}
                <span className="ml-auto text-sm" style={{ color: 'var(--ink-faint)' }}>
                  {p.scheduled_for
                    ? `scheduled ${p.scheduled_for.toLocaleString()}`
                    : 'next tick'}
                </span>
                {/* 'publishing' is deliberately excluded: the worker already
                    holds that row and is mid-release, so cancelling it would
                    be a promise the queue cannot keep. */}
                {p.state !== 'publishing' && (
                  <CancelPublicationButton
                    id={p.id}
                    channel={p.channel === 'x' ? 'X' : p.channel}
                    scheduledFor={p.scheduled_for?.toISOString() ?? null}
                  />
                )}
              </div>
              {p.last_error && (
                <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
                  {p.last_error} · {p.attempts} attempt{p.attempts === 1 ? '' : 's'}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
