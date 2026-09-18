import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env, mockClaude } from './env';
import {
  RequestAuditSchema,
  SelectionSchema,
  ContentPlanSchema,
  ArticleDraftSchema,
  EvaluationSchema,
  CHANNEL_SCHEMAS,
  LinkedInSchema,
  XPostSchema,
  NewsletterSchema,
  RUBRIC_CRITERIA,
  intakeAsText,
  type Channel,
  type Intake,
} from './schemas';
import { SYSTEM_PROMPT } from './prompts/system';
import { depthProfile } from './research-depth';
import {
  AUDIT_PROMPT,
  SELECTION_PROMPT,
  EVALUATE_PROMPT,
  researchPrompt,
  digestPrompt,
  planPrompt,
  generatePrompt,
  revisePrompt,
  channelPrompt,
} from './prompts/stages';
import { CHANNEL_RULES } from './prompts/rules';
import { findingsOf, type ResearchFinding } from './research-results';
import * as mock from '../test/mock-anthropic';

/**
 * The only file in this project that constructs an Anthropic request.
 *
 * Every call returns a ClaudeOutcome<T> — never throws for an API-level
 * problem — so the pipeline runner (lib/pipeline.ts) records the same shape
 * in stage_runs no matter which stage failed. That is what makes PRD test 8
 * ("failures must be clear enough to debug") a property of the architecture
 * rather than of individual error handling.
 */

/**
 * One model for every call; `effort` is the only dial.
 *
 * This used to be two constants — Opus for the judgement-heavy calls, then
 * Sonnet, with Haiku underneath for the mechanical ones. Haiku earned its
 * removal: it cannot take `output_config.effort` at all (400: "This model
 * does not support the effort parameter") or adaptive thinking, so those
 * four call sites had to be shaped differently from every other one. Two
 * request shapes to keep straight, for one tier of savings, on the calls
 * that were already the cheapest in the pipeline.
 *
 * Effort carries the tiering instead, and reads honestly at each call site:
 *
 *   low     — mechanical or network-bound (audit, digest, research)
 *   medium  — ranking and reformatting against fixed rules
 *   high    — the writing itself, and the evaluation that gates it
 *
 * Those are what each call ASKS for. What it gets is capped by the request's
 * research depth — see effortFor below.
 */
const MODEL = 'claude-sonnet-5';

type Effort = 'low' | 'medium' | 'high';

/** Cheapest first, so a cap is a comparison rather than a lookup table. */
const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high'];

/**
 * The effort a call actually gets: what it asked for, or the depth's ceiling.
 *
 * Depth is a whole-pipeline dial, not a research setting. On `quick` the
 * ceiling is medium, so planning, generation, evaluation and revision — the
 * four calls that ask for high — come down with it. Those four are the
 * longest stages in the pipeline and the largest output lines in the bill, so
 * capping them is most of what makes a quick run quick.
 *
 * It only ever lowers. A call asking for low still gets low at every depth:
 * research is bound by web round trips and the digest by extraction, and
 * paying for deliberation on either buys nothing at any setting.
 */
function effortFor(intake: Partial<Intake>, asked: Effort): Effort {
  const cap = depthProfile(intake.research_depth).maxEffort;
  return EFFORT_ORDER.indexOf(asked) <= EFFORT_ORDER.indexOf(cap) ? asked : cap;
}

/**
 * On a policy decline, Anthropic retries the same request on a substitute
 * model server-side before we ever see a refusal. Content generation for a
 * client is exactly where that is worth having.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * How long one call may take before it is abandoned.
 *
 * The SDK's default is TEN MINUTES, and it retries timeouts by default
 * (maxRetries: 2), so a single hung request can occupy ~30 minutes. That is
 * not a hypothetical: a selection call sat in `running` for 17 minutes with no
 * request id, no tokens and no error, holding the pipeline lock, while the
 * platform's own function limit is 300 seconds. The stage outlived by minutes
 * the process that was supposed to be running it.
 *
 * A call that has not answered in three minutes is not going to produce
 * something worth the wait — the slowest single call measured here is well
 * under that, and a stage's own duration is the sum of several. Timing out
 * turns a silent hang into a typed failure the run can report and retry.
 *
 * maxRetries drops to 1 for the same reason: the worst case has to stay
 * bounded. withRetry above owns the retry that actually matters (429 with
 * retry-after); the SDK's remaining attempt covers transient network and 5xx.
 */
const CALL_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 180_000);

const client = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  timeout: CALL_TIMEOUT_MS,
  maxRetries: 1,
});

/**
 * Research is allowed longer than everything else, and still not forever.
 *
 * Ten minutes — comfortably above what research should now take, and still
 * a bound.
 *
 * The history is worth keeping, because both earlier values were wrong for
 * opposite reasons. It was first 300s, to match the platform's function
 * ceiling, which would have aborted a 657-second call that was working
 * perfectly. Then 900s, to clear that observed maximum — but that maximum was
 * itself the symptom: research was allowed 24 web fetches and took as long as
 * the slowest of them.
 *
 * With the tool budgets cut (lib/research-depth.ts) research is sized to
 * finish inside the platform limit, so this no longer has to accommodate a
 * ten-minute call. What it still has to catch is a stream that never ends at
 * all, which is the only thing a client-side deadline can catch: the ceiling
 * itself is enforced by Vercel killing the function, and no value here
 * changes that.
 *
 * Seven minutes, and it is now the WHOLE budget for the stage rather than per
 * attempt — a deadline abort is no longer retried, because retrying a
 * deadline is the same as not having one. At 600s with three attempts the
 * worst case was thirty minutes of a stage row saying `running` and nothing
 * else happening.
 */
const RESEARCH_DEADLINE_MS = 420_000;

/**
 * A hard deadline on a single call, as an abort signal rather than the
 * client's `timeout`.
 *
 * The client timeout does NOT bound a streamed response. Proof from this
 * system: a research call ran 276 seconds to completion under a 180-second
 * client timeout, and another sat `running` for 303 seconds with no request
 * id and no error until a watchdog killed the drive around it. `timeout`
 * governs getting the response; once a stream is flowing it stops applying.
 *
 * An AbortSignal does apply, to streamed and unstreamed calls alike. Aborting
 * surfaces as a thrown error, which withRetry turns into a typed stage
 * failure — so the pipeline reports "this call did not answer" instead of
 * holding a lock until something else notices.
 */
function deadline(ms: number = CALL_TIMEOUT_MS): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(ms) };
}

export interface ClaudeResult<T> {
  ok: true;
  data: T;
  requestId: string | null;
  model: string;
  effort: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
export interface ClaudeFailure {
  ok: false;
  reason: 'refusal' | 'rate_limit' | 'invalid_response' | 'api_error';
  message: string;
  requestId: string | null;
  category?: string | null;
  durationMs: number;
}
export type ClaudeOutcome<T> = ClaudeResult<T> | ClaudeFailure;

interface Attempt<T> {
  data: T;
  requestId: string | null;
  model: string;
  stopReason: string | null;
  stopDetails: { category?: string | null } | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * One retrying wrapper around every call, so the nine call sites below stay
 * about *what* to ask, not how to survive a 429 or a refusal.
 *
 * Retries only 429s (honouring retry-after) — never a 400, which means our
 * own request was malformed and retrying it changes nothing.
 */
/**
 * Turn an Anthropic spend-limit error into something worth reading.
 *
 * Returns null for anything else, so ordinary API errors keep their existing
 * wording.
 */
function usageLimitMessage(err: InstanceType<typeof Anthropic.APIError>): string | null {
  const raw = String(err.message ?? '');
  if (!/usage limit|credit balance|spend limit/i.test(raw)) return null;

  const when = /regain access on ([0-9]{4}-[0-9]{2}-[0-9]{2})(?: at ([0-9:]+ ?\w*))?/i.exec(raw);
  const returns = when ? ` Access returns on ${when[1]}${when[2] ? ` at ${when[2]}` : ''}.` : '';

  return (
    'The Anthropic workspace has reached its API spend limit, so no further ' +
    `calls can be made.${returns} Raise the limit in the Anthropic console ` +
    '(Settings → Limits) to carry on before then. Nothing already produced is ' +
    'lost — this run can be resumed once there is budget.'
  );
}

/**
 * Was this call cut off by its own deadline?
 *
 * AbortSignal.timeout rejects with a DOMException named 'TimeoutError', and
 * the SDK wraps a caller-supplied abort in APIUserAbortError. Both mean the
 * same thing here — we gave up on it — and neither should be filed as an
 * invalid response, which is a verdict about content.
 */
function isDeadlineAbort(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return true;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  return false;
}

async function withRetry<T>(
  effort: string,
  attempt: () => Promise<Attempt<T>>,
  maxAttempts = 3,
): Promise<ClaudeOutcome<T>> {
  const startedAt = Date.now();

  for (let n = 1; n <= maxAttempts; n++) {
    try {
      const r = await attempt();

      // Check stop_reason BEFORE trusting content — a refusal is a 200 with
      // empty content, and reading it as success saves a blank article.
      if (r.stopReason === 'refusal') {
        return {
          ok: false,
          reason: 'refusal',
          message: 'Claude declined this request for a safety reason.',
          category: r.stopDetails?.category ?? null,
          requestId: r.requestId,
          durationMs: Date.now() - startedAt,
        };
      }
      if (r.stopReason === 'max_tokens') {
        return {
          ok: false,
          reason: 'invalid_response',
          message: 'The reply was cut off before it finished (max_tokens reached).',
          requestId: r.requestId,
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        ok: true,
        data: r.data,
        requestId: r.requestId,
        model: r.model,
        effort,
        durationMs: Date.now() - startedAt,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
      };
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError && n < maxAttempts) {
        const retryAfter = Number(err.headers?.get('retry-after')) || 2 ** n;
        await new Promise((res) => setTimeout(res, retryAfter * 1000));
        continue;
      }
      if (err instanceof Anthropic.RateLimitError) {
        return failure('rate_limit', 'Claude is rate-limiting requests. Try again shortly.', err, startedAt);
      }
      if (err instanceof Anthropic.AuthenticationError) {
        return failure('api_error', 'The Anthropic API key is missing or invalid.', err, startedAt);
      }
      // The call ran past its deadline and was aborted. It is NOT retried.
      //
      // This branch first retried like any other transient failure, and that
      // was a contradiction: a deadline says how long we are willing to wait,
      // and waiting again is the definition of not having one. With three
      // attempts against a ten-minute research deadline, the arithmetic came
      // to thirty minutes before the stage reported anything at all — and a
      // run was observed sitting at twenty-one, its stage row still saying
      // `running`, which is indistinguishable from the hang this was added to
      // catch.
      //
      // These are not transient either. A research call that spends its whole
      // deadline is one working through slow web fetches; giving it another
      // deadline buys another slow crawl, not a different answer. Failing here
      // is visible in minutes, names the likely cause, and Resume re-runs the
      // stage if it is worth another go.
      if (isDeadlineAbort(err)) {
        return {
          ok: false,
          reason: 'api_error',
          message:
            'The call did not answer within its deadline and was abandoned. ' +
            'This is usually a slow source the research tools were waiting on.',
          requestId: null,
          durationMs: Date.now() - startedAt,
        };
      }
      // A dropped connection or a stream that ended mid-flight. These arrive
      // as a bare Error whose message is 'terminated' (undici's wording when a
      // response body stops early), and without this branch they fell through
      // to the catch-all below and were reported as `invalid_response` — a
      // permanent verdict on what is a transport hiccup. One killed a revision
      // stage that had two perfectly good drafts behind it. The long streamed
      // calls are the ones exposed to it, which is exactly where losing the
      // whole stage costs the most.
      if (isTransientTransportError(err) && n < maxAttempts) {
        await new Promise((res) => setTimeout(res, 2 ** n * 1000));
        continue;
      }
      if (err instanceof Anthropic.APIError) {
        // A spend cap is not a bug, and it should not read like one.
        //
        // It arrives as a generic 400 whose message is a JSON blob, which the
        // request page then showed verbatim — so the one failure a person can
        // actually DO something about was the least legible on the screen.
        // It is also the only API error with a known end: the message carries
        // the date access returns, and retrying before then cannot succeed.
        const capped = usageLimitMessage(err);
        if (capped) return failure('api_error', capped, err, startedAt);

        return failure('api_error', `Claude API error (${err.status}): ${err.message}`, err, startedAt);
      }
      // A structured-output parse failure or a validation error we raised
      // ourselves — real information, not a transport problem.
      if (err instanceof Error) {
        return {
          ok: false,
          reason: 'invalid_response',
          message: err.message,
          requestId: null,
          durationMs: Date.now() - startedAt,
        };
      }
      throw err;
    }
  }
  return {
    ok: false,
    reason: 'rate_limit',
    message: 'Exhausted retries.',
    requestId: null,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Is this a transport failure rather than a verdict about the content?
 *
 * Deliberately narrow. Anything not listed here keeps its existing treatment,
 * because retrying a genuine error three times only makes it slower.
 */
function isTransientTransportError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!(err instanceof Error)) return false;
  const text = `${err.message} ${(err.cause as Error | undefined)?.message ?? ''}`.toLowerCase();
  return (
    text.includes('terminated') ||
    text.includes('socket hang up') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('premature close')
  );
}

function failure(
  reason: ClaudeFailure['reason'],
  message: string,
  err: InstanceType<typeof Anthropic.APIError>,
  startedAt: number,
): ClaudeFailure {
  return {
    ok: false,
    reason,
    message,
    requestId: err.requestID ?? null,
    durationMs: Date.now() - startedAt,
  };
}

/** Usage fields, defaulted — the shape differs slightly across endpoints. */
function usageOf(u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}) {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

const cachedSystem = (text: string) => [
  { type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } },
];

/* ═══════════════════════════════════════════════════════════════════════════
   0 · Pre-flight audit — cheap, and it saves an expensive research run.
   ═══════════════════════════════════════════════════════════════════════════ */
export async function auditRequest(
  intake: Partial<Intake>,
): Promise<ClaudeOutcome<z.infer<typeof RequestAuditSchema>>> {
  if (mockClaude) return mock.mockAudit(intake);

  return withRetry('low', async () => {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: zodOutputFormat(RequestAuditSchema) },
      system: cachedSystem(AUDIT_PROMPT),
      messages: [{ role: 'user', content: intakeAsText(intake) }],
    }, deadline());
    if (!res.parsed_output) throw new Error('the audit did not return parsable structured output');
    return {
      data: res.parsed_output,
      requestId: res._request_id ?? null,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usageOf(res.usage),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 · Research — web_search + web_fetch, Anthropic's own server tools.

   Structured output is OFF here, deliberately. These tools return citations,
   and citations and `output_config.format` are mutually exclusive (400 if
   combined) — so this call returns PROSE plus the raw search-result blocks,
   and the URLs it found become `sources` rows parsed in code.
   ═══════════════════════════════════════════════════════════════════════════ */

export type { ResearchFinding } from './research-results';

export interface ResearchResult {
  brief_md: string;
  findings: ResearchFinding[];
}

/**
 * What the depth profile controls about this one call.
 *
 * An options object rather than more positional arguments: there are now six
 * of them, they all come from the same place (lib/research-depth.ts), and a
 * call site passing three numbers in the wrong order would be silently wrong
 * rather than a type error.
 */
export interface ResearchBudget {
  maxSearches: number;
  /**
   * Fetching gets its own, larger budget than searching. The two used to
   * share one number, which meant a topic whose first candidates all blocked
   * the fetcher had no attempts left to go and find readable ones — and that
   * is exactly the case the budget needs to survive, because it is routine:
   * academic publishers and big aggregators block by default.
   */
  maxFetches: number;
  /** Page text admitted per fetch. Caps what one very long page can cost. */
  maxContentTokens: number;
  /** Target length of the brief — the main control on how long this takes. */
  briefWords: number;
  /** Output ceiling, thinking included. A backstop; briefWords is the control. */
  maxOutputTokens: number;
  /**
   * The server runs its own sampling loop for these tools and stops at 10
   * iterations with `stop_reason: 'pause_turn'`. Resuming is just re-sending
   * the conversation with the paused assistant turn appended — no extra user
   * message, which would confuse the resume. Each resume re-sends every
   * search result and fetched page so far, so late resumes are the dearest
   * turns in the call.
   */
  maxContinuations: number;
  /**
   * URLs an earlier round already tried. Passed on a top-up round, when the
   * first pass came back with too few READABLE sources: the model is told
   * what it has already been given so it goes looking somewhere else instead
   * of returning the same blocked publishers a second time.
   */
  alreadyTried?: string[];
}

export async function researchTopic(
  intake: Partial<Intake>,
  budget: ResearchBudget,
): Promise<ClaudeOutcome<ResearchResult>> {
  const {
    maxSearches,
    maxFetches,
    maxContentTokens,
    briefWords,
    maxOutputTokens,
    maxContinuations,
    alreadyTried = [],
  } = budget;

  if (mockClaude) return mock.mockResearch(intake);

  const topUp = alreadyTried.length
    ? `\n\nSOURCES ALREADY COLLECTED — DO NOT RETURN THESE AGAIN\n` +
      `A previous round found these, but too few of them could actually be read. ` +
      `Find DIFFERENT sources on the same topic, and favour ones that are openly ` +
      `readable: official and government pages, standards bodies, company engineering ` +
      `blogs, primary research posted by its authors, established news outlets, and ` +
      `documentation. Fetch each one you intend to rely on.\n` +
      alreadyTried.map((u) => `- ${u}`).join('\n')
    : '';

  return withRetry('low', async () => {
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: 'user',
        content: `${researchPrompt(briefWords, minFetchedFor(maxFetches))}\n\nTHE CONTENT REQUEST\n${intakeAsText(intake)}${topUp}`,
      },
    ];

    let res: Anthropic.Beta.BetaMessage | null = null;
    let requestId: string | null = null;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    for (let turn = 0; turn <= maxContinuations; turn++) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: maxOutputTokens,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        // 'low', not 'medium': this call's wall-clock time is dominated by
        // the search/fetch tool round trips themselves, not by thinking
        // depth, so this mainly trims cost rather than latency — but it's
        // real cost, on the single most expensive call in the pipeline.
        output_config: { effort: 'low' },
        system: cachedSystem(
          'You are a research assistant. You find and read real sources, and you ' +
            'never state a fact you did not read. Quote exactly.',
        ),
        tools: [
          { type: 'web_search_20260209', name: 'web_search', max_uses: maxSearches },
          {
            type: 'web_fetch_20260209',
            name: 'web_fetch',
            max_uses: maxFetches,
            max_content_tokens: maxContentTokens,
          },
        ],
        messages,
      }, deadline(RESEARCH_DEADLINE_MS));
      res = await stream.finalMessage();
      // finalMessage() does not carry _request_id; the stream exposes it.
      requestId = stream.request_id ?? requestId;

      const u = usageOf(res.usage);
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.cacheReadTokens += u.cacheReadTokens;
      usage.cacheWriteTokens += u.cacheWriteTokens;

      if (res.stop_reason !== 'pause_turn') break;
      // Resume: append the paused assistant turn and go round again. The
      // server sees the trailing server_tool_use block and continues.
      messages.push({ role: 'assistant', content: res.content });
    }

    if (!res) throw new Error('research produced no response');

    return {
      data: { brief_md: textOf(res), findings: findingsOf(res) },
      requestId,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usage,
    };
  });
}

/**
 * How many successful fetches to ask for, from the fetch budget.
 *
 * Half, floored at two. Asking for four out of a budget of eight is a real
 * target; asking for four out of a budget of eight on a topic whose sources
 * all block is an instruction the model cannot satisfy, and it burns the
 * whole budget trying.
 */
function minFetchedFor(maxFetches: number): number {
  return Math.max(2, Math.floor(maxFetches / 2));
}

function textOf(res: Anthropic.Beta.BetaMessage): string {
  return res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n')
    .trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 · Per-source digest — citations ON, structured output OFF (see above).

   Returns exact quotes with the API's own char_location locators, which is
   what makes "source grounding" checkable later rather than asserted.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface DigestResult {
  digest_md: string;
  citations: unknown[];
}

export async function digestSource(params: {
  sourceText: string;
  sourceTitle: string;
  context: string;
}): Promise<ClaudeOutcome<DigestResult>> {
  if (mockClaude) return mock.mockDigest(params);

  return withRetry('low', async () => {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: digestPrompt(params.context),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'text',
                media_type: 'text/plain',
                data: params.sourceText,
              },
              title: params.sourceTitle,
              citations: { enabled: true },
            },
            { type: 'text', text: 'Extract the relevant material from this source.' },
          ],
        },
      ],
    }, deadline());

    const blocks = res.content.filter(
      (b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text',
    );

    return {
      data: {
        digest_md: blocks.map((b) => b.text).join('\n\n'),
        citations: blocks.flatMap((b) => b.citations ?? []),
      },
      requestId: res._request_id ?? null,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usageOf(res.usage),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 · Selection — the brief's "choose the sources or excerpts that matter".
   ═══════════════════════════════════════════════════════════════════════════ */
export async function selectSources(params: {
  intake: Partial<Intake>;
  excerpts: { id: string; quote: string; gist: string; source_title: string }[];
}): Promise<ClaudeOutcome<z.infer<typeof SelectionSchema>>> {
  if (mockClaude) return mock.mockSelection(params);

  const list = params.excerpts
    .map(
      (e) =>
        `excerpt_id: ${e.id}\nfrom: ${e.source_title}\nquote: "${e.quote}"\nwhy: ${e.gist}`,
    )
    .join('\n\n---\n\n');

  return withRetry('medium', async () => {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: zodOutputFormat(SelectionSchema) },
      system: cachedSystem(SELECTION_PROMPT),
      messages: [
        {
          role: 'user',
          content: `THE CONTENT REQUEST\n${intakeAsText(params.intake)}\n\nTHE EXCERPTS\n\n${list}`,
        },
      ],
    }, deadline());
    if (!res.parsed_output) throw new Error('selection did not return parsable structured output');
    return {
      data: res.parsed_output,
      requestId: res._request_id ?? null,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usageOf(res.usage),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   4 · Planning — the outline, and the N genuinely different angles.
   ═══════════════════════════════════════════════════════════════════════════ */
export async function planContent(params: {
  intake: Partial<Intake>;
  optionCount: number;
  researchBrief: string;
  selected: { id: string; quote: string; gist: string; source_title: string; url: string | null }[];
}): Promise<ClaudeOutcome<z.infer<typeof ContentPlanSchema>>> {
  if (mockClaude) return mock.mockPlan(params);

  const effort = effortFor(params.intake, 'high');

  return withRetry(effort, async () => {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort, format: zodOutputFormat(ContentPlanSchema) },
      system: cachedSystem(SYSTEM_PROMPT),
      messages: [
        {
          role: 'user',
          content:
            `${planPrompt(params.optionCount)}\n\n` +
            `THE CONTENT REQUEST\n${intakeAsText(params.intake)}\n\n` +
            `RESEARCH BRIEF\n${params.researchBrief}\n\n` +
            `SELECTED SOURCE EXCERPTS\n${excerptBlock(params.selected)}`,
        },
      ],
    }, deadline());
    const plan = res.parsed_output;
    if (!plan) throw new Error('the plan did not return parsable structured output');
    // Checked here rather than in the schema so the message names the problem.
    if (plan.angles.length !== params.optionCount) {
      throw new Error(
        `the plan returned ${plan.angles.length} angles, expected ${params.optionCount}`,
      );
    }
    if (plan.outline.length === 0) throw new Error('the plan returned an empty outline');

    return {
      data: plan,
      requestId: res._request_id ?? null,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usageOf(res.usage),
    };
  });
}

function excerptBlock(
  excerpts: { id: string; quote: string; gist: string; source_title: string; url: string | null }[],
): string {
  return excerpts
    .map(
      (e) =>
        `[excerpt_id: ${e.id}] from "${e.source_title}"${e.url ? ` (${e.url})` : ''}\n` +
        `"${e.quote}"\n(${e.gist})`,
    )
    .join('\n\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
   5 · Generation — ONE CALL PER OPTION.

   This diverges from the sibling proposal app, which generates all six
   sections of a document in one call — and the divergence is the point.
   Sections must COHERE with each other, so one call is right there. Options
   must DIFFER from each other, and generating them in one response reliably
   produces three variations on a theme rather than three angles. It also
   means one refusal or one truncation costs one option instead of the whole
   generation stage.
   ═══════════════════════════════════════════════════════════════════════════ */
export async function generateArticle(params: {
  intake: Partial<Intake>;
  optionIndex: number;
  angle: string;
  whyItDiffers: string;
  plan: { thesis: string; primary_keyword: string; secondary_keywords: string[]; outline: unknown; link_targets: unknown };
  selected: { id: string; quote: string; gist: string; source_title: string; url: string | null }[];
}): Promise<ClaudeOutcome<z.infer<typeof ArticleDraftSchema>>> {
  if (mockClaude) return mock.mockArticle(params);

  const effort = effortFor(params.intake, 'high');

  return withRetry(effort, async () => {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort, format: zodOutputFormat(ArticleDraftSchema) },
      system: cachedSystem(SYSTEM_PROMPT),
      messages: [
        {
          role: 'user',
          content:
            `${generatePrompt({
              angle: params.angle,
              whyItDiffers: params.whyItDiffers,
              optionIndex: params.optionIndex,
              wordCountTarget: params.intake.word_count_target ?? null,
            })}\n\n` +
            `THE CONTENT REQUEST\n${intakeAsText(params.intake)}\n\n` +
            `THE PLAN\nthesis: ${params.plan.thesis}\n` +
            `primary keyword: ${params.plan.primary_keyword}\n` +
            `secondary keywords: ${params.plan.secondary_keywords.join(', ')}\n` +
            `outline: ${JSON.stringify(params.plan.outline)}\n` +
            `link targets: ${JSON.stringify(params.plan.link_targets)}\n\n` +
            `SELECTED SOURCE EXCERPTS — the only evidence you have\n${excerptBlock(params.selected)}`,
        },
      ],
    }, deadline());
    const res = await stream.finalMessage();
    if (!res.parsed_output) throw new Error('the draft did not return parsable structured output');
    if (!res.parsed_output.body_md.trim()) throw new Error('the draft returned an empty body');

    return {
      data: res.parsed_output,
      // finalMessage() does not carry _request_id (unlike .parse()/.create());
      // the stream object exposes it via the request-id header.
      requestId: stream.request_id ?? null,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usageOf(res.usage),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   6 · Evaluation — the brief's rubric, one call per version.
   ═══════════════════════════════════════════════════════════════════════════ */
export async function evaluateArticle(params: {
  intake: Partial<Intake>;
  title: string;
  bodyMd: string;
  claims: { claim_text: string; support: string; excerpt_ids: string[] }[];
  selected: { id: string; quote: string; gist: string; source_title: string; url: string | null }[];
  seoFindings: string;
}): Promise<ClaudeOutcome<z.infer<typeof EvaluationSchema>>> {
  if (mockClaude) return mock.mockEvaluation(params);

  const effort = effortFor(params.intake, 'high');

  return withRetry(effort, async () => {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort, format: zodOutputFormat(EvaluationSchema) },
      system: cachedSystem(EVALUATE_PROMPT),
      messages: [
        {
          role: 'user',
          content:
            `THE CONTENT REQUEST\n${intakeAsText(params.intake)}\n\n` +
            `THE DRAFT\n# ${params.title}\n\n${params.bodyMd}\n\n` +
            `THE DRAFT'S OWN CLAIMS\n${params.claims
              .map((c) => `- [${c.support}] "${c.claim_text}" → ${c.excerpt_ids.join(', ') || 'no excerpts'}`)
              .join('\n')}\n\n` +
            `THE AVAILABLE EVIDENCE\n${excerptBlock(params.selected)}\n\n` +
            `DETERMINISTIC SEO CHECK (already computed — do not re-count, but do ` +
            `weigh these findings in seo_fit)\n${params.seoFindings}`,
        },
      ],
    }, deadline());
    const evaluation = res.parsed_output;
    if (!evaluation) throw new Error('the evaluation did not return parsable structured output');

    // The rubric has nine criteria and the brief requires all of them. A
    // missing one would render as a blank row rather than an error.
    const got = new Set(evaluation.scores.map((s) => s.criterion));
    const missing = RUBRIC_CRITERIA.filter((c) => !got.has(c));
    if (missing.length) {
      throw new Error(`the evaluation omitted rubric criteria: ${missing.join(', ')}`);
    }

    return {
      data: evaluation,
      requestId: res._request_id ?? null,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usageOf(res.usage),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   7 · Revision — same output shape as generation, so a revision is
   substitutable for a draft everywhere downstream.
   ═══════════════════════════════════════════════════════════════════════════ */
export async function reviseArticle(params: {
  intake: Partial<Intake>;
  title: string;
  bodyMd: string;
  instruction: string;
  fromHuman: boolean;
  selected: { id: string; quote: string; gist: string; source_title: string; url: string | null }[];
}): Promise<ClaudeOutcome<z.infer<typeof ArticleDraftSchema>>> {
  if (mockClaude) return mock.mockRevision(params);

  const effort = effortFor(params.intake, 'high');

  return withRetry(effort, async () => {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort, format: zodOutputFormat(ArticleDraftSchema) },
      system: cachedSystem(SYSTEM_PROMPT),
      messages: [
        {
          role: 'user',
          content:
            `${revisePrompt(params.instruction, params.fromHuman)}\n\n` +
            `THE CONTENT REQUEST\n${intakeAsText(params.intake)}\n\n` +
            `THE CURRENT DRAFT\n# ${params.title}\n\n${params.bodyMd}\n\n` +
            `SELECTED SOURCE EXCERPTS — the only evidence you have\n${excerptBlock(params.selected)}`,
        },
      ],
    }, deadline());
    const res = await stream.finalMessage();
    if (!res.parsed_output) throw new Error('the revision did not return parsable structured output');
    if (!res.parsed_output.body_md.trim()) throw new Error('the revision returned an empty body');

    return {
      data: res.parsed_output,
      requestId: stream.request_id ?? null,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usageOf(res.usage),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   8 · Channel packaging — one call per channel, one schema per channel.
   ═══════════════════════════════════════════════════════════════════════════ */
export type ChannelPayload =
  | z.infer<typeof LinkedInSchema>
  | z.infer<typeof XPostSchema>
  | z.infer<typeof NewsletterSchema>;

export async function packageForChannel(params: {
  channel: Channel;
  intake: Partial<Intake>;
  title: string;
  bodyMd: string;
  /** A previous failed attempt's rule violations, fed back on a retry. */
  ruleFeedback?: string;
}): Promise<ClaudeOutcome<ChannelPayload>> {
  if (mockClaude) return mock.mockChannel(params);

  const schema = CHANNEL_SCHEMAS[params.channel];

  return withRetry('medium', async () => {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: zodOutputFormat(schema) },
      system: cachedSystem(channelPrompt(params.channel, CHANNEL_RULES[params.channel])),
      messages: [
        {
          role: 'user',
          content:
            `THE AUDIENCE\n${params.intake.target_audience ?? ''}\n` +
            `THE DESIRED TONE\n${params.intake.desired_tone || 'the brand default'}\n\n` +
            `THE APPROVED ARTICLE\n# ${params.title}\n\n${params.bodyMd}` +
            (params.ruleFeedback
              ? `\n\nA PREVIOUS ATTEMPT BROKE THESE RULES — fix them:\n${params.ruleFeedback}`
              : ''),
        },
      ],
    }, deadline());
    if (!res.parsed_output) {
      throw new Error(`the ${params.channel} asset did not return parsable structured output`);
    }
    return {
      data: res.parsed_output,
      requestId: res._request_id ?? null,
      model: res.model,
      stopReason: res.stop_reason,
      stopDetails: res.stop_details,
      ...usageOf(res.usage),
    };
  });
}
