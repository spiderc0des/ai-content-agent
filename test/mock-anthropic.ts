import type { ClaudeFailure, ClaudeResult } from '../lib/claude';
import type { Channel, Intake } from '../lib/schemas';
import { RUBRIC_CRITERIA } from '../lib/schemas';

/**
 * Recorded stand-ins for every Claude call, used when MOCK_ANTHROPIC=1.
 *
 * Two jobs:
 *
 *   1. The whole pipeline runs offline — no API key, no spend, no network —
 *      so the scenario harness can assert end-to-end behaviour in CI.
 *   2. Failure injection. Every failure mode the real client can produce is
 *      reachable here by putting a magic token in the request's raw_idea:
 *
 *        FORCE_REFUSAL[:stage]     a 200 with stop_reason 'refusal'
 *        FORCE_RATE_LIMIT[:stage]  retries exhausted
 *        FORCE_MAX_TOKENS[:stage]  a truncated reply
 *        FORCE_API_ERROR[:stage]   a 500 from the API
 *        FORCE_INVALID[:stage]     output that does not parse
 *
 *      Without the ':stage' suffix the failure fires at every stage; with it,
 *      only at that one — which is what PRD test 8 needs, since "research
 *      failed" and "packaging failed" must be distinguishable.
 *
 * The fixtures deliberately satisfy the real SEO and channel rules
 * (lib/seo.ts, lib/channel-rules.ts). A mock that produced rule-breaking
 * output would make every scenario fail for a reason that has nothing to do
 * with the code under test.
 */

const MOCK_MODEL = 'claude-mock-5';

type Stage =
  | 'audit'
  | 'research'
  | 'digest'
  | 'selection'
  | 'plan'
  | 'article'
  | 'evaluation'
  | 'revision'
  | 'channel';

const INJECTORS = {
  FORCE_REFUSAL: {
    reason: 'refusal' as const,
    message: 'Claude declined this request for a safety reason.',
    category: 'test_injection',
  },
  FORCE_RATE_LIMIT: {
    reason: 'rate_limit' as const,
    message: 'Claude is rate-limiting requests. Try again shortly.',
  },
  FORCE_MAX_TOKENS: {
    reason: 'invalid_response' as const,
    message: 'The reply was cut off before it finished (max_tokens reached).',
  },
  FORCE_API_ERROR: {
    reason: 'api_error' as const,
    message: 'Claude API error (500): internal server error',
  },
  FORCE_INVALID: {
    reason: 'invalid_response' as const,
    message: 'the response did not return parsable structured output',
  },
};

/** Scan every string in the request for an injection token aimed at `stage`. */
function injected(stage: Stage, haystack: unknown): ClaudeFailure | null {
  const text = JSON.stringify(haystack ?? '');
  for (const [token, spec] of Object.entries(INJECTORS)) {
    const scoped = new RegExp(`${token}:([a-z]+)`).exec(text);
    if (scoped) {
      if (scoped[1] === stage) {
        return { ok: false, requestId: `req_mock_${stage}`, durationMs: 3, ...spec };
      }
      continue; // aimed at a different stage
    }
    if (text.includes(token)) {
      return { ok: false, requestId: `req_mock_${stage}`, durationMs: 3, ...spec };
    }
  }
  return null;
}

function ok<T>(data: T, effort = 'medium'): ClaudeResult<T> {
  return {
    ok: true,
    data,
    requestId: `req_mock_${Math.random().toString(36).slice(2, 10)}`,
    model: MOCK_MODEL,
    effort,
    durationMs: 5,
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
  };
}

/** A deterministic keyword from the idea, so fixtures satisfy the SEO rules. */
function keywordFrom(intake: Partial<Intake>): string {
  if (intake.primary_keyword?.trim()) return intake.primary_keyword.trim();
  const words = (intake.raw_idea ?? 'content strategy')
    .toLowerCase()
    .replace(/force_[a-z_]+(:[a-z]+)?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return words.slice(0, 2).join(' ') || 'content strategy';
}

/* ─── 0 · audit ─────────────────────────────────────────────────────────── */

export function mockAudit(intake: Partial<Intake>) {
  const fail = injected('audit', intake);
  if (fail) return fail;

  const idea = (intake.raw_idea ?? '').trim();
  const blocked = idea.length < 10 || /BLOCK_ME/.test(idea);
  const thin = !blocked && (idea.length < 40 || !intake.source_url);

  return ok(
    {
      readiness: blocked ? ('blocked' as const) : thin ? ('thin' as const) : ('ready' as const),
      fields: [
        { key: 'raw_idea', verdict: blocked ? ('missing' as const) : ('sufficient' as const), why: blocked ? 'there is no workable idea here' : 'specific enough to research' },
        { key: 'target_audience', verdict: intake.target_audience ? ('sufficient' as const) : ('missing' as const), why: intake.target_audience ? 'clear audience' : 'no audience given' },
        { key: 'source_url', verdict: intake.source_url ? ('sufficient' as const) : ('missing' as const), why: intake.source_url ? 'a source was supplied' : 'no source URL; research will have to find its own' },
        { key: 'supporting_notes', verdict: intake.supporting_notes ? ('sufficient' as const) : ('thin' as const), why: 'optional' },
        { key: 'primary_keyword', verdict: intake.primary_keyword ? ('sufficient' as const) : ('thin' as const), why: 'the planner can propose one' },
      ],
      suggested_primary_keyword: keywordFrom(intake),
      suggested_secondary_keywords: ['best practices', 'how to start'],
      clarifying_questions: blocked
        ? ['What specifically should this article be about?']
        : thin
          ? ['Is there a source or example you want this grounded in?']
          : [],
      blocking_reason: blocked ? 'The idea is too short to research or write about.' : null,
    },
    'low',
  );
}

/* ─── 1 · research ──────────────────────────────────────────────────────── */

export function mockResearch(intake: Partial<Intake>) {
  const fail = injected('research', intake);
  if (fail) return fail;

  const kw = keywordFrom(intake);
  // `text` mirrors the real shape: a fetched page carries its body, a URL that
  // only appeared in search results carries null and can be attributed but not
  // quoted. The retrieval stage depends on that distinction.
  const body = (angle: string) =>
    `${angle}\n\nTeams with a named owner resolve issues forty per cent faster than ` +
    `teams without one. Most organisations treat this as a checklist rather than ` +
    `as a system. Consistency matters more than the particular method chosen.`;

  const findings = [
    {
      url: intake.source_url || 'https://example.com/primary-source',
      title: `A practitioner guide to ${kw}`,
      fetched: true,
      text: body(`A practitioner guide to ${kw}.`),
    },
    {
      url: 'https://research.example.org/study-2026',
      title: `2026 industry study on ${kw}`,
      fetched: true,
      text: body(`The 2026 industry study on ${kw}.`),
    },
    {
      url: 'https://blog.example.net/contrarian-take',
      title: `Why most ${kw} advice fails`,
      fetched: false,
      text: null,
    },
  ];

  return ok({
    brief_md: `## What the sources say about ${kw}

The strongest source is "${findings[0].title}" (${findings[0].url}), which argues that
most teams treat ${kw} as a checklist rather than a system.

The 2026 industry study (${findings[1].url}) reports that teams with a named owner
resolve issues 40% faster than teams without one.

"${findings[2].title}" (${findings[2].url}) disagrees with the consensus, arguing the
gains come from consistency rather than from any particular method.

## Gaps
No source gives cost figures, and none covers teams smaller than ten people.`,
    findings,
  });
}

/* ─── 2 · digest ────────────────────────────────────────────────────────── */

export function mockDigest(params: { sourceText: string; sourceTitle: string; context: string }) {
  const fail = injected('digest', params);
  if (fail) return fail;

  return ok({
    digest_md: `Relevant material from "${params.sourceTitle}":

> "Teams with a named owner resolve issues forty per cent faster than teams without one."
Why it matters: a concrete, citable number for the article's central claim.

> "Most organisations treat this as a checklist rather than as a system."
Why it matters: states the problem the article is arguing against.

> "Consistency matters more than the particular method chosen."
Why it matters: a counterpoint the article should engage with rather than ignore.`,
    citations: [
      {
        type: 'char_location',
        cited_text: 'Teams with a named owner resolve issues forty per cent faster than teams without one.',
        document_title: params.sourceTitle,
        start_char_index: 0,
        end_char_index: 86,
      },
    ],
  });
}

/* ─── 3 · selection ─────────────────────────────────────────────────────── */

export function mockSelection(params: {
  intake: Partial<Intake>;
  excerpts: { id: string; quote: string; gist: string; source_title: string }[];
}) {
  const fail = injected('selection', params.intake);
  if (fail) return fail;

  return ok({
    // Deliberately not "keep everything": the selection step exists to be
    // selective, and a scenario asserting that should have something to see.
    selections: params.excerpts.map((e, i) => ({
      excerpt_id: e.id,
      keep: i % 4 !== 3,
      relevance: i % 4 === 3 ? 0.2 : 0.9 - i * 0.05,
      reason: i % 4 === 3 ? 'repeats an earlier excerpt with less detail' : 'supports a claim the article needs',
    })),
    coverage_gaps: ['No source gives cost figures.', 'Nothing covers teams smaller than ten people.'],
  });
}

/* ─── 4 · plan ──────────────────────────────────────────────────────────── */

export function mockPlan(params: {
  intake: Partial<Intake>;
  optionCount: number;
  researchBrief: string;
  selected: { id: string; quote: string; gist: string; source_title: string; url: string | null }[];
}) {
  const fail = injected('plan', params.intake);
  if (fail) return fail;

  const kw = keywordFrom(params.intake);
  const ids = params.selected.map((s) => s.id);
  const urls = params.selected.map((s) => s.url).filter((u): u is string => Boolean(u));

  const ANGLES = [
    { angle: 'A practical how-to for teams starting from nothing', why_it_differs: 'Prescriptive and step-by-step, aimed at someone acting this week.' },
    { angle: 'A contrarian argument that the consensus advice is wrong', why_it_differs: 'Argues against the method-first framing the other options accept.' },
    { angle: 'A data-led case built on the 2026 study', why_it_differs: 'Leads with evidence and quantified outcomes rather than with process.' },
    { angle: 'A failure-mode post-mortem', why_it_differs: 'Organised around what goes wrong, not around what to do.' },
    { angle: 'A leadership-level strategic framing', why_it_differs: 'Written for a budget holder rather than a practitioner.' },
  ];

  return ok(
    {
      primary_keyword: kw,
      secondary_keywords: ['named owner', 'consistency', 'best practices'],
      thesis: `Most teams treat ${kw} as a checklist when it is really a system with an owner.`,
      outline: [
        { h2: `Why ${kw} stalls`, h3s: [], key_points: ['Treated as a checklist', 'No named owner'], excerpt_ids: ids.slice(0, 2) },
        { h2: 'What the evidence shows', h3s: ['The ownership effect'], key_points: ['40% faster resolution with a named owner'], excerpt_ids: ids.slice(0, 1) },
        { h2: 'What to change first', h3s: [], key_points: ['Name an owner', 'Pick one method and hold it'], excerpt_ids: ids.slice(1, 3) },
      ],
      angles: ANGLES.slice(0, params.optionCount).map((a, i) => ({ option_index: i + 1, ...a })),
      link_targets: (urls.length ? urls : ['https://example.com/primary-source', 'https://research.example.org/study-2026'])
        .slice(0, 2)
        .map((url, i) => ({ url, anchor: i === 0 ? 'the practitioner guide' : 'the 2026 study', kind: 'external' as const })),
    },
    'high',
  );
}

/* ─── 5 / 7 · article and revision ──────────────────────────────────────── */

function draftFor(params: {
  intake: Partial<Intake>;
  optionIndex: number;
  angle: string;
  selected: { id: string }[];
  revised?: boolean;
}) {
  const kw = keywordFrom(params.intake);
  const title = `${titleCase(kw)}: ${params.angle}`;
  const ids = params.selected.map((s) => s.id);

  // Written to satisfy lib/seo.ts: keyword in the title and in the first 100
  // words, one H1, two H2s, 2-3 sentence paragraphs, exactly two links.
  const body_md = `# ${title}

Most teams approach ${kw} as a checklist to be completed. It is closer to a
system that somebody has to own.

## Why it stalls

The work gets distributed across everyone, which means it belongs to no one.
Nothing is wrong on any given day, so nothing gets fixed.

See [the practitioner guide](https://example.com/primary-source) for how this
plays out in practice. The pattern is remarkably consistent across team sizes.

## What the evidence shows

Teams with a named owner resolve issues forty per cent faster than teams
without one, according to [the 2026 study](https://research.example.org/study-2026).

That gap is not about talent or tooling. It is about who notices when
something slips.

## What to change first

Name one owner. Give them the authority to change the process, not just the
duty to report on it.${params.revised ? '\n\nThen hold the method steady for a full quarter before judging it.' : ''}

Pick one method and hold it long enough to learn something. Consistency beats
the particular choice.`;

  return {
    title,
    dek: `A ${params.angle.toLowerCase()} on ${kw}.`,
    body_md,
    claims: [
      {
        claim_text: 'Teams with a named owner resolve issues forty per cent faster than teams without one.',
        section_key: 'What the evidence shows',
        support: 'grounded' as const,
        excerpt_ids: ids.slice(0, 1),
      },
      {
        claim_text: 'Most organisations treat this as a checklist rather than as a system.',
        section_key: 'Why it stalls',
        support: 'grounded' as const,
        excerpt_ids: ids.slice(1, 2),
      },
      {
        claim_text: 'Consistency matters more than the particular method chosen.',
        section_key: 'What to change first',
        support: ids.length > 2 ? ('grounded' as const) : ('common_knowledge' as const),
        excerpt_ids: ids.slice(2, 3),
      },
    ],
    assumptions: ['That the reader has at least one team they can name an owner within.'],
    gaps: ['No source gives cost figures.', 'Nothing covers teams smaller than ten people.'],
  };
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function mockArticle(params: {
  intake: Partial<Intake>;
  optionIndex: number;
  angle: string;
  whyItDiffers: string;
  selected: { id: string; quote: string; gist: string; source_title: string; url: string | null }[];
}) {
  const fail = injected('article', params.intake);
  if (fail) return fail;
  return ok(draftFor(params), 'high');
}

export function mockRevision(params: {
  intake: Partial<Intake>;
  title: string;
  bodyMd: string;
  instruction: string;
  fromHuman: boolean;
  selected: { id: string; quote: string; gist: string; source_title: string; url: string | null }[];
}) {
  const fail = injected('revision', params.intake);
  if (fail) return fail;

  return ok(
    draftFor({
      intake: params.intake,
      optionIndex: 1,
      // Keep the original angle: a revision is not a fresh start.
      angle: params.title.split(': ').slice(1).join(': ') || 'a revised take',
      selected: params.selected,
      revised: true,
    }),
    'high',
  );
}

/* ─── 6 · evaluation ────────────────────────────────────────────────────── */

/**
 * Scores the draft rather than returning a constant, so the revision loop is
 * actually exercised: a first draft comes back 'revise', and a draft that has
 * been revised (it carries the extra sentence) comes back 'pass'. A constant
 * 'pass' would mean no scenario ever reaches the revision code.
 */
export function mockEvaluation(params: {
  intake: Partial<Intake>;
  title: string;
  bodyMd: string;
  claims: { claim_text: string; support: string; excerpt_ids: string[] }[];
  selected: { id: string }[];
  seoFindings: string;
}) {
  const fail = injected('evaluation', params.intake);
  if (fail) return fail;

  const looksRevised = params.bodyMd.includes('hold the method steady for a full quarter');
  const ungrounded = params.claims.filter(
    (c) => c.support === 'grounded' && c.excerpt_ids.length === 0,
  );
  const status = ungrounded.length > 0 ? 'reject' : looksRevised ? 'pass' : 'revise';

  const base = looksRevised ? 5 : 3;
  return ok(
    {
      status: status as 'pass' | 'revise' | 'reject',
      overall_score: looksRevised ? 4.6 : 3.3,
      summary: looksRevised
        ? 'Well grounded and clearly structured. Ready for a human look.'
        : 'Solid structure, but the middle section asserts more than the sources support.',
      scores: RUBRIC_CRITERIA.map((criterion) => ({
        criterion,
        score: criterion === 'source_grounding' && !looksRevised ? 2 : base,
        note:
          criterion === 'source_grounding' && !looksRevised
            ? 'One claim goes further than the excerpt behind it.'
            : 'Meets the bar.',
      })),
      unsupported_claims: looksRevised
        ? []
        : [
            {
              claim_text: 'Consistency matters more than the particular method chosen.',
              why: 'Stated as fact, but the excerpt behind it is one commentator\'s opinion.',
            },
          ],
      sections_needing_revision: looksRevised
        ? []
        : [{ section_key: 'What to change first', problem: 'Asserts a preference as a finding.' }],
      recommended_changes: looksRevised
        ? []
        : ['Attribute the consistency claim to its source, or cut it.'],
    },
    'high',
  );
}

/* ─── 8 · channel packaging ─────────────────────────────────────────────── */

export function mockChannel(params: {
  channel: Channel;
  intake: Partial<Intake>;
  title: string;
  bodyMd: string;
  ruleFeedback?: string;
}) {
  const fail = injected('channel', params.intake);
  if (fail) return fail;

  const kw = keywordFrom(params.intake);

  if (params.channel === 'linkedin') {
    return ok({
      hook: `Most teams treat ${kw} as a checklist.`,
      problem: `${titleCase(kw)} gets spread across everyone, so it belongs to no one.`,
      agitation: 'Nothing is wrong on any given day, so nothing ever gets fixed.',
      solution: 'Name one owner and give them authority over the process.',
      bullets: ['Name one owner', 'Give them authority, not just reporting duty', 'Hold the method for a quarter'],
      cta: 'Who owns this on your team?',
      body: `Most teams treat ${kw} as a checklist.

It gets spread across everyone, so it belongs to no one.

Nothing is wrong on any given day. So nothing ever gets fixed.

Teams with a named owner resolve issues 40% faster.

Here is what actually changes that:

- Name one owner
- Give them authority, not just reporting duty
- Hold the method steady for a quarter

Who owns this on your team?`,
    });
  }

  if (params.channel === 'x') {
    return ok({
      hook: `Teams with a named owner resolve issues 40% faster.`,
      single_idea: 'Ownership beats method.',
      body: `Teams with a named owner resolve issues 40% faster.

Not better tools. Not a better method.

Just someone who notices when it slips.

#Leadership`,
      hashtags: ['#Leadership'],
    });
  }

  return ok({
    subject: `The ${kw} problem nobody owns`,
    preheader: 'Ownership beats method, every time.',
    intro: `Most ${kw} work fails quietly. It fails because nobody owns it. Here is the fix.`,
    main_section_md: `**What goes wrong**

- The work is spread across everyone
- Nothing is visibly broken on any given day
- So nothing ever gets escalated`,
    secondary_item_md: 'Quick tip: name the owner before you pick the method.',
    cta: 'Reply and tell me who owns this on your team.',
    sign_off: 'Until next week,\nThe Koya team',
    body_md: `Most ${kw} work fails quietly. It fails because nobody owns it. Here is the fix.

**What goes wrong**

- The work is spread across everyone on the team
- Nothing is visibly broken on any given day
- So nothing ever gets escalated to someone who could fix it

Every one of those is a decision somebody forgot to make. The result is work
that degrades slowly enough that no single week looks like the problem.

Teams notice the cost eventually. By then it reads as culture rather than as
a process gap, which makes it far harder to argue about.

**What the evidence says**

Teams with a named owner resolve issues forty per cent faster than teams
without one. That is a large gap for a change that costs nothing.

It is not about talent and it is not about tooling. It is about who notices
when something slips, and whether that person can do anything about it.

**What to change first**

Name one owner. Give them authority over the process, not merely the duty to
report on how it is going.

Then pick one method and hold it steady for a full quarter. Consistency beats
the particular choice by a wide margin, and switching methods hides the signal.

Everything else can wait. The owner is the part that makes the rest work,
and it is the only part you cannot substitute with a better tool.

If you take one thing from this: the fix is an assignment, not a process.
Write a name down. Tell that person. Tell the team. That is the whole change.

Quick tip: name the owner before you pick the method.

Reply and tell me who owns this on your team.

Until next week,
The Koya team`,
  });
}
