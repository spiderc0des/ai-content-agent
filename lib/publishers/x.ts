import 'server-only';
import type { ChannelAssetRow } from '../db-schemas';
import type { Publisher, PublishOutcome, PublishTarget } from './index';
import { xConfigured } from '../env';
import { accessTokenFor } from './token';
import { markChannelInvalid } from '../queries';
import { composeXPost, X_MAX_CHARS } from './compose';

/**
 * Posting to X.
 *
 * POST https://api.x.com/2/tweets with an OAuth 2.0 user-context token —
 * app-only bearer tokens cannot create posts, which is why this needs the
 * connect flow rather than a key in the environment.
 *
 * Falls back to the manual publisher when the app is not configured, for the
 * same reason the newsletter does: running this without live posting is a
 * supported setup, not a broken one.
 */
export function xPublisher(): Publisher {
  return {
    name: xConfigured ? 'x_api' : 'manual',

    isConfigured() {
      // True either way. Returning false would park every X post as failed on
      // an installation that never intended to post live.
      return true;
    },

    async publish(asset: ChannelAssetRow, target: PublishTarget): Promise<PublishOutcome> {
      if (!xConfigured) {
        return { ok: true, provider: 'manual', providerId: `x:${asset.id}`, externalUrl: null };
      }

      // The tags are part of the post, so they are part of the character
      // count. Checked at queue time too, but an asset can be regenerated
      // between queueing and release, and 280 is a hard platform limit — a
      // post one character over is rejected outright, not truncated.
      const composed = composeXPost(asset.body, target.tagHandles);
      if (!composed.ok) {
        return {
          ok: false,
          provider: 'x_api',
          retryable: false,
          error: composed.error,
        };
      }

      const token = await accessTokenFor('x');
      if (!token.ok) {
        return { ok: false, provider: 'x_api', retryable: !token.needsReconnect, error: token.reason };
      }

      let res: Response;
      try {
        res = await fetch('https://api.x.com/2/tweets', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text: composed.text }),
        });
      } catch (err) {
        // The network, not X. Worth another tick.
        return {
          ok: false,
          provider: 'x_api',
          retryable: true,
          error: `could not reach X — ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const body = await res.text();

      if (res.status === 201) {
        const json = JSON.parse(body) as { data?: { id?: string } };
        const id = json.data?.id ?? null;
        return {
          ok: true,
          provider: 'x_api',
          providerId: id,
          // The handle is in the connection, so the post is linkable without
          // a second lookup. X redirects /i/status/<id> to the canonical URL.
          externalUrl: id ? `https://x.com/i/status/${id}` : null,
          note: `posted as ${token.connection.accountLabel} · ${composed.text.length} characters`,
        };
      }

      // 401 means the token is gone — revoked, or the app's permissions
      // changed. Retrying cannot fix it, and every scheduled post afterwards
      // would fail the same way, so the connection is flagged for reconnect.
      if (res.status === 401) {
        await markChannelInvalid('x', `X rejected the token: ${body.slice(0, 200)}`);
        return {
          ok: false,
          provider: 'x_api',
          retryable: false,
          error: 'X rejected the access token — reconnect the account',
        };
      }

      // X bills per post — pay-per-use is the default for new developers, at
      // roughly $0.015 a post. 402 means the account has run out, which no
      // amount of retrying fixes: it needs someone to add credits. Retrying
      // it every worker run would burn the attempt budget and then mark it
      // permanently failed, which is the opposite of what should happen.
      if (res.status === 402) {
        return {
          ok: false,
          provider: 'x_api',
          retryable: false,
          error:
            'X refused the post: the account is out of API credits. X bills per post — ' +
            'top up in the X developer portal, then publish this again.',
        };
      }

      // 403 is usually a missing tweet.write scope or a duplicate post; 400 is
      // a malformed one. Neither improves with time.
      if (res.status === 400 || res.status === 403) {
        return {
          ok: false,
          provider: 'x_api',
          retryable: false,
          error: `X refused the post (${res.status}): ${xMessage(body)}`,
        };
      }

      // 429 and 5xx are worth another tick.
      return {
        ok: false,
        provider: 'x_api',
        retryable: true,
        error: `X returned ${res.status}: ${xMessage(body)}`,
      };
    },
  };
}

/**
 * X's error bodies come in two shapes — a `detail`/`title` problem object, or
 * an `errors` array — and the useful sentence is in a different place in each.
 */
function xMessage(body: string): string {
  try {
    const json = JSON.parse(body) as {
      detail?: string;
      title?: string;
      errors?: { message?: string; detail?: string }[];
    };
    return (
      json.detail ??
      json.errors?.[0]?.detail ??
      json.errors?.[0]?.message ??
      json.title ??
      body.slice(0, 200)
    );
  } catch {
    return body.slice(0, 200);
  }
}

export { X_MAX_CHARS };
