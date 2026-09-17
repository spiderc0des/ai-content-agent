import Link from 'next/link';
import { costOf, cacheSavings, formatUsd, formatTokens, ratesFor } from '@/lib/pricing';
import type { UsageRow, RequestUsageRow } from '@/lib/queries';

type TokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * What the pipeline has cost.
 *
 * A server component: the numbers come from `stage_runs`, which already
 * records model, effort and the four token counts per attempt, so this is
 * arithmetic over rows that exist rather than a new kind of tracking.
 *
 * Two things it deliberately does NOT claim:
 *   • Web searches are billed separately ($10 per 1,000) and this app does not
 *     record a count, so they are excluded and the page says so.
 *   • Failed calls are excluded. A stage that never got a reply cost nothing.
 */
export default function UsageCost({
  byStage,
  byRequest,
  requestCount,
}: {
  byStage: UsageRow[];
  byRequest: RequestUsageRow[];
  requestCount: number;
}) {
  // The SQL groups by (model, stage) so each row prices at its own rate — a
  // dated model id and a null one are different rows for the same stage. That
  // is right for the arithmetic and wrong for the table, which wants one line
  // per stage, so the fold happens here rather than losing the model in SQL.
  const stages = new Map<
    string,
    { stage: string; calls: number; unpriced: number; cost: number } & TokenTotals
  >();
  for (const r of byStage) {
    const recorded = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens > 0;
    const acc = stages.get(r.stage) ?? {
      stage: r.stage,
      calls: 0,
      // Runs from before usage was recorded per call. Counted, but kept out
      // of the cost column — showing them as "$0" would read as free rather
      // than as unknown.
      unpriced: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    acc.calls += r.calls;
    if (!recorded) acc.unpriced += r.calls;
    acc.cost += costOf(r.model, r);
    acc.inputTokens += r.inputTokens;
    acc.outputTokens += r.outputTokens;
    acc.cacheReadTokens += r.cacheReadTokens;
    acc.cacheWriteTokens += r.cacheWriteTokens;
    stages.set(r.stage, acc);
  }
  const rows = [...stages.values()].sort((a, b) => b.cost - a.cost);
  const unpricedCalls = rows.reduce((n, r) => n + r.unpriced, 0);

  const total = byStage.reduce((sum, r) => sum + costOf(r.model, r), 0);
  const saved = byStage.reduce((sum, r) => sum + cacheSavings(r.model, r), 0);
  const calls = byStage.reduce((sum, r) => sum + r.calls, 0);
  const tokens = byStage.reduce(
    (sum, r) => sum + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
    0,
  );
  const models = [...new Set(byStage.map((r) => r.model).filter(Boolean))] as string[];
  const unpriced = models.filter((m) => !ratesFor(m).known);

  if (!calls) {
    return (
      <section className="mb-6">
        <h2 className="mb-2 font-semibold">Model usage</h2>
        <div className="card text-sm" style={{ color: 'var(--ink-soft)' }}>
          Nothing has run yet.
        </div>
      </section>
    );
  }

  return (
    <section className="mb-6">
      <h2 className="mb-2 font-semibold">Model usage</h2>
      <p className="mb-3 max-w-prose text-sm" style={{ color: 'var(--ink-faint)' }}>
        Across every run. Web searches are billed separately and not counted here.
      </p>

      <div className="card mb-3">
        <dl className="grid gap-4 sm:grid-cols-4">
          <Stat label="Total" value={formatUsd(total)} />
          <Stat
            label="Per request"
            value={requestCount ? formatUsd(total / requestCount) : '—'}
            note={`${requestCount} request${requestCount === 1 ? '' : 's'}`}
          />
          <Stat label="Claude calls" value={String(calls)} note={`${formatTokens(tokens)} tokens`} />
          <Stat label="Saved by caching" value={formatUsd(saved)} note="vs. no cache" />
        </dl>
      </div>

      {unpriced.length > 0 && (
        <p className="panel panel-warning mb-3 text-sm">
          Priced at the Sonnet rate — no rate on file for {unpriced.join(', ')}.
        </p>
      )}

      <div className="card mb-3 overflow-x-auto">
        <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
          <caption className="pb-2 text-left text-xs" style={{ color: 'var(--ink-faint)' }}>
            By stage
          </caption>
          <thead>
            <tr style={{ color: 'var(--ink-faint)' }}>
              <Th>Stage</Th>
              <Th right>Calls</Th>
              <Th right>In</Th>
              <Th right>Out</Th>
              <Th right>Cached</Th>
              <Th right>Cost</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.stage} style={{ borderTop: '1px solid var(--rule)' }}>
                <Td>{r.stage}</Td>
                <Td right>{r.calls}</Td>
                <Td right>{formatTokens(r.inputTokens)}</Td>
                <Td right>{formatTokens(r.outputTokens)}</Td>
                <Td right>{formatTokens(r.cacheReadTokens)}</Td>
                <Td right>
                  <strong>{formatUsd(r.cost)}</strong>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        {unpricedCalls > 0 && (
          <p className="mt-2 text-xs" style={{ color: 'var(--ink-faint)' }}>
            {unpricedCalls} of {calls} calls predate per-call usage recording, so their cost is
            not included.
          </p>
        )}
      </div>

      {byRequest.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
            <caption className="pb-2 text-left text-xs" style={{ color: 'var(--ink-faint)' }}>
              Most expensive requests
            </caption>
            <thead>
              <tr style={{ color: 'var(--ink-faint)' }}>
                <Th>Request</Th>
                <Th right>Calls</Th>
                <Th right>Cost</Th>
              </tr>
            </thead>
            <tbody>
              {byRequest.map((r) => (
                <tr key={r.requestId} style={{ borderTop: '1px solid var(--rule)' }}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/r/${r.requestId}`}
                        className="min-w-0 flex-1 truncate no-underline hover:underline"
                        title={r.title}
                      >
                        {r.title || 'Untitled'}
                      </Link>
                      <span className="badge shrink-0">{r.status}</span>
                    </div>
                  </Td>
                  <Td right>{r.calls}</Td>
                  <Td right>
                    <strong>{formatUsd(costOf(r.model, r))}</strong>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--ink-faint)' }}>
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </dd>
      {note && (
        <dd className="text-xs" style={{ color: 'var(--ink-faint)' }}>
          {note}
        </dd>
      )}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-2 py-2 text-xs font-semibold ${right ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}
function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <td
      className={`px-2 py-2 align-top ${right ? 'text-right' : ''}`}
      style={right ? { fontVariantNumeric: 'tabular-nums' } : undefined}
    >
      {children}
    </td>
  );
}
