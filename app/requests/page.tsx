import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser, AuthError } from '@/lib/auth';
import { listRequests, countRequestsByStatus } from '@/lib/queries';
import StatusPill from '../StatusPill';
import NotAuthorized from '../NotAuthorized';
import DeleteRequestButton from './DeleteRequestButton';

export const dynamic = 'force-dynamic';

/**
 * Lifecycle order, so the tabs read as a pipeline rather than an alphabet.
 * Statuses with nothing in them are left out — eighteen chips, fifteen of them
 * zero, is a filter that hides the three that matter.
 */
const STATUS_ORDER = [
  'draft',
  'blocked',
  'researching',
  'retrieving',
  'selecting',
  'planning',
  'generating',
  'evaluating',
  'revising',
  'awaiting_review',
  'approved',
  'rejected',
  'packaging',
  'ready',
  'queued',
  'published',
  'failed',
  'archived',
];

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) redirect('/login');
    if (err instanceof AuthError) return <NotAuthorized message={err.message} />;
    throw err;
  }

  const seesAll = user.is_reviewer || user.is_publisher || user.is_admin;
  const scope = seesAll ? {} : { authorId: user.id };

  const { status } = await searchParams;
  const counts = await countRequestsByStatus(scope);
  // An unknown or now-empty status falls back to everything rather than
  // rendering an empty list with no way back — a stale bookmark should not
  // look like "you have no requests".
  const active = status && counts[status] ? status : undefined;
  const requests = await listRequests({ ...scope, status: active });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

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

      {total > 0 && (
        <nav className="mb-5 flex flex-wrap gap-2" aria-label="Filter by status">
          <FilterChip label="All" count={total} active={!active} href="/requests" />
          {STATUS_ORDER.filter((s) => counts[s]).map((s) => (
            <FilterChip
              key={s}
              label={s.replace(/_/g, ' ')}
              count={counts[s]}
              active={active === s}
              href={`/requests?status=${s}`}
            />
          ))}
        </nav>
      )}

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

function FilterChip({
  label,
  count,
  active,
  href,
}: {
  label: string;
  count: number;
  active: boolean;
  href: string;
}) {
  return (
    // badge-accent rather than a hand-rolled colour: it is already defined for
    // both themes, and the accent is a pale green in dark mode, so white text
    // on it would be unreadable.
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={active ? 'badge badge-accent' : 'badge'}
      style={{ textDecoration: 'none', fontWeight: active ? 600 : undefined }}
    >
      {label}
      <span style={{ opacity: 0.65, marginLeft: '0.4em' }}>{count}</span>
    </Link>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}
