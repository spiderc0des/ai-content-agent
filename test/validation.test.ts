import { describe, it, expect } from 'vitest';
import {
  requiredText,
  optionalHttpUrl,
  httpUrl,
  futureDate,
  pastDate,
  optionalFutureDate,
  dateTimeLocalBounds,
  email, tagHandles, firstIssue } from '../lib/validation';
import { IntakeSchema, QueuePublicationSchema } from '../lib/schemas';

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('text fields', () => {
  it('trims and requires', () => {
    expect(requiredText('The idea').safeParse('   ').success).toBe(false);
    expect(requiredText('The idea').parse('  hello  ')).toBe('hello');
  });

  it('names the field in its message rather than saying "invalid"', () => {
    const r = requiredText('The target audience', 3).safeParse('a');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain('The target audience');
  });

  it('bounds length', () => {
    expect(requiredText('X', 1, 5).safeParse('abcdef').success).toBe(false);
  });
});

describe('urls', () => {
  it('accepts ordinary http(s) urls', () => {
    expect(httpUrl().safeParse('https://example.com/a?b=c').success).toBe(true);
  });

  /** A link field that later renders as an anchor is an XSS sink. */
  it('refuses non-http schemes', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
    ]) {
      expect(httpUrl().safeParse(bad).success, bad).toBe(false);
    }
  });

  it('refuses local and private addresses', () => {
    for (const bad of [
      'http://localhost:3000/admin',
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/',
    ]) {
      expect(httpUrl().safeParse(bad).success, bad).toBe(false);
    }
  });

  it('treats an empty optional url as null, not as an error', () => {
    expect(optionalHttpUrl().parse('')).toBeNull();
    expect(optionalHttpUrl().parse(undefined)).toBeNull();
  });
});

describe('dates are directional', () => {
  it('a future field accepts tomorrow and refuses yesterday', () => {
    expect(futureDate('The deadline').safeParse(iso(DAY)).success).toBe(true);
    expect(futureDate('The deadline').safeParse(iso(-DAY)).success).toBe(false);
  });

  it('a future field explains itself', () => {
    const r = futureDate('The deadline').safeParse(iso(-DAY));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/has to be in the future/);
  });

  it('a past field accepts yesterday and refuses tomorrow', () => {
    expect(pastDate('The publication date').safeParse(iso(-DAY)).success).toBe(true);
    expect(pastDate('The publication date').safeParse(iso(DAY)).success).toBe(false);
  });

  /** A typo'd year is the realistic failure, not a malicious one. */
  it('catches a far-future typo', () => {
    const in100Years = new Date();
    in100Years.setFullYear(in100Years.getFullYear() + 100);
    const r = futureDate('The publish time').safeParse(in100Years.toISOString());
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/check the year/);
  });

  it('tolerates "now" across the round trip rather than rejecting it', () => {
    expect(futureDate('The deadline').safeParse(iso(-2000)).success).toBe(true);
  });

  it('an optional future date accepts empty', () => {
    expect(optionalFutureDate('The deadline').parse('')).toBeNull();
    expect(optionalFutureDate('The deadline').parse(null)).toBeNull();
  });
});

describe('the browser bounds match the server rules', () => {
  it('a future field offers now as the earliest selectable moment', () => {
    const { min, max } = dateTimeLocalBounds('future', 2);
    expect(new Date(min).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(new Date(max).getTime()).toBeGreaterThan(Date.now());
    // The format datetime-local actually requires — no seconds, no zone.
    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('a past field offers now as the latest selectable moment', () => {
    const { min, max } = dateTimeLocalBounds('past', 2);
    expect(new Date(max).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(new Date(min).getTime()).toBeLessThan(Date.now());
  });
});

describe('the intake form', () => {
  const valid = {
    raw_idea: 'Why most teams get onboarding wrong in the first week',
    target_audience: 'Heads of talent',
  };

  it('accepts a minimal valid request', () => {
    expect(IntakeSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a deadline that has already passed', () => {
    const r = IntakeSchema.safeParse({ ...valid, deadline_at: iso(-DAY) });
    expect(r.success).toBe(false);
  });

  it('accepts a deadline in the future', () => {
    expect(IntakeSchema.safeParse({ ...valid, deadline_at: iso(7 * DAY) }).success).toBe(true);
  });

  it('refuses an unreachable source url', () => {
    expect(IntakeSchema.safeParse({ ...valid, source_url: 'javascript:alert(1)' }).success).toBe(
      false,
    );
  });

  it('bounds the word count to something writable', () => {
    expect(IntakeSchema.safeParse({ ...valid, word_count_target: 10 }).success).toBe(false);
    expect(IntakeSchema.safeParse({ ...valid, word_count_target: 99999 }).success).toBe(false);
    expect(IntakeSchema.safeParse({ ...valid, word_count_target: 900 }).success).toBe(true);
  });

  it('requires at least one channel', () => {
    expect(IntakeSchema.safeParse({ ...valid, channels_wanted: [] }).success).toBe(false);
  });

  it('drops empty secondary keywords rather than storing blanks', () => {
    const r = IntakeSchema.parse({ ...valid, secondary_keywords: ['a', '', '  ', 'b'] });
    expect(r.secondary_keywords).toEqual(['a', 'b']);
  });
});

describe('scheduling a publish', () => {
  const base = { channels: ['linkedin' as const], expected_version: 1 };

  it('allows no schedule — that means the next worker tick', () => {
    expect(QueuePublicationSchema.parse({ ...base, scheduled_for: null }).scheduled_for).toBeNull();
    expect(QueuePublicationSchema.parse({ ...base, scheduled_for: '' }).scheduled_for).toBeNull();
  });

  it('allows a future time', () => {
    expect(QueuePublicationSchema.safeParse({ ...base, scheduled_for: iso(DAY) }).success).toBe(
      true,
    );
  });

  /**
   * The bug this prevents: a past "schedule" is not a schedule. The worker
   * looks for rows whose time has come, so anything backdated goes out on the
   * very next tick — immediately, with no warning, which is the one outcome
   * someone setting a schedule is trying to avoid.
   */
  it('refuses a time that has already passed', () => {
    expect(QueuePublicationSchema.safeParse({ ...base, scheduled_for: iso(-DAY) }).success).toBe(
      false,
    );
  });

  it('requires at least one channel', () => {
    expect(QueuePublicationSchema.safeParse({ ...base, channels: [] }).success).toBe(false);
  });
});

describe('email', () => {
  it('lowercases and trims', () => {
    expect(email().parse('  Person@Example.COM ')).toBe('person@example.com');
  });
  it('refuses nonsense', () => {
    expect(email().safeParse('not-an-email').success).toBe(false);
  });
});

/**
 * Tagging the wrong account, or nobody, is a post that has to be deleted and
 * redone — so a handle that is silently wrong is worse than a rejected one.
 * The two platforms have genuinely different rules, and one regex for both
 * would have to be the loose one.
 */
describe('tagHandles', () => {
  const parse = (channel: 'x' | 'linkedin', input: string) => tagHandles(channel).safeParse(input);
  const ok = (channel: 'x' | 'linkedin', input: string) => {
    const r = parse(channel, input);
    if (!r.success) throw new Error(firstIssue(r.error));
    return r.data;
  };

  it('normalises every accepted form to a leading @', () => {
    expect(ok('x', 'koyatalent')).toEqual(['@koyatalent']);
    expect(ok('x', '@koyatalent')).toEqual(['@koyatalent']);
    expect(ok('x', 'https://x.com/koyatalent')).toEqual(['@koyatalent']);
    expect(ok('x', 'https://twitter.com/koyatalent')).toEqual(['@koyatalent']);
  });

  it('reads a LinkedIn profile or company URL', () => {
    expect(ok('linkedin', 'https://www.linkedin.com/in/ada-lovelace-123')).toEqual(['@ada-lovelace-123']);
    expect(ok('linkedin', 'https://linkedin.com/company/koya-talent/')).toEqual(['@koya-talent']);
  });

  it('splits on commas, spaces and newlines, because people paste all three', () => {
    expect(ok('x', '@a, @b @c\n@d')).toEqual(['@a', '@b', '@c', '@d']);
  });

  it('drops a repeated handle rather than erroring on it', () => {
    expect(ok('x', '@koyatalent, koyatalent, @KoyaTalent')).toEqual(['@koyatalent', '@KoyaTalent']);
  });

  it('enforces the X length limit, which is a real platform rule', () => {
    expect(ok('x', 'a'.repeat(15))).toEqual([`@${'a'.repeat(15)}`]);
    expect(parse('x', 'a'.repeat(16)).success).toBe(false);
  });

  it('rejects characters the platform does not allow in a handle', () => {
    expect(parse('x', '@bad!handle').success).toBe(false);
    expect(parse('x', '@has-a-hyphen').success).toBe(false); // legal on LinkedIn, not on X
    expect(ok('linkedin', 'has-a-hyphen')).toEqual(['@has-a-hyphen']);
  });

  it('splits X handles on spaces, because that is how people type them', () => {
    expect(ok('x', '@ada @grace')).toEqual(['@ada', '@grace']);
  });

  it('does NOT split a LinkedIn entry on spaces — a pasted name must fail, not become two tags', () => {
    // The thing people reach for on LinkedIn is the person's name. Splitting
    // it would turn one wrong input into two plausible-looking mentions of
    // accounts belonging to somebody else.
    const r = parse('linkedin', 'Ada Lovelace');
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toContain('Ada Lovelace');
    // The slug form still works, and commas still separate.
    expect(ok('linkedin', 'ada-lovelace, koya-talent')).toEqual(['@ada-lovelace', '@koya-talent']);
  });

  it('rejects a LinkedIn slug too short to be one', () => {
    expect(parse('linkedin', '@ab').success).toBe(false);
  });

  it('names the offending handle, so it can be fixed rather than hunted for', () => {
    const r = parse('x', '@good, @way!too!wrong');
    expect(r.success).toBe(false);
    if (!r.success) expect(firstIssue(r.error)).toContain('way!too!wrong');
  });

  it('caps the number of accounts, so a paste accident is not a send', () => {
    expect(parse('x', Array.from({ length: 10 }, (_, i) => `@a${i}`).join(',')).success).toBe(true);
    expect(parse('x', Array.from({ length: 11 }, (_, i) => `@a${i}`).join(',')).success).toBe(false);
  });

  it('treats empty and missing as "tag nobody", not as an error', () => {
    expect(ok('x', '')).toEqual([]);
    expect(ok('x', '   ')).toEqual([]);
    expect(tagHandles('x').safeParse(undefined).success).toBe(true);
  });
});
