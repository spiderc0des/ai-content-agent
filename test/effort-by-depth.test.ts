import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { depthProfile, RESEARCH_DEPTHS } from '../lib/research-depth';
import { intakeAsText } from '../lib/schemas';

const CLAUDE = readFileSync(join(process.cwd(), 'lib', 'claude.ts'), 'utf8');

/**
 * Research depth caps effort across the WHOLE pipeline, not just research.
 *
 * Planning, generation, evaluation and revision ask for high. Those four are
 * the longest stages in the pipeline and the largest output lines in the
 * bill, so leaving them at high made "quick" quick in name only — it capped
 * what research searched for and fetched, and left the expensive half of the
 * run exactly as it was.
 */
describe('effort is capped by research depth', () => {
  it('caps quick at medium and leaves the slower depths alone', () => {
    expect(depthProfile('quick').maxEffort).toBe('medium');
    expect(depthProfile('standard').maxEffort).toBe('high');
    expect(depthProfile('deep').maxEffort).toBe('high');
  });

  it('never raises effort, only lowers it', () => {
    // A call asking for low must still get low at every depth: research is
    // bound by web round trips and the digest by extraction, and paying for
    // deliberation on either buys nothing at any setting.
    for (const d of RESEARCH_DEPTHS) {
      expect(['medium', 'high']).toContain(depthProfile(d).maxEffort);
    }
  });

  it('applies the cap at every call site that asks for high', () => {
    // Source-level, because missing one is invisible: it compiles, passes
    // every other test, and quietly leaves a stage running at full effort on
    // a depth the user chose for speed.
    for (const fn of ['planContent', 'generateArticle', 'evaluateArticle', 'reviseArticle']) {
      const at = CLAUDE.indexOf(`export async function ${fn}(`);
      expect(at, fn).toBeGreaterThan(-1);
      const body = CLAUDE.slice(at, at + 3000);
      expect(body, fn).toContain("effortFor(params.intake, 'high')");
      // And the resolved value is what gets sent AND what gets recorded on
      // the stage run, so the log cannot claim an effort that was not used.
      expect(body, fn).toContain('output_config: { effort,');
      expect(body, fn).toContain('withRetry(effort,');
    }
    expect(CLAUDE).not.toMatch(/effort:\s*'high'/);
  });

  it('keeps the depth out of the prompt the model reads', () => {
    // It travels on the intake so effort can be sized from it. It is an
    // instruction to this system, not context about the article.
    const text = intakeAsText({ raw_idea: 'a thing', research_depth: 'quick' });
    expect(text).toContain('raw_idea');
    expect(text).not.toContain('research_depth');
  });
});
