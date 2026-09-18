'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import MarkdownBody from '../../MarkdownBody';
import ConfirmButton from '../../ConfirmButton';
import AddSourceForm from './AddSourceForm';
import { dateTimeLocalBounds, tagHandles, firstIssue } from '@/lib/validation';
import { CRITERION_LABELS, type RubricCriterion } from '@/lib/schemas';

/* ─── The shape the Server Component hands down ──────────────────────────── */

interface RuleCheckView {
  label: string;
  pass: boolean;
  detail: string;
  required: boolean;
}

/** What GET /api/requests/:id/status returns, polled while a run is going. */
export interface PipelineStatus {
  status: string;
  version: number;
  progress: number;
  running: boolean;
  runningSince: string | null;
  nextStage: string | null;
  needsReview: boolean;
  failedStage: string | null;
  failedReason: string | null;
  revisionRound: number;
  maxRevisionRounds: number;
  stages: { stage: string; attempt: number; status: string; seconds: number | null }[];
}

export interface WorkspaceData {
  request: {
    id: string;
    version: number;
    status: string;
    rawIdea: string;
    titleHint: string;
    targetAudience: string;
    sourceUrl: string | null;
    primaryKeyword: string;
    secondaryKeywords: string[];
    supportingNotes: string;
    desiredTone: string;
    wordCountTarget: number | null;
    optionCount: number;
    researchDepth: string;
    publicToken: string | null;
    views: { total: number; last7: number; lastViewedAt: string | null } | null;
    deadlineAt: string | null;
    createdAt: string;
    readiness: string | null;
    clarifyingQuestions: string[];
    blockingReason: string | null;
    failedStage: string | null;
    failedReason: string | null;
    revisionRound: number;
    maxRevisionRounds: number;
    selectedArticleId: string | null;
    approvedVersionId: string | null;
    channelsWanted: string[];
    progress: number;
    nextStage: string | null;
    updatedAt: string;
    lastRun: { stage: string; status: string; startedAt: string; finishedAt: string | null } | null;
    /** True while a server-side driver holds this request's pipeline lock. */
    running: boolean;
  };
  capabilities: { canRun: boolean; canReview: boolean; canPublish: boolean };
  plan: { primaryKeyword: string; secondaryKeywords: string[]; thesis: string } | null;
  sourceCount: number;
  excerptCount: number;
  selectedExcerptCount: number;
  allSources: {
    id: string;
    title: string;
    url: string | null;
    domain: string | null;
    status: string;
    error: string | null;
  }[];
  options: {
    articleId: string;
    optionIndex: number;
    angle: string;
    discarded: boolean;
    version: {
      id: string;
      revisionNo: number;
      origin: string;
      title: string;
      dek: string;
      bodyMd: string;
      wordCount: number;
      seoPass: boolean | null;
      seoChecks: RuleCheckView[];
      assumptions: string[];
      gaps: string[];
    } | null;
    history: {
      id: string;
      revisionNo: number;
      origin: string;
      instruction: string | null;
      wordCount: number;
      createdAt: string;
    }[];
    evaluation: {
      status: string;
      overallScore: number;
      summary: string;
      scores: { criterion: string; score: number; note: string }[];
      unsupportedClaims: { claim_text: string; why: string }[];
      sectionsNeedingRevision: { section_key: string; problem: string }[];
      recommendedChanges: string[];
    } | null;
    sources: { id: string; title: string; url: string | null; domain: string | null; claim_count: number }[];
    claims: { claimText: string; sectionKey: string; support: string }[];
  }[];
  assets: {
    id: string;
    channel: string;
    assetNo: number;
    body: string;
    subject: string | null;
    preheader: string | null;
    cta: string;
    hashtags: string[];
    rulesPass: boolean;
    rulesChecks: RuleCheckView[];
  }[];
  publications: {
    id: string;
    channel: string;
    state: string;
    scheduledFor: string | null;
    publishedAt: string | null;
    lastError: string | null;
    attempts: number;
    emailGroupName: string | null;
    tagHandles: string[];
    recipientCount: number | null;
  }[];
  /** Live recipient lists, for the newsletter picker. Admin-managed. */
  emailGroups: { id: string; name: string; memberCount: number }[];
  reviews: {
    id: number;
    action: string;
    note: string;
    instruction: string | null;
    by: string;
    optionIndex: number | null;
    fromStatus: string;
    toStatus: string;
    at: string;
  }[];
}

/**
 * How often an open page asks the server where the run is.
 *
 * Five seconds. It was two minutes, on the reasoning that the work takes ten
 * to fifteen minutes so a tighter loop buys nothing — which was wrong twice
 * over. Stages finish in 40 to 200 seconds, so a two-minute poll could miss a
 * whole stage and leave the page showing work that had already moved on; and
 * a person watching a run wants to see it move, not wonder whether the tab is
 * broken. Someone refreshing by hand to find out what is happening is the
 * clearest possible signal that the interval is wrong.
 *
 * Cheap, too: the poll hits one small status endpoint, and only while a run is
 * actually in flight — it stops the moment the pipeline reaches a person or
 * finishes.
 */
const POLL_INTERVAL_MS = 5_000;

/**
 * How each source outcome reads to a person.
 *
 * 'discovered' is the one that matters here: it means the search found the
 * URL but nothing ever opened it, which is routine and not an error. It used
 * to render as a red "failed — no text was retrieved from this source",
 * which made ordinary blocked-publisher behaviour look like a broken
 * pipeline.
 */
const SOURCE_LABEL: Record<string, { text: string; tone: string }> = {
  digested: { text: 'quoted', tone: 'badge badge-success' },
  fetched: { text: 'read', tone: 'badge' },
  discovered: { text: 'not read', tone: 'badge' },
  rejected: { text: 'not usable', tone: 'badge badge-warning' },
  failed: { text: 'failed', tone: 'badge badge-danger' },
};

/** Where a draft came from. The enum values are terse; these are the sentence. */
const ORIGIN_LABEL: Record<string, string> = {
  generated: 'first draft',
  auto_revised: 'rewritten by the evaluation loop',
  human_revised: 'rewritten on a reviewer’s instruction',
  human_edited: 'edited by hand',
};

const CHANNEL_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  x: 'X',
  newsletter: 'Newsletter',
};

export default function Workspace({ data }: { data: WorkspaceData }) {
  const router = useRouter();
  const { request, capabilities } = data;

  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  /**
   * Which part of the page an error belongs to.
   *
   * Every action funnelled its failure into one banner at the top, inside the
   * pipeline card. A publishing error would appear several screens above the
   * publishing controls that caused it — you press a button, nothing visibly
   * happens, and the explanation is somewhere you are not looking.
   */
  const [errorWhere, setErrorWhere] = useState<'pipeline' | 'publish'>('pipeline');
  const [polling, setPolling] = useState(false);
  // The last thing the status endpoint said. Preferred over the server-
  // rendered props while a run is in flight, because it is seconds old rather
  // than however long ago this page was last fully rendered.
  const [live, setLive] = useState<PipelineStatus | null>(null);
  /**
   * The option this page has just selected, before the server re-render that
   * confirms it has come back. See review() — without it, Approve stays
   * disabled for the length of a full page render after the selection is
   * already recorded.
   */
  /**
   * The version a 409 reported, between post() seeing it and the caller
   * retrying. A ref rather than state: it is read inside the same async
   * function that set it, where a state update would not have landed yet.
   */
  const lastConflict = useRef<number | null>(null);
  const [optimisticSelection, setOptimisticSelection] = useState<{
    articleId: string;
    /** What the server said when this was written, to know when it moves on. */
    serverWas: string | null;
  } | null>(null);
  const [activeOption, setActiveOption] = useState(
    data.options.find((o) => o.articleId === request.selectedArticleId)?.optionIndex ??
      data.options[0]?.optionIndex ??
      1,
  );

  // The server's answer wins as soon as it MOVES — including when it
  // disagrees, which is what happens if someone else selected a different
  // option while this page was deciding.
  //
  // Comparing against what the server said at the time of the write, not
  // against null: a request that already had a selection would otherwise
  // discard the optimistic one on the very next render, which is precisely
  // the case of changing your mind about which option to approve.
  useEffect(() => {
    if (optimisticSelection && request.selectedArticleId !== optimisticSelection.serverWas) {
      setOptimisticSelection(null);
    }
  }, [request.selectedArticleId, optimisticSelection]);

  const selectedArticleId = optimisticSelection?.articleId ?? request.selectedArticleId;

  /**
   * Follow the run, rather than drive it.
   *
   * The pipeline now runs server-side (POST /start → lib/pipeline.ts
   * drivePipeline). This page's only job while it runs is to ask the server
   * where things are every few seconds and reload the real data when the
   * answer changes. Closing this tab no longer stops anything.
   *
   * That is the whole fix for a class of bug this project hit repeatedly: the
   * page used to advance the pipeline itself, one fetch per stage, so any
   * interruption to this exact tab — a sleep, a dropped connection, a closed
   * window — left the request parked mid-pipeline with nothing wrong with it
   * and nothing to notice.
   */
  useEffect(() => {
    if (!polling) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/requests/${request.id}/status`, { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const s = (await res.json()) as PipelineStatus;
        if (cancelled) return;

        setLive(s);

        // Stop polling once nothing is working on it any more, and pull the
        // full page data in to show whatever it produced.
        if (!s.running) {
          setPolling(false);
          router.refresh();
        } else if (s.status !== request.status || s.version !== request.version) {
          // Refresh on a version change too, not just a status change.
          //
          // Every stage transition bumps `version`, and the actions that take
          // an expected_version (publish, review) send whatever this page was
          // rendered with. Watching only the status string meant a request
          // could churn through several stages inside one status — packaging
          // retrying, say — leaving the page holding a version many bumps out
          // of date and every publish attempt failing with "this request
          // changed while you were looking at it".
          router.refresh();
        }
      } catch {
        // A failed poll is not interesting: the next one is five seconds
        // away, and the server is the one doing the work either way.
      }
    };

    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [polling, request.id, request.status, router]);

  // Pick polling back up on load if a run is already in flight — e.g. the tab
  // was reopened, or another tab started it.
  useEffect(() => {
    if (request.running) setPolling(true);
  }, [request.running]);

  const option = data.options.find((o) => o.optionIndex === activeOption) ?? null;

  /**
   * POST and parse, or fail visibly.
   *
   * A stage like research can run for several minutes, and over that long a
   * window a dropped connection (a network blip, a backgrounded tab, a sleep)
   * is a real possibility, not an edge case. Without this try/catch, a thrown
   * fetch() rejection propagated out of an unguarded caller and left the UI
   * showing "Running…" forever — the button disabled, no error on screen, no
   * refresh — while the server had in fact finished the stage. Every caller
   * below relies on this never throwing.
   */
  async function post(url: string, body?: unknown): Promise<Record<string, unknown> | null> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // The request may well have reached the server and be running or have
      // finished — only the response was lost. Refreshing (done by every
      // caller in its finally block) picks up whatever actually happened.
      setError(
        'Lost the connection while waiting for a response. The step may still ' +
          'be running on the server — reload, or press Run again in a moment.',
      );
      return null;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A version conflict carries the version the row is actually on. Stash
      // it so the caller can retry against it — see review().
      lastConflict.current =
        json.code === 'VERSION_CONFLICT' && typeof json.currentVersion === 'number'
          ? json.currentVersion
          : null;
      setError(json.error ?? `Request failed (${res.status}).`);
      return null;
    }
    lastConflict.current = null;
    return json;
  }

  /**
   * The one button.
   *
   * Asks the server to start, and that is the whole of this function's
   * responsibility. The server runs every machine stage back to back and
   * stops at the review gate; this page just starts polling and watches.
   *
   * Note what is NOT here any more: a loop, a stage counter, any notion of
   * "what runs next". All of that was the bug — a pipeline that only advanced
   * while one browser tab stayed awake and connected.
   */
  async function startPipeline() {
    setBusy('pipeline');
    setError('');
    setErrorWhere('pipeline');
    try {
      const result = await post(`/api/requests/${request.id}/start`);
      if (result && result.started === false) {
        // Already running, or nothing to do — either way the poller will
        // show the truth, so surface the reason and start watching.
        setError(String(result.message ?? ''));
      }
      setPolling(true);
    } finally {
      setBusy('');
      router.refresh();
    }
  }

  /**
   * Back to draft, so the pipeline can be run again.
   *
   * Does not start it: reset is usually reached for because something went
   * wrong, and the next useful step is often to change the intake rather than
   * immediately spend another run's worth of Claude calls.
   */
  async function resetRequest() {
    setBusy('reset');
    setError('');
    setErrorWhere('pipeline');
    try {
      const result = await post(`/api/requests/${request.id}/reset`);
      if (result) {
        setOptimisticSelection(null);
        setActiveOption(1);
        router.refresh();
      }
    } finally {
      setBusy('');
    }
  }

  async function review(action: 'approve' | 'reject' | 'revise' | 'select', extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError('');
    setErrorWhere('pipeline');
    try {
      // One round trip on the happy path.
      //
      // This used to GET /status first, purely to read a fresh `version`, so
      // that a background bump from the pipeline could not reject a perfectly
      // valid review. It worked, and it cost about two seconds of auth and
      // queries before every single action — on the overwhelmingly common
      // case where there was no conflict at all.
      //
      // Now the version this page holds is sent straight out, and a genuine
      // conflict comes back carrying the current one, which is retried once.
      // The rare case pays for itself instead of the common case paying for it.
      const send = (expectedVersion: number) =>
        post(`/api/requests/${request.id}/review`, {
          action,
          article_id: option?.articleId ?? null,
          version_id: option?.version?.id ?? null,
          expected_version: expectedVersion,
          note: '',
          instruction: '',
          ...extra,
        });

      let result = await send(live?.version ?? request.version);

      if (!result && lastConflict.current !== null) {
        const retryVersion = lastConflict.current;
        lastConflict.current = null;
        // Exactly one retry. A second conflict on the same action means
        // something is genuinely changing under this page, and quietly
        // looping would hide that.
        setError('');
        result = await send(retryVersion);
      }
      // Selecting is settled the moment the server says 200. Waiting for
      // router.refresh() to come back before enabling Approve meant three
      // round trips — status, review, then a full re-render of this page and
      // its ten queries — and Approve sat disabled for seconds after the
      // decision had already been recorded. Hold the answer locally; the
      // refresh below still runs and the effect clears this once it lands.
      if (result && action === 'select' && option) {
        setOptimisticSelection({
          articleId: option.articleId,
          serverWas: request.selectedArticleId,
        });
      }
      if (result) router.refresh();
    } finally {
      setBusy('');
    }
  }

  async function packageChannels() {
    setBusy('package');
    setError('');
    setErrorWhere('pipeline');
    try {
      const result = await post(`/api/requests/${request.id}/package`);
      if (result) {
        if (!result.ok) setError(String(result.message));
        router.refresh();
      }
    } finally {
      setBusy('');
    }
  }

  async function queueAll(
    channels: string[],
    targets: ChannelTargets,
    scheduledFor: string | null,
  ) {
    setBusy('queue');
    setError('');
    setErrorWhere('publish');
    try {
      // Read the version immediately before writing, rather than sending
      // whatever this page happened to be rendered with.
      //
      // expected_version is there to catch a REAL conflict — someone else
      // editing while you were deciding. It was instead catching the pipeline
      // bumping the version on its own during packaging, so a perfectly valid
      // "schedule this" failed with "this request changed while you were
      // looking at it" and the only fix was to reload and hope. Re-reading
      // here closes the window to the length of one request, and a genuine
      // concurrent edit still collides.
      const fresh = await fetch(`/api/requests/${request.id}/status`, { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<PipelineStatus>) : null))
        .catch(() => null);

      if (fresh?.running) {
        setError(
          'The pipeline is still working on this request. Wait for it to finish before scheduling.',
        );
        return;
      }

      if (!channels.length) {
        setError('Pick at least one channel to publish to.');
        return;
      }

      // Handles are normalised here so a typo is caught before anything is
      // written, and reported against the field it came from. The server
      // re-validates: this is for the message, not for the guarantee.
      const parsed: Record<string, unknown> = {};
      if (channels.includes('newsletter')) {
        parsed.newsletter = { email_group_id: targets.newsletterGroupId || null };
      }
      for (const [channel, raw] of [
        ['linkedin', targets.linkedinTags],
        ['x', targets.xTags],
      ] as const) {
        if (!channels.includes(channel)) continue;
        const result = tagHandles(channel).safeParse(raw);
        if (!result.success) {
          setError(firstIssue(result.error));
          return;
        }
        parsed[channel] = { tag_handles: result.data };
      }

      const result = await post(`/api/requests/${request.id}/publish`, {
        channels,
        targets: parsed,
        scheduled_for: scheduledFor,
        expected_version: fresh?.version ?? request.version,
      });
      if (result) router.refresh();
    } finally {
      setBusy('');
    }
  }

  const atGate = request.status === 'awaiting_review';
  const approved = Boolean(request.approvedVersionId);

  // Prefer the poller's view while a run is in flight — it is seconds old,
  // where the server-rendered props are as old as the last full page render.
  const status = live?.status ?? request.status;
  const running = live?.running ?? request.running;
  const progressPct = live?.progress ?? request.progress;
  const stages = live?.stages ?? [];

  return (
    <div className="space-y-6">
      {/* ── Pipeline ───────────────────────────────────────────────────── */}
      <section className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Pipeline</h2>
          <div className="flex items-center gap-2">
            {running && (
              <span className="text-sm" style={{ color: 'var(--ink-soft)' }}>
                Running{live?.stages.some((x) => x.status === 'running')
                  ? ` · ${live.stages.filter((x) => x.status === 'running')[0].stage}`
                  : ''}
                …
              </span>
            )}
            {capabilities.canRun && request.nextStage && !running && (
              <button
                className="btn btn-primary btn-sm"
                onClick={startPipeline}
                disabled={Boolean(busy)}
              >
                {busy === 'pipeline'
                  ? 'Starting…'
                  : status === 'failed'
                    ? `Retry ${request.failedStage}`
                    : status === 'draft'
                      ? 'Run pipeline'
                      : 'Resume'}
              </button>
            )}
            {/* Reset is the way out when Resume is not: a request that is
                finished, stuck past the point a retry helps, or simply wants
                running again from scratch. Hidden once published, because
                nothing here can unpublish a post. */}
            {capabilities.canRun && !running && status !== 'published' && status !== 'draft' && (
              <ConfirmButton
                tone="danger"
                layout="popover"
                className="btn-sm"
                label="Reset"
                confirmLabel="Yes, reset it"
                question="Delete everything and start over?"
                detail="Deletes every draft, source and evaluation. The intake and the audit stay."

                busy={busy === 'reset'}
                busyLabel="Resetting…"
                onConfirm={resetRequest}
              />
            )}
          </div>
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--rule)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${progressPct}%`, background: 'var(--accent)' }}
          />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Sources" value={String(data.sourceCount)} />
          <Stat label="Excerpts kept" value={`${data.selectedExcerptCount} / ${data.excerptCount}`} />
          <Stat label="Options" value={String(data.options.length)} />
          <Stat label="Revisions" value={`${request.revisionRound} / ${request.maxRevisionRounds}`} />
        </dl>

        {running && (
          <p className="mt-3 text-sm panel panel-info">
            Runs on the server — <strong>you can close this tab</strong>.
          </p>
        )}

        {/* Every stage attempt so far, live. Beats one spinner: you can see
            which stage is slow and which ones already finished. */}
        {stages.length > 0 && (
          <ul className="mt-4 space-y-1 text-sm" style={{ color: 'var(--ink-soft)' }}>
            {stages.map((st, i) => (
              <li key={`${st.stage}-${st.attempt}-${i}`}>
                <span
                  style={{
                    color:
                      st.status === 'ok'
                        ? 'var(--success)'
                        : st.status === 'failed'
                          ? 'var(--danger)'
                          : 'var(--ink-faint)',
                  }}
                >
                  {st.status === 'ok' ? '✓' : st.status === 'failed' ? '✗' : '•'}
                </span>{' '}
                {st.stage}
                {st.attempt > 1 && ` (try ${st.attempt})`}
                {st.seconds !== null && ` — ${st.seconds}s`}
                {st.status === 'running' && ' — running…'}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-xs" style={{ color: 'var(--ink-faint)' }}>
          {request.lastRun ? (
            <>
              Last activity: {request.lastRun.stage} {statusWord(request.lastRun.status)}{' '}
              {relativeTime(request.lastRun.finishedAt ?? request.lastRun.startedAt)}
            </>
          ) : (
            'No pipeline stage has run yet.'
          )}
          {' · request updated '}
          {relativeTime(request.updatedAt)}
        </p>

        {/* Readership. Only exists once the article has a public page, which
            is minted at first publish — so its absence is meaningful rather
            than an empty state to explain. */}
        {request.publicToken && request.views && (
          <div className="mt-4 rounded-lg border p-3" style={{ borderColor: 'var(--rule)' }}>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="font-medium">
                {request.views.total} reader{request.views.total === 1 ? '' : 's'}
              </span>
              <span style={{ color: 'var(--ink-faint)' }}>
                {request.views.last7} in the last 7 days
                {request.views.lastViewedAt &&
                  ` · last ${relativeTime(request.views.lastViewedAt)}`}
              </span>
              <a
                className="ml-auto text-sm"
                href={`/read/${request.publicToken}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open the public page
              </a>
            </div>
            <p className="mt-1 text-xs" style={{ color: 'var(--ink-faint)' }}>
              Counted once per reader per day, not per refresh.
            </p>
          </div>
        )}

        {request.status === 'blocked' && (
          <div className="panel panel-warning mt-4">
            {/* Two different blocks land here. The audit decides the INTAKE is
                unworkable and leaves clarifying questions; research decides it
                has no readable EVIDENCE and leaves a reason on failed_reason.
                Both are "a person has to do something", which is why they
                share a panel — but only the second one has a fix we can put a
                button on. */}
            <strong>
              {request.failedStage === 'research'
                ? 'Nothing here could be read.'
                : 'This request is blocked.'}
            </strong>
            <p className="mt-1" style={{ color: 'var(--ink-soft)' }}>
              {request.blockingReason ?? request.failedReason}
            </p>
            {request.clarifyingQuestions.length > 0 && (
              <ul className="mt-2 list-disc pl-5" style={{ color: 'var(--ink-soft)' }}>
                {request.clarifyingQuestions.map((q) => <li key={q}>{q}</li>)}
              </ul>
            )}
            {request.failedStage === 'research' && (
              <AddSourceForm
                requestId={request.id}
                onDone={() => {
                  // The route resumes the pipeline itself, so start watching
                  // rather than making them press Run again.
                  setPolling(true);
                  router.refresh();
                }}
              />
            )}
          </div>
        )}

        {request.status === 'failed' && (
          <div className="panel panel-danger mt-4">
            <strong>{request.failedStage} failed.</strong>
            <p className="mt-1">{request.failedReason}</p>
            <p className="mt-2 text-xs">The run log has the details.</p>
            {/* A research failure is the one kind that retrying cannot fix —
                the sites that refused to be read will refuse again. Requests
                that failed this way before research learned to park are still
                sitting in 'failed', so the way out is offered here too. */}
            {request.failedStage === 'research' && (
              <AddSourceForm
                requestId={request.id}
                onDone={() => {
                  setPolling(true);
                  router.refresh();
                }}
              />
            )}
          </div>
        )}

        {error && errorWhere === 'pipeline' && (
          <div className="panel panel-danger mt-4">{error}</div>
        )}
      </section>

      {/* ── The request as it was submitted ────────────────────────────── */}
      <details className="card">
        <summary className="cursor-pointer font-semibold">The request</summary>
        <p className="mt-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Everything the pipeline was given. Submitted {new Date(request.createdAt).toLocaleString()}.
        </p>
        <dl className="mt-3 space-y-3 text-sm">
          <Field label="Idea" value={request.rawIdea} />
          <Field label="Audience" value={request.targetAudience} />
          <Field label="Source URL" value={request.sourceUrl} link />
          <Field label="Supporting material" value={request.supportingNotes} />
          <Field label="Title hint" value={request.titleHint} />
          <Field label="Primary keyword" value={request.primaryKeyword} />
          <Field label="Secondary keywords" value={request.secondaryKeywords.join(', ')} />
          <Field label="Tone" value={request.desiredTone} />
          <Field
            label="Word count target"
            value={request.wordCountTarget ? String(request.wordCountTarget) : ''}
          />
          <Field label="Options asked for" value={String(request.optionCount)} />
          <Field label="Research depth" value={request.researchDepth} />
          <Field
            label="Channels"
            value={request.channelsWanted.map((c) => CHANNEL_LABEL[c] ?? c).join(', ')}
          />
          <Field
            label="Deadline"
            value={request.deadlineAt ? new Date(request.deadlineAt).toLocaleString() : ''}
          />
        </dl>
      </details>

      {/* ── Options ────────────────────────────────────────────────────── */}
      {data.options.length > 0 && (
        <section>
          <div className="mb-3 flex flex-wrap gap-2">
            {data.options.map((o) => (
              <button
                key={o.optionIndex}
                className={`btn btn-sm ${o.optionIndex === activeOption ? 'btn-primary' : ''}`}
                onClick={() => setActiveOption(o.optionIndex)}
              >
                Option {o.optionIndex}
                {o.articleId === selectedArticleId && ' ✓'}
                {o.evaluation && (
                  <span className="ml-1 opacity-70">
                    {o.evaluation.status === 'pass' ? '·pass' : o.evaluation.status === 'reject' ? '·reject' : '·revise'}
                  </span>
                )}
              </button>
            ))}
          </div>

          {option && <OptionPanel option={option} isSelected={option.articleId === selectedArticleId} />}
        </section>
      )}

      {/* ── The human gate ─────────────────────────────────────────────── */}
      {capabilities.canReview && (atGate || request.status === 'rejected') && option && (
        <ReviewPanel
          option={option}
          isSelected={option.articleId === selectedArticleId}
          status={request.status}
          busy={busy}
          onAction={review}
        />
      )}

      {!capabilities.canReview && atGate && (
        <div className="panel panel-warning">
          Waiting on a reviewer.
        </div>
      )}

      {/* ── Packaging ──────────────────────────────────────────────────── */}
      {approved && (
        <section className="card">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Channel assets</h2>
            {capabilities.canRun && (
              <button className="btn btn-sm" onClick={packageChannels} disabled={Boolean(busy)}>
                {busy === 'package' ? 'Preparing…' : data.assets.length ? 'Regenerate' : 'Prepare channels'}
              </button>
            )}
          </div>

          {data.assets.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
              Approved. Prepare the channel versions next.
            </p>
          ) : (
            <div className="space-y-4">
              {data.assets.map((a) => (
                <AssetCard key={a.id} asset={a} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Publishing ─────────────────────────────────────────────────── */}
      {approved && data.assets.some((a) => a.rulesPass) && (
        <PublishPanel
          status={request.status}
          error={errorWhere === 'publish' ? error : ''}
          publications={data.publications}
          assets={data.assets}
          emailGroups={data.emailGroups}
          canPublish={capabilities.canPublish}
          busy={busy}
          running={running}
          onQueue={queueAll}
        />
      )}

      {/* ── Sources ────────────────────────────────────────────────────── */}
      {data.allSources.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer font-semibold">
            Sources ({data.allSources.length}) ·{' '}
            {data.allSources.filter((s) => s.status === 'digested').length} quotable
          </summary>

          <p className="mt-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
            Only <strong>quoted</strong> sources ground a claim. The rest were found but blocked
            automated reading.
          </p>

          <ul className="mt-3 space-y-2 text-sm">
            {data.allSources.map((s) => {
              const label = SOURCE_LABEL[s.status] ?? { text: s.status, tone: 'badge' };
              return (
                <li key={s.id} className="flex flex-wrap items-baseline gap-2">
                  <span className={label.tone}>{label.text}</span>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)' }}>
                      {s.title}
                    </a>
                  ) : (
                    <span>{s.title}</span>
                  )}
                  {s.error && (
                    <span
                      style={{
                        color: s.status === 'failed' ? 'var(--danger)' : 'var(--ink-faint)',
                      }}
                    >
                      — {s.error}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {/* ── Review history ─────────────────────────────────────────────── */}
      {data.reviews.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer font-semibold">
            Review history ({data.reviews.length})
          </summary>
          <p className="mt-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
            Every human decision, in order. Append-only.
          </p>
          <ul className="mt-3 space-y-3 text-sm">
            {data.reviews.map((r) => (
              <li key={r.id}>
                <span
                  className={
                    r.action === 'approve'
                      ? 'badge badge-success'
                      : r.action === 'reject'
                        ? 'badge badge-danger'
                        : 'badge'
                  }
                >
                  {r.action}
                </span>{' '}
                <span>{reviewSentence(r)}</span>{' '}
                <span style={{ color: 'var(--ink-faint)' }}>
                  {/* The transition only earns a mention when it IS one.
                      A 'select' leaves the status where it was, so
                      "awaiting_review → awaiting_review" was pure noise on
                      exactly the entries that needed explaining. */}
                  {r.fromStatus !== r.toStatus && `${r.fromStatus} → ${r.toStatus} · `}
                  {new Date(r.at).toLocaleString()}
                </span>
                {r.note && <p className="mt-1">{r.note}</p>}
                {r.instruction && (
                  <p className="mt-1" style={{ color: 'var(--ink-soft)' }}>
                    Instruction: {r.instruction}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ─── Pieces ─────────────────────────────────────────────────────────────── */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs" style={{ color: 'var(--ink-faint)' }}>{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function OptionPanel({
  option,
  isSelected,
}: {
  option: WorkspaceData['options'][number];
  isSelected: boolean;
}) {
  if (!option.version) {
    return (
      <div className="card text-sm" style={{ color: 'var(--ink-soft)' }}>
        <p className="mb-1 font-medium" style={{ color: 'var(--ink)' }}>{option.angle}</p>
        This option has not been written yet.
      </div>
    );
  }

  const v = option.version;

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
          <span className="chip">{option.angle}</span>
          <span>revision {v.revisionNo}</span>
          <span>· {v.origin.replace('_', ' ')}</span>
          <span>· {v.wordCount} words</span>
          {isSelected && <span className="badge badge-success">selected</span>}
          {v.seoPass === false && <span className="badge badge-warning">SEO rules not met</span>}
        </div>

        <MarkdownBody body={v.bodyMd} />
      </div>

      {/* Which sources informed this output — required by the brief. */}
      {option.sources.length > 0 && (
        <div className="card">
          <h3 className="mb-2 text-sm font-semibold">Sources behind this draft</h3>
          <ul className="space-y-1 text-sm">
            {option.sources.map((s) => (
              <li key={s.id}>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent)' }}>
                    {s.title}
                  </a>
                ) : (
                  s.title
                )}
                <span style={{ color: 'var(--ink-faint)' }}> — {s.claim_count} claim{s.claim_count === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {option.claims.length > 0 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold">
            Claims and grounding ({option.claims.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm">
            {option.claims.map((c, i) => (
              <li key={i}>
                <span
                  className={
                    c.support === 'grounded'
                      ? 'badge badge-success'
                      : c.support === 'unsupported'
                        ? 'badge badge-danger'
                        : 'badge'
                  }
                >
                  {c.support.replace('_', ' ')}
                </span>{' '}
                {c.claimText}
              </li>
            ))}
          </ul>
        </details>
      )}

      {option.evaluation && <EvaluationPanel evaluation={option.evaluation} seoChecks={v.seoChecks} />}

      {(v.assumptions.length > 0 || v.gaps.length > 0) && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold">Assumptions and gaps</summary>
          <div className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <p className="mb-1 font-medium">Assumed</p>
              <ul className="list-disc pl-5" style={{ color: 'var(--ink-soft)' }}>
                {v.assumptions.length ? v.assumptions.map((a) => <li key={a}>{a}</li>) : <li>None stated.</li>}
              </ul>
            </div>
            <div>
              <p className="mb-1 font-medium">Not covered by the sources</p>
              <ul className="list-disc pl-5" style={{ color: 'var(--ink-soft)' }}>
                {v.gaps.length ? v.gaps.map((g) => <li key={g}>{g}</li>) : <li>None stated.</li>}
              </ul>
            </div>
          </div>
        </details>
      )}

      {option.history.length > 1 && (
        <details className="card">
          <summary className="cursor-pointer text-sm font-semibold">
            Revision history ({option.history.length} drafts of this option)
          </summary>
          <p className="mt-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
            Oldest first. r{option.history.length} is shown above.
          </p>
          <ol className="mt-3 space-y-2 text-sm">
            {option.history.map((h) => (
              <li key={h.id}>
                <span className="chip">r{h.revisionNo}</span>{' '}
                <span>{ORIGIN_LABEL[h.origin] ?? h.origin.replace(/_/g, ' ')}</span>{' '}
                <span style={{ color: 'var(--ink-faint)' }}>
                  · {h.wordCount} words · {new Date(h.createdAt).toLocaleString()}
                </span>
                {h.instruction && (
                  <p className="mt-1" style={{ color: 'var(--ink-soft)' }}>
                    <span style={{ color: 'var(--ink-faint)' }}>Asked to: </span>
                    {h.instruction}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function EvaluationPanel({
  evaluation,
  seoChecks,
}: {
  evaluation: NonNullable<WorkspaceData['options'][number]['evaluation']>;
  seoChecks: RuleCheckView[];
}) {
  const tone =
    evaluation.status === 'pass'
      ? 'panel panel-success'
      : evaluation.status === 'reject'
        ? 'panel panel-danger'
        : 'panel panel-warning';

  return (
    <div className="card space-y-4">
      <div className={tone}>
        <strong>{evaluation.status}</strong> · {evaluation.overallScore.toFixed(1)} / 5
        <p className="mt-1">{evaluation.summary}</p>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Rubric</h3>
        <ul className="space-y-1 text-sm">
          {evaluation.scores.map((s) => (
            <li key={s.criterion} className="flex flex-wrap items-baseline gap-2">
              <span className="w-40 shrink-0" style={{ color: 'var(--ink-soft)' }}>
                {CRITERION_LABELS[s.criterion as RubricCriterion] ?? s.criterion}
              </span>
              <span className="font-medium">{s.score}/5</span>
              <span style={{ color: 'var(--ink-faint)' }}>{s.note}</span>
            </li>
          ))}
        </ul>
      </div>

      {evaluation.unsupportedClaims.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--danger)' }}>
            Unsupported claims
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {evaluation.unsupportedClaims.map((c, i) => (
              <li key={i}>
                “{c.claim_text}” — {c.why}
              </li>
            ))}
          </ul>
        </div>
      )}

      {evaluation.recommendedChanges.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Recommended changes</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {evaluation.recommendedChanges.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}

      {seoChecks.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">SEO checks</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {seoChecks.map((c) => (
              <li key={c.label}>
                <span style={{ color: c.pass ? 'var(--success)' : c.required ? 'var(--danger)' : 'var(--warning)' }}>
                  {c.pass ? '✓' : '✗'}
                </span>{' '}
                {c.label} <span style={{ color: 'var(--ink-faint)' }}>— {c.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ReviewPanel({
  option,
  isSelected,
  status,
  busy,
  onAction,
}: {
  option: WorkspaceData['options'][number];
  isSelected: boolean;
  status: string;
  busy: string;
  onAction: (action: 'approve' | 'reject' | 'revise' | 'select', extra?: Record<string, unknown>) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [note, setNote] = useState('');

  return (
    <section className="card space-y-4" style={{ borderColor: 'var(--accent)' }}>
      <div>
        <h2 className="font-semibold">Review</h2>
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          Nothing publishes until you approve.
        </p>
      </div>

      {!isSelected && status === 'awaiting_review' && (
        <div className="panel panel-info">
          Select option {option.optionIndex} before approving.
        </div>
      )}

      <div>
        <label className="label" htmlFor="note">Note</label>
        <input
          id="note" className="field" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Required to reject."
        />
      </div>

      <div>
        <label className="label" htmlFor="instruction">Revision instruction</label>
        <textarea
          id="instruction" className="field" rows={2} value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Required to revise."
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn"
          disabled={Boolean(busy) || isSelected}
          onClick={() => onAction('select')}
        >
          {busy === 'select' ? 'Selecting…' : `Select option ${option.optionIndex}`}
        </button>
        <button
          className="btn"
          disabled={Boolean(busy) || !instruction.trim()}
          onClick={() => onAction('revise', { instruction })}
          title={instruction.trim() ? '' : 'Needs an instruction.'}
        >
          {busy === 'revise' ? 'Revising…' : 'Revise'}
        </button>
      </div>

      {/* Approve and reject are the two that are hard to walk back — approve
          is what lets content reach a channel at all, and reject ends the
          request. Both ask first. Select and revise do not: selecting is
          reversible by selecting something else, and a revision writes a new
          version without destroying the old one. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <ConfirmButton
          tone="danger"
          label="Reject"
          confirmLabel="Yes, reject it"
          question="Reject this request?"
          detail="Goes back to the author. Nothing is deleted."
          disabled={Boolean(busy) || !note.trim()}
          busy={busy === 'reject'}
          busyLabel="Rejecting…"
          title={note.trim() ? '' : 'Needs a reason.'}
          onConfirm={() => onAction('reject', { note })}
        />
        <div className="sm:ml-auto">
          <ConfirmButton
            tone="primary"
            label="Approve"
            confirmLabel="Yes, approve it"
            question={`Approve option ${option.optionIndex}?`}
            detail="Records the exact text. Any later edit revokes the approval."
            disabled={Boolean(busy) || !isSelected || !option.version}
            busy={busy === 'approve'}
            busyLabel="Approving…"
            onConfirm={() => onAction('approve', { note })}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * The newsletter as it will actually arrive.
 *
 * The other two channels are plain text going into a box on someone else's
 * site, so `preformatted` is honest for them. A newsletter is a rendered
 * document, and showing it as raw markdown meant the thing being approved was
 * not the thing being sent — you approved `**The reality check.**` and a
 * subscriber received something that had been through a different renderer.
 *
 * So this mirrors lib/email-layout.ts: the same eyebrow, the same subject as
 * the title, the same body through the same markdown parser, the same footer
 * line. It is styled with the app's own tokens rather than the email's
 * hard-coded hexes — those exist because a CSS variable cannot survive in an
 * inbox, which is not a constraint here — so it also follows dark mode.
 */
function NewsletterPreview({ asset }: { asset: WorkspaceData['assets'][number] }) {
  return (
    <div
      className="mt-2 rounded-lg border p-5"
      style={{ borderColor: 'var(--rule)', background: 'var(--card)' }}
    >
      <p
        className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em]"
        style={{ color: 'var(--accent)' }}
      >
        Koya Talent
      </p>
      {asset.subject && (
        <h3 className="mb-1 text-lg font-semibold leading-snug" style={{ color: 'var(--ink)' }}>
          {asset.subject}
        </h3>
      )}
      {/* The inbox preview line. Shown because it is the one part of a
          newsletter nobody can check by reading the body. */}
      {asset.preheader && (
        <p className="mb-4 text-xs" style={{ color: 'var(--ink-faint)' }}>
          Inbox preview: {asset.preheader}
        </p>
      )}

      <div className="markdown-body">
        <MarkdownBody body={asset.body} />
      </div>

      <p
        className="mt-5 border-t pt-3 text-xs"
        style={{ borderColor: 'var(--rule)', color: 'var(--ink-faint)' }}
      >
        You are receiving this because you are on the <em>[chosen at publish]</em> list. Reply to
        this email to unsubscribe.
      </p>
    </div>
  );
}

function AssetCard({ asset }: { asset: WorkspaceData['assets'][number] }) {
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: 'var(--rule)' }}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="text-sm">{CHANNEL_LABEL[asset.channel] ?? asset.channel}</strong>
        <span className={asset.rulesPass ? 'badge badge-success' : 'badge badge-danger'}>
          {asset.rulesPass ? 'rules pass' : 'rules failed'}
        </span>
        <span className="text-xs" style={{ color: 'var(--ink-faint)' }}>v{asset.assetNo}</span>
      </div>

      {asset.channel === 'newsletter' ? (
        <NewsletterPreview asset={asset} />
      ) : (
        <div className="preformatted">{asset.body}</div>
      )}

      {asset.hashtags.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1">
          {asset.hashtags.map((h) => <span key={h} className="chip">{h}</span>)}
        </p>
      )}

      {!asset.rulesPass && (
        <ul className="mt-3 space-y-1 text-sm">
          {asset.rulesChecks
            .filter((c) => c.required && !c.pass)
            .map((c) => (
              <li key={c.label} style={{ color: 'var(--danger)' }}>
                ✗ {c.label} — {c.detail}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

interface ChannelTargets {
  newsletterGroupId: string;
  linkedinTags: string;
  xTags: string;
}

function PublishPanel({
  status,
  error,
  publications,
  assets,
  emailGroups,
  canPublish,
  busy,
  running,
  onQueue,
}: {
  /** The request's status — only 'ready' and 'queued' can take a new publication. */
  status: string;
  /** A failure from the last queue attempt, shown here rather than at the top. */
  error: string;
  publications: WorkspaceData['publications'];
  /** Only rule-passing assets can be queued, so only they are offered. */
  assets: WorkspaceData['assets'];
  emailGroups: WorkspaceData['emailGroups'];
  canPublish: boolean;
  busy: string;
  /** A driver still owns this request — the assets may yet change. */
  running: boolean;
  onQueue: (
    channels: string[],
    targets: ChannelTargets,
    scheduledFor: string | null,
  ) => void;
}) {
  const [when, setWhen] = useState('');
  // Cancelled rows are SHOWN, not filtered out. Hiding them made a cancel
  // look like it had done nothing: the row simply vanished, and whatever was
  // left — often another channel still queued — read as the thing you had
  // just cancelled.
  const live = publications;
  const bounds = dateTimeLocalBounds('future', 2);

  // A channel already live cannot be queued again — the database refuses it
  // (publications_one_live_per_channel), so offering it would be an error
  // waiting to happen rather than a choice.
  const alreadyLive = new Set(
    live.filter((p) => p.state !== 'failed' && p.state !== 'canceled').map((p) => p.channel),
  );

  // And once everything has gone out the request is 'published', which
  // guard_publication_insert() refuses outright — it takes only 'ready' or
  // 'queued'. The form used to stay live anyway, so a request with one
  // unqueued channel offered a schedule that the database then rejected with
  // "cannot queue a publication for a request in status published". Deciding
  // it here, from the same rule, means the UI cannot offer what the database
  // will not accept.
  const acceptsPublications = status === 'ready' || status === 'queued';
  const available = acceptsPublications
    ? assets.filter((a) => a.rulesPass && !alreadyLive.has(a.channel))
    : [];

  const [picked, setPicked] = useState<string[]>(() => available.map((a) => a.channel));
  const [targets, setTargets] = useState<ChannelTargets>({
    newsletterGroupId: '',
    linkedinTags: '',
    xTags: '',
  });

  const toggle = (channel: string) =>
    setPicked((prev) =>
      prev.includes(channel) ? prev.filter((c) => c !== channel) : [...prev, channel],
    );

  const set = (patch: Partial<ChannelTargets>) => setTargets((prev) => ({ ...prev, ...patch }));

  const wantsNewsletter = picked.includes('newsletter');
  const chosenGroup = emailGroups.find((g) => g.id === targets.newsletterGroupId);
  // Blocked rather than warned: a newsletter with no list is not a smaller
  // send, it is a send to nobody that still reports as published.
  const newsletterUnready = wantsNewsletter && !chosenGroup;

  const summary =
    picked.length === 0
      ? 'Nothing selected'
      : picked.map((c) => CHANNEL_LABEL[c] ?? c).join(', ');

  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Publishing</h2>

      {error && <div className="panel panel-danger">{error}</div>}

      {live.length > 0 && (
        <ul className="space-y-2 text-sm">
          {live.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span className="badge">{CHANNEL_LABEL[p.channel] ?? p.channel}</span>
              <span
                className={
                  p.state === 'published'
                    ? 'badge badge-success'
                    : p.state === 'failed'
                      ? 'badge badge-danger'
                      : p.state === 'canceled'
                        ? 'badge'
                        : 'badge badge-accent'
                }
              >
                {p.state === 'canceled' ? 'cancelled' : p.state}
              </span>
              {p.emailGroupName && (
                <span style={{ color: 'var(--ink-soft)' }}>
                  to {p.emailGroupName}
                  {/* The count only exists once it has actually gone out — it
                      is written at release, not at queue time. */}
                  {p.recipientCount !== null && ` (${p.recipientCount} recipients)`}
                </span>
              )}
              {p.tagHandles.length > 0 && (
                <span style={{ color: 'var(--ink-soft)' }}>tagging {p.tagHandles.join(' ')}</span>
              )}
              {p.scheduledFor && (
                <span style={{ color: 'var(--ink-faint)' }}>
                  for {new Date(p.scheduledFor).toLocaleString()}
                </span>
              )}
              {p.publishedAt && (
                <span style={{ color: 'var(--ink-faint)' }}>
                  at {new Date(p.publishedAt).toLocaleString()}
                </span>
              )}
              {p.lastError && (
                <span style={{ color: 'var(--danger)' }}>
                  {p.lastError} (attempt {p.attempts})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {running && (
        <div className="panel panel-info">
          Still running. Scheduling is held until it finishes.
        </div>
      )}

      {!canPublish ? (
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          A publisher handles this.
        </p>
      ) : !acceptsPublications ? (
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          {status === 'published'
            ? 'Published. Nothing further can be queued against it.'
            : `Nothing to queue from “${status}”.`}
        </p>
      ) : available.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          Everything that passes its rules is queued.
        </p>
      ) : (
        <div className="space-y-4">
          <fieldset>
            <legend className="label">Publish to</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {available.map((a) => (
                <label key={a.channel} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked.includes(a.channel)}
                    onChange={() => toggle(a.channel)}
                    disabled={Boolean(busy) || running}
                  />
                  <span>{CHANNEL_LABEL[a.channel] ?? a.channel}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* ── Newsletter: who it goes to ─────────────────────────────── */}
          {wantsNewsletter && (
            <div>
              <label className="label" htmlFor="newsletter-group">
                Send the newsletter to
              </label>
              {emailGroups.length === 0 ? (
                <p className="panel panel-warning text-sm">
                          No email groups yet — add one on the Admin page.
                </p>
              ) : (
                <>
                  <select
                    id="newsletter-group"
                    className="field"
                    value={targets.newsletterGroupId}
                    onChange={(e) => set({ newsletterGroupId: e.target.value })}
                    disabled={Boolean(busy) || running}
                  >
                    <option value="">Choose a list…</option>
                    {emailGroups.map((g) => (
                      <option key={g.id} value={g.id} disabled={g.memberCount === 0}>
                        {g.name} — {g.memberCount} subscribed
                        {g.memberCount === 0 ? ' (empty)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="hint">Addresses resolve at send, not now.</p>
                </>
              )}
            </div>
          )}

          {/* ── Social: who to tag ─────────────────────────────────────── */}
          {picked.includes('linkedin') && (
            <TagField
              id="linkedin-tags"
              label="Tag on LinkedIn"
              placeholder="@koya-talent, linkedin.com/in/ada-lovelace"
              hint="Names or profile URLs, comma separated."
              value={targets.linkedinTags}
              onChange={(v) => set({ linkedinTags: v })}
              disabled={Boolean(busy) || running}
            />
          )}
          {picked.includes('x') && (
            <TagField
              id="x-tags"
              label="Tag on X"
              placeholder="@koyatalent, @adalovelace"
              hint="Comma separated. Counts toward the 280 limit."
              value={targets.xTags}
              onChange={(v) => set({ xTags: v })}
              disabled={Boolean(busy) || running}
            />
          )}

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="when">Schedule for</label>
              <input
                id="when"
                className="field"
                type="datetime-local"
                value={when}
                // The picker cannot offer a moment the server would refuse.
                // A past "schedule" is not a schedule: the worker releases
                // anything already due on its very next tick, so backdating it
                // publishes immediately — the one outcome someone setting a
                // schedule is trying to avoid.
                min={bounds.min}
                max={bounds.max}
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>
            <ConfirmButton
              tone="primary"
              label={when ? 'Schedule' : 'Queue now'}
              confirmLabel={when ? 'Yes, schedule it' : 'Yes, publish it'}
              question={
                picked.length === 0
                  ? 'Pick a channel first.'
                  : when
                    ? `Schedule ${summary} for ${new Date(when).toLocaleString()}?`
                    : `Queue ${summary} to publish now?`
              }
              detail={
                chosenGroup
                  ? `Goes to ${chosenGroup.name}. Nobody checks again.`
                  : 'Nobody checks again. Cancel from the queue if needed.'
              }
              disabled={Boolean(busy) || running || picked.length === 0 || newsletterUnready}
              busy={busy === 'queue'}
              busyLabel="Queueing…"
              title={
                running
                  ? 'Still running.'
                  : picked.length === 0
                    ? 'Pick a channel.'
                    : newsletterUnready
                      ? 'Pick a list first.'
                      : ''
              }
              onConfirm={() => onQueue(picked, targets, when ? new Date(when).toISOString() : null)}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/** One "accounts to tag" input. Two channels, identical shape, different rules. */
function TagField({
  id,
  label,
  placeholder,
  hint,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  placeholder: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label} <span style={{ color: 'var(--ink-faint)' }}>— optional</span>
      </label>
      <input
        id={id}
        className="field"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      <p className="hint">{hint}</p>
    </div>
  );
}

/**
 * One review entry as a sentence.
 *
 * The old row printed `select · awaiting_review → awaiting_review`, which is
 * true and says nothing: selecting does not move the status, so the only two
 * facts on the line were identical and the one fact that mattered — WHICH
 * option — was not there at all.
 */
function reviewSentence(r: WorkspaceData['reviews'][number]): string {
  const option = r.optionIndex !== null ? `option ${r.optionIndex}` : 'this request';
  switch (r.action) {
    case 'select':
      return `${r.by} chose ${option}`;
    case 'approve':
      return `${r.by} approved ${option}`;
    case 'reject':
      return `${r.by} rejected ${option}`;
    case 'revise':
      return `${r.by} sent ${option} back for a revision`;
    default:
      return `${r.by} acted on ${option}`;
  }
}

/**
 * One intake field.
 *
 * Empty ones are skipped rather than rendered as "—". Most of this form is
 * optional, so a typical request leaves half of it blank; printing a dash for
 * each turns the panel into a list of things that are not there, and buries
 * the three or four that were actually filled in.
 */
function Field({ label, value, link }: { label: string; value: string | null; link?: boolean }) {
  if (!value?.trim()) return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
        {label}
      </dt>
      <dd className="mt-0.5 whitespace-pre-wrap break-words">
        {link ? (
          <a href={value} target="_blank" rel="noreferrer noopener">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/** "ok" for a completed stage read better than the raw enum value "ok". */
function statusWord(status: string): string {
  if (status === 'ok') return 'finished';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'is running, started';
  return status;
}

/** "3m ago", "just now" — the whole point is to make staleness legible at a
 *  glance, without doing arithmetic on an ISO timestamp in your head. */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
