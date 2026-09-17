import { redirect } from 'next/navigation';
import { requireUser, AuthError } from '@/lib/auth';
import {
  listAppUsers,
  listEmailGroups,
  listChannelConnections,
  usageByStage,
  usageByRequest,
  countRequestsWithUsage,
} from '@/lib/queries';
import NotAuthorized from '../NotAuthorized';
import UserAccessTable, { type Row } from './UserAccessTable';
import InviteForm from './InviteForm';
import EmailGroups, { type GroupRow } from './EmailGroups';
import ChannelConnections from './ChannelConnections';
import UsageCost from './UsageCost';
import { xConfigured, linkedinConfigured, env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * /admin — who can get in, and what they can do once they are in.
 *
 * This closes the last workflow that needed SQL by hand. Signing in creates a
 * pending app_users row; before this page, activating it meant editing an
 * email into sql/03-seed-users.sql and running it against the database —
 * fine for whoever built the app, impossible for anyone else.
 *
 * Gated on is_admin directly rather than through requireUser's capability
 * argument. That is deliberate: is_admin is not a peer of the other three —
 * it bypasses per-request ownership everywhere ownership is checked — so it
 * is never something a route asks for by passing a string.
 */
export default async function AdminPage({
  searchParams,
}: {
  // The OAuth callback redirects back here with the outcome.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    if (err.status === 401) redirect('/login');
    return <NotAuthorized message={err.message} />;
  }

  if (!user.is_admin) {
    return (
      <NotAuthorized message="This page is for admins. Everything your own capabilities allow still works." />
    );
  }

  const [users, groups, connections, byStage, byRequest, requestCount, query] = await Promise.all([
    listAppUsers(),
    listEmailGroups(true),
    listChannelConnections(),
    usageByStage(),
    usageByRequest(8),
    countRequestsWithUsage(),
    searchParams,
  ]);
  const pending = users.filter((u) => !u.active);

  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const connectError = one(query.connect_error);
  const connected = one(query.connected);
  const notice = connectError
    ? { kind: 'error' as const, text: connectError }
    : connected
      ? {
          kind: 'ok' as const,
          text:
            `${connected === 'x' ? 'X' : 'LinkedIn'} is connected as ${one(query.account) ?? 'that account'}.` +
            (one(query.connect_warning)
              ? ' Note: no refresh token was issued, so scheduled posts more than a couple of hours out will need reconnecting.'
              : ''),
        }
      : null;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-6 text-xl font-semibold">Admin</h1>

      <UsageCost byStage={byStage} byRequest={byRequest} requestCount={requestCount} />

      <div className="my-8 border-t" style={{ borderColor: 'var(--rule)' }} />

      <h2 className="mb-1 font-semibold">People &amp; access</h2>
      <p className="mb-6 max-w-prose text-sm" style={{ color: 'var(--ink-faint)' }}>
        Invited people activate on first sign-in. Everyone else stays pending.
      </p>

      <InviteForm />

      {pending.length > 0 && (
        <div className="panel panel-warning mb-6 text-sm">
          <p className="mb-1 font-semibold">
            {pending.length === 1
              ? 'One person is waiting to be let in'
              : `${pending.length} people are waiting to be let in`}
          </p>
          <p>Listed first. Give them capabilities, or leave them inactive.</p>
        </div>
      )}

      <UserAccessTable users={users.map(serialize)} currentUserId={user.id} />

      <div className="my-8 border-t" style={{ borderColor: 'var(--rule)' }} />

      <EmailGroups groups={groups.map(serializeGroup)} />

      <div className="my-8 border-t" style={{ borderColor: 'var(--rule)' }} />

      <ChannelConnections
        connections={connections}
        configured={{ x: xConfigured, linkedin: linkedinConfigured }}
        callbackBase={env.APP_URL.replace(/\/$/, '')}
        notice={notice}
      />



      <div className="card mt-6 text-sm" style={{ color: 'var(--ink-soft)' }}>
        <h2
          className="mb-2 text-xs font-semibold uppercase tracking-wide"
          style={{ color: 'var(--ink-faint)' }}
        >
          Capabilities
        </h2>
        <ul className="flex flex-col gap-1.5">
          <li>
            <b style={{ color: 'var(--ink)' }}>Creator</b> — submits requests, runs the pipeline.
            Sees only their own.
          </li>
          <li>
            <b style={{ color: 'var(--ink)' }}>Reviewer</b> — approves, rejects, revises, selects.
            Nothing publishes without this.
          </li>
          <li>
            <b style={{ color: 'var(--ink)' }}>Publisher</b> — queues and schedules.
          </li>
          <li>
            <b style={{ color: 'var(--ink)' }}>Admin</b> — all of the above on every request, plus
            this page.
          </li>
          <li>
            <b style={{ color: 'var(--ink)' }}>Active</b> — off means they reach nothing. An active
            person needs at least one capability.
          </li>
        </ul>
      </div>
    </div>
  );
}

function serialize(u: Awaited<ReturnType<typeof listAppUsers>>[number]): Row {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    is_creator: u.is_creator,
    is_reviewer: u.is_reviewer,
    is_publisher: u.is_publisher,
    is_admin: u.is_admin,
    active: u.active,
    // Dates cross the Server→Client boundary as strings.
    invited_at: u.invited_at?.toISOString() ?? null,
    invited_by: u.invited_by,
    first_signed_in_at: u.first_signed_in_at?.toISOString() ?? null,
  };
}

function serializeGroup(g: Awaited<ReturnType<typeof listEmailGroups>>[number]): GroupRow {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    // Dates cross the Server→Client boundary as strings.
    archived_at: g.archived_at?.toISOString() ?? null,
    member_count: g.member_count,
    unsubscribed_count: g.unsubscribed_count,
  };
}
