import 'server-only';
import type { ChannelAssetRow } from '../db-schemas';
import type { Publisher, PublishOutcome, PublishTarget } from './index';
import { linkedinConfigured } from '../env';
import { accessTokenFor } from './token';
import { markChannelInvalid } from '../queries';
import { composeLinkedInPost } from './compose';

/**
 * Posting to LinkedIn.
 *
 * POST https://api.linkedin.com/rest/posts — the versioned Posts API, which
 * replaced ugcPosts. Three headers are mandatory and the request is rejected
 * without them: the bearer token, `X-Restli-Protocol-Version: 2.0.0`, and
 * `LinkedIn-Version` in YYYYMM form.
 *
 * The created post's id comes back in the `x-restli-id` RESPONSE HEADER, not
 * in a body — a 201 here has no JSON at all, and reading one gets an empty
 * string rather than an error.
 */

/**
 * The API version this code is written against.
 *
 * Pinned, not computed from today's date. LinkedIn sunsets versions on a
 * published schedule, and a version string that rolls forward on its own
 * would silently start sending requests against a contract nobody has read —
 * the failure would arrive as a schema error on a live post. Bumping this is
 * a deliberate act with the changelog open.
 */
const LINKEDIN_VERSION = '202609';

export function linkedinPublisher(): Publisher {
  return {
    name: linkedinConfigured ? 'linkedin_api' : 'manual',

    isConfigured() {
      return true;
    },

    async publish(asset: ChannelAssetRow, target: PublishTarget): Promise<PublishOutcome> {
      if (!linkedinConfigured) {
        return {
          ok: true,
          provider: 'manual',
          providerId: `linkedin:${asset.id}`,
          externalUrl: null,
        };
      }

      const composed = composeLinkedInPost(asset.body, target.tagHandles, target.readUrl);
      if (!composed.ok) {
        return { ok: false, provider: 'linkedin_api', retryable: false, error: composed.error };
      }

      const token = await accessTokenFor('linkedin');
      if (!token.ok) {
        return {
          ok: false,
          provider: 'linkedin_api',
          retryable: !token.needsReconnect,
          error: token.reason,
        };
      }

      const author = token.connection.authorUrn;
      if (!author) {
        return {
          ok: false,
          provider: 'linkedin_api',
          retryable: false,
          error:
            'no LinkedIn author is set — reconnect, or set LINKEDIN_AUTHOR_URN to the page or profile to post as',
        };
      }

      let res: Response;
      try {
        res = await fetch('https://api.linkedin.com/rest/posts', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            'content-type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': LINKEDIN_VERSION,
          },
          body: JSON.stringify({
            author,
            commentary: composed.text,
            visibility: 'PUBLIC',
            distribution: {
              feedDistribution: 'MAIN_FEED',
              targetEntities: [],
              thirdPartyDistributionChannels: [],
            },
            lifecycleState: 'PUBLISHED',
            isReshareDisabledByAuthor: false,
          }),
        });
      } catch (err) {
        return {
          ok: false,
          provider: 'linkedin_api',
          retryable: true,
          error: `could not reach LinkedIn — ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (res.status === 201) {
        // The id is a header. There is no body to read.
        const urn = res.headers.get('x-restli-id');
        return {
          ok: true,
          provider: 'linkedin_api',
          providerId: urn,
          externalUrl: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null,
          note: `posted as ${token.connection.accountLabel}`,
        };
      }

      const body = await res.text();

      if (res.status === 401) {
        await markChannelInvalid('linkedin', `LinkedIn rejected the token: ${body.slice(0, 200)}`);
        return {
          ok: false,
          provider: 'linkedin_api',
          retryable: false,
          error: 'LinkedIn rejected the access token — reconnect the account',
        };
      }

      // 403 here is nearly always the scope or the page role: posting as an
      // organization needs w_organization_social AND an admin role on that
      // page. Naming both saves the half hour it otherwise takes to find.
      if (res.status === 403) {
        return {
          ok: false,
          provider: 'linkedin_api',
          retryable: false,
          error:
            `LinkedIn refused the post: ${linkedinMessage(body)}. ` +
            (author.startsWith('urn:li:organization:')
              ? 'Posting as a page needs the w_organization_social scope and an admin role on that page.'
              : 'Posting as a member needs the w_member_social scope.'),
        };
      }

      // 400 and 422 are the request itself; retrying sends the same thing.
      if (res.status === 400 || res.status === 404 || res.status === 422) {
        return {
          ok: false,
          provider: 'linkedin_api',
          retryable: false,
          error: `LinkedIn refused the post (${res.status}): ${linkedinMessage(body)}`,
        };
      }

      // 409 is a write conflict, 429 a rate limit, 5xx theirs — all worth
      // another tick. LinkedIn's own docs say to retry each of these.
      return {
        ok: false,
        provider: 'linkedin_api',
        retryable: true,
        error: `LinkedIn returned ${res.status}: ${linkedinMessage(body)}`,
      };
    },
  };
}

function linkedinMessage(body: string): string {
  try {
    const json = JSON.parse(body) as { message?: string; errorDetails?: unknown };
    return json.message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}
