import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser, AuthError } from '@/lib/auth';
import { listRequests } from '@/lib/queries';
import StatusPill from '../StatusPill';
import NotAuthorized from '../NotAuthorized';
import DeleteRequestButton from './DeleteRequestButton';

export const dynamic = 'force-dynamic';

export default async function RequestsPage() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) redirect('/login');
    if (err instanceof AuthError) return <NotAuthorized message={err.message} />;
    throw err;
  }

  const seesAll = user.is_reviewer || user.is_publisher || user.is_admin;
  const requests = await listRequests(seesAll ? {} : { authorId: user.id });

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Content requests</h1>
          <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
            {seesAll ? 'Every request.' : 'Requests you created.'}
          </p>
        </div>
        <Link href="/new" className="btn btn-primary">New request</Link>
      </div>

      {requests.length === 0 ? (
        <div className="card text-center" style={{ color: 'var(--ink-soft)' }}>
          <p className="mb-4">Nothing here yet.</p>
          <Link href="/new" className="btn btn-primary">Create the first request</Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {requests.map((r) => (
            <li key={r.id}>
              <Link href={`/r/${r.id}`} className="card card-link">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{r.title_hint || truncate(r.raw_idea, 90)}</p>
                    <p className="mt-1 text-sm" style={{ color: 'var(--ink-soft)' }}>
                      For {r.target_audience}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {r.status === 'failed' && r.failed_stage && (
                      <span className="badge badge-danger">{r.failed_stage} failed</span>
                    )}
                    <StatusPill status={r.status} />
                    {(r.author_id === user.id || user.is_admin) && r.status !== 'published' && (
                      <DeleteRequestButton
                        id={r.id}
                        label={r.title_hint || truncate(r.raw_idea, 50)}
                        status={r.status}
                      />
                    )}
                  </div>
                </div>
                <p className="mt-3 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  Updated {r.updated_at.toLocaleString()}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}
