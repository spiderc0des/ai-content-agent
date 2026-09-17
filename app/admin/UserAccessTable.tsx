'use client';
import { useState } from 'react';

export interface Row {
  id: string;
  email: string;
  full_name: string;
  is_creator: boolean;
  is_reviewer: boolean;
  is_publisher: boolean;
  is_admin: boolean;
  active: boolean;
  invited_at: string | null;
  invited_by: string | null;
  first_signed_in_at: string | null;
}

const CAPS = [
  { key: 'is_creator', label: 'Creator' },
  { key: 'is_reviewer', label: 'Reviewer' },
  { key: 'is_publisher', label: 'Publisher' },
  { key: 'is_admin', label: 'Admin' },
] as const;

/**
 * Edits are staged, not live.
 *
 * Ticking a checkbox changes local state only; nothing is written until Save
 * on that row. Three reasons, none of them fussiness:
 *
 *   • An active person must hold at least one capability (the database
 *     enforces it). Clearing the last one to swap it for a different one
 *     would, with live writes, be rejected halfway through a legitimate
 *     change.
 *   • Removing your own admin is a real decision. Staging gives it a confirm
 *     step instead of making it one stray click.
 *   • A row that failed to save keeps what you ticked, so you fix the one
 *     thing that was wrong rather than redoing all four.
 */
export default function UserAccessTable({
  users,
  currentUserId,
}: {
  users: Row[];
  currentUserId: string;
}) {
  const [rows, setRows] = useState(users);
  const [draft, setDraft] = useState<Record<string, Partial<Row>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  /** The row as it would be saved: stored values with any staged edits over them. */
  const pending = (row: Row): Row => ({ ...row, ...draft[row.id] });

  const isDirty = (row: Row): boolean => {
    const d = pending(row);
    return (
      d.is_creator !== row.is_creator ||
      d.is_reviewer !== row.is_reviewer ||
      d.is_publisher !== row.is_publisher ||
      d.is_admin !== row.is_admin ||
      d.active !== row.active
    );
  };

  function stage(id: string, patch: Partial<Row>) {
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    setErrors((prev) => ({ ...prev, [id]: '' }));
    setSaved(null);
  }

  function discard(id: string) {
    setDraft((prev) => {
      const { [id]: _dropped, ...rest } = prev;
      return rest;
    });
    setErrors((prev) => ({ ...prev, [id]: '' }));
    setConfirming(null);
  }

  async function save(row: Row) {
    const next = pending(row);

    // Dropping your own admin is the one change that can take away your
    // access to this page. Confirmed rather than blocked: with another active
    // admin it is a legitimate thing to do, and the API refuses it outright
    // when you would be locking yourself out.
    if (row.id === currentUserId && row.is_admin && !next.is_admin && confirming !== row.id) {
      setConfirming(row.id);
      return;
    }
    setConfirming(null);
    setBusy(row.id);
    setErrors((prev) => ({ ...prev, [row.id]: '' }));
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: row.id,
          is_creator: next.is_creator,
          is_reviewer: next.is_reviewer,
          is_publisher: next.is_publisher,
          is_admin: next.is_admin,
          active: next.active,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);

      // Take the saved row back from the server rather than assuming the
      // draft landed as sent.
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...data.user } : r)));
      discard(row.id);
      setSaved(row.id);
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [row.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(null);
    }
  }

  // Pending people first — they are the ones waiting on a decision.
  const ordered = [...rows].sort((a, b) => Number(a.active) - Number(b.active));

  return (
    <div className="space-y-3">
      {ordered.map((row) => {
        const next = pending(row);
        const dirty = isDirty(row);
        const noCapability =
          !next.is_creator && !next.is_reviewer && !next.is_publisher && !next.is_admin;
        const invalid = next.active && noCapability;

        return (
          <div key={row.id} className="card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">
                  {row.full_name || row.email}
                  {row.id === currentUserId && <span className="chip ml-2">you</span>}
                </p>
                {/* Only when it adds something. Someone who signed themselves
                    in has no name yet, and printing their address twice reads
                    as a rendering bug rather than as a missing field. */}
                {row.full_name && (
                  <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
                    {row.email}
                  </p>
                )}
                <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                  {row.active ? (
                    <span className="badge badge-success">active</span>
                  ) : row.first_signed_in_at ? (
                    <span className="badge badge-warning">waiting on you</span>
                  ) : row.invited_at ? (
                    <span className="badge">invited</span>
                  ) : (
                    <span className="badge">pending</span>
                  )}
                  {row.invited_by && ` · invited by ${row.invited_by}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {dirty && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => discard(row.id)}
                    disabled={busy === row.id}
                  >
                    Discard
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => save(row)}
                  disabled={busy === row.id || !dirty || invalid}
                  title={
                    invalid
                      ? 'Needs at least one capability.'
                      : !dirty
                        ? 'Nothing changed.'
                        : ''
                  }
                >
                  {busy === row.id ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={next.active}
                  onChange={(e) => stage(row.id, { active: e.target.checked })}
                  disabled={busy === row.id}
                />
                <span className="font-medium">Active</span>
              </label>
              {CAPS.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={next[c.key]}
                    onChange={(e) => stage(row.id, { [c.key]: e.target.checked })}
                    disabled={busy === row.id}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>

            {invalid && (
              <p className="hint" style={{ color: 'var(--warning)' }}>
                An active person needs at least one capability.
              </p>
            )}

            {confirming === row.id && (
              <div className="panel panel-warning mt-3 text-sm">
                <p className="mb-2">
                  <strong>Remove your own admin access?</strong> You lose this page.
                </p>
                <div className="flex gap-2">
                  <button className="btn btn-danger btn-sm" onClick={() => save(row)}>
                    Yes, remove it
                  </button>
                  <button className="btn btn-sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {errors[row.id] && (
              <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
                {errors[row.id]}
              </p>
            )}
            {saved === row.id && (
              <p className="mt-2 text-sm" style={{ color: 'var(--success)' }}>
                Saved.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
