import { describe, it, expect } from 'vitest';
import { intakeAsText } from '../lib/schemas';
import { generatePrompt } from '../lib/prompts/stages';

/**
 * The model is told about the article, not about the machine producing it.
 *
 * `intakeAsText` serialises every field it is handed, so anything added to
 * the intake reaches every prompt by default. Two orchestration settings got
 * in that way, and the second one reached the page:
 *
 *   research_depth  — how hard research works. Noise.
 *   option_count    — how many articles the PIPELINE will produce, by making
 *                     that many separate calls. A single writer producing one
 *                     article read it as a brief for three, and emitted a
 *                     section headed "Editor's Note: Why This Is One Article,
 *                     Not Three Options" — addressed to whoever commissioned
 *                     the work, in copy meant for readers.
 */
describe('operator settings stay out of the prompt', () => {
  const intake = {
    raw_idea: 'a thing worth writing about',
    target_audience: 'people',
    option_count: 3,
    research_depth: 'standard' as const,
    primary_keyword: 'a keyword',
  };

  it('sends the content fields', () => {
    const text = intakeAsText(intake);
    expect(text).toContain('raw_idea');
    expect(text).toContain('target_audience');
    expect(text).toContain('primary_keyword');
  });

  it('withholds how the pipeline is configured', () => {
    const text = intakeAsText(intake);
    expect(text).not.toContain('option_count');
    expect(text).not.toContain('research_depth');
  });
});

describe('the article is written for the reader', () => {
  it('tells the writer not to address whoever commissioned it', () => {
    const p = generatePrompt({
      angle: 'an angle',
      whyItDiffers: 'because',
      optionIndex: 1,
      wordCountTarget: null,
    });
    expect(p).toMatch(/READER/);
    expect(p).toMatch(/Editor's note/i);
    // And it must still hold the line on committing to one angle.
    expect(p).toMatch(/Commit to this angle/);
  });
});
