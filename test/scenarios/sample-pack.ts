/**
 * Generate the content sample pack deliverable.
 *
 *   npx tsx test/scenarios/sample-pack.ts
 *
 * Runs one request all the way through the pipeline's logic against the mock
 * Claude layer and writes docs/sample-pack/ — the input given to the system
 * and every output it produced: the article, the LinkedIn post, the X post,
 * the newsletter, and the source list.
 *
 * Running it against the real API instead is a matter of swapping the mock
 * calls for lib/claude.ts's, which take the same arguments and return the
 * same shapes. The mock is used here so the pack regenerates deterministically
 * and costs nothing.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as mock from '../mock-anthropic';
import { checkSeo } from '../../lib/seo';
import { checkChannel, failureSummary } from '../../lib/channel-rules';
import { excerptsFrom } from '../../lib/excerpts';
import { groundClaims, groundingSummary } from '../../lib/grounding';
import { CHANNELS, CRITERION_LABELS, type Channel, type RubricCriterion } from '../../lib/schemas';

const OUT = join(process.cwd(), 'docs', 'sample-pack');

const INTAKE = {
  raw_idea:
    'Remote onboarding quietly decides whether a new hire stays. Most teams treat it as paperwork when it is closer to a product launch.',
  target_audience: 'Heads of talent at 50-200 person companies',
  source_url: 'https://example.com/remote-onboarding-guide',
  supporting_notes: 'We want something a reader can act on in their next hire, not a think piece.',
  primary_keyword: 'remote onboarding',
  secondary_keywords: ['new hires', 'retention'],
  desired_tone: 'Direct, warm, no jargon',
  option_count: 3,
  channels_wanted: [...CHANNELS],
};

function must<T>(outcome: { ok: boolean } & Record<string, unknown>, what: string): T {
  if (!outcome.ok) throw new Error(`${what} failed: ${String(outcome.message)}`);
  return outcome.data as T;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const lines: string[] = [];

  // ── 1 · audit ────────────────────────────────────────────────────────────
  const audit = must<{ readiness: string }>(mock.mockAudit(INTAKE) as never, 'audit');

  // ── 2 · research ─────────────────────────────────────────────────────────
  const research = must<{ brief_md: string; findings: { url: string; title: string; fetched: boolean }[] }>(
    mock.mockResearch(INTAKE) as never,
    'research',
  );

  // ── 3 · retrieval ────────────────────────────────────────────────────────
  const allExcerpts: { id: string; quote: string; gist: string; source_title: string; url: string }[] = [];
  research.findings.forEach((f, si) => {
    const digest = must<{ digest_md: string; citations: unknown[] }>(
      mock.mockDigest({ sourceText: 'source body', sourceTitle: f.title, context: INTAKE.raw_idea }) as never,
      'digest',
    );
    excerptsFrom(digest.digest_md, digest.citations).forEach((e, ei) => {
      allExcerpts.push({
        id: `s${si + 1}-e${ei + 1}`,
        quote: e.quote,
        gist: e.gist,
        source_title: f.title,
        url: f.url,
      });
    });
  });

  // ── 4 · selection ────────────────────────────────────────────────────────
  const selection = must<{ selections: { excerpt_id: string; keep: boolean }[]; coverage_gaps: string[] }>(
    mock.mockSelection({ intake: INTAKE, excerpts: allExcerpts }) as never,
    'selection',
  );
  const keptIds = new Set(selection.selections.filter((s) => s.keep).map((s) => s.excerpt_id));
  const selected = allExcerpts.filter((e) => keptIds.has(e.id));

  // ── 5 · plan ─────────────────────────────────────────────────────────────
  const plan = must<{
    primary_keyword: string;
    thesis: string;
    angles: { option_index: number; angle: string; why_it_differs: string }[];
  }>(mock.mockPlan({ intake: INTAKE, optionCount: 3, researchBrief: research.brief_md, selected }) as never, 'plan');

  // ── 6 · generate, evaluate, revise ───────────────────────────────────────
  const options = plan.angles.map((a) => {
    const draft = must<{
      title: string;
      dek: string;
      body_md: string;
      claims: { claim_text: string; section_key: string; support: string; excerpt_ids: string[] }[];
      assumptions: string[];
      gaps: string[];
    }>(
      mock.mockArticle({
        intake: INTAKE,
        optionIndex: a.option_index,
        angle: a.angle,
        whyItDiffers: a.why_it_differs,
        selected,
      }) as never,
      `option ${a.option_index}`,
    );

    const claims = groundClaims(draft.claims, selected.map((s) => s.id));
    const evaluation = must<{ status: string; overall_score: number; summary: string; scores: { criterion: string; score: number; note: string }[]; recommended_changes: string[]; unsupported_claims: { claim_text: string; why: string }[] }>(
      mock.mockEvaluation({
        intake: INTAKE,
        title: draft.title,
        bodyMd: draft.body_md,
        claims,
        selected,
        seoFindings: '',
      }) as never,
      'evaluation',
    );

    return { angle: a, draft, claims, evaluation, revision: null as typeof draft | null, revisionEval: null as typeof evaluation | null };
  });

  // The first option is revised, so the pack shows the loop actually working.
  const target = options[0];
  target.revision = must(
    mock.mockRevision({
      intake: INTAKE,
      title: target.draft.title,
      bodyMd: target.draft.body_md,
      instruction: target.evaluation.recommended_changes.join('\n'),
      fromHuman: false,
      selected,
    }) as never,
    'revision',
  );
  target.revisionEval = must(
    mock.mockEvaluation({
      intake: INTAKE,
      title: target.revision!.title,
      bodyMd: target.revision!.body_md,
      claims: target.claims,
      selected,
      seoFindings: '',
    }) as never,
    'second evaluation',
  );

  // ── 7 · the approved article, packaged for each channel ──────────────────
  const approved = { title: target.revision!.title, body_md: target.revision!.body_md };
  const seo = checkSeo({
    title: approved.title,
    body_md: approved.body_md,
    primary_keyword: plan.primary_keyword,
    secondary_keywords: INTAKE.secondary_keywords,
  });

  const assets = CHANNELS.map((channel) => {
    const payload = must<Record<string, unknown>>(
      mock.mockChannel({ channel: channel as Channel, intake: INTAKE, title: approved.title, bodyMd: approved.body_md }) as never,
      `${channel} asset`,
    );
    return { channel, payload, report: checkChannel(channel as Channel, payload) };
  });

  /* ─── Write the pack ───────────────────────────────────────────────────── */

  lines.push('# Content sample pack');
  lines.push('');
  lines.push('Generated by `npx tsx test/scenarios/sample-pack.ts`. One request, start to finish.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 1. The input given to the system');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(INTAKE)) {
    lines.push(`| ${k} | ${Array.isArray(v) ? v.join(', ') : String(v)} |`);
  }
  lines.push('');
  lines.push(`**Pre-flight audit:** readiness \`${audit.readiness}\``);
  lines.push('');

  lines.push('## 2. Research and source selection');
  lines.push('');
  lines.push(research.brief_md);
  lines.push('');
  lines.push(
    `Retrieval produced **${allExcerpts.length} excerpts** across ${research.findings.length} sources. ` +
      `Selection kept **${selected.length}** of them.`,
  );
  lines.push('');
  lines.push('**Coverage gaps the sources do not answer:**');
  for (const g of selection.coverage_gaps) lines.push(`- ${g}`);
  lines.push('');

  lines.push('## 3. The plan');
  lines.push('');
  lines.push(`**Primary keyword:** ${plan.primary_keyword}`);
  lines.push('');
  lines.push(`**Thesis:** ${plan.thesis}`);
  lines.push('');
  lines.push('**Angles generated for the reviewer to choose between:**');
  lines.push('');
  for (const a of plan.angles) {
    lines.push(`${a.option_index}. **${a.angle}** — ${a.why_it_differs}`);
  }
  lines.push('');

  lines.push('## 4. Article options');
  lines.push('');
  for (const o of options) {
    lines.push(`### Option ${o.angle.option_index} — ${o.angle.angle}`);
    lines.push('');
    lines.push(`Evaluation: **${o.evaluation.status}** (${o.evaluation.overall_score.toFixed(1)} / 5). ${o.evaluation.summary}`);
    lines.push('');
    if (o.angle.option_index !== 1) {
      lines.push('<details><summary>Full draft</summary>');
      lines.push('');
      lines.push(o.draft.body_md);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('## 5. The evaluation and revision loop');
  lines.push('');
  lines.push(`Option 1 was evaluated **${target.evaluation.status}** at ${target.evaluation.overall_score.toFixed(1)}/5.`);
  lines.push('');
  lines.push('**What the evaluator found:**');
  for (const c of target.evaluation.unsupported_claims) {
    lines.push(`- Unsupported: “${c.claim_text}” — ${c.why}`);
  }
  for (const c of target.evaluation.recommended_changes) lines.push(`- ${c}`);
  lines.push('');
  lines.push('**Rubric, revision 1 → revision 2:**');
  lines.push('');
  lines.push('| Criterion | r1 | r2 |');
  lines.push('| --- | --- | --- |');
  for (const s of target.evaluation.scores) {
    const after = target.revisionEval!.scores.find((x) => x.criterion === s.criterion);
    lines.push(
      `| ${CRITERION_LABELS[s.criterion as RubricCriterion] ?? s.criterion} | ${s.score} | ${after?.score ?? '—'} |`,
    );
  }
  lines.push('');
  lines.push(
    `After revision the same option evaluated **${target.revisionEval!.status}** ` +
      `(${target.revisionEval!.overall_score.toFixed(1)} / 5). Revision 1 and its evaluation are both still readable — ` +
      '`article_versions` is append-only.',
  );
  lines.push('');

  lines.push('## 6. The approved article');
  lines.push('');
  lines.push(approved.body_md);
  lines.push('');
  lines.push(`**SEO check:** ${seo.pass ? 'passes' : 'fails'} — ${seo.word_count} words.`);
  lines.push('');
  for (const c of seo.checks) lines.push(`- ${c.pass ? '✓' : '✗'} ${c.label} — ${c.detail}`);
  lines.push('');

  lines.push('## 7. Channel assets');
  lines.push('');
  for (const a of assets) {
    const label = a.channel === 'x' ? 'X post' : a.channel === 'linkedin' ? 'LinkedIn post' : 'Email newsletter';
    lines.push(`### ${label}`);
    lines.push('');
    lines.push(`Rules: **${a.report.pass ? 'pass' : 'fail'}**${a.report.pass ? '' : ` — ${failureSummary(a.report)}`} · ${a.report.word_count} words`);
    lines.push('');
    if (a.payload.subject) lines.push(`**Subject:** ${String(a.payload.subject)}`);
    lines.push('');
    lines.push('```');
    lines.push(String(a.payload.body ?? a.payload.body_md ?? ''));
    lines.push('```');
    lines.push('');
    for (const c of a.report.checks) lines.push(`- ${c.pass ? '✓' : '✗'} ${c.label} — ${c.detail}`);
    lines.push('');
  }

  lines.push('## 8. Source list');
  lines.push('');
  lines.push('Which sources informed the output, and how many claims rest on each.');
  lines.push('');
  const byUrl = new Map<string, { title: string; claims: number }>();
  for (const c of target.claims) {
    for (const id of c.excerpt_ids) {
      const ex = selected.find((s) => s.id === id);
      if (!ex) continue;
      const entry = byUrl.get(ex.url) ?? { title: ex.source_title, claims: 0 };
      entry.claims++;
      byUrl.set(ex.url, entry);
    }
  }
  lines.push('| Source | URL | Claims |');
  lines.push('| --- | --- | --- |');
  for (const [url, v] of byUrl) lines.push(`| ${v.title} | ${url} | ${v.claims} |`);
  lines.push('');

  const summary = groundingSummary(target.claims);
  lines.push(
    `**Grounding:** ${summary.grounded} of ${summary.total} claims rest on reviewed source material; ` +
      `${summary.common_knowledge} are common knowledge; ${summary.unsupported} are unsupported.`,
  );
  lines.push('');
  lines.push('**All sources retrieved:**');
  lines.push('');
  for (const f of research.findings) {
    lines.push(`- [${f.title}](${f.url})${f.fetched ? ' — fetched and read' : ' — found in search'}`);
  }
  lines.push('');

  writeFileSync(join(OUT, 'SAMPLE-PACK.md'), lines.join('\n'));

  // The individual assets, as a person would actually paste them.
  writeFileSync(join(OUT, 'article.md'), `${approved.body_md}\n`);
  for (const a of assets) {
    const body = String(a.payload.body ?? a.payload.body_md ?? '');
    const header = a.payload.subject ? `Subject: ${String(a.payload.subject)}\n\n` : '';
    writeFileSync(join(OUT, `${a.channel}.txt`), header + body + '\n');
  }

  console.log(`Wrote the sample pack to docs/sample-pack/`);
  console.log(`  SAMPLE-PACK.md   the whole run: input, research, options, evaluation, outputs`);
  console.log(`  article.md       the approved article`);
  for (const a of assets) console.log(`  ${a.channel}.txt${' '.repeat(Math.max(0, 15 - a.channel.length))}${a.report.pass ? 'rules pass' : 'RULES FAIL'}`);
}

main();
