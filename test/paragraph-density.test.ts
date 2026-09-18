import { describe, it, expect } from 'vitest';
import { sentenceCount, paragraphs } from '../lib/seo';
import { isLongParagraph, failureInstructions, type RuleReport } from '../lib/channel-rules';

/**
 * "Keep paragraphs short" — what the brief actually asks for, and what this
 * used to measure instead.
 *
 * A real LinkedIn post failed this rule twice through manual regeneration and
 * could not be made to pass, for three separate reasons that stacked:
 *
 *   1. The test was `sentenceCount > 3` alone. The brief says only "keep
 *      paragraphs short"; the 3-sentence ceiling was borrowed from the SEO
 *      document's advice about ARTICLE paragraphs. On LinkedIn it failed a
 *      twelve-word staccato opener while passing a forty-five-word block.
 *   2. sentenceCount counted a trailing emoji as a sentence, so a genuinely
 *      three-sentence close was reported as four. No rewrite fixes that.
 *   3. The repair instruction named a COUNT and not the paragraphs, asking a
 *      model that cannot count sentences to find two among eight.
 */
describe('what counts as a dense paragraph', () => {
  const OPENER = "It's 4pm Thursday. Cursor blinking. Coffee cold. You've got nothing to post.";

  it('does not fail a short staccato opener, however many full stops it has', () => {
    // Four sentences, twelve words — the punchiest shape on the platform, and
    // the one the old rule rejected outright.
    expect(sentenceCount(OPENER)).toBe(4);
    expect(isLongParagraph(OPENER)).toBe(false);
  });

  it('still fails an actual wall of text', () => {
    const wall =
      'This is a genuine wall of text that a reader on a phone would simply scroll ' +
      'straight past without reading any of it. It runs on and on with clause after ' +
      'clause. Nobody wants to read this in a feed. It keeps going well beyond the ' +
      'point where attention has already gone. And then it adds one more for luck.';
    expect(isLongParagraph(wall)).toBe(true);
  });

  it('needs a paragraph to be long BOTH ways, not either', () => {
    // Many sentences but few words: fine. Many words but few sentences: also
    // fine on this platform. Only both together is a block a reader skips.
    const manySentences = 'One. Two. Three. Four. Five.';
    const manyWords =
      'A single sentence can run to a considerable length and still read perfectly ' +
      'well in a feed because the eye follows one unbroken thought rather than ' +
      'stopping and restarting over and over again across many separate lines.';
    expect(isLongParagraph(manySentences)).toBe(false);
    expect(isLongParagraph(manyWords)).toBe(false);
  });
});

describe('counting sentences', () => {
  it('does not count a trailing emoji as a sentence', () => {
    expect(sentenceCount('Drop your test below. 👇')).toBe(1);
    expect(
      sentenceCount(
        'Which one are you dealing with this week — empty, or just scared? ' +
          'Curious how other founders tell the difference. Drop your test below. 👇',
      ),
    ).toBe(3);
  });

  it('does not count bare punctuation or symbols', () => {
    expect(sentenceCount('Ship it. —')).toBe(1);
    expect(sentenceCount('Really? !!')).toBe(1);
  });

  it('still tolerates abbreviations that end in a period', () => {
    expect(sentenceCount('Ask Dr. Smith about it. Then decide.')).toBe(2);
  });
});

describe('the instruction sent back on a retry', () => {
  const report = (): RuleReport => ({
    pass: false,
    word_count: 0,
    checks: [
      {
        key: 'short_paragraphs',
        label: 'Paragraphs are short',
        pass: false,
        detail: '1 of 2 paragraphs are dense blocks',
        required: true,
      },
    ],
  });

  it('quotes the offending paragraph rather than counting it', () => {
    const wall =
      'This is a genuine wall of text that a reader on a phone would simply scroll ' +
      'straight past without reading any of it. It runs on and on with clause after ' +
      'clause. Nobody wants to read this in a feed. It keeps going well beyond the ' +
      'point where attention has already gone. And then it adds one more for luck.';
    const body = `${wall}\n\nA short one here.`;

    const instruction = failureInstructions('linkedin', report(), body);

    // The whole failure was that the model was told "2 paragraphs" and left to
    // guess which. It must now be able to see them.
    expect(instruction).toContain('This is a genuine wall of text');
    expect(instruction).toMatch(/blank line/i);
    expect(instruction).not.toMatch(/Fix this\.$/);

    // And only the guilty one — quoting the short paragraph too would invite
    // a rewrite of copy that was already fine.
    expect(instruction).not.toContain('A short one here');
  });

  it('names paragraphs consistently with what the check found', () => {
    const body = paragraphs('Alpha beta. Gamma delta.').join('\n\n');
    expect(failureInstructions('linkedin', report(), body)).toBeTypeOf('string');
  });
});
