import type { Channel } from './schemas';

/**
 * Ready-made content requests, offered on the intake form as one-click fills.
 *
 * These exist because a blank "what's your idea?" box is a bad demo and a
 * worse test. You need a topic you can judge the output on — if you don't
 * know whether an article about supply-chain telemetry is any good, it tells
 * you nothing about whether the pipeline works. Every one of these is
 * something a person who writes for a living has actually felt, so the
 * output is immediately judgeable: you'll know within two sentences whether
 * it rings true.
 *
 * They also deliberately cover the different SHAPES the brief calls for,
 * not just different subjects:
 *
 *   · idea only, no source          — the "Raw Idea Request" test scenario
 *   · idea with a source URL        — the "URL-Based Request" test scenario
 *   · a deliberately thin idea      — exercises the pre-flight audit
 *   · a narrow, well-specified idea — the easiest path to a clean run
 */
export interface Sample {
  id: string;
  label: string;
  /** Why you'd pick this one — shown under the label. */
  note: string;
  raw_idea: string;
  target_audience: string;
  source_url?: string;
  supporting_notes?: string;
  primary_keyword?: string;
  desired_tone?: string;
  option_count: number;
  channels_wanted: Channel[];
  /** Roughly how long a real run takes, so nobody sits watching a spinner. */
  expect: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'consistency',
    label: 'The weeks you have nothing to say',
    note: 'Idea only, no source. The everyday version of the brief\'s "Raw Idea Request".',
    raw_idea:
      'Everyone says "just be consistent" about posting, but nobody explains what to do on the ' +
      'weeks you genuinely have nothing worth saying. Most advice assumes you always have a take.',
    target_audience: 'Founders and marketers who write their own content',
    supporting_notes:
      'Should be honest about the weeks when there is genuinely nothing, rather than pretending ' +
      'every week contains a lesson.',
    desired_tone: 'Direct, warm, no hustle-culture cheerleading',
    option_count: 2,
    channels_wanted: ['linkedin', 'x', 'newsletter'],
    expect: '~10-15 min · 2 options',
  },
  {
    id: 'first-line',
    label: 'Why posts lose the reader in line one',
    note: 'Meta and easy to judge: you already know whether the advice is right.',
    raw_idea:
      'Most LinkedIn posts lose the reader in the first line, and most writers never find out ' +
      'why — the analytics just show a post that "didn\'t do well".',
    target_audience: 'Marketing and content leads at small B2B companies',
    supporting_notes:
      'We write and ship content for clients every week — this should read like something we ' +
      'learned the hard way, not a generic listicle.',
    desired_tone: 'Direct, a little wry, no corporate voice',
    option_count: 2,
    channels_wanted: ['linkedin', 'x', 'newsletter'],
    expect: '~10-15 min · 2 options',
  },
  {
    id: 'ai-drafts',
    label: 'Editing AI drafts takes longer than writing',
    note: 'A grounded-claims stress test — lots of tempting statistics to invent.',
    raw_idea:
      'Teams adopted AI writing tools expecting to save time, and a lot of them quietly found ' +
      'that editing the draft takes longer than writing from scratch would have. Nobody wants ' +
      'to say so out loud.',
    target_audience: 'Content teams who have adopted AI writing tools in the last year',
    supporting_notes:
      'Be even-handed. The answer is probably not "AI bad" — it is more likely about what you ' +
      'ask it for and where the editing time actually goes.',
    desired_tone: 'Measured and specific, not a hot take',
    option_count: 3,
    channels_wanted: ['linkedin', 'x', 'newsletter'],
    expect: '~15-20 min · 3 options',
  },
  {
    id: 'with-source',
    label: 'Anchored to a source you provide',
    note: 'Paste any article URL. Exercises the brief\'s "URL-Based Request" path.',
    raw_idea:
      'Take the argument in this source and turn it into something our audience can act on ' +
      'this week, rather than just agree with.',
    target_audience: 'Marketing and content leads at small B2B companies',
    source_url: 'https://example.com/replace-me-with-a-real-article',
    supporting_notes:
      'Replace the source URL with a real article before running. The agent will research ' +
      'around it as well, but this one is the anchor.',
    desired_tone: 'Practical, plain language',
    option_count: 2,
    channels_wanted: ['linkedin', 'x', 'newsletter'],
    expect: '~10-15 min · 2 options',
  },
  {
    id: 'thin',
    label: 'A deliberately thin idea',
    note: 'Should come back "thin" or blocked from the pre-flight audit — that is the point.',
    raw_idea: 'something about marketing',
    target_audience: 'people',
    option_count: 1,
    channels_wanted: ['linkedin'],
    expect: 'seconds · stops at the audit',
  },
];

export function findSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}
