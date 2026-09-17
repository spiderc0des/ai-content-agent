/**
 * Telling a real page from what a fetcher gets instead of one.
 *
 * Pure — no database, no 'server-only' — so it is directly testable.
 *
 * A surprising share of what comes back from fetching a URL is not the page:
 * it is a bot challenge, a cookie wall, a login interstitial, or an error
 * page served with the wrong status. These have text, so every naive "did we
 * get text?" check passes them, and they then cost a Claude call each to
 * digest into nothing.
 *
 * This was found in a real run: two "Checking your browser - reCAPTCHA"
 * pages from pmc.ncbi.nlm.nih.gov were stored as sources and sent to the
 * digest stage. The digest prompt caught them ("Nothing in this source is
 * relevant to the content request") and they produced zero excerpts, so the
 * evidence base was never actually polluted — but they still cost two calls
 * to establish that, and they sat in the sources list looking like real
 * material a reader might think the article rested on.
 */

export type SourceVerdict =
  | { usable: true }
  | { usable: false; reason: string };

/**
 * Phrases that only appear on interstitials. Deliberately specific: a real
 * article about web security could easily contain the word "captcha", so
 * matching on that alone would throw away good sources. These are the
 * boilerplate strings the challenge pages themselves use.
 */
const INTERSTITIAL_MARKERS: { pattern: RegExp; reason: string }[] = [
  { pattern: /checking your browser before accessing/i, reason: 'a bot-check interstitial' },
  { pattern: /\brecaptcha\/challengepage\b/i, reason: 'a reCAPTCHA challenge page' },
  { pattern: /enable javascript and cookies to continue/i, reason: 'a JavaScript/cookie wall' },
  { pattern: /verify you are (a )?human/i, reason: 'a human-verification page' },
  { pattern: /attention required!?\s*\|\s*cloudflare/i, reason: 'a Cloudflare block page' },
  { pattern: /ddos protection by cloudflare/i, reason: 'a Cloudflare interstitial' },
  { pattern: /access denied|403 forbidden|error 1020/i, reason: 'an access-denied page' },
  { pattern: /you (do not|don't) have permission to access/i, reason: 'an access-denied page' },
  { pattern: /please (sign in|log in) to continue/i, reason: 'a login wall' },
  { pattern: /subscribe to (continue reading|read the full)/i, reason: 'a paywall' },
  { pattern: /are you a robot\b/i, reason: 'a bot-check interstitial' },
  // The WALL, not the banner. "We use cookies…" sits on top of plenty of
  // perfectly readable articles and would throw them away; "accept cookies
  // to continue" is the page that exists instead of the article.
  { pattern: /(please )?accept cookies to continue/i, reason: 'a cookie-consent wall' },
];

/**
 * Below this, there is not enough text to quote from even if it is genuine.
 * Set low on purpose — the cost of wrongly discarding a real source is worse
 * than the cost of one wasted digest call.
 */
const MIN_USABLE_CHARS = 500;

export function assessSource(input: { title?: string | null; text: string | null }): SourceVerdict {
  const text = input.text?.trim() ?? '';
  if (!text) return { usable: false, reason: 'no text was fetched' };

  // Only the opening matters for an interstitial: a challenge page is
  // ENTIRELY boilerplate, whereas a real article that happens to discuss
  // CAPTCHAs would mention them well past its own first screenful.
  const opening = `${input.title ?? ''}\n${text.slice(0, 1500)}`;
  for (const { pattern, reason } of INTERSTITIAL_MARKERS) {
    if (pattern.test(opening)) return { usable: false, reason };
  }

  if (text.length < MIN_USABLE_CHARS) {
    return { usable: false, reason: `only ${text.length} characters — too little to quote from` };
  }

  return { usable: true };
}
