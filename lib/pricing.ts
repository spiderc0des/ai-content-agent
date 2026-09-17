/**
 * What a run actually cost.
 *
 * Pure — no database, no 'server-only' — so the arithmetic is testable. It is
 * worth testing: the four token counts are priced at four different rates, and
 * getting cache reads wrong by a factor of ten is invisible in a total.
 *
 * Rates are USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing
 * as of September 2026. They are transcribed here rather than fetched: a
 * dashboard that silently changes historical figures when a price changes is
 * worse than one that is a month out of date and says so.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelRates {
  /** Base input, per million tokens. */
  input: number;
  output: number;
  /** 5-minute cache write — 1.25x base input. This app uses ephemeral caching. */
  cacheWrite: number;
  /** Cache hit — 0.1x base input. */
  cacheRead: number;
}

const RATES: Record<string, ModelRates> = {
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
};

/** The model this app actually uses, and what an unknown model falls back to. */
const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * The API returns a dated id — `claude-sonnet-5-20260115` — and the fallback
 * beta can substitute a different model entirely. Match on the longest known
 * prefix so a dated variant prices correctly and an unfamiliar one is obvious
 * rather than silently free.
 */
export function ratesFor(model: string | null): { rates: ModelRates; known: boolean } {
  if (!model) return { rates: RATES[DEFAULT_MODEL]!, known: false };
  const key = Object.keys(RATES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key
    ? { rates: RATES[key]!, known: true }
    : { rates: RATES[DEFAULT_MODEL]!, known: false };
}

/** USD for one call's usage. */
export function costOf(model: string | null, usage: TokenUsage): number {
  const { rates } = ratesFor(model);
  return (
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheWriteTokens * rates.cacheWrite +
      usage.cacheReadTokens * rates.cacheRead) /
    1_000_000
  );
}

/**
 * Money, at a precision that matches the number.
 *
 * A pipeline stage costs fractions of a cent and a month of them costs
 * dollars. Fixing on two decimals turns every individual stage into "$0.00",
 * which reads as free — and the whole point of the page is that it is not.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

/** `1.2M`, `84.1k`, `912` — a token count you can read at a glance. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * What prompt caching saved, against the counterfactual of not using it.
 *
 * Those tokens would have been billed at the full input rate on every call
 * that reused them; instead the cache write was paid once at 1.25x and each
 * read at 0.1x. Reported because it is the one number that justifies the
 * complexity of cache_control being in the codebase at all.
 */
export function cacheSavings(model: string | null, usage: TokenUsage): number {
  const { rates } = ratesFor(model);
  const withoutCache = (usage.cacheReadTokens + usage.cacheWriteTokens) * rates.input;
  const withCache =
    usage.cacheReadTokens * rates.cacheRead + usage.cacheWriteTokens * rates.cacheWrite;
  return Math.max(0, (withoutCache - withCache) / 1_000_000);
}
