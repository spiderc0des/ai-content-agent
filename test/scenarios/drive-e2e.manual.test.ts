/**
 * End-to-end test of the server-side pipeline driver, against the real
 * database and the real Claude API.
 *
 *   RUN_LIVE_DRIVE=1 npx vitest run test/scenarios/drive-e2e.manual.test.ts
 *
 * Optionally target an existing request instead of creating a new one:
 *   RUN_LIVE_DRIVE=1 DRIVE_REQUEST_ID=<uuid> npx vitest run ...
 *
 * What this actually proves, which no mock-backed test can: that one call to
 * drivePipeline() carries a request all the way from wherever it is to the
 * human review gate, with no client involvement at any point. That is the
 * fix for the failure mode this project kept hitting — a browser tab driving
 * the pipeline one fetch per stage, and the whole thing parking silently the
 * moment that tab was interrupted.
 *
 * Gated behind RUN_LIVE_DRIVE=1 so `npm test` never picks it up: it costs
 * real API spend and takes many minutes.
 */
import { describe, it, expect } from 'vitest';

const RUN_LIVE = process.env.RUN_LIVE_DRIVE === '1';
if (RUN_LIVE) process.env.MOCK_ANTHROPIC = '0';

const EXISTING_ID = process.env.DRIVE_REQUEST_ID ?? null;

describe.skipIf(!RUN_LIVE)('drivePipeline end to end', () => {
  it(
    'runs every machine stage and stops at the review gate',
    async () => {
      const q = await import('../../lib/queries');
      const { drivePipeline, nextStage } = await import('../../lib/pipeline');

      const author = await q.findAppUserByEmail(process.env.SCENARIO_AUTHOR_EMAIL ?? 'abdul.spidercodes@gmail.com');
      if (!author) throw new Error('Seed an admin user first (sql/03-seed-users.sql).');

      let requestId: string;

      if (EXISTING_ID) {
        const existing = await q.getRequest(EXISTING_ID);
        if (!existing) throw new Error(`No such request: ${EXISTING_ID}`);
        requestId = existing.id;
        console.log(`Resuming existing request ${requestId} from '${existing.status}'`);
      } else {
        const created = await q.createRequest({
          raw_idea:
            'Everyone says "just be consistent" about posting, but nobody explains what to do ' +
            'on the weeks you have nothing worth saying.',
          target_audience: 'Founders and marketers who write their own content',
          source_url: null,
          supporting_notes: 'Should be honest about the weeks when there is genuinely nothing.',
          title_hint: '',
          primary_keyword: '',
          secondary_keywords: [],
          desired_tone: 'Direct, warm, no hustle-culture cheerleading',
          word_count_target: null,
          channels_wanted: ['linkedin', 'x', 'newsletter'],
          option_count: 2,
          deadline_at: null,
          intake_hash: `drive-e2e-${Date.now()}`,
          author_id: author.id,
        });
        requestId = created.id;
        console.log(`Created request ${requestId}`);
      }

      // Exactly what POST /api/requests/:id/start does: claim, then drive.
      const claimed = await q.claimPipelineLock(requestId, author.email);
      expect(claimed, 'should be able to claim an idle request').not.toBeNull();

      // …and while it is claimed, nobody else can. This is the guard that was
      // missing when two clicks started two pipelines over the same request.
      expect(await q.claimPipelineLock(requestId, 'someone-else')).toBeNull();

      const started = Date.now();
      const result = await drivePipeline(requestId, author.email);
      const minutes = ((Date.now() - started) / 60000).toFixed(1);

      console.log(
        `\ndrivePipeline finished in ${minutes} min:\n` +
          `  stages run:  ${result.stagesRun}\n` +
          `  stopped:     ${result.stoppedBecause}\n` +
          `  status:      ${result.finalStatus}\n` +
          `  message:     ${result.message}\n`,
      );

      const final = await q.getRequest(requestId);
      expect(final).not.toBeNull();

      // The lock must always be released, however the run ended — a lock that
      // outlives its driver blocks the request for twenty minutes.
      expect(q.lockIsLive(final!)).toBe(false);

      if (result.stoppedBecause === 'failed') {
        const runs = await q.getStageRuns(requestId);
        const failed = runs.filter((r) => r.status === 'failed');
        console.log('Failed stage runs:', failed.map((r) => `${r.stage}: ${r.error}`).join('\n'));
        throw new Error(`Pipeline failed: ${result.message}`);
      }

      // The point of the whole exercise: it got itself to the human gate
      // without anyone clicking anything along the way.
      expect(result.stoppedBecause).toBe('needs_a_human');
      expect(final!.status).toBe('awaiting_review');
      expect(nextStage(final!)).toBeNull();

      const versions = await q.getCurrentVersions(requestId);
      expect(versions.length).toBeGreaterThan(0);
      console.log(`${versions.length} article option(s) ready for review:`);
      for (const v of versions) {
        const evaluation = await q.getEvaluationFor(v.id);
        console.log(
          `  · "${v.title}" — r${v.revision_no}, ${v.word_count} words, ` +
            `eval ${evaluation?.status ?? 'none'} ${evaluation?.overall_score ?? ''}`,
        );
      }
    },
    30 * 60 * 1000,
  );
});
