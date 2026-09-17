import { describe, it, expect } from 'vitest';
import {
  checkLinkedIn,
  checkX,
  checkNewsletter,
  countEmoji,
  countHashtags,
  failureSummary,
  failureInstructions,
} from '../lib/channel-rules';
import type { LinkedInPost, XPost, Newsletter } from '../lib/schemas';

const linkedin: LinkedInPost = {
  hook: 'Most remote onboarding fails in week one.',
  problem: 'New hires start remote with no owner.',
  agitation: 'They spend two weeks guessing, and half of them quietly disengage.',
  solution: 'Give every new hire one owner and one shippable task.',
  bullets: ['One owner', 'One task', 'One week'],
  cta: 'What did your best first week look like?',
  body: `Most remote onboarding fails in week one.

New hires start with no owner and no first task.

They spend two weeks guessing. Half quietly disengage.

Here is what works:

- One owner
- One shippable task
- One week

What did your best first week look like?`,
};

const xpost: XPost = {
  hook: 'Remote onboarding is a product launch, not paperwork.',
  single_idea: 'Treat the first week as a launch.',
  body: `Remote onboarding is a product launch, not paperwork.

One owner. One shippable task. One week.

#RemoteWork`,
  hashtags: ['#RemoteWork'],
};

const newsletter: Newsletter = {
  subject: 'The first week decides everything',
  preheader: 'One owner, one task, one week.',
  intro: 'Most remote onboarding fails quietly. It fails in week one. Here is the fix.',
  main_section_md: `**What goes wrong.** Three things, every time:

- No owner
- No first task
- Too much reading

**What to do instead.** Give every new hire one owner. Give them one
shippable task in week one.`,
  secondary_item_md: 'Quick tip: write the first task before the offer is signed.',
  cta: 'Reply and tell me how your last hire started.',
  sign_off: 'Until next week,\nThe Koya team',
  body_md: `Most remote onboarding fails quietly. It fails in week one. Here is the fix.

**What goes wrong.** Three things, every time:

- No owner for the new hire
- No first task that actually ships
- Far too much reading material handed over on day one

Every one of those is a decision someone forgot to make. New hires notice.
They form their view of a company inside five days, and that view is sticky.

Most teams respond by adding more documentation. That is the wrong lever.
Documentation is what you reach for when nobody owns the outcome.

**What to do instead.** Give every new hire one owner. That owner answers questions and unblocks them,
and they are measured on whether the new hire ships in week one.

Give them one shippable task in the first week. Something small and real,
that a user will actually see. A copy fix counts. A config change counts.

Everything else can wait. The tools matter far less than the owner does.
Pick anything and be consistent about it across every hire you make.

**Why it works.** A shipped task in week one proves the new hire belongs here. It proves your
systems work end to end. It gives the owner something concrete to react to.

It also surfaces broken onboarding fast. If a new hire cannot ship a one-line
change in five days, that is a finding about your environment, not about them.

Teams that do this see faster ramp times and far less quiet disengagement.
The effect shows up inside the first month, and it compounds from there.

Quick tip: write the first task before the offer is signed.

Reply and tell me how your last hire started.

Until next week,
The Koya team`,
};

describe('primitives', () => {
  it('counts emoji by code point, not UTF-16 unit', () => {
    expect(countEmoji('nice 🎉 work 🚀')).toBe(2);
    expect(countEmoji('no emoji here')).toBe(0);
  });

  it('counts hashtags in text', () => {
    expect(countHashtags('one #a and #b here')).toBe(2);
    expect(countHashtags('a url#fragment is not a hashtag')).toBe(0);
  });
});

describe('LinkedIn rules', () => {
  it('passes a well-formed PAS post', () => {
    expect(checkLinkedIn(linkedin).pass).toBe(true);
  });

  it('fails when the PAS structure is incomplete', () => {
    const r = checkLinkedIn({ ...linkedin, agitation: '' });
    expect(r.pass).toBe(false);
    expect(failureSummary(r)).toContain('PAS');
  });

  it('fails without a call to action', () => {
    expect(checkLinkedIn({ ...linkedin, cta: '' }).pass).toBe(false);
  });

  it('fails on emoji spam', () => {
    const r = checkLinkedIn({ ...linkedin, body: `${linkedin.body} 🎉🚀🔥💡✨🎯` });
    expect(r.checks.find((c) => c.key === 'emoji_restraint')?.pass).toBe(false);
  });
});

describe('X rules', () => {
  it('passes a well-formed post', () => {
    expect(checkX(xpost).pass).toBe(true);
  });

  it('fails on three hashtags', () => {
    const r = checkX({ ...xpost, hashtags: ['#a', '#b', '#c'] });
    expect(r.checks.find((c) => c.key === 'hashtag_cap')?.pass).toBe(false);
  });

  it('counts hashtags written into the body even when none are declared', () => {
    const r = checkX({
      ...xpost,
      hashtags: [],
      body: 'A hook line.\n\n#one #two #three',
    });
    expect(r.checks.find((c) => c.key === 'hashtag_cap')?.pass).toBe(false);
  });

  it('fails when the post exceeds 280 characters', () => {
    const r = checkX({ ...xpost, body: 'x'.repeat(281) });
    expect(r.checks.find((c) => c.key === 'fits_the_platform')?.pass).toBe(false);
  });
});

describe('Newsletter rules', () => {
  it('passes a well-formed newsletter', () => {
    const r = checkNewsletter(newsletter);
    expect(r.pass).toBe(true);
    expect(r.word_count).toBeGreaterThanOrEqual(250);
    expect(r.word_count).toBeLessThanOrEqual(600);
  });

  it('fails below 250 words', () => {
    const r = checkNewsletter({ ...newsletter, body_md: 'Too short.' });
    expect(r.checks.find((c) => c.key === 'word_band')?.pass).toBe(false);
  });

  it('fails above 600 words', () => {
    const r = checkNewsletter({
      ...newsletter,
      body_md: `${newsletter.body_md}\n\n${Array(500).fill('padding').join(' ')}`,
    });
    expect(r.checks.find((c) => c.key === 'word_band')?.pass).toBe(false);
  });

  it('fails a four-sentence intro', () => {
    const r = checkNewsletter({ ...newsletter, intro: 'One. Two. Three. Four.' });
    expect(r.checks.find((c) => c.key === 'intro_length')?.pass).toBe(false);
  });

  it('requires a subject line and a sign-off', () => {
    expect(checkNewsletter({ ...newsletter, subject: '' }).pass).toBe(false);
    expect(checkNewsletter({ ...newsletter, sign_off: '' }).pass).toBe(false);
  });

  it('treats the secondary item as genuinely optional', () => {
    const r = checkNewsletter({ ...newsletter, secondary_item_md: null });
    expect(r.pass).toBe(true);
  });
});

describe('retry instructions', () => {
  /**
   * Every X asset this pipeline has ever failed, failed on the character
   * count — nine attempts, seven failures, 286 to 490 characters, and
   * nothing else on the checklist ever missed. Restating the measurement
   * back to a model that just proved it cannot count is not feedback; the
   * arithmetic has to be done for it.
   */
  it('tells an over-long X post exactly how much to cut, with headroom', () => {
    const body = 'x'.repeat(384);
    const report = checkX({ ...xpost, body });
    const text = failureInstructions('x', report, body);

    expect(text).toContain('384 characters');
    expect(text).toContain('104 too many'); // 384 - 280
    // Asks for more than the strict overshoot, so a near-miss retry still lands.
    expect(text).toMatch(/[Cc]ut at least 124/);
    expect(text).toContain('180');
  });

  it('tells a short newsletter to add words and a long one to cut them', () => {
    const short = checkNewsletter({ ...newsletter, body_md: 'Too short.' });
    expect(failureInstructions('newsletter', short, '')).toMatch(/add at least \d+ more/);

    const long = checkNewsletter({
      ...newsletter,
      body_md: `${newsletter.body_md}\n\n${Array(500).fill('padding').join(' ')}`,
    });
    expect(failureInstructions('newsletter', long, '')).toMatch(/cut at least \d+/);
  });

  it('says nothing when nothing failed', () => {
    expect(failureInstructions('x', checkX(xpost), xpost.body)).toBe('');
    expect(failureInstructions('linkedin', checkLinkedIn(linkedin), linkedin.body)).toBe('');
  });

  it('names the hashtag cap plainly', () => {
    const post = { ...xpost, hashtags: ['#a', '#b', '#c'] };
    const text = failureInstructions('x', checkX(post), post.body);
    expect(text).toMatch(/hashtag/i);
  });
});

/**
 * A newsletter is a letter, not an article. `## The Reality Check` renders at
 * the size of the subject line inside the mail, and arrives as literal hashes
 * in a plain-text client — so the rule is enforced here rather than only asked
 * for in the prompt.
 */
describe('checkNewsletter — bold lead-ins, not headings', () => {
  const base = {
    subject: 'A clear subject',
    intro: 'One sentence of intro.',
    cta: 'Reply and tell us.',
    sign_off: 'Stay well,',
    body_md: 'word '.repeat(300),
  };
  const checkOf = (main: string) =>
    checkNewsletter({ ...base, main_section_md: main } as never).checks;
  const named = (main: string, key: string) => checkOf(main).find((c) => c.key === key)!;

  it('passes a main section built from bold lead-ins', () => {
    const main = '**The reality check.** Nigeria built one wind farm and it closed.';
    expect(named(main, 'no_headings').pass).toBe(true);
    expect(named(main, 'skimmable_main').pass).toBe(true);
  });

  it('passes a main section built from bullets', () => {
    const main = '- Location matters\n- Pairing beats standalone';
    expect(named(main, 'no_headings').pass).toBe(true);
    expect(named(main, 'skimmable_main').pass).toBe(true);
  });

  it('fails a markdown heading, at every level', () => {
    for (const main of ['# Big', '## The Reality Check', '### Smaller']) {
      expect(named(main, 'no_headings').pass, main).toBe(false);
    }
  });

  it('names the offending headings so they can be found', () => {
    expect(named('## The Reality Check\n\ncopy', 'no_headings').detail).toContain('The Reality Check');
  });

  it('no longer counts a heading alone as skimmable', () => {
    // It used to: headings satisfied the skimmable check, which is exactly
    // how the newsletter ended up full of them.
    expect(named('## Only a heading here', 'skimmable_main').pass).toBe(false);
  });

  it('does not mistake a hash inside a line for a heading', () => {
    const main = '**Cost.** Turbines run $200 to $13,000 — see issue #4 for the breakdown.';
    expect(named(main, 'no_headings').pass).toBe(true);
  });

  it('tells the retry what substitution to make', () => {
    const report = checkNewsletter({ ...base, main_section_md: '## The Reality Check' } as never);
    const instruction = failureInstructions('newsletter', report, base.body_md);
    expect(instruction).toContain('bold lead-in');
    expect(instruction).toContain('**The reality check.**');
  });
});
