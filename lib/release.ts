import 'server-only';
import {
  getAsset,
  markPublished,
  markPublishFailed,
  recipientsOf,
  recordRecipients,
  getEmailGroup,
  logEvent,
  ensurePublicToken,
} from './queries';
import { env } from './env';
import { publisherFor } from './publishers';
import type { PublicationRow } from './db-schemas';

/**
 * Releasing one publication.
 *
 * Extracted so that the scheduled worker and the Publish now button run the
 * identical path. Two copies of this would drift — and the way they would
 * drift is that one of them forgets to record who a newsletter went to, or
 * leaves a claimed row stuck in 'publishing' on an error, and nobody notices
 * until a send goes missing.
 *
 * The caller is responsible for CLAIMING the row first (flipping it to
 * 'publishing'), because that is where the concurrency guarantee lives: the
 * claim is a conditional UPDATE, so a row the cron has taken is invisible to
 * the button and vice versa.
 */
export interface ReleaseOutcome {
  ok: boolean;
  channel: string;
  error?: string;
  note?: string;
  externalUrl?: string | null;
}

export async function releasePublication(
  publication: PublicationRow,
  actor: string,
): Promise<ReleaseOutcome> {
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

    // Minted here rather than at approval, so a request that is never
    // published never gets a public address at all. Idempotent: the same
    // token comes back for every channel of the same request, which is what
    // makes one link work across the newsletter, the post and the tweet.
    const token = await ensurePublicToken(publication.request_id).catch(() => null);
    const readUrl = token ? `${env.APP_URL.replace(/\/$/, '')}/read/${token}` : null;

    const result = await publisher.publish(asset, {
      recipients,
      groupName: group?.name ?? null,
      tagHandles: publication.tag_handles,
      readUrl,
    });

    if (result.ok) {
      // Who it actually went to, written BEFORE it is marked published, so
      // there is no window where the row says "published" and cannot say to
      // whom.
      if (publication.email_group_id) {
        await recordRecipients(publication.id, recipients);
      }
      await markPublished(publication.id, {
        provider: result.provider,
        providerId: result.providerId,
        externalUrl: result.externalUrl,
      });
      await logEvent({
        requestId: publication.request_id,
        actor,
        stage: 'publishing',
        step: `publish_${publication.channel}`,
        ok: true,
        detail: {
          provider: result.provider,
          external_url: result.externalUrl,
          recipients: recipients.length || undefined,
          // "198 delivered, 2 rejected" — a partial send is neither a success
          // nor a failure, and the log is where that has to say so.
          delivery: result.note,
          tagged: publication.tag_handles.length ? publication.tag_handles : undefined,
        },
      });
      return {
        ok: true,
        channel: publication.channel,
        note: result.note,
        externalUrl: result.externalUrl,
      };
    }

    await markPublishFailed(publication.id, result.error, result.retryable);
    await logEvent({
      requestId: publication.request_id,
      actor,
      stage: 'publishing',
      step: `publish_${publication.channel}`,
      ok: false,
      detail: { provider: result.provider, error: result.error, retryable: result.retryable },
    });
    return { ok: false, channel: publication.channel, error: result.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A claimed row must never be left in 'publishing'. It would be invisible
    // to every future tick and never retried — a send that silently stops
    // existing, which is the worst outcome available here.
    await markPublishFailed(publication.id, message).catch(() => {});
    await logEvent({
      requestId: publication.request_id,
      actor,
      stage: 'publishing',
      step: `publish_${publication.channel}`,
      ok: false,
      detail: { error: message },
    }).catch(() => {});
    return { ok: false, channel: publication.channel, error: message };
  }
}
