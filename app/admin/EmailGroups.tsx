'use client';
import { useState } from 'react';
import ConfirmButton from '../ConfirmButton';

export interface GroupRow {
  id: string;
  name: string;
  description: string;
  archived_at: string | null;
  member_count: number;
  unsubscribed_count: number;
}

export interface MemberRow {
  id: string;
  email: string;
  name: string;
  unsubscribed_at: string | null;
}

/**
 * Recipient lists for the newsletter.
 *
 * A group is opened one at a time rather than all expanded: a list can hold
 * hundreds of addresses, and rendering four of those at once turns this page
 * into a scroll. Members are fetched when a group is opened, so the admin page
 * itself stays a single cheap query no matter how big the lists get.
 */
export default function EmailGroups({ groups: initial }: { groups: GroupRow[] }) {
  const [groups, setGroups] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [paste, setPaste] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  async function call(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setError('');
    try {
      const res = await fetch(url, {
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data.error ?? `Request failed (${res.status})`));
      return data as Record<string, unknown>;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function refreshGroups() {
    const data = await call('/api/admin/email-groups', { method: 'GET' });
    if (data) setGroups(data.groups as GroupRow[]);
  }

  async function open(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setMembers([]);
    setPaste('');
    setNotice('');
    setLoadingMembers(true);
    const data = await call(`/api/admin/email-groups/${id}`, { method: 'GET' });
    if (data) setMembers(data.members as MemberRow[]);
    setLoadingMembers(false);
  }

  async function create() {
    setBusy('create');
    const data = await call('/api/admin/email-groups', {
      method: 'POST',
      body: JSON.stringify({ name: newName.trim(), description: newDescription.trim() }),
    });
    setBusy('');
    if (!data) return;
    setNewName('');
    setNewDescription('');
    setCreating(false);
    await refreshGroups();
  }

  async function addMembers(groupId: string) {
    setBusy('add');
    setNotice('');
    const data = await call(`/api/admin/email-groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ text: paste }),
    });
    setBusy('');
    if (!data) return;

    setMembers(data.members as MemberRow[]);
    setPaste('');
    const added = Number(data.added ?? 0);
    const skipped = Number(data.skipped ?? 0);
    const invalid = (data.invalid as string[]) ?? [];
    setNotice(
      [
        `Added ${added} address${added === 1 ? '' : 'es'}.`,
        skipped ? `${skipped} already in the group.` : '',
        // Named, not just counted — so you can fix the typo rather than
        // hunting through the paste for whichever line went missing.
        invalid.length
          ? `Could not read ${invalid.length}: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? '…' : ''}`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    await refreshGroups();
  }

  async function editMember(groupId: string, memberId: string, action: string) {
    setBusy(memberId);
    const data = await call(`/api/admin/email-groups/${groupId}/members`, {
      method: 'PATCH',
      body: JSON.stringify({ member_id: memberId, action }),
    });
    setBusy('');
    if (!data) return;
    setMembers(data.members as MemberRow[]);
    await refreshGroups();
  }

  async function setArchived(groupId: string, archived: boolean) {
    setBusy(groupId);
    const data = await call(`/api/admin/email-groups/${groupId}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !archived }),
    });
    setBusy('');
    if (!data) return;
    if (archived && openId === groupId) setOpenId(null);
    await refreshGroups();
  }

  const live = groups.filter((g) => !g.archived_at);
  const archived = groups.filter((g) => g.archived_at);
  const shown = showArchived ? [...live, ...archived] : live;

  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Email groups</h2>
        {archived.length > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide' : `Show ${archived.length} archived`}
          </button>
        )}
      </div>
      <p className="mb-3 max-w-prose text-sm" style={{ color: 'var(--ink-faint)' }}>
        Recipient lists for the newsletter. Addresses resolve at send, not at queue.
      </p>

      {error && (
        <p className="panel panel-danger mb-3 text-sm">{error}</p>
      )}

      {!creating ? (
        <button className="btn btn-sm mb-3" onClick={() => setCreating(true)}>
          New group
        </button>
      ) : (
        <div className="card mb-3">
          <label className="label" htmlFor="group-name">Name</label>
          <input
            id="group-name"
            className="field"
            value={newName}
            maxLength={80}
            placeholder="Monthly newsletter subscribers"
            onChange={(e) => setNewName(e.target.value)}
            disabled={busy === 'create'}
          />
          <label className="label mt-3" htmlFor="group-description">
            Description <span style={{ color: 'var(--ink-faint)' }}>— optional</span>
          </label>
          <input
            id="group-description"
            className="field"
            value={newDescription}
            maxLength={300}
            placeholder="Everyone who opted in from the site footer"
            onChange={(e) => setNewDescription(e.target.value)}
            disabled={busy === 'create'}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="btn btn-primary btn-sm"
              disabled={busy === 'create' || newName.trim().length < 2}
              onClick={create}
            >
              {busy === 'create' ? 'Creating…' : 'Create group'}
            </button>
            <button className="btn btn-sm" onClick={() => setCreating(false)} disabled={busy === 'create'}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="card text-sm" style={{ color: 'var(--ink-soft)' }}>
          No groups yet. A newsletter needs one before it can be queued.
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((g) => (
            <div key={g.id} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => open(g.id)}
                  aria-expanded={openId === g.id}
                >
                  <p className="font-medium">
                    {openId === g.id ? '▾' : '▸'} {g.name}
                    {g.archived_at && <span className="badge ml-2">archived</span>}
                  </p>
                  {g.description && (
                    <p className="mt-1 text-sm" style={{ color: 'var(--ink-soft)' }}>
                      {g.description}
                    </p>
                  )}
                  <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                    {g.member_count} subscribed
                    {g.unsubscribed_count > 0 && ` · ${g.unsubscribed_count} unsubscribed`}
                  </p>
                </button>

                <div className="shrink-0">
                  {g.archived_at ? (
                    <button
                      className="btn btn-sm"
                      disabled={busy === g.id}
                      onClick={() => setArchived(g.id, false)}
                    >
                      Restore
                    </button>
                  ) : (
                    <ConfirmButton
                      tone="danger"
                      layout="popover"
                      className="btn-sm"
                      label="Archive"
                      confirmLabel="Yes, archive it"
                      question={`Archive “${g.name}”?`}
                      detail="Past sends keep their record. It stops appearing when queueing."
                      busy={busy === g.id}
                      busyLabel="Archiving…"
                      onConfirm={() => setArchived(g.id, true)}
                    />
                  )}
                </div>
              </div>

              {openId === g.id && (
                <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--rule)' }}>
                  <label className="label" htmlFor={`paste-${g.id}`}>
                    Add addresses
                  </label>
                  <textarea
                    id={`paste-${g.id}`}
                    className="field"
                    rows={3}
                    value={paste}
                    onChange={(e) => setPaste(e.target.value)}
                    disabled={busy === 'add'}
                    placeholder={'ada@example.com, grace@example.com\nAda Lovelace <ada@example.com>\nor one per line'}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={busy === 'add' || !paste.trim()}
                      onClick={() => addMembers(g.id)}
                    >
                      {busy === 'add' ? 'Adding…' : 'Add to group'}
                    </button>
                    {notice && (
                      <span className="text-sm" style={{ color: 'var(--ink-soft)' }}>
                        {notice}
                      </span>
                    )}
                  </div>

                  {loadingMembers ? (
                    <p className="mt-4 text-sm" style={{ color: 'var(--ink-faint)' }}>
                      Loading…
                    </p>
                  ) : members.length === 0 ? (
                    <p className="mt-4 text-sm" style={{ color: 'var(--ink-faint)' }}>
                      Empty.
                    </p>
                  ) : (
                    <ul className="mt-4 space-y-1 text-sm">
                      {members.map((m) => (
                        <li key={m.id} className="flex flex-wrap items-center gap-2">
                          <span
                            className="min-w-0 flex-1 truncate"
                            style={{
                              color: m.unsubscribed_at ? 'var(--ink-faint)' : 'var(--ink)',
                              textDecoration: m.unsubscribed_at ? 'line-through' : undefined,
                            }}
                          >
                            {m.name ? `${m.name} · ` : ''}
                            {m.email}
                          </span>
                          {m.unsubscribed_at ? (
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={busy === m.id}
                              onClick={() => editMember(g.id, m.id, 'resubscribe')}
                            >
                              Resubscribe
                            </button>
                          ) : (
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={busy === m.id}
                              onClick={() => editMember(g.id, m.id, 'unsubscribe')}
                              title="Keeps them on record so an import cannot add them back."
                            >
                              Unsubscribe
                            </button>
                          )}
                          <ConfirmButton
                            tone="danger"
                            layout="popover"
                            className="btn-sm"
                            label="Remove"
                            confirmLabel="Yes, remove"
                            question={`Remove ${m.email}?`}
                            detail="Unsubscribe instead if they asked to stop."
                            busy={busy === m.id}
                            onConfirm={() => editMember(g.id, m.id, 'remove')}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
