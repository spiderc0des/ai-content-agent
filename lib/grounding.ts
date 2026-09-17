/**
 * The rule that makes source grounding structural rather than asserted.
 *
 * The generator emits its own claims, each pointing at the excerpt ids it
 * rests on. That is useful — a model asked to enumerate and cite its claims
 * writes more carefully — but it is not self-certifying: a model can mark a
 * claim "grounded" while citing an excerpt that was dropped in selection, or
 * one that belongs to a different request, or an id it made up.
 *
 * So every citation is resolved against the excerpts that were actually
 * SELECTED for this request, and a "grounded" claim left with nothing behind
 * it is downgraded to "unsupported". The evaluator then sees an honest claims
 * list, and the UI cannot show a green "grounded" badge over a citation that
 * does not exist.
 *
 * Pure — no database, no 'server-only' — so this is directly testable.
 */

export interface RawClaim {
  claim_text: string;
  section_key: string;
  support: string;
  excerpt_ids: string[];
}

export interface GroundedClaim extends RawClaim {
  support: 'grounded' | 'unsupported' | 'common_knowledge';
}

export function groundClaims(claims: RawClaim[], selectedExcerptIds: string[]): GroundedClaim[] {
  const selected = new Set(selectedExcerptIds);

  return claims.map((c) => {
    const resolved = c.excerpt_ids.filter((id) => selected.has(id));
    const claimed = c.support;

    // "common_knowledge" is a claim the writer says needs no source, so an
    // empty citation list is correct there and must not be rewritten into
    // "unsupported" — that would flood the reviewer with false findings.
    const support: GroundedClaim['support'] =
      claimed === 'grounded' && resolved.length === 0
        ? 'unsupported'
        : claimed === 'grounded' || claimed === 'unsupported' || claimed === 'common_knowledge'
          ? claimed
          : 'unsupported'; // an unrecognised value is not a licence to trust it

    return { ...c, excerpt_ids: resolved, support };
  });
}

/** How many claims actually rest on reviewed source material. */
export function groundingSummary(claims: GroundedClaim[]) {
  return {
    total: claims.length,
    grounded: claims.filter((c) => c.support === 'grounded').length,
    unsupported: claims.filter((c) => c.support === 'unsupported').length,
    common_knowledge: claims.filter((c) => c.support === 'common_knowledge').length,
  };
}
