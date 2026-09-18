import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE = readFileSync(join(process.cwd(), 'lib', 'claude.ts'), 'utf8');

/**
 * A spend cap is the one API failure a person can actually act on, and it was
 * the least legible thing on the screen.
 *
 * It arrives as a generic 400 whose message is a JSON blob:
 *
 *   Claude API error (400): 400 {"type":"error","error":{"type":
 *   "invalid_request_error","message":"You have reached your specified
 *   workspace API usage limits. You will regain access on 2026-10-01 at
 *   00:00 UTC."},"request_id":"req_011CfEq9jFy9FCJS92trvFmZ"}
 *
 * which the request page rendered verbatim.
 */
describe('a spend limit reads as an instruction', () => {
  it('is recognised before the generic API-error wording', () => {
    const at = CLAUDE.indexOf('if (err instanceof Anthropic.APIError) {');
    expect(at).toBeGreaterThan(-1);
    const body = CLAUDE.slice(at, at + 1400);
    const capped = body.indexOf('const capped = usageLimitMessage');
    const generic = body.indexOf('Claude API error (');
    expect(capped, 'the cap check is missing').toBeGreaterThan(-1);
    expect(generic, 'the generic branch is missing — widen the window').toBeGreaterThan(-1);
    expect(capped, 'the cap check must come first').toBeLessThan(generic);
  });

  it('matches the wordings Anthropic actually uses', () => {
    const at = CLAUDE.indexOf('function usageLimitMessage(');
    const body = CLAUDE.slice(at, at + 900);
    for (const phrase of ['usage limit', 'credit balance', 'spend limit']) {
      expect(body).toContain(phrase);
    }
  });

  it('says when access returns and what to do about it', () => {
    const at = CLAUDE.indexOf('function usageLimitMessage(');
    const body = CLAUDE.slice(at, at + 1200);
    expect(body).toMatch(/regain access on/);
    expect(body).toMatch(/Anthropic console/);
    // And that the work already done is not lost — the failure is about
    // budget, not about the content.
    expect(body).toMatch(/resumed|lost/);
  });
});
