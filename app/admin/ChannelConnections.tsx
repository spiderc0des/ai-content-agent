'use client';
import { useState } from 'react';
import ConfirmButton from '../ConfirmButton';

export interface ConnectionRow {
  channel: string;
  accountLabel: string;
  authorUrn: string | null;
  scopes: string[];
  connectedAt: string;
  expiresAt: string | null;
  invalidSince: string | null;
  lastError: string | null;
}

const CHANNELS = [
  {
    key: 'x',
    label: 'X',
    blurb: 'Needs an X app with OAuth 2.0 and write access.',
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    blurb: 'A company page needs w_organization_social and an admin role on it.',
  },
] as const;

/**
 * Connecting the accounts this app posts to.
 *
 * Three states per channel, and they mean genuinely different things, so the
 * UI says which one it is rather than showing a single on/off:
 *
 *   not set up   — no client id and secret in the environment. Nothing an
 *                  admin can fix from this page; it needs a deploy.
 *   not connected— set up, but nobody has authorised an account yet. Posts
 *                  still queue and release; a person publishes them by hand.
 *   connected    — the app posts for you. Or `needs attention`, when a token
 *                  was revoked and every scheduled post will now fail.
 */
export default function ChannelConnections({
  connections,
  configured,
  notice,
}: {
  connections: ConnectionRow[];
  /** Which channels have client credentials in the environment. */
  configured: Record<string, boolean>;
  /** A message the OAuth callback redirected back with. */
  notice: { kind: 'ok' | 'error'; text: string } | null;
}) {
  const [rows, setRows] = useState(connections);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function connect(channel: string) {
    setBusy(channel);
    setError('');
    try {
      const res = await fetch(`/api/admin/channels/${channel}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      // Full navigation, not a popup: the provider's consent screen refuses to
      // render in an iframe, and a popup is the thing most likely to be
      // blocked at the exact moment someone clicks.
      window.location.href = String(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy('');
    }
  }

  async function disconnect(channel: string) {
    setBusy(channel);
    setError('');
    try {
      const res = await fetch(`/api/admin/channels/${channel}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setRows((prev) => prev.filter((r) => r.channel !== channel));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="mb-6">
      <h2 className="mb-2 font-semibold">Publishing accounts</h2>
      <p className="mb-3 max-w-prose text-sm" style={{ color: 'var(--ink-faint)' }}>
        Connected accounts post automatically. Unconnected ones are released for you to post by hand.
      </p>

      {notice && (
        <p className={`panel ${notice.kind === 'ok' ? 'panel-success' : 'panel-danger'} mb-3 text-sm`}>
          {notice.text}
        </p>
      )}
      {error && <p className="panel panel-danger mb-3 text-sm">{error}</p>}

      <div className="space-y-2">
        {CHANNELS.map((c) => {
          const row = rows.find((r) => r.channel === c.key);
          const isConfigured = configured[c.key] ?? false;
          const needsAttention = Boolean(row?.invalidSince);

          return (
            <div key={c.key} className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {c.label}{' '}
                    {!isConfigured ? (
                      <span className="badge">not set up</span>
                    ) : needsAttention ? (
                      <span className="badge badge-danger">needs attention</span>
                    ) : row ? (
                      <span className="badge badge-success">connected</span>
                    ) : (
                      <span className="badge badge-warning">not connected</span>
                    )}
                  </p>

                  {row ? (
                    <>
                      <p className="mt-1 text-sm" style={{ color: 'var(--ink-soft)' }}>
                        Posts as <strong>{row.accountLabel}</strong>
                        {row.authorUrn && row.authorUrn !== row.accountLabel && (
                          <span style={{ color: 'var(--ink-faint)' }}> · {row.authorUrn}</span>
                        )}
                      </p>
                      <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
                        Connected {new Date(row.connectedAt).toLocaleString()}
                        {row.scopes.length > 0 && ` · ${row.scopes.join(', ')}`}
                      </p>
                      {needsAttention && (
                        <p className="mt-1 text-sm" style={{ color: 'var(--danger)' }}>
                          {row.lastError ?? 'The token was rejected.'} Reconnect — {c.label} posts
                          will fail until you do.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-1 max-w-prose text-sm" style={{ color: 'var(--ink-soft)' }}>
                      {isConfigured
                        ? c.blurb
                        : `${c.blurb} Add its client id and secret first.`}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    className="btn btn-sm"
                    disabled={!isConfigured || busy === c.key}
                    onClick={() => connect(c.key)}
                    title={isConfigured ? '' : 'Needs a client id and secret.'}
                  >
                    {busy === c.key ? 'Opening…' : row ? 'Reconnect' : `Connect ${c.label}`}
                  </button>
                  {row && (
                    <ConfirmButton
                      tone="danger"
                      layout="popover"
                      className="btn-sm"
                      label="Disconnect"
                      confirmLabel="Yes, disconnect"
                      question={`Disconnect ${c.label}?`}
                      detail={`${c.label} posts go back to being published by hand.`}
                      busy={busy === c.key}
                      onConfirm={() => disconnect(c.key)}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-3 max-w-prose text-xs" style={{ color: 'var(--ink-faint)' }}>
        LinkedIn tags appear as plain text, not real mentions — it needs an internal URN, which a
        typed handle is not. On X they are real mentions.
      </p>
    </section>
  );
}
