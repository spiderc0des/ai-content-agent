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
    // Comfortably above what research should take now that its tool budgets
    // are sized to fit the platform limit, and still finite.
    //
    // Both earlier values were wrong, for opposite reasons. 300s would have
    // aborted a 657-second call that completed normally — a deadline tighter
    // than observed healthy work does not catch hangs, it manufactures them.
    // 900s cleared that maximum, but the maximum was itself the symptom:
    // research was allowed 24 web fetches and took as long as the slowest.
    expect(ms).toBeGreaterThanOrEqual(2 * 300_000);
    expect(ms).toBeLessThanOrEqual(600_000);
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
