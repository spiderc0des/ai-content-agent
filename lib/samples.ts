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
 * Three things every one of these is chosen for:
 *
 *   · EVERYDAY. Food going off, the phone in bed, the password you reuse.
 *     You do not need to work in marketing to know whether the article is
 *     any good, which is the whole point of a sample.
 *   · WELL-SOURCED. Each topic has plenty of openly readable material —
 *     government health and consumer sites, standards bodies, public
 *     research. Research stalls when every publisher blocks the fetcher, and
 *     a sample that stalls teaches nothing about the pipeline.
 *   · QUICK. Quick depth, one option. Research is the long pole and its
 *     cost scales with both, so a sample runs in roughly the time somebody
 *     will actually sit and watch.
 *
 * They also cover the SHAPES the brief calls for, not just subjects:
 *
 *   · idea only, no source          — the "Raw Idea Request" test scenario
 *   · idea with a real source URL   — the "URL-Based Request" test scenario
 *   · an idea with nothing to work  — exercises the pre-flight audit's block
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
  /**
   * How hard research should work for this sample.
   *
   * Carried on the sample rather than left at the form's default, because
   * "quick to run" is mostly this one field: research is the long pole, and
   * the depth sets both how much it searches and how much it writes.
   */
  research_depth: 'quick' | 'standard' | 'deep';
  channels_wanted: Channel[];
  /** Roughly how long a real run takes, so nobody sits watching a spinner. */
  expect: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'food-waste',
    label: 'The food you meant to cook',
    note: 'Anchored to a real source URL — the brief\'s "URL-Based Request" path.',
    raw_idea:
      'We shop with good intentions and then throw away the bag of salad, the herbs and half ' +
      'the loaf. It is less carelessness than a planning problem nobody ever taught us, and it ' +
      'quietly costs a household real money every month.',
    target_audience: 'People who cook for themselves or a family during a busy week',
    // A real, fetchable page. Government and public-health sites are the
    // reliable choice for a sample: they publish substantial text and they do
    // not block automated fetching, which is exactly what this stage needs.
    source_url: 'https://www.epa.gov/recycle/preventing-wasted-food-home',
    supporting_notes:
      'Practical and non-judgemental. Nobody needs another lecture about the planet — they ' +
      'need to know what actually stops the salad going off by Thursday.',
    primary_keyword: 'reduce food waste at home',
    desired_tone: 'Warm and practical, no guilt',
    option_count: 1,
    research_depth: 'quick',
    channels_wanted: ['linkedin', 'x', 'newsletter'],
    expect: '~8-12 min · 1 option · quick research',
  },
  {
    id: 'phone-in-bed',
    label: 'Putting the phone down at night',
    note: 'Idea only. Plenty of readable sleep research, so retrieval has real quotes to pull.',
    raw_idea:
      'Everyone knows scrolling in bed makes it harder to sleep, and almost everyone does it ' +
      'anyway. The advice is always "don\'t", which is not a plan — it is the goal restated.',
    target_audience: 'Anyone who reads their phone in bed and wishes they didn\'t',
    supporting_notes:
      'Go past "blue light is bad". What is actually keeping people awake, and what has been ' +
      'shown to help someone who is not going to give up their phone entirely?',
    primary_keyword: 'phone before bed sleep',
    desired_tone: 'Understanding, specific, not preachy',
    option_count: 1,
    research_depth: 'quick',
    channels_wanted: ['linkedin', 'x', 'newsletter'],
    expect: '~8-12 min · 1 option · quick research',
  },
  {
    id: 'one-password',
    label: 'The one password you use everywhere',
    note: 'Security guidance is published openly, so sources are easy to read and easy to quote.',
    raw_idea:
      'Most people have one password with a number on the end and use it across dozens of ' +
      'accounts. They already know it is a bad idea. Explaining the risk is the easy half; ' +
      'making the fix feel manageable on a Tuesday evening is the hard half.',
    target_audience: 'People who are not especially technical but bank and shop online',
    supporting_notes:
      'Avoid scaring people into doing nothing. The useful version tells someone which two or ' +
      'three accounts to fix first and why those ones matter most.',
    primary_keyword: 'reusing the same password',
    desired_tone: 'Calm and concrete, no fear-mongering',
    option_count: 1,
    research_depth: 'quick',
    channels_wanted: ['linkedin', 'newsletter'],
    expect: '~7-10 min · 1 option · quick research',
  },
  {
    id: 'subscriptions',
    label: 'Subscriptions you forgot you had',
    note: 'Consumer-finance topic with plenty of published data — a good grounding test.',
    raw_idea:
      'Small monthly charges for things you stopped using add up quietly in the background, ' +
      'and the effort of cancelling is kept just high enough that you keep not doing it.',
    target_audience: 'Anyone with a bank account and a few streaming apps',
    supporting_notes:
      'Be specific about how to find them, not just that you should. The interesting part is ' +
      'why cancelling is deliberately made awkward.',
    primary_keyword: 'cancel unused subscriptions',
    desired_tone: 'Plain, a little wry',
    option_count: 1,
    research_depth: 'quick',
    channels_wanted: ['linkedin', 'x', 'newsletter'],
    expect: '~7-10 min · 1 option · quick research',
  },
  {
    id: 'nothing-to-work-with',
    label: 'An idea with nothing to work with',
    note: 'Refused by the pre-flight audit in seconds, before anything expensive runs. That is the point.',
    raw_idea: 'write something good',
    target_audience: 'everyone',
    supporting_notes:
      'Nothing here says what the article is about or who it is for, and no amount of research ' +
      'would settle either. The audit should stop it and say what is missing rather than ' +
      'inventing a topic — a request nobody can work is a person\'s problem to fix, not a ' +
      'failure to retry.',
    option_count: 1,
    research_depth: 'quick',
    channels_wanted: ['linkedin'],
    expect: 'seconds · stops at the audit',
  },
];

export function findSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}
