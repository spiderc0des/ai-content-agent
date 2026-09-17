import 'server-only';
import type { Channel } from '../schemas';
import type { ChannelAssetRow } from '../db-schemas';
import type { Publisher, PublishOutcome, PublishTarget } from './index';

/**
 * The publisher that publishes nothing.
 *
 * It marks the publication as released at its scheduled time and records that
 * a human is the delivery mechanism. This is not a stub standing in for real
 * code — it is the honest implementation of "saved into a clear publishing
 * queue": the content is approved, formatted, scheduled, and released, and a
 * person copies it into the platform.
 *
 * It never fails, which is the point: the queue's failure handling is
 * exercised by the real publishers, and this one should never be the reason a
 * scheduled item does not come due.
 */
export function manualPublisher(channel: Channel): Publisher {
  return {
    name: 'manual',

    isConfigured() {
      return true;
    },

    async publish(asset: ChannelAssetRow, target: PublishTarget): Promise<PublishOutcome> {
      // The one thing this publisher WILL refuse. A newsletter released to an
      // empty list is not a small send — it is no send at all, reported as a
      // success, and the failure surfaces weeks later as "nobody got it". The
      // list is checked at queue time too, but people unsubscribe in between.
      if (channel === 'newsletter' && target.recipients.length === 0) {
        return {
          ok: false,
          provider: 'manual',
          retryable: false,
          error:
            'the recipient list is empty — everyone on it has unsubscribed, or it was emptied after this was queued',
        };
      }

      return {
        ok: true,
        provider: 'manual',
        providerId: `${channel}:${asset.id}`,
        externalUrl: null,
      };
    },
  };
}
