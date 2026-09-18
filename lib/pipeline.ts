import 'server-only';
import * as claude from './claude';
import * as q from './queries';
import { checkSeo, slugify, wordCount } from './seo';
import { excerptsFrom, applyKeepFloor } from './excerpts';
import { mergeFindings, readableCount } from './research-results';
import { depthProfile } from './research-depth';
import { groundClaims } from './grounding';
import { assessSource } from './source-quality';
import { nextAfterEvaluation, shouldStopRepeating } from './permissions';
import { checkChannel, failureSummary, failureInstructions, type RuleReport } from './channel-rules';
import { sendReviewRequest } from './email';
import { env } from './env';
import type { ContentRequestRow, PipelineStage } from './db-schemas';
import type { Channel, Intake } from './schemas';
import { CHANNELS } from './schemas';

/**
 * The pipeline runner: one function per stage, all the same shape.
 *
 *   claim a stage_run → call Claude → persist what came back → advance status
 *
 * Every stage records its attempt in `stage_runs` with the model, the Claude
 * request id, the effort, and the token counts, and every failure records why
 * in the same row before the request moves to `failed` with `failed_stage`
 * set. That is what makes the brief's "failures must be clear enough to
 * debug" a property of the architecture rather than of individual try/catch.
 *
 * Stages are driven one at a time from the client rather than as a single
 * long POST. Generating three options with a research stage in front of them
 * exceeds any sensible serverless request budget, and a stage that fails
 * halfway through a monolithic run leaves nothing to resume from.
 */

export interface StageResult {
  stage: PipelineStage;
  ok: boolean;
  /** The status the request is in after this stage. */
  status: string;
  message: string;
  detail?: Record<string, unknown>;
}

/** The request's intake fields, in the shape the prompts want. */
function intakeOf(r: ContentRequestRow): Partial<Intake> {
  return {
    raw_idea: r.raw_idea,
    target_audience: r.target_audience,
    source_url: r.source_url,
    supporting_notes: r.supporting_notes,
    title_hint: r.title_hint,
    primary_keyword: r.primary_keyword,
    secondary_keywords: r.secondary_keywords,
    desired_tone: r.desired_tone,
    word_count_target: r.word_count_target,
    option_count: r.option_count,
    // Not shown to the model — intakeAsText filters it out. It travels here
    // so each call can size its effort from the depth the request asked for.
    research_depth: r.research_depth as Intake['research_depth'],
  };
}

/**
 * Run per-item work concurrently, with a ceiling on how many are in flight.
 *
 * Every stage that makes one Claude call per item — per source, per option,
 * per channel — was doing them one after another, so the stage cost the SUM
 * of its calls rather than roughly the slowest one. Retrieval with ten
 * readable sources was ten calls in series for no reason: they share nothing
 * and neither depends on another's answer.
 *
 * Bounded rather than a bare Promise.all, because the item counts are not
 * fixed. Thirteen simultaneous calls is how a rate limit gets hit, and a 429
 * storm costs more time than the serialisation saved. Five in flight is well
 * inside any per-minute allowance while still collapsing most of the wait.
 *
 * Results come back in input order, so logs and stored rows stay in the order
 * a person would expect regardless of which call finished first.
 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * How many per-item Claude calls may be in flight within one stage.
 *
 * Bounded by the DATABASE, not by the API. Each concurrent item persists its
 * result, and some of those writes open a transaction (insertExcerpts does),
 * which holds a pooled connection for its whole duration. Run more of these
 * at once than the pool can serve and the stage does not fail — it queues,
 * silently, forever.
 *
 * Four against a pool of twenty leaves ample room for the heartbeat, the
 * drive's own reads, and every open page polling the status endpoint.
 */
const STAGE_CONCURRENCY = 4;

/**
 * Wrap a stage so that a Claude failure and a thrown error both land in the
 * same place: a failed stage_run, a failed request with the stage named, and
 * a StageResult the route can return as JSON.
 */
/**
 * Has this driver been superseded?
 *
 * A ConflictError from a status transition means another driver already moved
 * this request on. That is not this request failing — and a driver with no
 * standing to move it has no standing to fail it either.
 *
 * Without this, a research call that had hung for five minutes returned after
 * its lock had been reclaimed, found the request four stages further along,
 * and marked the whole healthy run failed. The next stage then failed too,
 * because the request it was working on had just been failed underneath it.
 */
async function standDown(
  request: ContentRequestRow,
  stage: PipelineStage,
  runId: string,
  err: unknown,
  startedAt: number,
): Promise<StageResult | null> {
  if (!(err instanceof q.ConflictError)) return null;
  const message = err.message;

  await q
    .finishStageRun(runId, {
      ok: false,
      failureReason: 'internal',
      error: `Superseded: ${message}`,
      durationMs: Date.now() - startedAt,
      detail: { stage, superseded: true },
    })
    .catch(() => {});
  await q
    .logEvent({
      requestId: request.id,
      actor: 'system',
      stage,
      step: 'stage_superseded',
      ok: true,
      detail: { stage, note: 'another driver moved this request on; this attempt stood down' },
    })
    .catch(() => {});

  return { stage, ok: false, status: request.status, message: `Superseded: ${message}` };
}

async function runStage<T>(
  request: ContentRequestRow,
  stage: PipelineStage,
  produce: (runId: string) => Promise<claude.ClaudeOutcome<T>>,
  persist: (data: T, runId: string) => Promise<StageResult>,
): Promise<StageResult> {
  const run = await q.startStageRun(request.id, stage);

  try {
    const outcome = await produce(run.id);

    if (!outcome.ok) {
      await q.finishStageRun(run.id, {
        ok: false,
        failureReason: outcome.reason,
        error: outcome.message,
        claudeRequestId: outcome.requestId,
        durationMs: outcome.durationMs,
        detail: { stage, category: 'category' in outcome ? outcome.category : null },
      });
      await q.markStageFailed(request.id, stage, `${outcome.reason}: ${outcome.message}`);
      return { stage, ok: false, status: 'failed', message: outcome.message };
    }

    const result = await persist(outcome.data, run.id);

    await q.finishStageRun(run.id, {
      ok: true,
      model: outcome.model,
      claudeRequestId: outcome.requestId,
      effort: outcome.effort,
      durationMs: outcome.durationMs,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      cacheReadTokens: outcome.cacheReadTokens,
      cacheWriteTokens: outcome.cacheWriteTokens,
      detail: result.detail ?? {},
    });
    await q.clearFailure(request.id);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // A ConflictError on a status transition means SOMEBODY ELSE MOVED THIS
    // REQUEST. It does not mean the request failed.
    //
    // This one did real damage. A research call that had hung for nearly five
    // minutes had its lock released, a second driver picked the request up and
    // carried it through research, retrieval, selection, planning and
    // generation — and then the original call finally returned, tried to
    // advance 'researching' → 'retrieving', found the request at 'evaluating'
    // and marked the whole healthy run failed. The next stage then failed too,
    // because the request it was working on had just been failed underneath
    // it.
    //
    // A driver that has been superseded has no standing to fail anything. It
    // records its own stage outcome so the attempt is visible, and leaves the
    // request to whoever holds it now.
    if (err instanceof q.ConflictError) {
      await q
        .finishStageRun(run.id, {
          ok: false,
          failureReason: 'internal',
          error: `Superseded: ${message}`,
          durationMs: 0,
          detail: { stage, superseded: true },
        })
        .catch(() => {});
      await q
        .logEvent({
          requestId: request.id,
          actor: 'system',
          stage: stage as PipelineStage,
          step: 'stage_superseded',
          ok: true,
          detail: { stage, note: 'another driver moved this request on; this attempt stood down' },
        })
        .catch(() => {});
      return { stage, ok: false, status: request.status, message: `Superseded: ${message}` };
    }

    // A persistence or validation problem, not an API one. It still has to
    // reach stage_runs, or the stage looks like it is still running.
    await q
      .finishStageRun(run.id, {
        ok: false,
        failureReason: 'validation',
        error: message,
        durationMs: 0,
        detail: { stage },
      })
      .catch(() => {});
    await q.markStageFailed(request.id, stage, message).catch(() => {});
    return { stage, ok: false, status: 'failed', message };
  }
}

/**
 * Adds up the Claude usage across a stage that makes several calls.
 *
 * runStage() records model, effort and tokens for the single-call stages
 * automatically. The stages that fan out — generation writes one article per
 * option, retrieval digests one source at a time, packaging does one call per
 * channel — record their own stage_run, and were recording no usage at all.
 * That left the expensive half of the pipeline as the half with no cost or
 * model attached to it, which is the opposite of useful.
 */
class UsageTally {
  private model: string | null = null;
  private effort: string | null = null;
  private lastRequestId: string | null = null;
  private calls = 0;
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;

  add(outcome: claude.ClaudeOutcome<unknown>) {
    this.calls++;
    if (!outcome.ok) {
      this.lastRequestId = outcome.requestId ?? this.lastRequestId;
      return;
    }
    this.model = outcome.model;
    this.effort = outcome.effort;
    this.lastRequestId = outcome.requestId ?? this.lastRequestId;
    this.input += outcome.inputTokens;
    this.output += outcome.outputTokens;
    this.cacheRead += outcome.cacheReadTokens;
    this.cacheWrite += outcome.cacheWriteTokens;
  }

  /** The usage half of a finishStageRun({ ok: true, ... }) payload. */
  forStageRun() {
    return {
      model: this.model,
      effort: this.effort,
      // The LAST request id, not a list: it is the one to quote when asking
      // Anthropic about a stage that misbehaved near its end, and stage_runs
      // holds one column, not an array.
      claudeRequestId: this.lastRequestId,
      inputTokens: this.input,
      outputTokens: this.output,
      cacheReadTokens: this.cacheRead,
      cacheWriteTokens: this.cacheWrite,
    };
  }

  get callCount() {
    return this.calls;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   0 · Audit
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runAudit(request: ContentRequestRow): Promise<StageResult> {
  return runStage(
    request,
    'audit',
    () => claude.auditRequest(intakeOf(request)),
    async (audit) => {
      await q.saveAudit(request.id, {
        readiness: audit.readiness,
        raw: audit,
        suggestedKeyword: audit.suggested_primary_keyword,
        suggestedSecondary: audit.suggested_secondary_keywords,
      });
      return {
        stage: 'audit',
        ok: true,
        status: audit.readiness === 'blocked' ? 'blocked' : 'draft',
        message:
          audit.readiness === 'blocked'
            ? (audit.blocking_reason ?? 'This request cannot be worked as written.')
            : `Readiness: ${audit.readiness}.`,
        detail: { readiness: audit.readiness, questions: audit.clarifying_questions.length },
      };
    },
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 · Research
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * How many sources have to come back READABLE before research is satisfied.
 *
 * Counting URLs was never the useful measure. Thirteen sources of which two
 * can be quoted is a worse evidence base than six of which five can, and the
 * first shape is the one that produces an article resting on almost nothing
 * while looking well-sourced in the UI. So the bar is the readable count, and
 * research tops up until it clears it.
 */
const MIN_READABLE_SOURCES = 7; // the Standard profile's value, kept for messages


/**
 * Research, topped up when too little of it can actually be read.
 *
 * One round returns whatever the open web happened to serve that minute. When
 * most of it is behind a block, the honest fix is not to write from the two
 * pages that worked — it is to go and look somewhere else, telling the model
 * which URLs it has already been given so it does not hand back the same
 * blocked publishers again.
 *
 * Stops as soon as the readable count clears the bar, and also stops early if
 * a round adds no new readable source at all: two more rounds of the same
 * result is just spend.
 */
interface ToppedUpResearch extends claude.ResearchResult {
  /** How many research calls it took. 1 on a good draw. */
  rounds: number;
}

async function researchWithTopUp(
  request: ContentRequestRow,
): Promise<claude.ClaudeOutcome<ToppedUpResearch>> {
  // How hard to work, from the request itself — research is the most
  // expensive stage, and a topic needing three good pages should not pay for
  // the sweep a broad one needs. See lib/research-depth.ts.
  const depth = depthProfile(request.research_depth);
  const roundFindings: claude.ResearchFinding[][] = [];
  const briefs: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let requestId: string | null = null;
  let model = '';
  let effort = '';
  let durationMs = 0;
  let rounds = 0;

  const merged = () => mergeFindings(roundFindings, depth.maxSources);

  const stageStartedAt = Date.now();

  for (let round = 1; round <= depth.maxRounds; round++) {
    // A top-up round is a WHOLE extra research call — its own web searches,
    // its own fetches, its own several minutes. Nothing used to bound the sum
    // of them, so the stage could take as long as maxRounds × the slowest
    // round: one real run spent 793 seconds across two rounds, against a
    // platform that kills a function at 300.
    //
    // The deadline on each CALL cannot catch this, because each call is
    // individually reasonable. What is unreasonable is starting another one
    // when there is no time left to use the answer.
    //
    // Stopping here is not a failure. Research already reports a thin
    // evidence base and the article is written narrower — which is the whole
    // "degrade, don't die" rule this pipeline is built on, applied to time
    // instead of to sources.
    if (round > 1 && Date.now() - stageStartedAt > RESEARCH_ROUND_BUDGET_MS) {
      break;
    }

    const before = readableCount(merged());
    const outcome = await claude.researchTopic(intakeOf(request), {
      maxSearches: depth.maxSearches,
      maxFetches: depth.maxFetches,
      maxContentTokens: depth.maxContentTokens,
      briefWords: depth.briefWords,
      maxOutputTokens: depth.maxOutputTokens,
      maxContinuations: depth.maxContinuations,
      alreadyTried: round === 1 ? [] : roundFindings.flat().map((f) => f.url),
    });

    if (!outcome.ok) {
      // The FIRST round failing is a real research failure. A top-up failing
      // is not: whatever the earlier rounds found is still good, and losing
      // it because the optional extra call hit a rate limit would be absurd.
      if (round === 1) return outcome;
      break;
    }

    rounds = round;
    requestId = outcome.requestId ?? requestId;
    model = outcome.model;
    effort = outcome.effort;
    durationMs += outcome.durationMs;
    usage.inputTokens += outcome.inputTokens;
    usage.outputTokens += outcome.outputTokens;
    usage.cacheReadTokens += outcome.cacheReadTokens;
    usage.cacheWriteTokens += outcome.cacheWriteTokens;
    briefs.push(outcome.data.brief_md);
    roundFindings.push(outcome.data.findings);

    if (readableCount(merged()) >= depth.minReadable) break;
    // A round that turned up nothing new to read means the next one would
    // come back the same way. Stop rather than pay for the same answer twice.
    if (round > 1 && readableCount(merged()) === before) break;
  }

  const findings = merged();

  return {
    ok: true,
    data: {
      brief_md: briefs.length > 1 ? briefs.join('\n\n---\n\n') : (briefs[0] ?? ''),
      findings,
      rounds,
    },
    requestId,
    model,
    effort,
    durationMs,
    ...usage,
  };
}

export async function runResearch(request: ContentRequestRow): Promise<StageResult> {
  await q.setStatus(request.id, 'researching', ['draft', 'blocked', 'failed', 'researching']);

  return runStage(
    request,
    'research',
    () => researchWithTopUp(request),
    async (research, runId) => {
      // The user's own source URL is a source whether or not search found it.
      const findings = [...research.findings];
      if (request.source_url && !findings.some((f) => f.url === request.source_url)) {
        findings.unshift({
          url: request.source_url,
          title: request.source_url,
          fetched: false,
          text: null,
        });
      }

      if (!findings.length) {
        throw new Error(
          'Research found no sources. Without source material nothing downstream can be grounded.',
        );
      }

      for (const f of findings) {
        await q.upsertSource({
          requestId: request.id,
          kind: 'web',
          url: f.url,
          title: f.title,
          discoveredBy: runId,
          rawText: f.text,
          // 'fetched' means "there is text to digest". A page the model saw in
          // search results but never opened stays 'discovered': it can be
          // attributed, but it cannot ground a claim.
          status: f.text ? 'fetched' : 'discovered',
        });
      }

      // The brief itself is stored as a source, so the planner can use it and
      // so the research is visible in the UI rather than only in a log.
      await q.upsertSource({
        requestId: request.id,
        kind: 'pasted',
        url: null,
        title: 'Research brief',
        discoveredBy: runId,
        rawText: research.brief_md,
        status: 'fetched',
      });

      const readable = findings.filter((f) => f.text).length;
      if (readable === 0) {
        // Refusing to continue is correct: an article grounded only in the
        // model's own summary of pages it never quoted is precisely what this
        // pipeline exists to prevent, and web_search gives us no way to
        // recover real quotes — its results carry only `encrypted_content`,
        // which is opaque to us, and it attaches no cited_text.
        //
        // But refusing is not the same as failing. Nothing broke; the sites
        // declined to be read. So the request PARKS for a human with the one
        // action that actually fixes it — paste a source you can read — while
        // the brief and all thirteen URLs stay on the record. Failing here
        // instead offered a retry button that would have hit the same walls.
        const reason =
          `Searched ${research.rounds === 1 ? 'once' : `${research.rounds} times`} and found ` +
          `${findings.length} sources, but every one of them refused automated reading — that is ` +
          'routine for academic publishers and large aggregators. Nothing can be quoted, so ' +
          'nothing downstream could be grounded. Add a source you can read and this picks up ' +
          'again from retrieval.';
        await q.parkForHuman(request.id, 'research', reason, ['researching']);
        return {
          stage: 'research',
          ok: true,
          status: 'blocked',
          message: reason,
          detail: { sources: findings.length, readable: 0, rounds: research.rounds, parked: true },
        };
      }

      await q.advanceStatus(request.id, 'retrieving', ['researching']);
      return {
        stage: 'research',
        ok: true,
        status: 'retrieving',
        message:
          `Found ${findings.length} sources, ${readable} of them readable` +
          (research.rounds > 1 ? ` (${research.rounds} rounds of searching).` : '.') +
          (readable < MIN_READABLE_SOURCES
            ? ' That is a thin evidence base — the article will be narrower than usual.'
            : ''),
        detail: {
          sources: findings.length,
          readable,
          rounds: research.rounds,
          thin: readable < MIN_READABLE_SOURCES,
        },
      };
    },
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 · Retrieval — digest each source into exact-quote excerpts.

   One Claude call per source, and a source that fails to digest is marked
   failed and skipped rather than killing the stage: losing one of six sources
   is a degraded result, not a broken pipeline. The stage only fails if
   NOTHING could be digested, because then there is no evidence base at all.
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runRetrieval(request: ContentRequestRow): Promise<StageResult> {
  await q.setStatus(request.id, 'retrieving', ['researching', 'retrieving', 'failed']);

  const run = await q.startStageRun(request.id, 'retrieval');
  const startedAt = Date.now();

  try {
    const sources = await q.getSources(request.id);
    const context = `${request.raw_idea}\nAudience: ${request.target_audience}`;

    const usage = new UsageTally();
    let digested = 0;
    let excerptCount = 0;
    /** Sources that could not contribute quotes, and why. Not errors. */
    const skipped: string[] = [];

    // Decide what each source needs before calling anything, so the calls
    // themselves can go out together. This pass is all local checks and small
    // writes — no Claude, nothing worth overlapping.
    const toDigest: { source: (typeof sources)[number]; text: string }[] = [];

    for (const source of sources) {
      if (source.status === 'digested') {
        digested++;
        continue;
      }
      // Nothing to read. The URL is kept as a source for attribution, but it
      // cannot produce excerpts.
      const verdict = assessSource({ title: source.title, text: source.raw_text });
      if (!verdict.usable) {
        // Not a failure — a normal outcome, and the distinction matters.
        //
        // Most of these are URLs the search found but never opened: academic
        // publishers and ResearchGate block automated fetching, so a real,
        // relevant paper can be perfectly visible in results and still be
        // unreadable. That is worth showing honestly rather than flagging as
        // if something broke: the URL is still legitimate attribution, it
        // just cannot ground a quote.
        //
        // Marking these 'failed' with "no text was retrieved" made routine
        // behaviour look like an error, and buried the one case that IS worth
        // noticing — a page we fetched and got junk from.
        const neverFetched = !source.raw_text?.trim();
        skipped.push(`${source.title}: ${verdict.reason}`);
        await q.setSourceOutcome(
          source.id,
          neverFetched ? 'discovered' : 'rejected',
          verdict.reason,
        );
        continue;
      }
      toDigest.push({ source, text: source.raw_text!.trim() });
    }

    // One call per source, several at a time. These are independent — no
    // source's digest depends on another's — so running them in series only
    // ever added up their latencies.
    const digests = await mapWithLimit(toDigest, STAGE_CONCURRENCY, async ({ source, text }) => ({
      source,
      outcome: await claude.digestSource({
        sourceText: text,
        sourceTitle: source.title,
        context,
      }),
    }));

    // Persisting stays serial: the writes are short, and keeping them in input
    // order means the excerpt numbering does not depend on which call
    // happened to answer first.
    for (const { source, outcome } of digests) {
      usage.add(outcome);

      if (!outcome.ok) {
        // This one IS a failure: we had the text and the digest call broke.
        skipped.push(`${source.title}: ${outcome.message}`);
        await q.markSourceFailed(source.id, `${outcome.reason}: ${outcome.message}`);
        continue;
      }

      await q.saveDigest(source.id, {
        digestMd: outcome.data.digest_md,
        citations: outcome.data.citations,
      });

      const excerpts = excerptsFrom(outcome.data.digest_md, outcome.data.citations);
      const inserted = await q.insertExcerpts(request.id, source.id, excerpts);
      excerptCount += inserted.length;
      digested++;
    }

    if (excerptCount === 0) {
      throw new Error(
        `No source could be read into usable excerpts. ${skipped.join('; ') || 'No sources had text.'}`,
      );
    }

    await q.finishStageRun(run.id, {
      ok: true,
      durationMs: Date.now() - startedAt,
      ...usage.forStageRun(),
      detail: { digested, excerpts: excerptCount, skipped, claude_calls: usage.callCount },
    });
    await q.advanceStatus(request.id, 'selecting', ['retrieving']);
    await q.clearFailure(request.id);

    return {
      stage: 'retrieval',
      ok: true,
      status: 'selecting',
      message:
        `Digested ${digested} sources into ${excerptCount} excerpts` +
        (skipped.length ? `; ${skipped.length} could not be read.` : '.'),
      detail: { digested, excerpts: excerptCount, skipped },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const superseded = await standDown(request, 'retrieval', run.id, err, startedAt);
    if (superseded) return superseded;
    await q.finishStageRun(run.id, {
      ok: false,
      failureReason: 'validation',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    await q.markStageFailed(request.id, 'retrieval', message);
    return { stage: 'retrieval', ok: false, status: 'failed', message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 · Selection
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runSelection(request: ContentRequestRow): Promise<StageResult> {
  await q.setStatus(request.id, 'selecting', ['retrieving', 'selecting', 'failed']);

  const excerpts = await q.getExcerpts(request.id);
  if (!excerpts.length) {
    await q.markStageFailed(request.id, 'selection', 'There are no excerpts to select from.');
    return {
      stage: 'selection',
      ok: false,
      status: 'failed',
      message: 'There are no excerpts to select from. Re-run retrieval first.',
    };
  }

  const sources = await q.getSources(request.id);
  const titleById = new Map(sources.map((s) => [s.id, s.title]));

  return runStage(
    request,
    'selection',
    () =>
      claude.selectSources({
        intake: intakeOf(request),
        excerpts: excerpts.map((e) => ({
          id: e.id,
          quote: e.quote,
          gist: e.gist,
          source_title: titleById.get(e.source_id) ?? 'a source',
        })),
      }),
    async (selection, runId) => {
      // Only decisions about excerpts that actually belong to this request.
      const valid = new Set(excerpts.map((e) => e.id));
      const applicable = selection.selections.filter((s) => valid.has(s.excerpt_id));

      // Selection is not allowed to hand back an empty evidence base while
      // excerpts exist — see applyKeepFloor for why that happens and why the
      // floor lives in code rather than in the prompt.
      const { decisions, floored } = applyKeepFloor(applicable);

      await q.applySelection(runId, decisions);

      const kept = decisions.filter((s) => s.keep).length;
      if (kept === 0) {
        throw new Error(
          'Selection kept no excerpts. There would be no evidence base to write from.',
        );
      }

      await q.advanceStatus(request.id, 'planning', ['selecting']);
      return {
        stage: 'selection',
        ok: true,
        status: 'planning',
        message: floored
          ? `Kept ${kept} of ${excerpts.length} excerpts (the evidence base is thin — ` +
            'selection dropped everything, so the highest-scoring were kept anyway).'
          : `Kept ${kept} of ${excerpts.length} excerpts.`,
        detail: {
          kept,
          considered: excerpts.length,
          floored,
          coverage_gaps: selection.coverage_gaps,
        },
      };
    },
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   4 · Planning
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runPlanning(request: ContentRequestRow): Promise<StageResult> {
  await q.setStatus(request.id, 'planning', ['selecting', 'planning', 'failed']);

  const selected = await q.getSelectedForPrompt(request.id);
  const sources = await q.getSources(request.id);
  const brief = sources.find((s) => s.title === 'Research brief')?.raw_text ?? '';

  return runStage(
    request,
    'planning',
    () =>
      claude.planContent({
        intake: intakeOf(request),
        optionCount: request.option_count,
        researchBrief: brief,
        selected,
      }),
    async (plan, runId) => {
      const row = await q.insertPlan({
        requestId: request.id,
        stageRunId: runId,
        primaryKeyword: plan.primary_keyword,
        secondaryKeywords: plan.secondary_keywords,
        thesis: plan.thesis,
        outline: plan.outline,
        angles: plan.angles,
        linkTargets: plan.link_targets,
      });

      // One article slot per angle, created now so the UI can show the
      // options before any of them has been written.
      for (const angle of plan.angles) {
        await q.upsertArticle({
          requestId: request.id,
          optionIndex: angle.option_index,
          angle: angle.angle,
          planId: row.id,
        });
      }

      await q.advanceStatus(request.id, 'generating', ['planning']);
      return {
        stage: 'planning',
        ok: true,
        status: 'generating',
        message: `Planned ${plan.angles.length} options around "${plan.primary_keyword}".`,
        detail: { plan_no: row.plan_no, sections: plan.outline.length },
      };
    },
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5 · Generation — one call per option, run concurrently.

   Partial success IS success: if two of three options come back, the stage
   advances with two. One refusal should cost one option, not the run.
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runGeneration(request: ContentRequestRow): Promise<StageResult> {
  await q.setStatus(request.id, 'generating', ['planning', 'generating', 'failed']);

  const run = await q.startStageRun(request.id, 'generation');
  const startedAt = Date.now();

  try {
    const plan = await q.getLatestPlan(request.id);
    if (!plan) throw new Error('There is no plan to generate from. Re-run planning first.');

    const articles = await q.getArticles(request.id);
    const selected = await q.getSelectedForPrompt(request.id);
    const angles = (plan.angles_json ?? []) as { option_index: number; angle: string; why_it_differs: string }[];

    const usage = new UsageTally();
    const results = await Promise.all(
      articles.map(async (article) => {
        const angle = angles.find((a) => a.option_index === article.option_index);
        const outcome = await claude.generateArticle({
          intake: intakeOf(request),
          optionIndex: article.option_index,
          angle: article.angle,
          whyItDiffers: angle?.why_it_differs ?? '',
          plan: {
            thesis: plan.thesis,
            primary_keyword: plan.primary_keyword,
            secondary_keywords: plan.secondary_keywords,
            outline: plan.outline_json,
            link_targets: plan.link_targets_json,
          },
          selected,
        });
        usage.add(outcome);

        if (!outcome.ok) {
          return { option: article.option_index, ok: false as const, error: outcome.message };
        }

        await persistDraft({
          request,
          articleId: article.id,
          parentVersionId: null,
          origin: 'generated',
          revisionInstruction: null,
          evaluationId: null,
          draft: outcome.data,
          primaryKeyword: plan.primary_keyword,
          secondaryKeywords: plan.secondary_keywords,
          model: outcome.model,
          claudeRequestId: outcome.requestId,
          stageRunId: run.id,
          actor: 'system',
        });

        return { option: article.option_index, ok: true as const };
      }),
    );

    const wrote = results.filter((r) => r.ok).length;
    const failures = results.filter((r) => !r.ok);

    if (wrote === 0) {
      throw new Error(
        `No option could be generated. ${failures.map((f) => `option ${f.option}: ${'error' in f ? f.error : ''}`).join('; ')}`,
      );
    }

    await q.finishStageRun(run.id, {
      ok: true,
      durationMs: Date.now() - startedAt,
      ...usage.forStageRun(),
      detail: { wrote, failed: failures.length, failures, claude_calls: usage.callCount },
    });
    await q.advanceStatus(request.id, 'evaluating', ['generating']);
    await q.clearFailure(request.id);

    return {
      stage: 'generation',
      ok: true,
      status: 'evaluating',
      message: `Wrote ${wrote} of ${articles.length} options.`,
      detail: { wrote, failed: failures.length },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const superseded = await standDown(request, 'generation', run.id, err, startedAt);
    if (superseded) return superseded;
    await q.finishStageRun(run.id, {
      ok: false,
      failureReason: 'validation',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    await q.markStageFailed(request.id, 'generation', message);
    return { stage: 'generation', ok: false, status: 'failed', message };
  }
}

/**
 * Persist a draft as a new immutable version, with its SEO report and its
 * claim attribution.
 *
 * The grounding rule is enforced here, not in the prompt: a claim marked
 * "grounded" whose excerpt ids do not resolve to SELECTED excerpts of this
 * request is downgraded to "unsupported" before it is stored. The model
 * cannot certify its own grounding.
 */
async function persistDraft(p: {
  request: ContentRequestRow;
  articleId: string;
  parentVersionId: string | null;
  origin: 'generated' | 'auto_revised' | 'human_revised' | 'human_edited';
  revisionInstruction: string | null;
  evaluationId: string | null;
  draft: {
    title: string;
    dek: string;
    body_md: string;
    claims: { claim_text: string; section_key: string; support: string; excerpt_ids: string[] }[];
    assumptions: string[];
    gaps: string[];
  };
  primaryKeyword: string;
  secondaryKeywords: string[];
  model: string | null;
  claudeRequestId: string | null;
  stageRunId: string | null;
  createdBy?: string | null;
  actor: string;
}) {
  const seo = checkSeo({
    title: p.draft.title,
    body_md: p.draft.body_md,
    primary_keyword: p.primaryKeyword,
    secondary_keywords: p.secondaryKeywords,
  });

  const version = await q.insertVersion({
    requestId: p.request.id,
    articleId: p.articleId,
    parentVersionId: p.parentVersionId,
    origin: p.origin,
    revisionInstruction: p.revisionInstruction,
    evaluationId: p.evaluationId,
    title: p.draft.title,
    slug: slugify(p.draft.title),
    dek: p.draft.dek,
    bodyMd: p.draft.body_md,
    wordCount: seo.word_count,
    readingTimeS: seo.reading_time_s,
    seoJson: seo,
    seoPass: seo.pass,
    assumptions: p.draft.assumptions,
    gaps: p.draft.gaps,
    model: p.model,
    claudeRequestId: p.claudeRequestId,
    stageRunId: p.stageRunId,
    createdBy: p.createdBy ?? null,
    actor: p.actor,
  });

  const selectedIds = (await q.getSelectedForPrompt(p.request.id)).map((e) => e.id);
  await q.insertClaims(version.id, groundClaims(p.draft.claims, selectedIds));
  return version;
}

/* ═══════════════════════════════════════════════════════════════════════════
   6 · Evaluation — one per version, against the brief's rubric.
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runEvaluation(request: ContentRequestRow): Promise<StageResult> {
  await q.setStatus(request.id, 'evaluating', ['generating', 'evaluating', 'revising', 'failed']);

  const run = await q.startStageRun(request.id, 'evaluation');
  const startedAt = Date.now();

  try {
    const versions = await q.getCurrentVersions(request.id);
    if (!versions.length) throw new Error('There are no drafts to evaluate.');

    const selected = await q.getSelectedForPrompt(request.id);
    const usage = new UsageTally();
    const statuses: string[] = [];

    // Work out which versions still need scoring, and gather what each call
    // needs, before making any of them.
    const pending: { version: (typeof versions)[number]; claims: Awaited<ReturnType<typeof q.getClaims>> }[] = [];

    for (const version of versions) {
      // unique(version_id) — a version can never be re-scored, only a new
      // version scored. Skip anything already evaluated so a retry of this
      // stage does not collide.
      //
      // One lookup, not two: this asked the same question twice on every
      // iteration, which on a three-option request is three wasted round
      // trips to a database in another region.
      const existing = await q.getEvaluationFor(version.id);
      if (existing) {
        statuses.push(existing.status);
        continue;
      }
      pending.push({ version, claims: await q.getClaims(version.id) });
    }

    // One call per option, several at a time. Each option is scored on its
    // own merits, so nothing here needed to wait for the option before it.
    const evaluated = await mapWithLimit(pending, STAGE_CONCURRENCY, async ({ version, claims }) => {
      const seo = version.seo_json as unknown as ReturnType<typeof checkSeo>;
      return {
        version,
        outcome: await claude.evaluateArticle({
          intake: intakeOf(request),
          title: version.title,
          bodyMd: version.body_md,
          claims: claims.map((c) => ({
            claim_text: c.claim_text,
            support: c.support,
            excerpt_ids: [],
          })),
          selected,
          seoFindings: (seo?.checks ?? [])
            .map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.label}: ${c.detail}`)
            .join('\n'),
        }),
      };
    });

    for (const { version, outcome } of evaluated) {
      usage.add(outcome);

      if (!outcome.ok) {
        throw new Error(`Evaluating option failed — ${outcome.reason}: ${outcome.message}`);
      }

      await q.insertEvaluation({
        versionId: version.id,
        requestId: request.id,
        status: outcome.data.status,
        overallScore: outcome.data.overall_score,
        summary: outcome.data.summary,
        unsupportedClaims: outcome.data.unsupported_claims,
        sectionsNeedingRevision: outcome.data.sections_needing_revision,
        recommendedChanges: outcome.data.recommended_changes,
        raw: outcome.data,
        scores: outcome.data.scores,
        model: outcome.model,
        claudeRequestId: outcome.requestId,
        stageRunId: run.id,
      });
      statuses.push(outcome.data.status);
    }

    // The auto-revision loop, bounded. When every option needs work and there
    // is budget left, revise. When the budget is spent, go to the human ANYWAY
    // with the failing evaluations attached — the machine's job is to route to
    // a person, and only a person can decide to reject.
    const anyPass = statuses.includes('pass');
    const budgetLeft = request.revision_round < request.max_revision_rounds;
    // Scores this round against the round before, so a revision that changed
    // nothing ends the loop instead of buying another one.
    const scored = await q.bestScoreByRound(request.id);
    const next = nextAfterEvaluation({
      anyPassed: anyPass,
      bestScore: scored.current,
      previousBestScore: scored.previous,
      revisionRound: request.revision_round,
      maxRevisionRounds: request.max_revision_rounds,
    });

    await q.finishStageRun(run.id, {
      ok: true,
      durationMs: Date.now() - startedAt,
      ...usage.forStageRun(),
      detail: {
        statuses,
        next,
        revision_round: request.revision_round,
        claude_calls: usage.callCount,
      },
    });
    // startAutoRevision spends one unit of the budget in the same statement
    // as the transition — the thing that actually makes budgetLeft above
    // eventually turn false. setStatus alone (used for the awaiting_review
    // path) leaves revision_round untouched, which is correct there: the
    // loop is ending, not spending another round.
    if (next === 'revising') {
      await q.startAutoRevision(request.id);
    } else {
      await q.advanceStatus(request.id, next, ['evaluating']);
      await notifyReviewers(request.id);
    }
    await q.clearFailure(request.id);

    return {
      stage: 'evaluation',
      ok: true,
      status: next,
      message: anyPass
        ? `Evaluated ${statuses.length} options; ${statuses.filter((s) => s === 'pass').length} passed.`
        : budgetLeft
          ? 'No option passed. Revising.'
          : 'No option passed and the revision budget is spent. Sending to a human with the evaluations attached.',
      detail: { statuses },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const superseded = await standDown(request, 'evaluation', run.id, err, startedAt);
    if (superseded) return superseded;
    await q.finishStageRun(run.id, {
      ok: false,
      failureReason: 'validation',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    await q.markStageFailed(request.id, 'evaluation', message);
    return { stage: 'evaluation', ok: false, status: 'failed', message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   7 · Revision — a new version per option, never an edit of the old one.
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runRevision(
  request: ContentRequestRow,
  opts: { instruction?: string; articleId?: string; actor?: string; createdBy?: string | null } = {},
): Promise<StageResult> {
  await q.setStatus(request.id, 'revising', ['evaluating', 'revising', 'awaiting_review', 'rejected', 'failed']);

  const run = await q.startStageRun(request.id, 'revision');
  const startedAt = Date.now();

  try {
    const plan = await q.getLatestPlan(request.id);
    const selected = await q.getSelectedForPrompt(request.id);
    const all = await q.getCurrentVersions(request.id);
    const versions = opts.articleId ? all.filter((v) => v.article_id === opts.articleId) : all;

    if (!versions.length) throw new Error('There is nothing to revise.');

    const fromHuman = Boolean(opts.instruction);
    const usage = new UsageTally();
    let revised = 0;
    const failures: string[] = [];

    // Work out what each option needs BEFORE calling anything, so the calls
    // themselves can run together.
    const jobs = [];
    for (const version of versions) {
      const evaluation = await q.getEvaluationFor(version.id);

      // An option the evaluator passed does not get rewritten. Revision is
      // reached when nothing passed, so this is usually empty — but a human
      // revising one option of three must not silently have the other two
      // rewritten underneath them, and a passing draft is the one thing a
      // revision can only make worse.
      if (!opts.instruction && evaluation?.status === 'pass') continue;

      // A human instruction always wins. Without one, the evaluation's own
      // findings are the instruction.
      const instruction =
        opts.instruction ||
        [
          evaluation?.summary,
          ...(((evaluation?.unsupported_claims ?? []) as { claim_text: string; why: string }[]) ?? []).map(
            (c) => `Unsupported: "${c.claim_text}" — ${c.why}`,
          ),
          ...(((evaluation?.sections_needing_revision ?? []) as { section_key: string; problem: string }[]) ?? []).map(
            (s) => `Section "${s.section_key}": ${s.problem}`,
          ),
          ...(((evaluation?.recommended_changes ?? []) as string[]) ?? []),
        ]
          .filter(Boolean)
          .join('\n');

      if (!instruction.trim()) continue; // nothing was wrong with this one
      jobs.push({ version, evaluation, instruction });
    }

    // One call per option, RUN TOGETHER — the same shape generation already
    // uses. Sequentially, three options at ~145s each is ~435s, and the
    // platform kills the function at 300: this stage failed three times in a
    // row that way, each time throwing out the options it had already
    // rewritten. Run together the stage costs about as long as its slowest
    // option instead of the sum of all of them.
    const outcomes = await Promise.all(
      jobs.map(async (job) => ({
        job,
        outcome: await claude.reviseArticle({
          intake: intakeOf(request),
          title: job.version.title,
          bodyMd: job.version.body_md,
          instruction: job.instruction,
          fromHuman,
          selected,
        }),
      })),
    );

    // Persisting stays sequential. These writes are short, and doing them one
    // at a time keeps option order deterministic in the log.
    for (const { job, outcome } of outcomes) {
      usage.add(outcome);

      if (!outcome.ok) {
        // One option's failure is not the stage's failure. Generation already
        // works this way; revision used to throw here, which threw away any
        // option it had ALREADY revised in this same pass and failed the whole
        // request over one bad call.
        failures.push(`Option ${job.version.article_id.slice(0, 8)} — ${outcome.reason}: ${outcome.message}`);
        continue;
      }

      await persistDraft({
        request,
        articleId: job.version.article_id,
        parentVersionId: job.version.id,
        origin: fromHuman ? 'human_revised' : 'auto_revised',
        revisionInstruction: job.instruction,
        evaluationId: job.evaluation?.id ?? null,
        draft: outcome.data,
        primaryKeyword: plan?.primary_keyword ?? request.primary_keyword,
        secondaryKeywords: plan?.secondary_keywords ?? request.secondary_keywords,
        model: outcome.model,
        claudeRequestId: outcome.requestId,
        stageRunId: run.id,
        createdBy: opts.createdBy ?? null,
        actor: opts.actor ?? 'system',
      });
      revised++;
    }

    // Nothing was rewritten. What happens next depends on who asked.
    if (revised === 0) {
      // A person asked for a specific change and did not get it. They need to
      // know that, and a retry is theirs to make, so this stays a failure.
      if (fromHuman) {
        throw new Error(
          failures.length
            ? `The revision could not be produced. ${failures[0]}`
            : 'No option had anything to revise.',
        );
      }

      // The automatic loop, though, is not allowed to fail a request that has
      // reviewable drafts sitting behind it. Every option here has already
      // been written and scored; the revision pass simply could not improve
      // them. That is the machine reaching the end of what it can do on its
      // own, which is the definition of "send it to a person" — the same rule
      // that already applies when the revision budget runs out.
      await q.finishStageRun(run.id, {
        ok: true,
        durationMs: Date.now() - startedAt,
        ...usage.forStageRun(),
        detail: { revised: 0, from_human: false, failures, routed_to_review: true },
      });
      await q.advanceStatus(request.id, 'awaiting_review', ['revising']);
      await q.clearFailure(request.id);
      await notifyReviewers(request.id);

      return {
        stage: 'revision',
        ok: true,
        status: 'awaiting_review',
        message: failures.length
          ? 'The automatic revision could not improve these drafts, so they go to you as they stand.'
          : 'Nothing was left to revise automatically — over to you.',
        detail: { revised: 0, failures },
      };
    }

    await q.finishStageRun(run.id, {
      ok: true,
      durationMs: Date.now() - startedAt,
      ...usage.forStageRun(),
      detail: { revised, failed: failures.length, failures, from_human: fromHuman, claude_calls: usage.callCount },
    });
    await q.advanceStatus(request.id, 'evaluating', ['revising']);
    await q.clearFailure(request.id);

    return {
      stage: 'revision',
      ok: true,
      status: 'evaluating',
      message:
        `Revised ${revised} option${revised === 1 ? '' : 's'}.` +
        (failures.length ? ` ${failures.length} could not be revised and go forward as they are.` : ''),
      detail: { revised, failed: failures.length },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const superseded = await standDown(request, 'revision', run.id, err, startedAt);
    if (superseded) return superseded;
    await q.finishStageRun(run.id, {
      ok: false,
      failureReason: 'validation',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    await q.markStageFailed(request.id, 'revision', message);
    return { stage: 'revision', ok: false, status: 'failed', message };
  }
}

/**
 * Tell the reviewers a request has reached the gate.
 *
 * Fire-and-forget on purpose. The pipeline has already done its work and
 * moved the request; a mail server being slow or misconfigured must not undo
 * that or fail the stage. What it must not do is fail SILENTLY, so the
 * outcome — sent, skipped, or refused — is written to the request's own log
 * either way.
 *
 * The link uses APP_URL because there is no incoming request to derive an
 * origin from this deep in the pipeline. That setting has been stale before,
 * and a wrong one here sends reviewers to the wrong place, so it is worth
 * checking after a domain change.
 */
async function notifyReviewers(requestId: string): Promise<void> {
  try {
    const request = await q.getRequest(requestId);
    if (!request) return;

    const [emails, author, versions] = await Promise.all([
      q.listReviewerEmails(),
      request.author_id ? q.findAppUser(request.author_id) : Promise.resolve(null),
      q.getCurrentVersions(requestId),
    ]);

    const result = await sendReviewRequest({
      toEmails: emails,
      title: request.title_hint || request.raw_idea.slice(0, 80),
      audience: request.target_audience,
      createdBy: author?.full_name?.trim() || author?.email || 'someone',
      optionCount: versions.length,
      link: `${env.APP_URL.replace(/\/$/, '')}/r/${requestId}`,
    });

    await q.logEvent({
      requestId,
      actor: 'system',
      stage: null,
      step: 'reviewers_notified',
      ok: result.sent || result.skipped,
      // EmailOutcome is a discriminated union — a sent result carries counts,
      // an unsent one carries a reason. Narrow rather than reach for fields
      // that only exist on one arm.
      detail: result.sent
        ? { reviewers: emails.length, sent: true, accepted: result.accepted, rejected: result.rejected }
        : { reviewers: emails.length, sent: false, skipped: result.skipped, reason: result.reason },
    });
  } catch (err) {
    await q
      .logEvent({
        requestId,
        actor: 'system',
        stage: null,
        step: 'reviewers_notified',
        ok: false,
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
      .catch(() => {});
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   8 · Packaging — the approved article into LinkedIn, X, and the newsletter.

   Each channel gets one retry with its own rule violations fed back into the
   prompt. Channel rules are mechanical (a word band, a hashtag cap), which is
   exactly the kind of miss a model fixes reliably when told precisely what it
   broke — and exactly the kind a human should not have to fix by hand.
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runPackaging(request: ContentRequestRow): Promise<StageResult> {
  if (!request.approved_version_id) {
    return {
      stage: 'packaging',
      ok: false,
      status: request.status,
      message: 'This request has not been approved, so there is nothing to package.',
    };
  }

  await q.setStatus(request.id, 'packaging', ['approved', 'packaging', 'ready', 'failed']);

  const run = await q.startStageRun(request.id, 'packaging');
  const startedAt = Date.now();

  try {
    const version = await q.getVersion(request.approved_version_id);
    if (!version) throw new Error('The approved version could not be loaded.');

    const wanted = request.channels_wanted.length ? request.channels_wanted : [...CHANNELS];
    const produced: Channel[] = [];
    const problems: string[] = [];
    const usage = new UsageTally();

    // Channels that already have a passing asset for THIS approved version are
    // done — don't pay to write them again.
    //
    // Without this, re-running packaging regenerated every channel from
    // scratch, including the ones that were already fine. One real request
    // ended up with 17 assets where 3 were wanted (eight X posts, because the
    // X post kept overshooting 280 characters while LinkedIn and the
    // newsletter were regenerated alongside it for no reason at all).
    const existing = await q.getLatestAssets(request.id);
    const alreadyGood = new Set(
      existing.filter((a) => a.rules_pass && a.version_id === version.id).map((a) => a.channel),
    );

    // Channels are independent — LinkedIn's wording has no bearing on the
    // newsletter's — so they are packaged together rather than in turn. The
    // retry inside each channel stays serial, because attempt two is the one
    // that gets told what attempt one broke.
    const todo = wanted.filter((c) => !alreadyGood.has(c));
    for (const channel of wanted) if (alreadyGood.has(channel)) produced.push(channel);

    await mapWithLimit(todo, STAGE_CONCURRENCY, async (channel) => {
      // Start from what the LAST attempt broke, not from nothing.
      //
      // A regenerate used to begin blind: attempt 1 was handed no feedback, so
      // pressing Regenerate on a failing asset threw away the diagnosis
      // already sitting in the database and re-made the same mistake before it
      // could learn anything. Two manual regenerates therefore bought one
      // informed attempt each instead of two.
      const lastFailed = existing.find(
        (a) => a.channel === channel && a.version_id === version.id && !a.rules_pass,
      );
      let feedback =
        lastFailed && lastFailed.rules_json
          ? failureInstructions(channel, lastFailed.rules_json as unknown as RuleReport, lastFailed.body)
          : undefined;
      let done = false;

      for (let attempt = 1; attempt <= 2 && !done; attempt++) {
        const outcome = await claude.packageForChannel({
          channel,
          intake: intakeOf(request),
          title: version.title,
          bodyMd: version.body_md,
          ruleFeedback: feedback,
        });
        usage.add(outcome);

        if (!outcome.ok) {
          problems.push(`${channel}: ${outcome.message}`);
          break;
        }

        const payload = outcome.data as Record<string, unknown>;
        const report = checkChannel(channel, payload);

        // The asset is stored whether or not it passes, so a human can see
        // what was produced and why it was rejected. rules_pass is what gates
        // the move to `ready`.
        await q.insertChannelAsset({
          requestId: request.id,
          versionId: version.id,
          channel,
          body: String(payload.body ?? payload.body_md ?? ''),
          subject: typeof payload.subject === 'string' ? payload.subject : null,
          preheader: typeof payload.preheader === 'string' ? payload.preheader : null,
          cta: typeof payload.cta === 'string' ? payload.cta : '',
          hashtags: Array.isArray(payload.hashtags) ? (payload.hashtags as string[]) : [],
          payload,
          rules: report,
          rulesPass: report.pass,
          model: outcome.model,
          claudeRequestId: outcome.requestId,
          stageRunId: run.id,
        });

        if (report.pass) {
          produced.push(channel);
          done = true;
        } else {
          // Instructions, not observations: "cut at least 124 characters"
          // beats "384 characters" for a model that could not count to 280
          // the first time.
          feedback = failureInstructions(channel, report, String(payload.body ?? payload.body_md ?? ''));
          if (attempt === 2) problems.push(`${channel}: ${failureSummary(report)}`);
        }
      }
    });

    if (!produced.length) {
      throw new Error(`No channel asset passed its formatting rules. ${problems.join('; ')}`);
    }

    const allDone = produced.length === wanted.length;
    await q.finishStageRun(run.id, {
      ok: true,
      durationMs: Date.now() - startedAt,
      ...usage.forStageRun(),
      detail: { produced, problems, claude_calls: usage.callCount },
    });

    // 'ready' even when a channel could not be made to pass its rules.
    //
    // Staying in 'packaging' was a trap: nextStage() sends 'packaging' back to
    // the driver, so a channel that could not pass — an X post that would not
    // come in under 280 characters, say — put the driver in a loop, burning a
    // full set of channel generations per turn until it hit the stage cap.
    //
    // Partly-done is a real, honest state: the assets that passed are
    // publishable now, the one that didn't is stored and visible with its
    // failures, and a person can regenerate just that one. The publish route
    // and the queue UI already only offer channels whose assets pass, so
    // 'ready' here cannot leak a broken asset into the queue.
    await q.advanceStatus(request.id, 'ready', ['packaging']);
    await q.clearFailure(request.id);

    return {
      stage: 'packaging',
      ok: true,
      status: 'ready',
      message: allDone
        ? `Produced all ${produced.length} channel assets.`
        : `Produced ${produced.length} of ${wanted.length}. ${problems.join('; ')}`,
      detail: { produced, problems },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const superseded = await standDown(request, 'packaging', run.id, err, startedAt);
    if (superseded) return superseded;
    await q.finishStageRun(run.id, {
      ok: false,
      failureReason: 'validation',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    await q.markStageFailed(request.id, 'packaging', message);
    return { stage: 'packaging', ok: false, status: 'failed', message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Driving the machine stages
   ═══════════════════════════════════════════════════════════════════════════ */

export const STAGE_RUNNERS = {
  audit: runAudit,
  research: runResearch,
  retrieval: runRetrieval,
  selection: runSelection,
  planning: runPlanning,
  generation: runGeneration,
  evaluation: runEvaluation,
  // Packaging is a machine stage like any other: once a human has approved,
  // turning the article into the three channel assets needs no further input.
  // Having it here means the driver carries straight on after an approval
  // instead of parking and waiting for another click.
  packaging: runPackaging,
} as const;

export type RunnableStage = keyof typeof STAGE_RUNNERS;

/**
 * Which stage should run next, given where the request is now.
 *
 * Returns null when the pipeline is waiting on a human, or is finished.
 */
export function nextStage(request: ContentRequestRow): RunnableStage | 'revision' | null {
  switch (request.status) {
    case 'draft':
      return request.readiness === null ? 'audit' : 'research';
    case 'blocked':
      return null; // a human has to fix the intake
    case 'researching':
      return 'research';
    case 'retrieving':
      return 'retrieval';
    case 'selecting':
      return 'selection';
    case 'planning':
      return 'planning';
    case 'generating':
      return 'generation';
    case 'evaluating':
      return 'evaluation';
    case 'revising':
      return 'revision';
    case 'approved':
      // Approval is the human's decision; producing the channel assets from
      // it is not. Carry on automatically.
      return 'packaging';
    case 'packaging':
      return 'packaging';
    case 'failed':
      return (request.failed_stage as RunnableStage) ?? null;
    default:
      return null; // awaiting_review, ready, queued, published, blocked…
  }
}

/** How far along the pipeline is, for a progress bar. */
export const PIPELINE_ORDER: readonly string[] = [
  'draft',
  'researching',
  'retrieving',
  'selecting',
  'planning',
  'generating',
  'evaluating',
  'awaiting_review',
  'approved',
  'packaging',
  'ready',
  'queued',
  'published',
];

export function progressOf(status: string): number {
  const i = PIPELINE_ORDER.indexOf(status);
  return i < 0 ? 0 : Math.round((i / (PIPELINE_ORDER.length - 1)) * 100);
}

/* ═══════════════════════════════════════════════════════════════════════════
   The driver — one click, then the machine runs itself
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A ceiling on how many stages one driver run may execute. The real pipeline
 * is ~8 stages plus at most two revision loops (~12); anything past this means
 * the state machine is cycling, and stopping is better than spending money in
 * a circle.
 */
const MAX_STAGES_PER_RUN = 24;

/**
 * How long one driver run is allowed to keep going.
 *
 * The platform kills the function at `maxDuration` — 300 seconds on Vercel's
 * Hobby plan — and a full pipeline averages around thirteen minutes, so a run
 * WILL be cut short. The question is only whether it stops cleanly or is
 * killed mid-stage.
 *
 * Killed mid-stage is much worse than it sounds: the stage_run stays 'running'
 * forever, the lock is held until it goes stale, and a Claude call that was
 * already paid for is thrown away. So the driver checks the clock between
 * stages and hands back voluntarily, leaving the request in a resumable state
 * with the lock released. /api/cron/resume picks it straight up.
 *
 * Set below the platform limit by enough to finish the stage in flight: the
 * check happens BEFORE starting a stage, and the slowest one (research)
 * averages about 220 seconds.
 */
export const RUN_BUDGET_MS = Number(process.env.PIPELINE_RUN_BUDGET_MS ?? 270_000);

/**
 * How often a running driver says it is still alive.
 *
 * Comfortably more often than the lock's staleness window, so a healthy run
 * is never mistaken for an abandoned one, and comfortably rarely enough that
 * it is one small UPDATE a minute rather than a load.
 */
/**
 * How long research may spend before it stops going back for more.
 *
 * Not a deadline on the stage — the round already running is allowed to
 * finish, because abandoning a call that is about to answer wastes everything
 * it fetched. This is the point past which a NEW round is no longer worth
 * starting.
 *
 * 240s, so that one round plus its overhead still has a chance of fitting
 * inside a 300-second function. A second round beginning after that cannot
 * finish there whatever it finds.
 */
const RESEARCH_ROUND_BUDGET_MS = 240_000;

const HEARTBEAT_MS = 20_000;

/**
 * The longest a drive can claim to be alive.
 *
 * The platform kills a function at 300 seconds, so a drive that has been
 * going longer than that is not running on Vercel — and where nothing kills
 * it, it is stuck rather than working. Past this the heartbeat stops, the
 * lock goes stale three minutes later, and the request becomes reclaimable by
 * a driver that will actually move it.
 */
const MAX_DRIVE_MS = 300_000;

/**
 * How long each stage usually takes, in milliseconds.
 *
 * These are the 75th percentile of recent successful runs, NOT the maximum.
 * That choice is the whole design, and the first version got it wrong.
 *
 * The reserve exists so the driver never starts a stage it cannot finish
 * before the platform kills the function. Set it near the worst case and the
 * arithmetic becomes self-defeating: every stage reserves two to three times
 * what it actually takes, so almost none of them fit alongside another, and a
 * run that needs nine stages burns a slice on each. That is exactly what
 * happened — a run whose stages totalled seven minutes of work exhausted its
 * whole hand-off budget and then sat waiting for the scheduled worker.
 *
 * Measured p50 against the old reserve makes the gap plain:
 *
 *   evaluation  p50  65s → reserved 150s      generation p50  76s → 150s
 *   revision    p50 118s → reserved 200s      selection  p50  57s → 120s
 *   research    p50 100s → reserved 300s      retrieval  p50  58s → 120s
 *
 * At p75 a stage occasionally overruns and the function is killed mid-work.
 * That costs one stage's time and money, and is now recovered within minutes
 * — the driver heartbeats every twenty seconds, a dead lock is reclaimable
 * after three, and the scheduled worker sweeps every five. Weighed against
 * burning a hand-off on every single stage, the occasional lost stage is much
 * the cheaper failure.
 */
export const STAGE_RESERVE_MS: Record<string, number> = {
  audit: 20_000,
  retrieval: 90_000,
  selection: 90_000,
  planning: 70_000,
  generation: 120_000,
  // Recent single-option runs: 49s, 55s, 55s, 65s. The p75 of 195s that this
  // was set from came from older multi-option runs where the per-option calls
  // still ran one after another; they are issued together now, so the wall
  // clock is roughly one option's worth however many there are.
  evaluation: 100_000,
  revision: 150_000,
  packaging: 60_000,
};

/**
 * Research is reserved by depth, because depth is what decides its length.
 *
 * One number cannot serve all three. Quick research runs in about a minute
 * and a half; deep can use most of a function on its own. Reserving the deep
 * figure for a quick run meant research never shared a slice with anything —
 * not even the six-second audit that always precedes it.
 */
export const RESEARCH_RESERVE_MS: Record<string, number> = {
  // 280s, not the 150s this was first set to, because quick research is not
  // reliably quick and nothing we control decides that.
  //
  // Measured over quick runs with identical work — 6 sources, 4 readable,
  // ~1,000 input tokens, ~4,000 output — the wall clock ranged from 46s to
  // 276s. A six-fold spread with the same inputs and the same outputs,
  // because web_search and web_fetch make real HTTP requests to real
  // websites: up to twelve external round trips inside one call, each of
  // which may be slow, redirect, or serve an enormous page.
  //
  // So the reserve has to cover the slow draw, not the typical one. At 150s
  // the driver would start research with room for the 46-second case and get
  // killed on the 276-second one — losing the stage, its cost, and the lock.
  // The cost of being wrong in that direction is a lost stage; the cost of
  // reserving too much is that research shares a slice with only the audit,
  // which it mostly did anyway.
  quick: 280_000,
  standard: 280_000,
  deep: 300_000,
};

/** The reserve for a stage, defaulting to the slowest, for an unknown one. */
export function reserveFor(stage: string, researchDepth = 'standard'): number {
  if (stage === 'research') return RESEARCH_RESERVE_MS[researchDepth] ?? RESEARCH_RESERVE_MS.standard;
  return STAGE_RESERVE_MS[stage] ?? 300_000;
}

/** Statuses the driver stops at because only a person can move them on. */
const WAITS_FOR_A_HUMAN = new Set(['awaiting_review', 'rejected', 'blocked']);

export interface DriveResult {
  stagesRun: number;
  finalStatus: string;
  stoppedBecause: 'needs_a_human' | 'finished' | 'failed' | 'stage_cap' | 'lock_lost' | 'out_of_time';
  message: string;
}

/**
 * Run every machine stage, back to back, until the pipeline needs a person.
 *
 * This is the thing that used to live in the browser. A React component
 * looped over `fetch('/run')` one stage at a time, which meant the pipeline
 * only advanced while that exact tab stayed open, awake, and connected — and
 * every "it's stuck" report in this project traced back to that: research
 * finishing fine server-side, the tab never making the next call, and the
 * request sitting at 'retrieving' for eight hours with nothing wrong with it.
 * A pipeline that depends on a browser tab to keep running is not a pipeline.
 *
 * Assumes the caller already holds the lock (claimPipelineLock) — the route
 * claims it so it can answer "already running" synchronously — and releases
 * it here when the run ends, however it ends.
 */
export async function drivePipeline(
  requestId: string,
  actor: string,
  /**
   * The exact value this driver's lock was claimed with.
   *
   * Not the same thing as `actor`: the continue endpoint claims as
   * `continue:hop-2` but drives as `pipeline`, so a driver that assumed they
   * matched would release and heartbeat a lock that was never its own.
   */
  lockOwner: string = actor,
): Promise<DriveResult> {
  const startedAt = Date.now();

  // Clean up after a driver that did not come back. A process killed mid-stage
  // never records an outcome, so its row keeps saying `running` and the
  // pipeline view keeps reporting work that stopped long ago. Doing this here
  // rather than at each claimPipelineLock site means every path that drives —
  // start, continue, review, cron — gets it, including ones added later.
  const reaped = await q.reapStaleStageRuns(requestId).catch(() => []);
  for (const r of reaped) {
    await q
      .logEvent({
        requestId,
        actor,
        stage: r.stage as PipelineStage,
        step: 'stage_run_abandoned',
        ok: false,
        detail: { attempt: r.attempt, note: 'no outcome recorded; the driver did not return' },
      })
      .catch(() => {});
  }

  // Keep the lock alive DURING a stage, not only between stages.
  //
  // This is what lets a dead driver be spotted quickly. Heartbeating only
  // between stages meant a healthy run looked identical to an abandoned one
  // for as long as its slowest stage — so the reclaim window had to be twenty
  // minutes, and a request whose driver really had died sat unresumable for
  // all of it. A dev server recompiling mid-run does exactly that, and so
  // does a deploy.
  //
  // Ticking while the work is in flight makes a quiet heartbeat mean what it
  // says: nobody is driving this.
  //
  // But only up to a point, and the point matters. A heartbeat proves a
  // PROCESS is alive; it does not prove the WORK is moving. A driver that
  // blocks before it writes its first stage row goes on heartbeating happily
  // forever, holding the lock, looking healthier than a driver that died —
  // which is the same failure this project keeps meeting, wearing the badge
  // that was meant to detect it.
  //
  // So the heartbeat stops at the platform's own ceiling. Past 300 seconds a
  // drive either cannot exist (Vercel has killed the function) or is stuck
  // (here, where nothing kills it). Either way it has stopped being evidence
  // of anything, and going quiet is what lets the lock go stale and the
  // request be picked up by somebody who will actually move it.
  // Say that the drive began, before anything can block.
  //
  // Three rounds of diagnosis were lost to not having this. A request would
  // sit with its lock held and its heartbeat ticking, with no stage row and
  // no event — so there was no way to tell whether the driver had started and
  // wedged, or never started at all. Those need completely different fixes,
  // and the log could not distinguish them.
  await q
    .logEvent({
      requestId,
      actor,
      stage: null,
      step: 'drive_started',
      ok: true,
      detail: { reaped: reaped.length },
    })
    .catch(() => {});

  /** Set by the heartbeat the moment the lock stops being ours. */
  let superseded = false;

  let stagesRun = 0;
  let finalStatus = 'unknown';
  // Guards against a stage that keeps being chosen but never changes the
  // status — the shape of a real bug this hit: packaging could not get one
  // channel past its rules, left the status at 'packaging', and nextStage()
  // duly handed packaging straight back. The driver regenerated every channel
  // each turn until it hit the stage cap. The stage cap alone is not enough
  // protection when each wasted turn costs a full set of Claude calls.
  let lastStage: string | null = null;
  let lastStatus: string | null = null;
  let repeats = 0;

  const heartbeat = setInterval(() => {
    void (async () => {
      if (Date.now() - startedAt <= MAX_DRIVE_MS) {
        // A false answer means the lock is no longer ours — another driver
        // reclaimed this request while we were inside a stage. Stop driving:
        // everything we write from here competes with whoever holds it now.
        const stillOurs = await q.heartbeatPipelineLock(requestId, lockOwner).catch(() => true);
        if (!stillOurs) {
          superseded = true;
          clearInterval(heartbeat);
        }
        return;
      }

      // Past the ceiling — but that alone does not mean wedged.
      //
      // The first version of this released the lock on elapsed time only, and
      // it was wrong: research has been measured completing successfully at
      // 657 seconds, and the watchdog fired at 300 while the call was still
      // genuinely working. Abandoning a stage that was about to finish is a
      // worse failure than the one this was built to catch.
      //
      // A stage row is the discriminator. runStage writes it before it makes
      // the call, so work in flight always has one; a driver that wedged
      // before starting its stage has none. That is exactly the shape of the
      // stall this exists for.
      if (await q.hasRunningStage(requestId).catch(() => true)) {
        const stillOurs = await q.heartbeatPipelineLock(requestId, lockOwner).catch(() => true);
        if (!stillOurs) {
          superseded = true;
          clearInterval(heartbeat);
        }
        return;
      }

    // Past the ceiling. Stop vouching for this drive, say so where the
    // request's own log will show it, and let the lock go — otherwise a
    // driver that has wedged holds the request hostage indefinitely, which
    // is exactly what this was built to prevent and was instead causing.
    //
    // Releasing under a drive that might still be alive is deliberate. It
    // cannot double-spend: a second driver claims the lock by conditional
    // UPDATE, and stage_runs is unique on (request_id, stage, attempt), so a
    // duplicate attempt is a database error rather than a second bill.
      clearInterval(heartbeat);
      await q
        .logEvent({
          requestId,
          actor,
          stage: null,
          step: 'drive_watchdog',
          ok: false,
          detail: {
            seconds: Math.round((Date.now() - startedAt) / 1000),
            stages_run: stagesRun,
            last_stage: lastStage,
            note: 'the driver stopped without a stage in flight; lock released so something else can take it',
          },
        })
        .catch(() => {});
      // Ours only — the watchdog is the one place most likely to be running
      // inside a driver that has already been superseded, which is exactly
      // where releasing somebody else's lock does the most damage.
      await q.releasePipelineLock(requestId, lockOwner).catch(() => {});
      superseded = true;
    })();
  }, HEARTBEAT_MS);

  try {
    for (let i = 0; i < MAX_STAGES_PER_RUN; i++) {
      if (superseded) {
        return {
          stagesRun,
          finalStatus,
          stoppedBecause: 'lock_lost',
          message: 'Another driver took this request on; this one stood down.',
        };
      }

      const request = await q.getRequest(requestId);
      if (!request) {
        return {
          stagesRun,
          finalStatus: 'deleted',
          stoppedBecause: 'failed',
          message: 'The request no longer exists.',
        };
      }
      finalStatus = request.status;

      if (WAITS_FOR_A_HUMAN.has(request.status)) {
        return {
          stagesRun,
          finalStatus,
          stoppedBecause: 'needs_a_human',
          message:
            request.status === 'awaiting_review'
              ? 'Ready for review.'
              : request.status === 'blocked'
                ? 'Blocked — the request needs more to work with.'
                : 'Rejected — waiting on a person.',
        };
      }

      const stage = nextStage(request);
      if (!stage) {
        return {
          stagesRun,
          finalStatus,
          stoppedBecause: 'finished',
          message: `Nothing left to run from '${request.status}'.`,
        };
      }

      // Out of time — stop between stages rather than be killed inside one.
      //
      // The question is "is there room for THIS stage", not "have I run over".
      // Asking the second one let a run that had spent 236 of 240 seconds
      // start a 92-second selection stage; the function died mid-call, leaving
      // a stage row stuck at `running`, the lock held, and no hand-off made.
      // The check has to know which stage is next, which is why it sits after
      // nextStage() rather than before it.
      //
      // The lock is released in the finally block below, and the caller hands
      // off on 'out_of_time', so the next slice carries on from here.
      const elapsed = Date.now() - startedAt;
      if (stagesRun > 0 && elapsed + reserveFor(stage, request.research_depth) > RUN_BUDGET_MS) {
        return {
          stagesRun,
          finalStatus,
          stoppedBecause: 'out_of_time',
          message:
            `Ran ${stagesRun} stage${stagesRun === 1 ? '' : 's'} in ${Math.round(elapsed / 1000)}s ` +
            `and stopped rather than start '${stage}' without time to finish it. ` +
            'The run continues in the next slice.',
        };
      }

      // Same stage, same status as last time round: it ran and changed
      // nothing. Once is a retry worth allowing; twice is a loop.
      const progress = shouldStopRepeating({
        stage,
        status: request.status,
        lastStage,
        lastStatus,
        repeats,
      });
      repeats = progress.repeats;
      if (progress.stop) {
        return {
          stagesRun,
          finalStatus,
          stoppedBecause: 'stage_cap',
          message:
            `'${stage}' ran repeatedly without moving the request past ` +
            `'${request.status}'. Stopped rather than keep paying for the same work.`,
        };
      }
      lastStage = stage;
      lastStatus = request.status;

      // Before, not only after. `drive_<stage>` is written when a stage
      // COMPLETES, so a stage that never returns leaves no trace of having
      // been attempted — which is exactly the case worth seeing.
      await q
        .logEvent({
          requestId,
          actor,
          stage: stage === 'revision' ? 'revision' : (stage as PipelineStage),
          step: 'stage_starting',
          ok: true,
          detail: { elapsed_s: Math.round(elapsed / 1000), stages_run: stagesRun },
        })
        .catch(() => {});

      const result =
        stage === 'revision'
          ? await runRevision(request, { actor, createdBy: null })
          : await STAGE_RUNNERS[stage as RunnableStage](request);

      stagesRun++;
      finalStatus = result.status;

      await q.logEvent({
        requestId,
        actor,
        stage: stage === 'revision' ? 'revision' : (stage as PipelineStage),
        step: `drive_${stage}`,
        ok: result.ok,
        detail: { message: result.message, status: result.status },
      });

      if (!result.ok) {
        return {
          stagesRun,
          finalStatus,
          stoppedBecause: 'failed',
          message: `${stage} failed: ${result.message}`,
        };
      }

      // Tell the lock we are still alive between stages — and check it is
      // still ours. A stage can run for minutes, and the request can have been
      // reclaimed in that time; carrying on would mean two drivers writing the
      // same request, which is how a late arrival came to fail a run that four
      // stages of healthy work had gone into.
      if (!(await q.heartbeatPipelineLock(requestId, lockOwner).catch(() => true))) {
        superseded = true;
      }
    }

    return {
      stagesRun,
      finalStatus,
      stoppedBecause: 'stage_cap',
      message: `Stopped after ${MAX_STAGES_PER_RUN} stages without reaching a resting state.`,
    };
  } catch (err) {
    // The stage functions handle their own failures; reaching here means
    // something outside them broke. Record it rather than letting a
    // fire-and-forget run die silently with no trace.
    const message = err instanceof Error ? err.message : String(err);

    // Every stage sets its own status BEFORE its try block, so a superseded
    // driver's ConflictError escapes the stage entirely and lands here. That
    // is not this run failing — it is this run discovering it is no longer
    // the one in charge.
    if (err instanceof q.ConflictError) {
      await q
        .logEvent({
          requestId,
          actor,
          step: 'drive_superseded',
          ok: true,
          detail: { note: 'another driver moved this request on', conflict: message },
        })
        .catch(() => {});
      return { stagesRun, finalStatus, stoppedBecause: 'lock_lost', message };
    }

    await q
      .logEvent({
        requestId,
        actor,
        step: 'drive_pipeline',
        ok: false,
        detail: { error: message },
      })
      .catch(() => {});
    return { stagesRun, finalStatus, stoppedBecause: 'failed', message };
  } finally {
    // Always — a lock that outlives its driver blocks the request for twenty
    // minutes for no reason.
    clearInterval(heartbeat);
    // Ours only. Releasing a lock we no longer hold is not cleanup, it is
    // taking it away from the driver that is using it.
    await q.releasePipelineLock(requestId, lockOwner).catch(() => {});
  }
}

/** Re-exported so routes can compute a word count without importing seo.ts. */
export { wordCount };
export { excerptsFrom } from './excerpts';
