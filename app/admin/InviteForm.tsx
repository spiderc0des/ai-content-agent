'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

const CAPS = [
  { key: 'is_creator', label: 'Creator' },
  { key: 'is_reviewer', label: 'Reviewer' },
  { key: 'is_publisher', label: 'Publisher' },
  { key: 'is_admin', label: 'Admin' },
] as const;

type Caps = Record<(typeof CAPS)[number]['key'], boolean>;

/**
 * Invite someone by email. Capabilities are chosen now and stored on the
 * pending account, so activating them later is one tick rather than a second
 * round of decisions.
 *
 * The sign-in link comes back here rather than being emailed — this app has
 * no mail provider configured, and adding one would mean new required
 * configuration for everyone running it, to automate a step an admin does a
 * handful of times. The link signs its holder in, so the panel says so.
 */
export default function InviteForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [caps, setCaps] = useState<Caps>({
    is_creator: true,
    is_reviewer: false,
    is_publisher: false,
    is_admin: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ email: string; link: string; resent: boolean } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const noCapability = !Object.values(caps).some(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    setCopied(false);
    try {
      const res = await fetch('/api/admin/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, full_name: fullName, ...caps }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);

      setResult({ email, link: data.link, resent: Boolean(data.resent) });
      setEmail('');
      setFullName('');
      setCaps({ is_creator: true, is_reviewer: false, is_publisher: false, is_admin: false });
      router.refresh(); // the new pending row appears in the list below
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="card mb-6">
      <h2 className="mb-1 text-sm font-semibold">Invite someone</h2>
      <p className="mb-4 text-xs" style={{ color: 'var(--ink-faint)' }}>
        Emails them a sign-in link. They activate on first use, with the capabilities you pick here.
      </p>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="label">
              Full name <span style={{ color: 'var(--danger)' }}>*</span>
            </span>
            <input
              required
              maxLength={120}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="field"
              disabled={busy}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label">
              Email <span style={{ color: 'var(--danger)' }}>*</span>
            </span>
            <input
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
              disabled={busy}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <span className="label">Capabilities</span>
          {CAPS.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={caps[c.key]}
                onChange={(e) => setCaps((prev) => ({ ...prev, [c.key]: e.target.checked }))}
                disabled={busy}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>

        {noCapability && (
          <p className="hint" style={{ color: 'var(--warning)' }}>
            At least one, or they reach nothing.
          </p>
        )}

        <div>
          <button type="submit" disabled={busy || noCapability} className="btn btn-primary btn-sm">
            {busy ? 'Creating invite…' : 'Create invite'}
          </button>
        </div>
      </form>

      {error && (
        <p className="mt-3 text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {result && (
        <div className="panel panel-success mt-4 text-sm">
          <p className="mb-2">
            {result.resent ? 'New link for ' : 'Invited '}
            <b>{result.email}</b>. They are activated the moment they use it — no further step
            from you.
          </p>
          <p className="mb-2">
            Send them this link privately — <b>it signs them in</b>, so treat it like a password.
            It expires.
          </p>
          <div className="flex items-start gap-2">
            <code
              className="flex-1 break-all rounded p-2 text-xs"
              style={{ background: 'var(--paper)' }}
            >
              {result.link}
            </code>
            <button
              type="button"
              onClick={() => copy(result.link)}
              className="btn btn-ghost btn-sm shrink-0"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
