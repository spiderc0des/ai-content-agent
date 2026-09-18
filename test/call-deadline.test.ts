import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE = readFileSync(join(process.cwd(), 'lib', 'claude.ts'), 'utf8');

/**
 * Every Claude call has a hard deadline, as an abort signal.
 *
 * The client's `timeout` option does not bound a streamed response. Two
 * proofs from this system's own data: a research call ran 276 seconds to
 * completion under a 180-second client timeout, and another sat `running` for
 * 303 seconds with no request id and no error until a watchdog killed the
 * drive around it. `timeout` governs obtaining the response; once a stream is
 * flowing it stops applying.
 *
 * An AbortSignal applies to both. Without one, the longest and most expensive
 * calls in the pipeline — the three streamed ones — were the only calls with
 * no upper bound at all.
 */
describe('every Claude call is bounded', () => {
  it('passes a deadline to every call site', () => {
    const calls = [...CLAUDE.matchAll(/client\.beta\.messages\.(parse|stream|create)\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(9);
    const deadlines = [...CLAUDE.matchAll(/\}, deadline\(/g)];
    expect(deadlines.length).toBe(calls.length);
  });

  it('bounds the streamed calls too, which the client timeout does not', () => {
    // These are the ones that hung. A stream with no signal can run forever.
    let from = 0;
    for (let i = 0; i < 3; i++) {
      const at = CLAUDE.indexOf('client.beta.messages.stream(', from);
      expect(at, `stream call ${i + 1}`).toBeGreaterThan(-1);
      const close = CLAUDE.indexOf('}, deadline(', at);
      expect(close, `stream call ${i + 1} has no deadline`).toBeGreaterThan(at);
      from = at + 1;
    }
  });

  it('gives research longer, but still finite', () => {
    const m = /const RESEARCH_DEADLINE_MS = ([\d_]+);/.exec(CLAUDE);
    expect(m).not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ''));
    // Above what research should take with its budgets cut, and finite.
    //
    // This is now the WHOLE budget for the stage, not per attempt, because a
    // deadline abort is no longer retried. At 600s across three attempts the
    // worst case was thirty minutes — and a run was observed sitting at
    // twenty-one with its stage row still saying `running`, which looks
    // exactly like the hang the deadline exists to end.
    expect(ms).toBeGreaterThan(300_000);
    expect(ms).toBeLessThanOrEqual(420_000);
  });

  it('does not retry a deadline abort', () => {
    // Retrying a deadline is the same as not having one: three attempts
    // against a ten-minute deadline is a thirty-minute stage that reports
    // nothing while it runs. These are not transient — a call that spends its
    // whole deadline is working through slow web fetches, and another
    // deadline buys another slow crawl, not a different answer.
    const at = CLAUDE.indexOf('if (isDeadlineAbort(err))');
    expect(at).toBeGreaterThan(-1);
    const body = CLAUDE.slice(at, at + 500);
    expect(body).not.toContain('continue;');
    expect(body).toContain('return {');
  });

  it('reports a deadline abort as its own failure, not as a bad response', () => {
    // 'invalid_response' is a verdict about content. Giving up on a call is
    // not a verdict about content, and filing it as one sends someone looking
    // at the wrong thing.
    expect(CLAUDE).toContain('isDeadlineAbort');
    const at = CLAUDE.indexOf('if (isDeadlineAbort(err))');
    expect(at).toBeGreaterThan(-1);
    const body = CLAUDE.slice(at, at + 700);
    expect(body).toContain("'api_error'");
    expect(body).not.toContain("'invalid_response'");
  });
});
