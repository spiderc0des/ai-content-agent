/**
 * Generate a SECOND content sample pack — this one for real.
 *
 *   RUN_LIVE_SAMPLE_PACK=1 npx vitest run test/scenarios/live-sample-pack.manual.test.ts
 *
 * docs/sample-pack/ (from `npm run sample-pack`) runs the mock layer:
 * fast, free, deterministic — good for proving the pipeline's plumbing
 * works. But test/mock-anthropic.ts's fixtures are hardcoded to the
 * "remote onboarding" topic specifically (the prose, not just the
 * keyword, is baked into the template strings), so a different topic fed
 * through it would produce mismatched, nonsensical text rather than a
 * genuinely different article. That's fine for testing grounding logic;
 * it's not what a "more relatable" sample pack needs.
 *
 * This script drives the REAL pipeline — actual Claude calls, actual web
 * research, actual money — end to end for one request, on a different
 * topic, exactly the way a person using the app would: creates a request,
 * runs every machine stage via the same functions and the same nextStage()
 * state machine the API routes use, approves the highest-scoring option
 * through the real review path (so the database's approval trigger
 * actually fires, same as a human clicking Approve), packages it for all
 * three channels, and writes docs/sample-pack-2/.
 *
 * Gated behind RUN_LIVE_SAMPLE_PACK=1 — same pattern as
 * queries.integration.test.ts's hasRealDatabase gate — so it never runs as
 * part of `npm test` (which would otherwise pick it up: its filename has to
 * match vitest's default include glob to be runnable by exact path at all,
 * and vitest's `exclude` has no path-argument bypass to opt back in per-run).
 * Bare `npm test` reports this file's one test as skipped, not run: no cost,
 * no multi-minute wait, nothing silently different from before this file
 * existed.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const RUN_LIVE = process.env.RUN_LIVE_SAMPLE_PACK === '1';

// Force the real API path regardless of .env.local's MOCK_ANTHROPIC value —
// must happen before anything imports lib/env.ts. Only when actually running
// (not on the skipped path) so importing this file never has this side
// effect on a bare `npm test`.
if (RUN_LIVE) process.env.MOCK_ANTHROPIC = '0';

const OUT = join(process.cwd(), 'docs', 'sample-pack-2');

const INTAKE = {
  raw_idea:
    'Most LinkedIn posts lose the reader in the first line, and most writers ' +
    'never find out why — the analytics just show a post that "didn\'t do well."',
  target_audience: 'Marketing and content leads at small B2B companies',
  source_url: null as string | null,
  supporting_notes:
    'We write and ship content for clients every week — this should read like ' +
    'something we learned the hard way, not a generic listicle.',
  primary_keyword: '',
  secondary_keywords: [] as string[],
  desired_tone: 'Direct, a little wry, no corporate voice',
  option_count: 2,
  channels_wanted: ['linkedin', 'x', 'newsletter'] as const,
};

describe.skipIf(!RUN_LIVE)('live sample pack', () => {
  it(
    'runs the real pipeline end to end and writes docs/sample-pack-2/',
    async () => {
      const q = await import('../../lib/queries');
      const pipeline = await import('../../lib/pipeline');
      const { contentFingerprint } = q;

      const author = await q.findAppUserByEmail(process.env.SCENARIO_AUTHOR_EMAIL ?? 'abdul.spidercodes@gmail.com');
      if (!author) throw new Error('Seed an admin user first (sql/03-seed-users.sql).');

      console.log('Creating the request…');
      let request = await q.createRequest({
        raw_idea: INTAKE.raw_idea,
        target_audience: INTAKE.target_audience,
        source_url: INTAKE.source_url,
        supporting_notes: INTAKE.supporting_notes,
        title_hint: '',
        primary_keyword: INTAKE.primary_keyword,
        secondary_keywords: INTAKE.secondary_keywords,
        desired_tone: INTAKE.desired_tone,
        word_count_target: null,
        channels_wanted: [...INTAKE.channels_wanted],
        option_count: INTAKE.option_count,
        deadline_at: null,
        intake_hash: `live-sample-pack-${Date.now()}`,
        author_id: author.id,
      });
      console.log(`  ${request.id}`);

      // Drive the machine stages exactly the way POST /api/requests/:id/run
      // does — same nextStage() state machine, same stage functions — so
      // this is genuinely the app's own pipeline, not a reimplementation of
      // it. Stops the moment a human is needed (awaiting_review) or a stage
      // fails.
      for (let i = 0; i < 20; i++) {
        const stage = pipeline.nextStage(request);
        if (!stage) break;

        console.log(`Running ${stage}…`);
        const result =
          stage === 'revision'
            ? await pipeline.runRevision(request, { actor: author.email, createdBy: author.id })
            : await pipeline.STAGE_RUNNERS[stage as keyof typeof pipeline.STAGE_RUNNERS](request);

        console.log(`  ${result.ok ? 'ok' : 'FAILED'} — ${result.message}`);
        if (!result.ok) throw new Error(`${stage} failed: ${result.message}`);

        const after = await q.getRequest(request.id);
        if (!after) throw new Error('request vanished mid-run');
        request = after;

        if (request.status === 'awaiting_review') break;
      }

      expect(request.status).toBe('awaiting_review');

      // Approve whichever option scored highest — the real review path
      // (recordReview), not a raw update, so the approval trigger
      // (guard_content_approval) actually runs, same as a human clicking
      // Approve in the UI.
      const versions = await q.getCurrentVersions(request.id);
      const scored = await Promise.all(
        versions.map(async (v) => ({ v, evaluation: await q.getEvaluationFor(v.id) })),
      );
      scored.sort((a, b) => Number(b.evaluation?.overall_score ?? 0) - Number(a.evaluation?.overall_score ?? 0));
      const chosen = scored[0];
      console.log(
        `Approving option (score ${chosen.evaluation?.overall_score ?? 'n/a'}): "${chosen.v.title}"`,
      );

      const approval = await q.recordReview({
        requestId: request.id,
        reviewerId: author.id,
        action: 'approve',
        articleId: chosen.v.article_id,
        versionId: chosen.v.id,
        note: 'Selected for the sample pack — highest evaluation score.',
        instruction: null,
        expectedVersion: request.version,
        toStatus: 'approved',
        approvedContentHash: contentFingerprint(chosen.v.title, chosen.v.body_md),
      });
      request = approval.request;
      expect(request.status).toBe('approved');

      console.log('Packaging channels…');
      const packaged = await pipeline.runPackaging(request);
      console.log(`  ${packaged.ok ? 'ok' : 'FAILED'} — ${packaged.message}`);
      request = (await q.getRequest(request.id))!;

      /* ─── Assemble the pack ──────────────────────────────────────────── */

      mkdirSync(OUT, { recursive: true });
      const lines: string[] = [];

      const sources = await q.getSources(request.id);
      const excerpts = await q.getExcerpts(request.id);
      const versionSources = await q.getVersionSources(chosen.v.id);
      const claims = await q.getClaims(chosen.v.id);
      const assets = await q.getLatestAssets(request.id);

      lines.push('# Content sample pack 2');
      lines.push('');
      lines.push(
        'Generated by `npx vitest run test/scenarios/live-sample-pack.manual.ts` — ' +
          'the real pipeline, real Claude calls, real web research. Not the mock layer.',
      );
      lines.push('');
      lines.push('---');
      lines.push('');
      lines.push('## 1. The input given to the system');
      lines.push('');
      lines.push('| Field | Value |');
      lines.push('| --- | --- |');
      lines.push(`| Idea | ${INTAKE.raw_idea} |`);
      lines.push(`| Audience | ${INTAKE.target_audience} |`);
      lines.push(`| Tone | ${INTAKE.desired_tone} |`);
      lines.push(`| Options requested | ${INTAKE.option_count} |`);
      lines.push(`| Channels | ${INTAKE.channels_wanted.join(', ')} |`);
      lines.push('');

      lines.push('## 2. Sources found and used');
      lines.push('');
      lines.push(
        `Retrieval produced **${excerpts.length} excerpts** across ${sources.length} sources; ` +
          `${excerpts.filter((e) => e.selected).length} were kept by selection.`,
      );
      lines.push('');
      for (const s of sources.filter((s) => s.url)) {
        lines.push(`- [${s.title}](${s.url})`);
      }
      lines.push('');

      lines.push('## 3. The approved article');
      lines.push('');
      lines.push(`**${chosen.v.title}**`);
      lines.push('');
      lines.push(chosen.v.body_md);
      lines.push('');
      lines.push(`Evaluation: **${chosen.evaluation?.status}** (${chosen.evaluation?.overall_score}/5)`);
      lines.push('');

      lines.push('## 4. Source list — what informed this output');
      lines.push('');
      lines.push('| Source | Claims resting on it |');
      lines.push('| --- | --- |');
      for (const vs of versionSources) {
        lines.push(`| [${vs.title}](${vs.url ?? '#'}) | ${vs.claim_count} |`);
      }
      lines.push('');
      const grounded = claims.filter((c) => c.support === 'grounded').length;
      lines.push(
        `${grounded} of ${claims.length} claims in this article rest on reviewed source material.`,
      );
      lines.push('');

      lines.push('## 5. Channel assets');
      lines.push('');
      for (const a of assets) {
        const label = a.channel === 'x' ? 'X post' : a.channel === 'linkedin' ? 'LinkedIn post' : 'Email newsletter';
        lines.push(`### ${label}`);
        lines.push('');
        lines.push(`Rules: **${a.rules_pass ? 'pass' : 'fail'}**`);
        lines.push('');
        if (a.subject) lines.push(`**Subject:** ${a.subject}`);
        lines.push('');
        lines.push('```');
        lines.push(a.body);
        lines.push('```');
        lines.push('');

        const body = a.body;
        writeFileSync(
          join(OUT, `${a.channel}.txt`),
          (a.subject ? `Subject: ${a.subject}\n\n` : '') + body + '\n',
        );
      }

      writeFileSync(join(OUT, 'SAMPLE-PACK.md'), lines.join('\n'));
      writeFileSync(join(OUT, 'article.md'), `${chosen.v.body_md}\n`);

      console.log(`\nWrote docs/sample-pack-2/ — request id ${request.id}`);
    },
    20 * 60 * 1000, // this is a real, multi-stage pipeline run — give it room
  );
});
