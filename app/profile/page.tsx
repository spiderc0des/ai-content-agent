import { redirect } from 'next/navigation';
import { sessionEmail, currentUser } from '@/lib/auth';
import { capabilityLabel } from '@/lib/permissions';

export const dynamic = 'force-dynamic';

/**
 * Who you are signed in as, what that lets you do, and the way out.
 *
 * Deliberately reachable by someone with a session but NO activated row —
 * that person can reach nothing else in the app, and this is the page that
 * tells them why and lets them sign out to try another account. Gating it on
 * an activated user would strand exactly the people who most need it.
 */
export default async function ProfilePage() {
  const email = await sessionEmail();
  if (!email) redirect('/login');

  const user = await currentUser();

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold">Your account</h1>
      <p className="mb-6 text-sm" style={{ color: 'var(--ink-soft)' }}>
        Signed in as {email}.
      </p>

      <div className="card space-y-4">
        <div>
          <p className="label">Email</p>
          <p className="text-sm">{email}</p>
        </div>

        <div>
          <p className="label">Access</p>
          {user ? (
            <p className="text-sm">
              <span className="badge badge-accent">{capabilityLabel(user)}</span>
            </p>
          ) : (
            <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
              Not activated yet.
            </p>
          )}
        </div>

        {user && (
          <div>
            <p className="label">What that means</p>
            <ul className="list-disc pl-5 text-sm" style={{ color: 'var(--ink-soft)' }}>
              {user.is_creator && <li>Submit content requests and run the pipeline.</li>}
              {user.is_reviewer && <li>Approve, reject, revise or select at the review gate.</li>}
              {user.is_publisher && <li>Queue and schedule approved content.</li>}
              {user.is_admin && <li>Everything above, on anyone&apos;s request, plus the Admin page.</li>}
            </ul>
          </div>
        )}
      </div>

      {!user && (
        <div className="panel panel-warning mt-4">
          <strong>This account is not activated yet.</strong>
          <p className="mt-1">
            You can sign in, but reach nothing until an admin activates you.
          </p>
        </div>
      )}

      <form action="/auth/signout" method="post" className="mt-6">
        <button className="btn" type="submit">
          Sign out
        </button>
      </form>
    </div>
  );
}
