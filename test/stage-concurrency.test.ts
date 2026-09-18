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
