'use client';
import { useState } from 'react';

/**
 * The way out of a research block.
 *
 * Shown when the pipeline found real sources and could not read any of them.
 * It asks for TEXT, not a URL to go and fetch — a URL would hit the same wall
 * that caused the block in the first place. The person can see the page; the
 * fetcher cannot. That asymmetry is the whole point, and it is the one thing
 * a human can contribute here that no amount of retrying will produce.
 *
 * What gets pasted is held to the same standard as a fetched page: it is
 * digested into exact-quote excerpts, ranked by selection, and every claim
 * still has to resolve to one of those excerpts or it is downgraded. Pasting
 * does not buy a shortcut past grounding; it only supplies the raw material.
 */
export default function AddSourceForm({
  requestId,
  onDone,
}: {
  requestId: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const characters = text.trim().length;
  const tooShort = characters > 0 && characters < 200;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/requests/${requestId}/sources`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), text: text.trim(), url: url.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setOpen(false);
      setTitle('');
      setUrl('');
      setText('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-primary btn-sm mt-3" onClick={() => setOpen(true)}>
        Add a source
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--rule)', background: 'var(--card)' }}>
      <p className="mb-3 text-sm" style={{ color: 'var(--ink-soft)' }}>
        Open a source above, copy its text, paste it here.
      </p>

      <label className="label" htmlFor="src-title">
        Title
      </label>
      <input
        id="src-title"
        className="field"
        value={title}
        maxLength={200}
        placeholder="Frontiers — AI-assisted writing revision in an undergraduate course"
        onChange={(e) => setTitle(e.target.value)}
        disabled={busy}
      />

      <label className="label mt-3" htmlFor="src-url">
        Source URL <span style={{ color: 'var(--ink-faint)' }}>— optional</span>
      </label>
      <input
        id="src-url"
        className="field"
        type="url"
        value={url}
        placeholder="https://…"
        onChange={(e) => setUrl(e.target.value)}
        disabled={busy}
      />

      <label className="label mt-3" htmlFor="src-text">
        The text
      </label>
      <textarea
        id="src-text"
        className="field"
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        placeholder="The article's own words, not navigation or cookie notices."
      />
      <p className="hint" style={{ color: tooShort ? 'var(--warning)' : 'var(--ink-faint)' }}>
        {characters === 0
          ? 'At least 200 characters.'
          : `${characters.toLocaleString()} characters${tooShort ? ' — not enough yet.' : ''}`}
      </p>

      {error && (
        <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || title.trim().length < 2 || characters < 200}
          onClick={submit}
        >
          {busy ? 'Adding…' : 'Add and continue'}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
