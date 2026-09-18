import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-option Claude calls must run together, not one after another.
 *
 * A source-level guard, in the same spirit as test/jsx-attributes.test.ts:
 * the property is structural, the regression is invisible to typecheck, and
 * it costs real money to discover at runtime.
 *
 * What it caught: revision made one call per option inside a sequential `for`
 * loop. Each call takes about 145 seconds, so three options took roughly 435 —
 * and the platform kills the function at 300. The stage failed three times in
 * a row, and each failure discarded the options it had already rewritten.
 * Generation had always used Promise.all; revision simply never did.
 *
 * Run together, the stage costs about as long as its slowest option rather
 * than the sum of all of them. That is the whole difference between fitting in
 * the function limit and not.
 */
const PIPELINE = readFileSync(join(process.cwd(), 'lib', 'pipeline.ts'), 'utf8');

/** The Claude calls that are made once per article option. */
const PER_OPTION_CALLS = ['claude.reviseArticle', 'claude.generateArticle'];

describe('per-option Claude calls run concurrently', () => {
  for (const call of PER_OPTION_CALLS) {
    it(`${call} is not awaited inside a sequential loop`, () => {
      expect(PIPELINE).toContain(call);

      // Walk back from the call to the nearest enclosing loop keyword. If a
      // `for (`/`while (` is closer than the `map(` that would put it inside a
      // Promise.all, the calls are serialised.
      const at = PIPELINE.indexOf(call);
      const before = PIPELINE.slice(0, at);

      const lastLoop = Math.max(before.lastIndexOf('for ('), before.lastIndexOf('while ('));
      const lastMap = before.lastIndexOf('.map(');

      expect(
        lastMap,
        `${call} appears to be awaited inside a sequential loop — it should be issued ` +
          `through Promise.all over the options, the way generation does it`,
      ).toBeGreaterThan(lastLoop);
    });
  }

  it('revision issues its calls through Promise.all', () => {
    const start = PIPELINE.indexOf('export async function runRevision');
    expect(start).toBeGreaterThan(-1);
    const body = PIPELINE.slice(start, start + 6000);
    expect(body).toContain('Promise.all');
    // The calls go out together; the database writes that follow may be serial.
    expect(body.indexOf('Promise.all')).toBeLessThan(body.indexOf('claude.reviseArticle'));
  });

  it('does not rewrite an option the evaluator passed', () => {
    // Revision is reached when nothing passed, so this is usually a no-op --
    // but a human revising one option must not have the others rewritten
    // underneath them, and a passing draft is the one thing a revision can
    // only make worse.
    const start = PIPELINE.indexOf('export async function runRevision');
    const body = PIPELINE.slice(start, start + 6000);
    expect(body).toMatch(/evaluation\?\.status === 'pass'/);
  });
});

/**
 * Every stage that makes one Claude call per item runs them together.
 *
 * Measured before this: retrieval 57s median and 156s max for one call per
 * readable source, evaluation 61s/239s for one per option, packaging 50s/83s
 * for one per channel — all in series, so each stage cost the SUM of its
 * calls rather than roughly the slowest one. None of those items depends on
 * another's answer.
 */
describe('per-item stages do not run one call at a time', () => {
  const PER_ITEM = ['runRetrieval', 'runEvaluation', 'runPackaging', 'runGeneration', 'runRevision'];

  it('issues per-item calls concurrently in every stage that has them', () => {
    for (const fn of PER_ITEM) {
      const at = PIPELINE.indexOf(`function ${fn}(`);
      expect(at, fn).toBeGreaterThan(-1);
      const body = PIPELINE.slice(at, at + 7000);
      expect(body, `${fn} still calls Claude one item at a time`).toMatch(
        /mapWithLimit|Promise\.all/,
      );
    }
  });

  it('bounds how many calls are in flight, rather than firing all of them', () => {
    // Item counts are not fixed — retrieval can have a dozen readable
    // sources. A bare Promise.all over those is how a rate limit gets hit,
    // and a 429 storm costs more than the serialisation saved.
    const m = /const STAGE_CONCURRENCY = (\d+);/.exec(PIPELINE);
    expect(m).not.toBeNull();
    const limit = Number(m![1]);
    expect(limit).toBeGreaterThan(1);
    expect(limit).toBeLessThanOrEqual(8);
  });

  it('keeps results in input order, so stored rows do not depend on timing', () => {
    const at = PIPELINE.indexOf('async function mapWithLimit');
    const body = PIPELINE.slice(at, at + 900);
    expect(body).toContain('results[i]');
  });
});

/**
 * Stage concurrency is bounded by the connection pool, not by the API.
 *
 * Each concurrent item persists its result, and some of those writes open a
 * transaction that holds a pooled connection for its whole duration. Run more
 * at once than the pool can serve and the stage does not fail — postgres.js
 * queues the query indefinitely. It never reaches Postgres, so there is
 * nothing in pg_stat_activity to find, and the process looks healthy while a
 * 300ms UPDATE hangs forever.
 */
describe('concurrency fits the connection pool', () => {
  const DB = readFileSync(join(process.cwd(), 'lib', 'db.ts'), 'utf8');

  it('sets an explicit pool size rather than taking the default of 10', () => {
    const m = /max:\s*Number\(process\.env\.DATABASE_POOL_MAX \?\? (\d+)\)/.exec(DB);
    expect(m, 'lib/db.ts must set an explicit max').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(10);
  });

  it('leaves room for the heartbeat, the drive and page polling', () => {
    const poolMax = Number(/DATABASE_POOL_MAX \?\? (\d+)/.exec(DB)![1]);
    const stage = Number(/const STAGE_CONCURRENCY = (\d+);/.exec(PIPELINE)![1]);
    // A stage's concurrent writes must not be able to take the whole pool.
    expect(stage * 2).toBeLessThan(poolMax);
  });

  it('fails a connection wait instead of queueing forever', () => {
    // An indefinite wait is what made this cost three days to find.
    expect(DB).toMatch(/connect_timeout:\s*\d+/);
    expect(DB).toMatch(/idle_timeout:\s*\d+/);
  });
});
