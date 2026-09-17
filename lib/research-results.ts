/**
 * Reading the server tools' own result blocks.
 *
 * Pure — no SDK client, no 'server-only' — so it is directly testable. That
 * matters more here than the file size suggests: this parser decides what the
 * evidence base contains, and an earlier version of it silently dropped every
 * fetched page's text, leaving the whole pipeline grounded on nothing.
 */
import type Anthropic from '@anthropic-ai/sdk';

/**
 * How many sources one request keeps. Web search returns roughly ten results
 * per query, so eight queries can produce fifty-odd URLs — far more than the
 * selection prompt can weigh, and most of them never read.
 */
export const MAX_SOURCES = 12;

export interface ResearchFinding {
  url: string;
  title: string;
  /** A page the model actually fetched, rather than only saw in results. */
  fetched: boolean;
  /**
   * The fetched page's text. Null for a URL that only appeared in search
   * results — there is nothing to read, so it can be attributed but not
   * quoted. This is what the retrieval stage digests into exact-quote
   * excerpts; without it a source cannot ground a single claim.
   */
  text: string | null;
}


/**
 * A web_fetch result wraps its page in a document block whose `source.data`
 * holds the text. Defensive about the shape: this is the one place a change in
 * the tool's response would silently empty the evidence base.
 */
export function documentTextOf(doc: Record<string, unknown> | undefined): string | null {
  if (!doc) return null;
  const source = doc.source as Record<string, unknown> | undefined;
  const data = source?.data;
  if (typeof data === 'string' && data.trim()) return data;
  // Some shapes put the text directly on the document block.
  if (typeof doc.text === 'string' && doc.text.trim()) return doc.text;
  return null;
}

/**
 * Pull the URLs out of the server tools' own result blocks rather than out of
 * the prose. A URL the model typed into its brief may be one it invented; a
 * URL in a web_search_tool_result is one the search engine actually returned.
 *
 * Server-tool errors arrive as HTTP 200 with an error OBJECT where the
 * success case has an ARRAY, so every access branches on that first.
 */
export function findingsOf(res: Anthropic.Beta.BetaMessage): ResearchFinding[] {
  const byUrl = new Map<string, ResearchFinding>();

  for (const block of res.content as unknown as Array<Record<string, unknown>>) {
    const type = block.type;

    if (type === 'web_search_tool_result') {
      const content = block.content;
      if (!Array.isArray(content)) continue; // an error object, not results
      for (const r of content as Array<Record<string, unknown>>) {
        const url = typeof r.url === 'string' ? r.url : null;
        if (!url) continue;
        if (!byUrl.has(url)) {
          byUrl.set(url, {
            url,
            title: typeof r.title === 'string' ? r.title : url,
            fetched: false,
            text: null,
          });
        }
      }
    }

    if (type === 'web_fetch_tool_result') {
      const content = block.content as Record<string, unknown> | undefined;
      if (!content || Array.isArray(content)) continue;
      const url = typeof content.url === 'string' ? content.url : null;
      if (!url) continue;
      const doc = content.content as Record<string, unknown> | undefined;
      const title = typeof doc?.title === 'string' ? doc.title : url;
      // The fetched page body. Keeping only the URL here was a real bug: the
      // retrieval stage digests raw_text, so discarding it left every source
      // unreadable and the article grounded on nothing but the research brief.
      byUrl.set(url, { url, title, fetched: true, text: documentTextOf(doc) });
    }
  }

  // A search that returns fifty results does not mean fifty sources. Pages the
  // model actually fetched come first — they are the only ones that can be
  // quoted — and the rest are kept only as far as the cap, for attribution.
  const all = [...byUrl.values()];
  const fetched = all.filter((f) => f.text);
  const rest = all.filter((f) => !f.text);
  return [...fetched, ...rest.slice(0, Math.max(0, MAX_SOURCES - fetched.length))];
}

/**
 * Fold several rounds of research into one evidence base.
 *
 * Research runs again when too few of its sources could actually be read, so
 * the findings arrive in rounds that overlap. Two rules settle the overlap:
 *
 *   • A later round that READ a page beats an earlier round that only saw it
 *     in search results. The same URL can legitimately come back twice, and
 *     the version with text is the one worth keeping.
 *   • Readable sources are never dropped by the cap. The cap exists to stop
 *     fifty attributable-but-unquotable URLs crowding the selection prompt;
 *     applying it in arrival order would throw away the exact sources the
 *     extra round was run to find.
 */
export function mergeFindings(rounds: ResearchFinding[][]): ResearchFinding[] {
  const byUrl = new Map<string, ResearchFinding>();
  for (const round of rounds) {
    for (const f of round) {
      const seen = byUrl.get(f.url);
      if (!seen || (!seen.text && f.text)) byUrl.set(f.url, f);
    }
  }
  const all = [...byUrl.values()];
  const readable = all.filter((f) => f.text);
  const rest = all.filter((f) => !f.text);
  return [...readable, ...rest.slice(0, Math.max(0, MAX_SOURCES - readable.length))];
}

/** How many of these can actually ground a claim. */
export function readableCount(findings: ResearchFinding[]): number {
  return findings.filter((f) => f.text).length;
}
