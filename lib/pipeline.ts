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
  };
}

/**
 * Wrap a stage so that a Claude failure and a thrown error both land in the
 * same place: a failed stage_run, a failed request with the stage named, and
 * a StageResult the route can return as JSON.
 */
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
    // A persistence or validation problem, not an API one. It still has to
    // reach stage_runs, or the stage looks like it is still running.
    const message = err instanceof Error ? err.message : String(err);
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
 * At most three research calls — the first plus two top-ups. Research is the
 * single most expensive call in the pipeline (real searching and fetching,
 * ~220s on average), so the ceiling is low on purpose: this is insurance
 * against a bad draw of publishers, not an attempt to scour the web.
 */
const MAX_RESEARCH_ROUNDS = 3;

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

  for (let round = 1; round <= depth.maxRounds; round++) {
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
      const text = source.raw_text!.trim();

      const outcome = await claude.digestSource({
        sourceText: text,
        sourceTitle: source.title,
        context,
      });
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

    for (const version of versions) {
      // unique(version_id) — a version can never be re-scored, only a new
      // version scored. Skip anything already evaluated so a retry of this
      // stage does not collide.
      if (await q.getEvaluationFor(version.id)) {
        const existing = await q.getEvaluationFor(version.id);
        statuses.push(existing!.status);
        continue;
      }

      const claims = await q.getClaims(version.id);
      const seo = version.seo_json as unknown as ReturnType<typeof checkSeo>;

      const outcome = await claude.evaluateArticle({
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
      });
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
    const next = nextAfterEvaluation({
      anyPassed: anyPass,
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

    for (const channel of wanted) {
      if (alreadyGood.has(channel)) {
        produced.push(channel);
        continue;
      }
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
    }

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
export const RUN_BUDGET_MS = Number(process.env.PIPELINE_RUN_BUDGET_MS ?? 240_000);

/**
 * How long each stage usually takes, in milliseconds.
 *
 * Measured from this system's own `stage_runs` — averages over real runs,
 * rounded up, because the point of a reserve is to be pessimistic:
 *
 *   research 244s · revision 165s · generation 99s · selection 92s
 *   evaluation 89s · retrieval 80s · packaging 58s · planning 48s · audit 8s
 *
 * These exist because the budget check used to ask the wrong question. It
 * asked "have I run over?" and not "do I have room for what comes next", so a
 * run that had used 236 of its 240 seconds happily started a 92-second stage.
 * The platform killed the function mid-call, which left the stage row saying
 * `running` forever, the lock held, and no hand-off made — the driver never
 * reached the line that hands off, because it was not running any more.
 *
 * Stopping one stage early costs one extra hop. Being killed mid-stage costs
 * the stage's work, the lock, and the chain.
 */
export const STAGE_RESERVE_MS: Record<string, number> = {
  audit: 30_000,
  research: 300_000,
  retrieval: 120_000,
  selection: 120_000,
  planning: 90_000,
  generation: 150_000,
  evaluation: 150_000,
  revision: 200_000,
  packaging: 90_000,
};

/** The reserve for a stage, defaulting to the slowest, for an unknown one. */
export function reserveFor(stage: string): number {
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
export async function drivePipeline(requestId: string, actor: string): Promise<DriveResult> {
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

  try {
    for (let i = 0; i < MAX_STAGES_PER_RUN; i++) {
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
      if (stagesRun > 0 && elapsed + reserveFor(stage) > RUN_BUDGET_MS) {
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

      // Tell the lock we are still alive between stages — a single stage can
      // legitimately run for minutes, and without this a slow-but-healthy run
      // would look abandoned and be reclaimed underneath itself.
      await q.heartbeatPipelineLock(requestId);
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
    await q.releasePipelineLock(requestId).catch(() => {});
  }
}

/** Re-exported so routes can compute a word count without importing seo.ts. */
export { wordCount };
export { excerptsFrom } from './excerpts';
