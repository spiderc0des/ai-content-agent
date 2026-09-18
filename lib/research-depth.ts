/**
 * How hard the research stage works.
 *
 * Pure — no database, no 'server-only' — so the profiles are testable and the
 * numbers live in one place instead of as five constants scattered across
 * three files.
 *
 * Research is the most expensive stage in the pipeline by a wide margin, and
 * it is also by far the slowest. Those two facts have different causes, which
 * is why this file carries two groups of knobs:
 *
 *   COST is driven by how much is read. Web search results and fetched pages
 *   arrive as input tokens and there are a great many of them, and retrieval
 *   then makes one Claude call per readable source — so a setting that finds
 *   twice as many sources costs twice as much twice over.
 *
 *   WALL-CLOCK is driven by how much is WRITTEN. Measured over real runs, the
 *   research call returned 8,000–21,000 output tokens against 600–2,000 input
 *   tokens, and took 149–533 seconds. Generation is serial and roughly linear
 *   in output length; the tool budget barely touches it. A 'quick' run that
 *   searched four times instead of eight but still wrote a 20,000-token brief
 *   was not quick, which is exactly the complaint this file now answers.
 *
 * So the source knobs make a depth CHEAPER and the brief knobs make it
 * FASTER, and a profile has to move both or it only half works.
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
  /**
   * Roughly how long the research brief should be, in words.
   *
   * The single biggest lever on how long this stage takes. Left unsaid, the
   * model writes an exhaustive brief every time — the prompt asks for facts,
   * figures and quotations attributed to every URL, and it obliges at length.
   */
  briefWords: number;
  /**
   * Ceiling on the research call's output, including thinking.
   *
   * A backstop, not the control — briefWords is the control. Kept well above
   * what briefWords implies, because hitting this is a stage FAILURE (see
   * withRetry's max_tokens branch), not a graceful truncation.
   */
  maxOutputTokens: number;
  /**
   * Page text admitted to context per fetch, in tokens.
   *
   * Caps the input a single long page can contribute. Cuts cost directly, and
   * time indirectly: less material read is less material written about.
   */
  maxContentTokens: number;
  /**
   * Resumes allowed after the server's own tool loop pauses.
   *
   * Each resume re-sends the whole conversation — every search result and
   * every fetched page so far — so late resumes are the most expensive turns
   * in the call. Quick gets one; there is no point finding more if there is
   * no room left in the brief to say anything about it.
   */
  maxContinuations: number;
  /**
   * The most effort any stage in the pipeline may use at this depth.
   *
   * Depth is a whole-pipeline dial, not just a research setting. Quick caps
   * at medium, so planning, generation, evaluation and revision — the four
   * calls that would otherwise run high — come down with it. That is most of
   * what makes a quick run quick: those four are the longest stages and the
   * largest output lines in the bill.
   *
   * Standard and deep keep high where a call asks for it, so nothing about
   * the default behaviour changes.
   */
  maxEffort: 'medium' | 'high';
  /** For the form. */
  label: string;
  hint: string;
  /**
   * Roughly how long the research stage takes, for the form to set an
   * expectation before someone waits on it.
   *
   * A RANGE, deliberately wide, and about the research stage only — not the
   * whole pipeline. Anchored to measured runs (standard research took 149s to
   * 533s across real requests before briefWords existed) and scaled by the
   * brief bound, which is what actually moves it. Not a promise: a topic whose
   * sources all block the fetcher takes longer at every depth.
   */
  pace: string;
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
    briefWords: 400,
    maxOutputTokens: 8000,
    maxContentTokens: 4000,
    maxContinuations: 1,
    maxEffort: 'medium',
    label: 'Quick',
    pace: 'about 2–4 minutes',
    hint: 'One search pass, up to 6 sources, a short brief, and every stage capped at medium effort. Fastest and cheapest; a narrower evidence base.',
  },
  standard: {
    maxSearches: 8,
    maxFetches: 16,
    minReadable: 7,
    maxRounds: 3,
    maxSources: 12,
    briefWords: 900,
    maxOutputTokens: 16000,
    maxContentTokens: 8000,
    maxContinuations: 3,
    maxEffort: 'high',
    label: 'Standard',
    pace: 'about 4–8 minutes',
    hint: 'Searches again if too few sources can be read. Up to 12 sources.',
  },
  deep: {
    maxSearches: 12,
    maxFetches: 24,
    minReadable: 10,
    maxRounds: 3,
    maxSources: 18,
    briefWords: 1600,
    maxOutputTokens: 24000,
    maxContentTokens: 12000,
    maxContinuations: 4,
    maxEffort: 'high',
    label: 'Deep',
    pace: 'about 8–15 minutes',
    hint: 'Casts wider, keeps up to 18 sources, writes a fuller brief. Noticeably slower and dearer.',
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
