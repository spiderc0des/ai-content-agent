import { requireUser, AuthError } from '@/lib/auth';
import { redirect } from 'next/navigation';
import NotAuthorized from '../NotAuthorized';
import RequestForm from './RequestForm';

export const dynamic = 'force-dynamic';

export default async function NewRequestPage() {
  try {
    await requireUser('creator');
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) redirect('/login');
    if (err instanceof AuthError) return <NotAuthorized message={err.message} />;
    throw err;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-xl font-semibold">New content request</h1>
      <p className="mb-6 text-sm" style={{ color: 'var(--ink-soft)' }}>
        An idea and an audience are enough.
      </p>
      <RequestForm />
    </div>
  );
}
