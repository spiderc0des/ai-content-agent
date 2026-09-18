import { describe, it, expect } from 'vitest';
import { interpretContinueResponse } from '../lib/continue-run';

/**
 * A run that is out of time hands off to itself over HTTP. That call is the
 * only thing keeping a twelve-minute pipeline alive inside five-minute
 * functions, which makes it the last thing in the system that should be
 * allowed to fail quietly.
 *
 * It was. The hand-off did `await fetch(...)` and never looked at the answer.
 * `fetch` rejects only on a transport failure, so a 401, a 404, a 503, and a
 * perfectly healthy 200 carrying `continued: false` all resolved exactly like
 * a success. A request stopped at `evaluating` with every stage green, no lock
 * held, no error anywhere, and nothing in the run log to say the chain had
 * ended — the failure was invisible by construction.
 */
describe('reading the continue endpoint’s answer', () => {
  it('treats a 200 with continued:true as handed off', () => {
    expect(interpretContinueResponse(true, 202, { continued: true }).outcome).toBe('accepted');
  });

  it('does NOT treat a 200 with continued:false as handed off', () => {
    // The whole bug in one assertion.
    const r = interpretContinueResponse(true, 200, {
      continued: false,
      reason: "nothing to run from 'published'",
    });
    expect(r.outcome).toBe('refused');
    expect(r.reason).toBe("nothing to run from 'published'");
  });

  it('carries the reason a lock race gave, so it can be retried', () => {
    const r = interpretContinueResponse(true, 200, {
      continued: false,
      reason: 'another driver claimed it first',
    });
    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/claimed it first/);
  });

  it('reports a bad secret rather than looking like success', () => {
    const r = interpretContinueResponse(false, 401, { error: 'Unauthorized' });
    expect(r.outcome).toBe('refused');
    expect(r.status).toBe(401);
    expect(r.reason).toBe('Unauthorized');
  });

  it('reports a server with no CRON_SECRET', () => {
    const r = interpretContinueResponse(false, 503, { error: 'CRON_SECRET is not set.' });
    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/CRON_SECRET/);
  });

  it('names a non-JSON reply, which is what a wrong origin returns', () => {
    // A stale APP_URL once pointed the chain at an unrelated app, which
    // answered with an HTML 404 page. That has to be distinguishable from a
    // refusal this application actually issued.
    const r = interpretContinueResponse(false, 404, null);
    expect(r.outcome).toBe('refused');
    expect(r.reason).toMatch(/non-JSON/);
  });

  it('falls back to the status when an error body says nothing', () => {
    expect(interpretContinueResponse(false, 500, {}).reason).toBe('HTTP 500');
  });
});
