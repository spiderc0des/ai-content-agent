/**
 * How hard the research stage works.
 *
 * Pure — no database, no 'server-only' — so the profiles are testable and the
 * numbers live in one place instead of as five constants scattered across
 * three files.
 *
 * Research is the most expensive stage in the pipeline by a wide margin: in
 * real runs it has been over half the total spend, because web search results
 * arrive as input tokens and there are a great many of them. It also drives a
 * SECOND cost that is easy to miss — retrieval makes one Claude call per
 * readable source, so a setting that finds twice as many sources costs twice
 * as much twice over.
 *
 * Hence three profiles rather than one dial: the knobs only make sense moved
 * together.
 */

export type ResearchDepth = 'quick' | 'standard' | 'deep';

export const RESEARCH_DEPTHS: ResearchDepth[] = ['quick', 'standard', 'deep'];

export interface DepthProfile {
  /** web_search uses per research call. */
  maxSearches: number;
  /** web_fetch uses per research call. Higher than searches: publishers block. */
  maxFetches: number;
  /** Readable sources below which research goes back for more. */
  minReadable: number;
  /** Total research calls, including top-ups. */
  maxRounds: number;
  /** Sources kept — and therefore retrieval calls made. */
  maxSources: number;
  /** For the form. */
  label: string;
  hint: string;
}

const PROFILES: Record<ResearchDepth, DepthProfile> = {
  quick: {
    maxSearches: 4,
    maxFetches: 8,
    minReadable: 3,
    // One round. A top-up is a whole extra research call, which is the single
    // most expensive thing this pipeline can decide to do.
    maxRounds: 1,
    maxSources: 6,
    label: 'Quick',
    hint: 'One search pass, up to 6 sources. Cheapest and fastest; a narrower evidence base.',
  },
  standard: {
    maxSearches: 8,
    maxFetches: 16,
    minReadable: 7,
    maxRounds: 3,
    maxSources: 12,
    label: 'Standard',
    hint: 'Searches again if too few sources can be read. Up to 12 sources.',
  },
  deep: {
    maxSearches: 12,
    maxFetches: 24,
    minReadable: 10,
    maxRounds: 3,
    maxSources: 18,
    label: 'Deep',
    hint: 'Casts wider and keeps up to 18 sources. Noticeably slower and dearer.',
  },
};

export function depthProfile(depth: string | null | undefined): DepthProfile {
  return PROFILES[(depth ?? 'standard') as ResearchDepth] ?? PROFILES.standard;
}

/**
 * Roughly what a depth costs relative to standard, for the form to show.
 *
 * Deliberately a ratio, not a dollar figure: the real number depends on how
 * long the fetched pages are, and a made-up precise price is worse than an
 * honest "about half".
 */
export function relativeCost(depth: ResearchDepth): string {
  const base = PROFILES.standard;
  const p = PROFILES[depth];
  // Sources drive retrieval calls; searches drive the research call itself.
  const ratio = (p.maxSources / base.maxSources + p.maxSearches / base.maxSearches) / 2;
  if (ratio < 0.95) return `about ${Math.round(ratio * 100)}% of Standard`;
  if (ratio > 1.05) return `about ${Math.round(ratio * 100)}% of Standard`;
  return 'the default';
}
