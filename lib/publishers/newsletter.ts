import 'server-only';
import type { ChannelAssetRow } from '../db-schemas';
import type { Publisher, PublishOutcome, PublishTarget } from './index';
import { emailEnabled } from '../env';
import { sendNewsletter, EMAIL_PROVIDER } from '../email';

/**
 * The one channel this app can actually deliver.
 *
 * LinkedIn and X need an app review and an OAuth dance per account; a
 * newsletter needs an SMTP account, which the agency already has. So the
 * newsletter is a real publisher and the other two remain honest manual ones
 * — the queue and the approval gate above are identical either way.
 *
 * Falls back to manual when no mail provider is configured, rather than
 * failing: the brief's requirement is a clear publishing queue, and an agency
 * running this without SMTP should still get the newsletter prepared,
 * approved and scheduled for someone to send by hand. Which of the two
 * happened is recorded on the publication as the provider, so nobody has to
 * guess afterwards whether a send actually left the building.
 */
export function newsletterPublisher(): Publisher {
  return {
    name: emailEnabled ? EMAIL_PROVIDER : 'manual',

    isConfigured() {
      // True either way — 'not configured' would park the row as failed, and
      // the no-SMTP case is a supported way to run this, not a broken one.
      return true;
    },

    async publish(asset: ChannelAssetRow, target: PublishTarget): Promise<PublishOutcome> {
      // Checked at queue time too, but a scheduled send sits for days and
      // people unsubscribe in between. Reporting this as published would
      // surface weeks later as "nobody ever got it".
      if (target.recipients.length === 0) {
        return {
          ok: false,
          provider: this.name,
          retryable: false,
          error:
            'the recipient list is empty — everyone on it has unsubscribed, or it was emptied after this was queued',
        };
      }

      if (!emailEnabled) {
        return {
          ok: true,
          provider: 'manual',
          providerId: `newsletter:${asset.id}`,
          externalUrl: null,
        };
      }

      const result = await sendNewsletter({
        subject: asset.subject ?? 'Koya Talent',
        bodyMd: asset.body,
        // The channel asset carries its own preheader; the subject is a poor
        // substitute but better than letting the client grab the first line
        // of the body for the inbox preview.
        preheader: asset.preheader || (asset.subject ?? ''),
        recipients: target.recipients,
        groupName: target.groupName ?? 'Koya Talent',
      });

      if (!result.sent) {
        return {
          ok: false,
          provider: EMAIL_PROVIDER,
          // A transport failure is worth another tick; an empty list is not.
          retryable: !result.skipped && result.accepted === 0 && !/empty/.test(result.reason ?? ''),
          error: result.reason ?? 'the mail server accepted nothing',
        };
      }

      return {
        ok: true,
        provider: EMAIL_PROVIDER,
        providerId: result.providerId,
        externalUrl: null,
        // Partial delivery is reported rather than rounded up to success:
        // with ten batches, one failing is neither "sent" nor "failed", and
        // the queue should say which addresses to look at.
        note: result.rejected.length
          ? `${result.accepted} delivered, ${result.rejected.length} rejected: ${result.rejected.slice(0, 5).join(', ')}${result.rejected.length > 5 ? '…' : ''}`
          : `${result.accepted} delivered`,
      };
    },
  };
}
