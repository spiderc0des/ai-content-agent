import { describe, it, expect } from 'vitest';
import { assessSource } from '../lib/source-quality';

/** A plausible article body — long enough to be quotable. */
const realArticle = (topic: string) =>
  `${topic} has been studied extensively over the past decade. ` +
  'Researchers found that deployment costs fell by roughly forty per cent between 2015 and 2023, ' +
  'driven mainly by cheaper components and better siting data. '.repeat(8);

describe('assessSource', () => {
  it('accepts a real article', () => {
    expect(assessSource({ title: 'Wind Energy in Nigeria', text: realArticle('Wind energy') })).toEqual({
      usable: true,
    });
  });

  it('rejects nothing at all', () => {
    expect(assessSource({ title: 'A paper', text: null })).toMatchObject({ usable: false });
    expect(assessSource({ title: 'A paper', text: '   ' })).toMatchObject({ usable: false });
  });

  /**
   * The case this file was written for. Two of these were stored as sources
   * in a real run and sent to the digest stage, which correctly found nothing
   * in them — but only after spending a Claude call each to establish it.
   */
  it('rejects a reCAPTCHA interstitial', () => {
    const verdict = assessSource({
      title: 'Checking your browser - reCAPTCHA',
      text:
        'base: https://www.google.com/recaptcha/challengepage/\n' +
        'title: Checking your browser - reCAPTCHA\n\n' +
        'Checking your browser before accessing pmc.ncbi.nlm.nih.gov ...',
    });
    expect(verdict.usable).toBe(false);
    if (!verdict.usable) expect(verdict.reason).toMatch(/interstitial|challenge/i);
  });

  it('rejects the other common interstitials', () => {
    const cases = [
      'Attention Required! | Cloudflare — please enable cookies.',
      'Please enable JavaScript and cookies to continue browsing this site.',
      'Verify you are human before continuing to the requested page.',
      'Access Denied. You do not have permission to access this resource on this server.',
      'Please sign in to continue reading this article from our archive.',
      'Subscribe to continue reading the rest of this investigation.',
    ];
    for (const text of cases) {
      expect(assessSource({ title: '', text: text.repeat(20) }).usable, text).toBe(false);
    }
  });

  it('rejects a page too short to quote from', () => {
    const verdict = assessSource({ title: 'Stub', text: 'Wind energy in Nigeria is growing.' });
    expect(verdict.usable).toBe(false);
    if (!verdict.usable) expect(verdict.reason).toMatch(/characters/);
  });

  /**
   * The failure mode a naive keyword filter would have: throwing away good
   * sources that merely discuss the thing the interstitials are made of.
   */
  it('does not reject a genuine article that happens to discuss CAPTCHAs', () => {
    const text =
      'Bot detection on the modern web relies heavily on CAPTCHA challenges, and this paper ' +
      'evaluates how reCAPTCHA v3 scoring affects legitimate accessibility tooling. ' +
      'We measured false-positive rates across twelve assistive browsers. '.repeat(10);
    expect(assessSource({ title: 'Evaluating CAPTCHA accessibility', text }).usable).toBe(true);
  });

  it('does not reject an article that mentions paywalls in its argument', () => {
    const text =
      'The economics of news paywalls have shifted since 2020. Publishers who ask readers to ' +
      'subscribe report higher retention but lower reach, and the tradeoff is not uniform. '.repeat(10);
    expect(assessSource({ title: 'The economics of paywalls', text }).usable).toBe(true);
  });
});

/**
 * The hand-pasted source path (POST /api/requests/:id/sources) runs the same
 * gate as a fetched page. These cases are the ones that motivated it: a person
 * hits a research block, opens the source in their own browser, and copies
 * whatever is on screen. Sometimes what is on screen is the block itself.
 */
describe('assessSource on hand-pasted material', () => {
  it('rejects a consent wall someone pasted instead of the article', () => {
    const v = assessSource({
      title: 'Frontiers | AI-assisted writing revision',
      text:
        'We use cookies and similar technologies to give you the best experience. ' +
        'Please accept cookies to continue. '.repeat(30),
    });
    expect(v.usable).toBe(false);
  });

  it('rejects a bot-check page, which is exactly what blocked the fetcher', () => {
    const v = assessSource({
      title: 'Just a moment...',
      text: 'Verify you are human by completing the action below. '.repeat(40),
    });
    expect(v.usable).toBe(false);
  });

  it('rejects a snippet too short to quote from', () => {
    expect(assessSource({ title: 'A paper', text: 'AI editing takes longer.' }).usable).toBe(false);
  });

  it('accepts real article prose, which is the whole point of the escape hatch', () => {
    const v = assessSource({
      title: 'Writing With AI Demands More From Students',
      text:
        'Across two semesters we tracked 214 undergraduates revising essays with and without ' +
        'AI assistance. Students using AI produced first drafts 41 percent faster, but spent ' +
        '38 percent longer in revision, and the net time saved was statistically indistinguishable ' +
        'from zero. The effect was strongest among students who rated their own writing confidence ' +
        'highest before the study began. We argue that the revision burden, not the drafting ' +
        'burden, is where the real cost of AI-assisted writing now sits, and that assignment ' +
        'design has not caught up with that shift. '.repeat(2),
    });
    expect(v.usable).toBe(true);
  });
});

it('still accepts an article that merely carries a cookie banner above it', () => {
  const v = assessSource({
    title: 'How editors really spend their time',
    text:
      'We use cookies and similar technologies to improve your experience. Manage preferences. ' +
      'Editors at three mid-sized publishers logged their hours for six weeks. The pattern was ' +
      'consistent: drafting time fell sharply once AI tools entered the workflow, while the time ' +
      'spent reconciling a draft against house style rose by roughly the same amount. One managing ' +
      'editor described the change as "moving the work, not removing it", and the logs bear that out. '.repeat(2),
  });
  expect(v.usable).toBe(true);
});
