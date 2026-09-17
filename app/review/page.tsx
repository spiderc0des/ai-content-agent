import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser, AuthError } from '@/lib/auth';
import { listAwaitingReview } from '@/lib/queries';
import NotAuthorized from '../NotAuthorized';

export const dynamic = 'force-dynamic';

/** Everything sitting at the human gate — the reviewer's whole job, in a list. */
export default async function ReviewQueuePage() {
  try {
    await requireUser('reviewer');
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) redirect('/login');
    if (err instanceof AuthError) return <NotAuthorized message={err.message} />;
    throw err;
  }

  const requests = await listAwaitingReview();

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">Awaiting review</h1>
      <p className="mb-6 text-sm" style={{ color: 'var(--ink-soft)' }}>
        Nothing publishes until approved here.
      </p>

      {requests.length === 0 ? (
        <div className="card text-center" style={{ color: 'var(--ink-soft)' }}>
          Nothing is waiting on you.
        </div>
      ) : (
        <ul className="space-y-3">
          {requests.map((r) => (
            <li key={r.id}>
              <Link href={`/r/${r.id}`} className="card card-link">
                <p className="font-medium">{r.title_hint || r.raw_idea}</p>
                <p className="mt-1 text-sm" style={{ color: 'var(--ink-soft)' }}>
                  For {r.target_audience} · {r.option_count} options
                  {r.revision_round > 0 && ` · revised ${r.revision_round}×`}
                </p>
                {r.deadline_at && (
                  <p className="mt-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
                    Due {r.deadline_at.toLocaleDateString()}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
