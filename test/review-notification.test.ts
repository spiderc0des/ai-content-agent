import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PIPELINE = readFileSync(join(process.cwd(), 'lib', 'pipeline.ts'), 'utf8');
const WORKSPACE = readFileSync(join(process.cwd(), 'app', 'r', '[id]', 'Workspace.tsx'), 'utf8');
const CONTINUE = readFileSync(join(process.cwd(), 'lib', 'continue-run.ts'), 'utf8');

/**
 * A request arriving at the human gate has to reach a human.
 *
 * There are two ways in — the evaluation loop ending because something
 * passed, and the revision budget running out — and they are in different
 * functions hundreds of lines apart. Wiring one and not the other produces a
 * notification that works in testing and silently misses the case that
 * matters most: the request nobody could fix automatically.
 */
describe('reviewers are told when a request reaches the gate', () => {
  it('notifies from BOTH routes into awaiting_review', () => {
    const calls = PIPELINE.match(/notifyReviewers\(/g) ?? [];
    // One definition plus a call from each route.
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('notifies after the status actually moves, not before', () => {
    // Mailing first and then failing to move the request would tell reviewers
    // to look at something that is not there.
    const idx = PIPELINE.indexOf("advanceStatus(request.id, 'awaiting_review', ['revising'])");
    expect(idx).toBeGreaterThan(-1);
    const after = PIPELINE.slice(idx, idx + 400);
    expect(after).toContain('notifyReviewers');
  });

  it('never lets a mail failure break the pipeline', () => {
    // The work is already done and the request already moved by this point.
    const start = PIPELINE.indexOf('async function notifyReviewers');
    const body = PIPELINE.slice(start, start + 2600);
    expect(body).toContain('try {');
    expect(body).toContain('catch');
    // And it must still say what happened, either way.
    expect(body).toContain('reviewers_notified');
  });
});

describe('the page keeps up with a running pipeline', () => {
  it('polls every five seconds, not every two minutes', () => {
    // Stages finish in 40 to 200 seconds, so a two-minute poll could miss a
    // whole stage — someone had to refresh by hand to see where a run was.
    const m = /const POLL_INTERVAL_MS = ([\d_]+);/.exec(WORKSPACE);
    expect(m).not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ''));
    expect(ms).toBeLessThanOrEqual(5_000);
    expect(ms).toBeGreaterThanOrEqual(1_000);
  });
});

describe('the hand-off chain stays under the platform ceiling', () => {
  it('allows fewer hops than the platform permits self-invocations', () => {
    // Vercel answers a deployment that invokes itself too deeply with a bare
    // 508 from its proxy — observed at hop 5, on a run whose every stage had
    // succeeded. A cap above that ceiling is not a cap at all: the chain ends
    // where the platform cuts it, which looks exactly like a bug.
    const m = /const MAX_HOPS = (\d+);/.exec(CONTINUE);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(5);
  });

  it('names a 508 as the platform refusing, not a mystery', () => {
    expect(CONTINUE).toContain('508');
    expect(CONTINUE).toMatch(/loop detected/i);
  });
});
