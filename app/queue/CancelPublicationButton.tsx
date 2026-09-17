'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ConfirmButton from '../ConfirmButton';

/**
 * Take something back out of the publishing queue.
 *
 * The only way to stop a scheduled release before the worker reaches it.
 * Without this the queue is a one-way door: you could schedule a post for
 * Tuesday and then have no way to stop it from inside the app, which makes
 * the scheduling feature riskier to use than not using it.
 */
export default function CancelPublicationButton({
  id,
  channel,
  scheduledFor,
}: {
  id: string;
  channel: string;
  scheduledFor: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        `/api/publications/${id}?reason=${encodeURIComponent('cancelled from the queue')}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0">
      <ConfirmButton
        tone="danger"
        className="btn-sm"
        label="Cancel"
        confirmLabel="Yes, cancel it"
        question={`Cancel the ${channel} publication?`}
        detail={
          scheduledFor
            ? `It will not go out at ${new Date(scheduledFor).toLocaleString()}. The asset is kept — you can queue it again.`
            : 'It will not go out at the next tick. The asset is kept — you can queue it again.'
        }
        busy={busy}
        busyLabel="Cancelling…"
        onConfirm={cancel}
      />
      {error && (
        <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
