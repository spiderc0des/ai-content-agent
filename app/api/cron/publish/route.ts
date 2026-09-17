import { NextRequest, NextResponse } from 'next/server';
import { cronEnabled } from '@/lib/env';
import { isAuthorisedCronRequest } from '@/lib/cron-auth';
import { claimDuePublications, syncPublishStatus } from '@/lib/queries';
import { releasePublication } from '@/lib/release';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/publish — release everything that has come due.
 *
 * Driven by .github/workflows/cron.yml, with a daily backstop in vercel.json
 * — Vercel's Hobby plan allows only one cron run per day, which is not a
 * cadence a publishing queue can work on. Safe to hit by hand at any time.
 *
 * Concurrency is handled in the claim, not here: claimDuePublications() uses
 * FOR UPDATE SKIP LOCKED and flips state to 'publishing' in the same
 * statement, so two overlapping ticks take disjoint sets of rows. A row this
 * worker is holding is invisible to the other one.
 */
export async function GET(request: NextRequest) {
  // An endpoint that releases content on a GET is not something to leave open.
  if (!cronEnabled) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not set, so the publishing worker refuses to run.' },
      { status: 503 },
    );
  }
  if (!isAuthorisedCronRequest(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const due = await claimDuePublications(10);
  const touched = new Set<string>();
  let published = 0;
  let failed = 0;

  for (const publication of due) {
    touched.add(publication.request_id);
    // One shared path with the Publish now button — see lib/release.ts.
    const outcome = await releasePublication(publication, 'cron');
    if (outcome.ok) published++;
    else failed++;
  }

  for (const requestId of touched) {
    await syncPublishStatus(requestId).catch(() => {});
  }

  return NextResponse.json({ claimed: due.length, published, failed });
}
