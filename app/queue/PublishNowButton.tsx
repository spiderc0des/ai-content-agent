'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ConfirmButton from '../ConfirmButton';

/**
 * Release one publication without waiting for the worker.
 *
 * Confirmed, because it is the point of no return: the queue can be cancelled
 * right up until this, and not afterwards. The confirmation names the channel
 * so it is clear which one is about to go.
 */
export default function PublishNowButton({
  id,
  channel,
  recipients,
}: {
  id: string;
  channel: string;
  /** Newsletter only — how many addresses it will actually reach. */
  recipients: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function publish() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/publications/${id}/publish`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      // A release failure is NOT shown here. The route answers 200 with
      // ok:false and the row's own `last_error` already carries the reason —
      // setting it here too printed the identical sentence twice, once under
      // the button and once under the row.
      //
      // Only a request that never got an answer needs its own message, which
      // is the catch below: that one is nowhere else.
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
        tone="primary"
        layout="popover"
        className="btn-sm"
        label="Publish now"
        confirmLabel="Yes, send it"
        question={`Publish the ${channel} post now?`}
        detail={
          recipients !== null
            ? `Goes to ${recipients} recipient${recipients === 1 ? '' : 's'}. This cannot be undone.`
            : 'This cannot be undone.'
        }
        busy={busy}
        busyLabel="Sending…"
        onConfirm={publish}
      />
      {error && (
        <p className="mt-1 max-w-xs text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
