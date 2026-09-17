import 'server-only';
import type { Channel } from '../schemas';
import type { ChannelAssetRow } from '../db-schemas';
import { manualPublisher } from './manual';
import { newsletterPublisher } from './newsletter';
import { xPublisher } from './x';
import { linkedinPublisher } from './linkedin';

/**
 * The seam between the publishing queue and whatever actually posts.
 *
 * Everything upstream — the approval gate, the queue, the scheduler, the cron
 * worker, the one-live-publication-per-channel index — is finished and does
 * not care who publishes. Adding real LinkedIn and X posting later means
 * adding two files here and two entries to the registry below: no schema
 * change, no migration, no change to the queue or the worker.
 */

export interface PublishResult {
  ok: true;
  provider: string;
  providerId: string | null;
  externalUrl: string | null;
  /**
   * What actually happened, when "ok" is not the whole story — a newsletter
   * delivered to 198 of 200 addresses succeeded, and the queue should say so
   * rather than rounding it to a green tick.
   */
  note?: string;
}

export interface PublishFailure {
  ok: false;
  provider: string;
  /** True when another attempt might succeed (a 5xx, a timeout, a 429). */
  retryable: boolean;
  error: string;
}

export type PublishOutcome = PublishResult | PublishFailure;

/**
 * Who this particular release is aimed at.
 *
 * Resolved by the worker at RELEASE time, not stored at queue time: an email
 * group is a live list, and someone added the day before a scheduled send
 * should receive it. A queue-time snapshot would quietly get that wrong, and
 * only the people who never received it would know.
 */
export interface PublishTarget {
  /** Newsletter only — the addresses this send resolved to, just now. */
  recipients: { email: string; name: string }[];
  /** Newsletter only — the list's name, for the mail's own footer. */
  groupName?: string | null;
  /** X and LinkedIn only — accounts to mention in the post. */
  tagHandles: string[];
}

export interface Publisher {
  /** Stored on the publication row, so you can tell how something went out. */
  readonly name: string;
  /** False when credentials are missing — the worker says so instead of failing. */
  isConfigured(): boolean;
  publish(asset: ChannelAssetRow, target: PublishTarget): Promise<PublishOutcome>;
}

/**
 * One publisher per channel, all three of them real.
 *
 * Each falls back to the manual publisher when its own credentials are
 * absent — an installation with no mail account and no connected social
 * accounts still queues, schedules and releases everything, for a person to
 * post by hand. The publication records which of the two actually happened,
 * so "did this go out, or is it waiting for me" is never a guess.
 *
 * This is what the adapter seam was for: adding live posting changed these
 * three lines, two new files, and nothing else. No schema change to the
 * queue, no change to the worker, no change to the approval gate.
 */
const REGISTRY: Record<Channel, Publisher> = {
  linkedin: linkedinPublisher(),
  x: xPublisher(),
  newsletter: newsletterPublisher(),
};

export function publisherFor(channel: Channel): Publisher {
  return REGISTRY[channel];
}
