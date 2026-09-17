/**
 * Turning a digest into excerpt rows.
 *
 * Pure — no database, no 'server-only' — so the scenario harness can exercise
 * it directly. This is the step that decides what counts as evidence, so it is
 * worth pinning down with tests rather than reasoning about by eye.
 */

/**
 * Turn a digest into excerpt rows.
 *
 * The citations the API returns are authoritative — `cited_text` is text the
 * model actually read, with a character locator into the source. They are
 * used first. The markdown blockquotes in the digest are a fallback for the
 * case where citations came back empty, and carry the model's "why it
 * matters" line, which the citation objects do not.
 */
export function excerptsFrom(
  digestMd: string,
  citations: unknown[],
): { quote: string; gist: string; locator: unknown }[] {
  const gistByQuote = new Map<string, string>();
  const fallback: { quote: string; gist: string; locator: unknown }[] = [];

  // Blocks look like:  > "the quote"\n  Why it matters: the gist
  const lines = digestMd.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const quoteMatch = /^>\s*"?(.+?)"?\s*$/.exec(lines[i].trim());
    if (!quoteMatch) continue;
    const quote = quoteMatch[1].trim();
    if (quote.length < 20) continue;

    let gist = '';
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const g = /^(?:why it matters|why)\s*:\s*(.+)$/i.exec(lines[j].trim());
      if (g) {
        gist = g[1].trim();
        break;
      }
    }
    gistByQuote.set(normalise(quote), gist);
    fallback.push({ quote, gist, locator: {} });
  }

  const fromCitations: { quote: string; gist: string; locator: unknown }[] = [];
  const seen = new Set<string>();

  for (const c of citations as Array<Record<string, unknown>>) {
    const quote = typeof c?.cited_text === 'string' ? c.cited_text.trim() : '';
    if (quote.length < 20) continue;
    const key = normalise(quote);
    if (seen.has(key)) continue;
    seen.add(key);
    fromCitations.push({
      quote,
      gist: gistByQuote.get(key) ?? nearestGist(gistByQuote, key),
      locator: c,
    });
  }

  const chosen = fromCitations.length ? fromCitations : dedupe(fallback);
  // A ceiling, so one enormous source cannot crowd out every other source in
  // the selection prompt.
  return chosen.slice(0, 12);
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A citation's text often differs from the blockquote by a clause. */
function nearestGist(gists: Map<string, string>, key: string): string {
  for (const [q, gist] of gists) {
    if (q.includes(key) || key.includes(q)) return gist;
  }
  return '';
}

function dedupe(
  items: { quote: string; gist: string; locator: unknown }[],
): { quote: string; gist: string; locator: unknown }[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = normalise(i.quote);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** One selection decision, as the model returns it. */
export interface KeepDecision {
  excerpt_id: string;
  keep: boolean;
  relevance: number;
}

/**
 * The fewest excerpts worth trying to write from. Not a target — a floor that
 * applies only when the selection call kept literally nothing.
 */
export const MIN_EXCERPTS_KEPT = 3;

/**
 * Stop the selection stage from emptying the evidence base.
 *
 * The selection prompt pushes hard for a tight evidence base, and on a thin
 * corpus it follows that instruction all the way to zero — which is the
 * prompt fighting the situation rather than a real verdict. Excerpts exist,
 * so there IS something to write from; dropping the lot turns a narrow
 * article into no article.
 *
 * The floor is enforced here rather than asked for in the prompt, on the same
 * principle as the word and character counts: the model's RANKING is useful
 * even when its keep/drop threshold is miscalibrated, so its relevance scores
 * pick which ones survive, and code decides that some must.
 *
 * Returns the decisions unchanged when anything was already kept.
 */
export function applyKeepFloor<T extends KeepDecision>(
  decisions: T[],
  floor = MIN_EXCERPTS_KEPT,
): { decisions: T[]; floored: boolean } {
  if (decisions.length === 0 || decisions.some((d) => d.keep)) {
    return { decisions, floored: false };
  }
  const rescued = new Set(
    [...decisions]
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, Math.min(floor, decisions.length))
      .map((d) => d.excerpt_id),
  );
  return {
    decisions: decisions.map((d) => (rescued.has(d.excerpt_id) ? { ...d, keep: true } : d)),
    floored: true,
  };
}
