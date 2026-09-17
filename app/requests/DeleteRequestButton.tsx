'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ConfirmButton from '../ConfirmButton';

/**
 * Soft-delete a request from the list.
 *
 * Lives inside the list item's <Link>, so every click has to stop
 * propagation — otherwise confirming also navigates into the request being
 * deleted.
 */
export default function DeleteRequestButton({
  id,
  label,
  status,
}: {
  id: string;
  label: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/requests/${id}`, { method: 'DELETE' });
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
    <div
      className="shrink-0"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <ConfirmButton
        tone="danger"
        layout="popover"
        className="btn-sm"
        label="Delete"
        confirmLabel="Yes, delete it"
        question={`Delete “${label}”?`}
        detail={
          status === 'published'
            ? 'This has already been published, so deleting it here would not unpublish anything.'
            : 'It disappears from your lists. The run log, reviews and every draft are kept — they are the record of what was approved and why, so nothing is actually destroyed.'
        }
        busy={busy}
        busyLabel="Deleting…"
        onConfirm={remove}
      />
      {error && (
        <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
