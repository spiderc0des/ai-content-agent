import { NextRequest, NextResponse } from 'next/server';
import { cronEnabled } from '@/lib/env';
import { isAuthorisedCronRequest } from '@/lib/cron-auth';
import {
  claimDuePublications,
  getAsset,
  markPublished,
  markPublishFailed,
  syncPublishStatus,
  logEvent,
  recipientsOf,
  recordRecipients,
  getEmailGroup,
} from '@/lib/queries';
import { publisherFor } from '@/lib/publishers';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/publish — release everything that has come due.
 *
 * Runs every 15 minutes from vercel.json, and is safe to hit by hand.
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
    const publisher = publisherFor(publication.channel);

    try {
      const asset = await getAsset(publication.asset_id);
      if (!asset) throw new Error('the channel asset no longer exists');

      if (!publisher.isConfigured()) {
        throw new Error(`the ${publication.channel} publisher is not configured`);
      }

      // Resolved NOW, not when this was queued. Someone added to the list
      // yesterday is on this send; someone who unsubscribed yesterday is not.
      const recipients = publication.email_group_id
        ? await recipientsOf(publication.email_group_id)
        : [];
      const group = publication.email_group_id
        ? await getEmailGroup(publication.email_group_id)
        : null;

      const result = await publisher.publish(asset, {
        recipients,
        groupName: group?.name ?? null,
        tagHandles: publication.tag_handles,
      });

      if (result.ok) {
        // Who it actually went to, written before it is marked published so
        // there is no window where the row says "published" and cannot say
        // to whom.
        if (publication.email_group_id) {
          await recordRecipients(publication.id, recipients);
        }
        await markPublished(publication.id, {
          provider: result.provider,
          providerId: result.providerId,
          externalUrl: result.externalUrl,
        });
        published++;
        await logEvent({
          requestId: publication.request_id,
          actor: 'cron',
          stage: 'publishing',
          step: `publish_${publication.channel}`,
          ok: true,
          detail: {
            provider: result.provider,
            external_url: result.externalUrl,
            recipients: recipients.length || undefined,
            // "198 delivered, 2 rejected" — a partial send is neither a
            // success nor a failure, and the log is where that has to say so.
            delivery: result.note,
            tagged: publication.tag_handles.length ? publication.tag_handles : undefined,
          },
        });
      } else {
        await markPublishFailed(publication.id, result.error);
        failed++;
        await logEvent({
          requestId: publication.request_id,
          actor: 'cron',
          stage: 'publishing',
          step: `publish_${publication.channel}`,
          ok: false,
          detail: { provider: result.provider, error: result.error, retryable: result.retryable },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A claimed row must never be left in 'publishing' — it would be
      // invisible to every future tick and never retried.
      await markPublishFailed(publication.id, message).catch(() => {});
      failed++;
      await logEvent({
        requestId: publication.request_id,
        actor: 'cron',
        stage: 'publishing',
        step: `publish_${publication.channel}`,
        ok: false,
        detail: { error: message },
      }).catch(() => {});
    }
  }

  for (const requestId of touched) {
    await syncPublishStatus(requestId).catch(() => {});
  }

  return NextResponse.json({ claimed: due.length, published, failed });
}
