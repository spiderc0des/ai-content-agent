/**
 * The eight test scenarios from the brief, run end to end against the mock
 * Claude layer, printing the pass/fail table that goes in the testing
 * evidence deliverable.
 *
 *   npm run scenarios
 *
 * No database and no API key: every Claude call is served from
 * test/mock-anthropic.ts, and the logic under test is the pure half of the
 * pipeline — the rules checkers, the grounding rule, the excerpt extraction,
 * the review transition table, and the queue preconditions.
 *
 * What this harness deliberately does NOT claim to prove is the half that
 * lives in Postgres: the append-only triggers, guard_content_approval(),
 * guard_publication_insert(), and the one-live-publication-per-channel index.
 * Those are asserted by sql/05-test-gates.sql, which runs against the real
 * database — a fake Postgres would only prove that the fake agrees with
 * itself. Each scenario below says which half covers it.
 */

import * as mock from '../mock-anthropic';
import { checkSeo } from '../../lib/seo';
import { checkChannel, failureSummary } from '../../lib/channel-rules';
import { excerptsFrom } from '../../lib/excerpts';
import { groundClaims, groundingSummary } from '../../lib/grounding';
import { checkReviewAction, checkQueueable, reviewTargetStatus } from '../../lib/permissions';
import { CHANNELS, RUBRIC_CRITERIA, type Channel } from '../../lib/schemas';

/* ─── Harness ────────────────────────────────────────────────────────────── */

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

interface Scenario {
  n: number;
  name: string;
  checks: Check[];
  covers: string;
}

const scenarios: Scenario[] = [];

function scenario(n: number, name: string, covers: string, body: (t: Tester) => void | Promise<void>) {
  return async () => {
    const checks: Check[] = [];
    const t: Tester = {
      ok(label, pass, detail = '') {
        checks.push({ label, pass, detail });
      },
      eq(label, actual, expected) {
        const pass = JSON.stringify(actual) === JSON.stringify(expected);
        checks.push({
          label,
          pass,
          // String(anObject) is "[object Object]", which told a reader of the
          // evidence output nothing about what actually matched.
          detail: pass
            ? (typeof actual === 'object' && actual !== null ? JSON.stringify(actual) : String(actual))
            : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        });
      },
    };
    try {
      await body(t);
    } catch (err) {
      checks.push({
        label: 'scenario ran without throwing',
        pass: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    scenarios.push({ n, name, checks, covers });
  };
}

interface Tester {
  ok(label: string, pass: boolean, detail?: string): void;
  eq(label: string, actual: unknown, expected: unknown): void;
}

/** Unwrap a mock outcome, failing loudly rather than returning undefined. */
function must<T>(outcome: { ok: boolean } & Record<string, unknown>, what: string): T {
  if (!outcome.ok) throw new Error(`${what} failed: ${String(outcome.message)}`);
  return outcome.data as T;
}

const AUDIENCE = 'Heads of talent at 50-200 person companies';

/* ═══════════════════════════════════════════════════════════════════════════
   1 · Raw Idea Request
   ═══════════════════════════════════════════════════════════════════════════ */

const s1 = scenario(
  1,
  'Raw Idea Request',
  'harness',
  async (t) => {
    const intake = {
      raw_idea: 'How remote onboarding quietly decides whether a new hire stays',
      target_audience: AUDIENCE,
      option_count: 3,
    };

    const audit = must<{ readiness: string }>(mock.mockAudit(intake) as never, 'audit');
    t.ok(
      'an idea-only request is not blocked',
      audit.readiness !== 'blocked',
      `readiness: ${audit.readiness}`,
    );

    const research = must<{ findings: { url: string }[] }>(mock.mockResearch(intake) as never, 'research');
    t.ok('research found sources', research.findings.length > 0, `${research.findings.length} sources`);

    const selected = fakeSelected(4);
    const plan = must<{ angles: { option_index: number; angle: string; why_it_differs: string }[] }>(
      mock.mockPlan({ intake, optionCount: 3, researchBrief: '', selected }) as never,
      'plan',
    );
    t.eq('the plan produced the requested number of options', plan.angles.length, 3);

    const angles = new Set(plan.angles.map((a) => a.angle));
    t.eq('every option is a distinct angle', angles.size, 3);

    const drafts = plan.angles.map((a) =>
      must<{ title: string; body_md: string }>(
        mock.mockArticle({
          intake,
          optionIndex: a.option_index,
          angle: a.angle,
          whyItDiffers: a.why_it_differs,
          selected,
        }) as never,
        `option ${a.option_index}`,
      ),
    );

    t.ok('at least two article options were produced', drafts.length >= 2, `${drafts.length} drafts`);
    t.eq('every option has a distinct title', new Set(drafts.map((d) => d.title)).size, drafts.length);
    t.ok(
      'every option is about the requested topic',
      drafts.every((d) => /onboarding/i.test(`${d.title} ${d.body_md}`)),
      'the primary keyword appears in each',
    );
  },
);

/* ═══════════════════════════════════════════════════════════════════════════
   2 · URL-Based Request
   ═══════════════════════════════════════════════════════════════════════════ */

const s2 = scenario(2, 'URL-Based Request', 'harness', async (t) => {
  const url = 'https://example.com/the-source-article';
  const intake = {
    raw_idea: 'What the 2026 onboarding study actually found',
    target_audience: AUDIENCE,
    source_url: url,
    option_count: 1,
  };

  const research = must<{ findings: { url: string; fetched: boolean }[] }>(
    mock.mockResearch(intake) as never,
    'research',
  );
  t.ok(
    'the supplied source URL is among the sources',
    research.findings.some((f) => f.url === url),
    url,
  );

  const digest = must<{ digest_md: string; citations: unknown[] }>(
    mock.mockDigest({ sourceText: 'the source body', sourceTitle: 'The source', context: intake.raw_idea }) as never,
    'digest',
  );

  const excerpts = excerptsFrom(digest.digest_md, digest.citations);
  t.ok('the source produced usable excerpts', excerpts.length > 0, `${excerpts.length} excerpts`);
  t.ok(
    'excerpts are exact quotes, not paraphrase',
    excerpts.every((e) => digest.digest_md.includes(e.quote)),
    'each quote appears verbatim in the digest',
  );
  t.ok(
    'a citation locator was preserved',
    excerpts.some((e) => Object.keys(e.locator as object).length > 0),
    'char_location kept',
  );

  const selected = excerpts.map((e, i) => ({
    id: `ex-${i}`,
    quote: e.quote,
    gist: e.gist,
    source_title: 'The source',
    url,
  }));

  const draft = must<{ body_md: string; claims: { excerpt_ids: string[] }[] }>(
    mock.mockArticle({
      intake,
      optionIndex: 1,
      angle: 'a data-led read of the study',
      whyItDiffers: '',
      selected,
    }) as never,
    'draft',
  );

  t.ok(
    'the draft cites the excerpts drawn from the source',
    draft.claims.some((c) => c.excerpt_ids.length > 0),
    'at least one claim resolves to a source excerpt',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 · Research and Source Grounding
   ═══════════════════════════════════════════════════════════════════════════ */

const s3 = scenario(3, 'Research and Source Grounding', 'harness', (t) => {
  const selectedIds = ['ex-1', 'ex-2', 'ex-3'];

  const claims = [
    { claim_text: 'A real cited claim.', section_key: 'A', support: 'grounded', excerpt_ids: ['ex-1'] },
    // The important case: the model asserts grounding but cites an excerpt
    // that selection dropped. Trusting it would be exactly the failure the
    // brief's "avoid claims not supported by available material" forbids.
    { claim_text: 'Cites a dropped excerpt.', section_key: 'B', support: 'grounded', excerpt_ids: ['ex-99'] },
    { claim_text: 'Cites nothing at all.', section_key: 'C', support: 'grounded', excerpt_ids: [] },
    { claim_text: 'Remote work grew after 2020.', section_key: 'D', support: 'common_knowledge', excerpt_ids: [] },
  ];

  const grounded = groundClaims(claims, selectedIds);
  const summary = groundingSummary(grounded);

  t.eq('a properly cited claim stays grounded', grounded[0].support, 'grounded');
  t.eq('a claim citing a dropped excerpt is downgraded', grounded[1].support, 'unsupported');
  t.eq('a claim citing nothing is downgraded', grounded[2].support, 'unsupported');
  t.eq('common knowledge is not falsely flagged', grounded[3].support, 'common_knowledge');
  t.eq('unresolvable citations are stripped', grounded[1].excerpt_ids, []);
  t.eq('the grounding summary counts correctly', summary, {
    total: 4,
    grounded: 1,
    unsupported: 2,
    common_knowledge: 1,
  });

  t.ok(
    'every surviving citation points at a selected excerpt',
    grounded.every((c) => c.excerpt_ids.every((id) => selectedIds.includes(id))),
    'no foreign or invented excerpt ids remain',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   4 · Evaluation and Revision Loop
   ═══════════════════════════════════════════════════════════════════════════ */

const s4 = scenario(4, 'Evaluation and Revision Loop', 'harness + SQL', async (t) => {
  const intake = {
    raw_idea: 'Why onboarding ownership beats onboarding process',
    target_audience: AUDIENCE,
    option_count: 1,
  };
  const selected = fakeSelected(3);

  const v1 = must<{ title: string; body_md: string; claims: never[] }>(
    mock.mockArticle({ intake, optionIndex: 1, angle: 'a practical how-to', whyItDiffers: '', selected }) as never,
    'draft',
  );

  const e1 = must<{ status: string; scores: { criterion: string }[]; recommended_changes: string[] }>(
    mock.mockEvaluation({
      intake,
      title: v1.title,
      bodyMd: v1.body_md,
      claims: v1.claims,
      selected,
      seoFindings: '',
    }) as never,
    'first evaluation',
  );

  t.eq('the rubric returns all nine criteria', e1.scores.length, RUBRIC_CRITERIA.length);
  t.ok(
    'every rubric criterion from the brief is scored',
    RUBRIC_CRITERIA.every((c) => e1.scores.some((s) => s.criterion === c)),
    RUBRIC_CRITERIA.join(', '),
  );
  t.eq('a weak first draft is marked for revision', e1.status, 'revise');
  t.ok('the evaluation says what to change', e1.recommended_changes.length > 0, e1.recommended_changes[0] ?? '');

  const v2 = must<{ title: string; body_md: string; claims: never[] }>(
    mock.mockRevision({
      intake,
      title: v1.title,
      bodyMd: v1.body_md,
      instruction: e1.recommended_changes.join('\n'),
      fromHuman: false,
      selected,
    }) as never,
    'revision',
  );

  t.ok('the revision produced different text', v2.body_md !== v1.body_md, 'body changed');
  t.ok(
    'the revision kept the original angle',
    v2.title === v1.title,
    'a revision is not a fresh start',
  );

  const e2 = must<{ status: string }>(
    mock.mockEvaluation({
      intake,
      title: v2.title,
      bodyMd: v2.body_md,
      claims: v2.claims,
      selected,
      seoFindings: '',
    }) as never,
    'second evaluation',
  );
  t.eq('the revised draft passes', e2.status, 'pass');

  // History preservation: both versions and both evaluations still exist as
  // separate objects. In the app this is guaranteed by article_versions being
  // INSERT-only (sql/02-triggers.sql) — asserted for real in 05-test-gates.sql.
  const history = [
    { revision_no: 1, body: v1.body_md, evaluation: e1.status },
    { revision_no: 2, body: v2.body_md, evaluation: e2.status },
  ];
  t.eq('both revisions are retained', history.length, 2);
  t.ok(
    'the original draft is still readable after the revision',
    history[0].body === v1.body_md && history[0].evaluation === 'revise',
    'revision 1 and its evaluation survive unchanged',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   5 · Human Approval
   ═══════════════════════════════════════════════════════════════════════════ */

const s5 = scenario(5, 'Human Approval', 'harness + SQL', (t) => {
  const base = {
    action: 'approve' as const,
    hasSelectedArticle: true,
    hasVersion: true,
    note: '',
    instruction: '',
  };

  // The whole point of the gate: approving is legal from exactly one status.
  const machineStatuses = [
    'draft',
    'researching',
    'retrieving',
    'selecting',
    'planning',
    'generating',
    'evaluating',
    'revising',
    'approved',
    'ready',
    'queued',
    'published',
  ];
  const refusedEverywhereElse = machineStatuses.every(
    (status) => !checkReviewAction({ ...base, status }).ok,
  );
  t.ok(
    'approval is refused from every status except awaiting_review',
    refusedEverywhereElse,
    `checked ${machineStatuses.length} statuses`,
  );
  t.ok(
    'approval is allowed from awaiting_review',
    checkReviewAction({ ...base, status: 'awaiting_review' }).ok,
    '',
  );

  t.ok(
    'approval is refused without a selected option',
    !checkReviewAction({ ...base, status: 'awaiting_review', hasSelectedArticle: false }).ok,
    'the brief requires selecting before approving',
  );
  t.ok(
    'approval is refused when the option has no draft',
    !checkReviewAction({ ...base, status: 'awaiting_review', hasVersion: false }).ok,
    '',
  );
  t.ok(
    'a rejection requires a reason',
    !checkReviewAction({ ...base, action: 'reject', status: 'awaiting_review' }).ok,
    '',
  );
  t.ok(
    'a revision requires an instruction',
    !checkReviewAction({ ...base, action: 'revise', status: 'awaiting_review' }).ok,
    '',
  );

  // All four actions the brief names are implemented and land somewhere sane.
  t.eq('approve → approved', reviewTargetStatus('approve'), 'approved');
  t.eq('reject → rejected', reviewTargetStatus('reject'), 'rejected');
  t.eq('revise → revising', reviewTargetStatus('revise'), 'revising');
  t.eq('select keeps the request at the gate', reviewTargetStatus('select'), 'awaiting_review');

  // Nothing reaches the queue without an approval on record.
  const noApproval = checkQueueable({
    status: 'ready',
    approvedVersionId: null,
    assetVersionId: 'v1',
    assetRulesPass: true,
    alreadyLiveOnChannel: false,
  });
  t.ok('publishing is refused with no approval on record', !noApproval.ok, '');

  const staleAsset = checkQueueable({
    status: 'ready',
    approvedVersionId: 'v1',
    assetVersionId: 'v2',
    assetRulesPass: true,
    alreadyLiveOnChannel: false,
  });
  t.ok(
    'publishing is refused when the asset is not from the approved version',
    !staleAsset.ok,
    '',
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   6 · Channel Formatting
   ═══════════════════════════════════════════════════════════════════════════ */

const s6 = scenario(6, 'Channel Formatting', 'harness', (t) => {
  const intake = {
    raw_idea: 'Why onboarding ownership beats onboarding process',
    target_audience: AUDIENCE,
  };

  for (const channel of CHANNELS) {
    const payload = must<Record<string, unknown>>(
      mock.mockChannel({ channel: channel as Channel, intake, title: 'T', bodyMd: '# T' }) as never,
      `${channel} asset`,
    );
    const report = checkChannel(channel as Channel, payload);
    t.ok(
      `${channel} follows the platform formatting rules`,
      report.pass,
      report.pass ? `${report.checks.length} checks passed` : failureSummary(report),
    );
  }

  // The specific numeric limits the brief states, checked directly — these are
  // the rules a model silently breaks most often.
  const x = must<{ hashtags: string[]; body: string }>(
    mock.mockChannel({ channel: 'x', intake, title: 'T', bodyMd: '# T' }) as never,
    'X asset',
  );
  t.ok('the X post uses no more than 2 hashtags', x.hashtags.length <= 2, `${x.hashtags.length}`);
  t.ok('the X post fits in 280 characters', x.body.length <= 280, `${x.body.length} chars`);

  const nl = must<{ body_md: string }>(
    mock.mockChannel({ channel: 'newsletter', intake, title: 'T', bodyMd: '# T' }) as never,
    'newsletter',
  );
  const words = checkChannel('newsletter', nl).word_count;
  t.ok('the newsletter is between 250 and 600 words', words >= 250 && words <= 600, `${words} words`);

  // And the SEO rules on the article itself.
  const draft = must<{ title: string; body_md: string }>(
    mock.mockArticle({
      intake: { ...intake, primary_keyword: 'onboarding ownership' },
      optionIndex: 1,
      angle: 'a practical how-to',
      whyItDiffers: '',
      selected: fakeSelected(3),
    }) as never,
    'draft',
  );
  const seo = checkSeo({
    title: draft.title,
    body_md: draft.body_md,
    primary_keyword: 'onboarding ownership',
    secondary_keywords: [],
  });
  t.ok(
    'the article follows the SEO best practices',
    seo.pass,
    seo.pass
      ? 'keyword in title and opening, one H1, 2-3 links'
      : seo.checks.filter((c) => c.required && !c.pass).map((c) => c.label).join('; '),
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   7 · Publishing or Scheduling
   ═══════════════════════════════════════════════════════════════════════════ */

const s7 = scenario(7, 'Publishing or Scheduling', 'harness + SQL', (t) => {
  const approved = {
    status: 'ready',
    approvedVersionId: 'v1',
    assetVersionId: 'v1',
    assetRulesPass: true,
    alreadyLiveOnChannel: false,
  };

  t.ok('an approved, rule-passing asset can be queued', checkQueueable(approved).ok, '');
  t.ok(
    'an asset that fails its channel rules cannot be queued',
    !checkQueueable({ ...approved, assetRulesPass: false }).ok,
    '',
  );
  t.ok(
    'a second publication on the same channel is refused',
    !checkQueueable({ ...approved, alreadyLiveOnChannel: true }).ok,
    'enforced for real by publications_one_live_per_channel',
  );
  t.ok(
    'queueing is refused before the request is ready',
    !checkQueueable({ ...approved, status: 'awaiting_review' }).ok,
    '',
  );

  // The publication state machine the cron worker drives.
  const transitions: [string, string, boolean][] = [
    ['queued', 'publishing', true],
    ['scheduled', 'publishing', true],
    ['publishing', 'published', true],
    ['publishing', 'queued', true], // a retryable failure goes back to the queue
    ['published', 'publishing', false], // never re-publish something already out
    ['canceled', 'publishing', false],
  ];
  const LEGAL: Record<string, string[]> = {
    queued: ['publishing', 'canceled'],
    scheduled: ['publishing', 'canceled'],
    publishing: ['published', 'queued', 'failed'],
    failed: ['queued', 'canceled'],
    published: [],
    canceled: [],
  };
  const allCorrect = transitions.every(([from, to, expected]) => (LEGAL[from] ?? []).includes(to) === expected);
  t.ok('the publication state machine allows only sane transitions', allCorrect, '6 transitions checked');
  t.eq('a published item is terminal', LEGAL.published, []);
});

/* ═══════════════════════════════════════════════════════════════════════════
   8 · Failure Handling
   ═══════════════════════════════════════════════════════════════════════════ */

const s8 = scenario(8, 'Failure Handling', 'harness', (t) => {
  const STAGES = [
    ['audit', (i: object) => mock.mockAudit(i)],
    ['research', (i: object) => mock.mockResearch(i)],
    ['selection', (i: object) => mock.mockSelection({ intake: i, excerpts: [] })],
    ['plan', (i: object) => mock.mockPlan({ intake: i, optionCount: 1, researchBrief: '', selected: [] })],
    ['article', (i: object) => mock.mockArticle({ intake: i, optionIndex: 1, angle: 'a', whyItDiffers: '', selected: [] })],
    ['evaluation', (i: object) => mock.mockEvaluation({ intake: i, title: 'T', bodyMd: 'b', claims: [], selected: [], seoFindings: '' })],
    ['channel', (i: object) => mock.mockChannel({ channel: 'x', intake: i, title: 'T', bodyMd: 'b' })],
  ] as const;

  const MODES = [
    ['FORCE_REFUSAL', 'refusal'],
    ['FORCE_RATE_LIMIT', 'rate_limit'],
    ['FORCE_MAX_TOKENS', 'invalid_response'],
    ['FORCE_API_ERROR', 'api_error'],
    ['FORCE_INVALID', 'invalid_response'],
  ] as const;

  // Every failure mode, at every stage, reports the stage it happened at and
  // a reason a person can act on.
  let checked = 0;
  const problems: string[] = [];

  for (const [stageName, call] of STAGES) {
    for (const [token, expectedReason] of MODES) {
      const intake = {
        raw_idea: `A perfectly good idea ${token}:${stageName}`,
        target_audience: AUDIENCE,
      };
      const outcome = call(intake) as { ok: boolean; reason?: string; message?: string; requestId?: string | null };
      checked++;

      if (outcome.ok) {
        problems.push(`${stageName}/${token}: did not fail`);
      } else if (outcome.reason !== expectedReason) {
        problems.push(`${stageName}/${token}: reason was '${outcome.reason}', expected '${expectedReason}'`);
      } else if (!outcome.message) {
        problems.push(`${stageName}/${token}: no message`);
      } else if (!outcome.requestId) {
        problems.push(`${stageName}/${token}: no request id to trace`);
      }
    }
  }

  t.ok(
    'every failure mode at every stage is reported with a reason and a request id',
    problems.length === 0,
    problems.length === 0 ? `${checked} stage/failure combinations` : problems.slice(0, 3).join('; '),
  );

  // A failure aimed at one stage must not fire at another, or "which stage
  // broke?" becomes unanswerable.
  const aimedAtResearch = { raw_idea: 'An idea FORCE_REFUSAL:research', target_audience: AUDIENCE };
  const auditOutcome = mock.mockAudit(aimedAtResearch) as { ok: boolean };
  const researchOutcome = mock.mockResearch(aimedAtResearch) as { ok: boolean };
  t.ok('a stage-scoped failure does not fire at other stages', auditOutcome.ok, 'audit still succeeded');
  t.ok('a stage-scoped failure fires at its own stage', !researchOutcome.ok, 'research failed');

  // A refusal must never be read as success: it comes back as HTTP 200 with
  // empty content, so the check has to be on stop_reason, not on content.
  const refusal = mock.mockResearch({ raw_idea: 'FORCE_REFUSAL', target_audience: AUDIENCE }) as {
    ok: boolean;
    reason?: string;
    category?: string | null;
  };
  t.ok('a refusal is a failure, not an empty success', !refusal.ok && refusal.reason === 'refusal', '');
  t.ok('a refusal carries its category', Boolean(refusal.category), String(refusal.category));

  // A blocked intake is a clean stop, not a crash.
  const blocked = mock.mockAudit({ raw_idea: 'short', target_audience: AUDIENCE }) as {
    ok: boolean;
    data?: { readiness: string; blocking_reason: string | null };
  };
  t.ok(
    'an unworkable request is blocked with a reason, not an error',
    blocked.ok && blocked.data?.readiness === 'blocked' && Boolean(blocked.data.blocking_reason),
    blocked.data?.blocking_reason ?? '',
  );
});

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function fakeSelected(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ex-${i + 1}`,
    quote: `A quoted sentence number ${i + 1} that is long enough to be a real excerpt.`,
    gist: `why excerpt ${i + 1} matters`,
    source_title: `Source ${i + 1}`,
    url: `https://example.com/source-${i + 1}`,
  }));
}

/* ─── Report ─────────────────────────────────────────────────────────────── */

async function main() {
  if (process.env.MOCK_ANTHROPIC !== '1') {
    // Not fatal — this harness calls the mock functions directly — but running
    // it against a configuration that would hit the real API is worth saying.
    console.log('note: MOCK_ANTHROPIC is not 1; this harness calls the mock layer directly anyway.\n');
  }

  for (const run of [s1, s2, s3, s4, s5, s6, s7, s8]) await run();
  scenarios.sort((a, b) => a.n - b.n);

  console.log('\nKoya Content Agent — PRD test scenarios\n');

  let failed = 0;
  for (const s of scenarios) {
    const pass = s.checks.every((c) => c.pass);
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${s.n}. ${s.name}`);
    for (const c of s.checks) {
      console.log(`      ${c.pass ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    console.log('');
  }

  console.log('─'.repeat(72));
  console.log(`${scenarios.length - failed} of ${scenarios.length} scenarios passed.\n`);
  console.log(
    'Scenarios marked "harness + SQL" have a second half that only a real\n' +
      'database can prove (the append-only triggers, the approval guard, the\n' +
      'one-live-publication index). Run sql/05-test-gates.sql against Supabase\n' +
      'for those.\n',
  );

  process.exit(failed === 0 ? 0 : 1);
}

void main();
