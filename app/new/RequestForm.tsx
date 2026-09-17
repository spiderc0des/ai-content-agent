'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CHANNELS, type Channel } from '@/lib/schemas';
import { SAMPLES, type Sample } from '@/lib/samples';
import { dateTimeLocalBounds } from '@/lib/validation';

/**
 * The three fields the brief requires are marked required; the rest are ours.
 *
 * The interesting behaviour is the blocked path: when the pre-flight audit
 * says the idea cannot be worked, this form shows the clarifying questions
 * instead of navigating away, so the person can fix the idea while it is
 * still in front of them.
 */
interface AuditResult {
  ok: boolean;
  status: string;
  message: string;
  detail?: { readiness?: string; questions?: number };
}

export default function RequestForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<{ id: string; audit: AuditResult } | null>(null);

  const [values, setValues] = useState({
    raw_idea: '',
    target_audience: '',
    source_url: '',
    supporting_notes: '',
    title_hint: '',
    primary_keyword: '',
    secondary_keywords: '',
    desired_tone: '',
    word_count_target: '',
    option_count: '3',
    deadline_at: '',
  });
  const [channels, setChannels] = useState<Channel[]>([...CHANNELS]);
  const deadlineBounds = dateTimeLocalBounds('future', 2);

  /** Drop a ready-made request into the form, so a real run is one click away. */
  function useSample(sample: Sample) {
    setValues({
      raw_idea: sample.raw_idea,
      target_audience: sample.target_audience,
      source_url: sample.source_url ?? '',
      supporting_notes: sample.supporting_notes ?? '',
      title_hint: '',
      primary_keyword: sample.primary_keyword ?? '',
      secondary_keywords: '',
      desired_tone: sample.desired_tone ?? '',
      word_count_target: '',
      option_count: String(sample.option_count),
      deadline_at: '',
    });
    setChannels([...sample.channels_wanted]);
    setError('');
    setIssues([]);
  }

  const set = (k: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setIssues([]);
    setBlocked(null);

    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...values,
        source_url: values.source_url.trim(),
        secondary_keywords: values.secondary_keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        word_count_target: values.word_count_target || null,
        option_count: values.option_count,
        // datetime-local gives local wall-clock with no zone; toISOString
        // resolves it against the browser's own offset, which is what the
        // person actually meant.
        deadline_at: values.deadline_at ? new Date(values.deadline_at).toISOString() : null,
        channels_wanted: channels,
      }),
    });
    const data = await res.json();
    setBusy(false);

    if (!res.ok) {
      setError(data.error ?? 'Something went wrong.');
      setIssues(data.issues ?? []);
      return;
    }
    if (data.status === 'blocked') {
      setBlocked({ id: data.id, audit: data.audit });
      return;
    }
    // Start the pipeline on the way out, so "create" IS the one button. The
    // request page then just follows the run — it does not have to be asked
    // to start it, and the next thing that needs a person is the review.
    //
    // Deliberately not awaited for its result beyond firing: /start answers in
    // milliseconds and the work continues server-side regardless, so there is
    // nothing worth making the user wait here for.
    await fetch(`/api/requests/${data.id}/start`, { method: 'POST' }).catch(() => {
      // If this does not land, the request page shows a Run button. Not worth
      // blocking navigation over.
    });

    router.push(`/r/${data.id}`);
  }

  if (blocked) {
    return (
      <div className="space-y-4">
        <div className="panel panel-warning">
          <strong>This request needs more to work with.</strong>
          <p className="mt-1">{blocked.audit.message}</p>
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          The request is saved. Open it to see the questions.
        </p>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setBlocked(null)}>Edit here</button>
          <a className="btn btn-primary" href={`/r/${blocked.id}`}>Open the request</a>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {/* Start from something real. A blank box is a bad demo: you can only
          judge the output if you already have an opinion about the topic. */}
      <div className="card">
        <p className="label">Start from an example</p>
        <div className="flex flex-wrap gap-2">
          {SAMPLES.map((sample) => (
            <button
              key={sample.id}
              type="button"
              className="btn btn-sm"
              onClick={() => useSample(sample)}
              title={`${sample.note}  (${sample.expect})`}
            >
              {sample.label}
            </button>
          ))}
        </div>
        <p className="hint mt-2">
          Fills the form below. Edit before running.
        </p>
      </div>

      <div className="card space-y-4">
        <div>
          <label className="label" htmlFor="raw_idea">The idea <span style={{ color: 'var(--danger)' }}>*</span></label>
          <textarea
            id="raw_idea" className="field" required minLength={10} rows={3}
            value={values.raw_idea} onChange={set('raw_idea')}
            placeholder="What should this article be about?"
          />
          <p className="hint">The more specific, the less generic the result.</p>
        </div>

        <div>
          <label className="label" htmlFor="target_audience">Target audience <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input
            id="target_audience" className="field" required
            value={values.target_audience} onChange={set('target_audience')}
            placeholder="Heads of talent at 50–200 person companies"
          />
        </div>

        <div>
          <label className="label" htmlFor="source_url">Source URL</label>
          <input
            id="source_url" className="field" type="url" inputMode="url"
            value={values.source_url} onChange={set('source_url')}
            placeholder="https://…"
          />
          <p className="hint">The agent grounds the article in it as well as what it finds.</p>
        </div>

        <div>
          <label className="label" htmlFor="supporting_notes">Supporting material</label>
          <textarea
            id="supporting_notes" className="field" rows={3}
            value={values.supporting_notes} onChange={set('supporting_notes')}
            placeholder="An angle you want, or a claim to avoid."
          />
        </div>
      </div>

      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold" style={{ color: 'var(--ink-soft)' }}>
          Sharpen it (optional)
        </summary>
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="primary_keyword">Primary keyword</label>
              <input id="primary_keyword" className="field" value={values.primary_keyword} onChange={set('primary_keyword')} />
              <p className="hint">Left empty, the agent proposes one.</p>
            </div>
            <div>
              <label className="label" htmlFor="secondary_keywords">Secondary keywords</label>
              <input id="secondary_keywords" className="field" value={values.secondary_keywords} onChange={set('secondary_keywords')} placeholder="comma, separated" />
            </div>
            <div>
              <label className="label" htmlFor="desired_tone">Tone</label>
              <input id="desired_tone" className="field" value={values.desired_tone} onChange={set('desired_tone')} placeholder="Direct, warm, no jargon" />
            </div>
            <div>
              <label className="label" htmlFor="word_count_target">Target word count</label>
              <input
                id="word_count_target" className="field" type="number"
                min={200} max={5000} step={50}
                value={values.word_count_target} onChange={set('word_count_target')}
              />
              <p className="hint">Between 200 and 5000.</p>
            </div>
            <div>
              <label className="label" htmlFor="deadline_at">Deadline</label>
              <input
                id="deadline_at" className="field" type="datetime-local"
                // Bounded to the future, matching the server rule. A deadline
                // that has already passed cannot be met, and nothing
                // downstream would ever flag it — the review queue just sorts
                // it to the top and leaves it there.
                min={deadlineBounds.min}
                max={deadlineBounds.max}
                value={values.deadline_at} onChange={set('deadline_at')}
              />
              <p className="hint">Optional. Must be in the future — it orders the review queue.</p>
            </div>
            <div>
              <label className="label" htmlFor="option_count">Article options</label>
              <select id="option_count" className="field" value={values.option_count} onChange={set('option_count')}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <p className="hint">Distinct angles to choose between.</p>
            </div>
          </div>

          <div>
            <span className="label">Channels</span>
            <div className="flex flex-wrap gap-3">
              {CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox" checked={channels.includes(c)}
                    onChange={(e) =>
                      setChannels((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))
                    }
                  />
                  {c === 'x' ? 'X' : c === 'linkedin' ? 'LinkedIn' : 'Newsletter'}
                </label>
              ))}
            </div>
          </div>
        </div>
      </details>

      {error && (
        <div className="panel panel-danger">
          {error}
          {issues.length > 0 && (
            <ul className="mt-2 list-disc pl-5">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={busy || channels.length === 0}>
          {busy ? 'Starting…' : 'Create and run'}
        </button>
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          Runs on its own. The next step that needs you is the review.
        </p>
      </div>
    </form>
  );
}
