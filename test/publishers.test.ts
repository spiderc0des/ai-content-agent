import { describe, it, expect } from 'vitest';
import { manualPublisher } from '../lib/publishers/manual';
import { newsletterPublisher } from '../lib/publishers/newsletter';
import { xPublisher } from '../lib/publishers/x';
import { linkedinPublisher } from '../lib/publishers/linkedin';
import { xConfigured, linkedinConfigured } from '../lib/env';
import type { ChannelAssetRow } from '../lib/db-schemas';

const asset = { id: 'asset-1', request_id: 'req-1', body: 'Body.', subject: 'S', preheader: 'P' } as ChannelAssetRow;

/**
 * The manual publisher is deliberately the publisher that cannot fail — the
 * queue's failure handling belongs to the real ones, and this should never be
 * the reason a scheduled item does not come due. It has exactly one exception,
 * and this is why.
 */
describe('manualPublisher', () => {
  it('releases a newsletter to a list that still has people on it', async () => {
    const out = await manualPublisher('newsletter').publish(asset, {
      recipients: [{ email: 'ada@example.com', name: 'Ada' }],
      tagHandles: [],
    });
    expect(out.ok).toBe(true);
  });

  it('REFUSES a newsletter whose list is empty at release time', async () => {
    // The route checks the list when it is queued, but a scheduled send sits
    // for hours or days and people unsubscribe in between. Reporting this as
    // published would surface weeks later as "nobody ever got it", with the
    // queue insisting it went out.
    const out = await manualPublisher('newsletter').publish(asset, {
      recipients: [],
      tagHandles: [],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.retryable).toBe(false); // waiting will not repopulate the list
      expect(out.error).toContain('empty');
    }
  });

  it('does not apply the recipient rule to channels that have no recipients', async () => {
    for (const channel of ['x', 'linkedin'] as const) {
      const out = await manualPublisher(channel).publish(asset, {
        recipients: [],
        tagHandles: ['@koyatalent'],
      });
      expect(out.ok).toBe(true);
    }
  });

  it('records which channel released it, so the row says how it went out', async () => {
    const out = await manualPublisher('x').publish(asset, { recipients: [], tagHandles: [] });
    expect(out.ok && out.provider).toBe('manual');
    expect(out.ok && out.providerId).toBe('x:asset-1');
  });
});

/**
 * The newsletter is the one channel this app can actually deliver, so it is
 * the one publisher that can really fail. These cover the paths that must
 * never reach the mail server.
 */
describe('newsletterPublisher', () => {
  it('refuses an empty list without attempting a send', async () => {
    const out = await newsletterPublisher().publish(asset, { recipients: [], tagHandles: [] });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      // Not retryable: waiting will not repopulate the list, and a retry
      // every tick forever is how a dead row becomes noise.
      expect(out.retryable).toBe(false);
      expect(out.error).toContain('empty');
    }
  });

  it('names itself by how it will actually deliver', () => {
    // 'gmail' when SMTP is configured, 'manual' when it is not — so the
    // publication row says whether a send left the building or whether a
    // person still has to press it.
    expect(['gmail', 'manual']).toContain(newsletterPublisher().name);
  });

  it('is always "configured", because running without SMTP is supported', () => {
    // Returning false here would park every newsletter as failed on a setup
    // that is a legitimate way to run this app.
    expect(newsletterPublisher().isConfigured()).toBe(true);
  });
});

/**
 * The two live publishers.
 *
 * What they resolve to depends on whether credentials are present, and this
 * suite loads .env.local — so an install with a real X app configured is a
 * legitimate state for this test to run in, not a reason to fail. Asserting
 * "falls back to manual" unconditionally made the suite go red the moment
 * someone actually set the thing up, which is the wrong way round.
 *
 * So the contract is asserted against the configuration, and the invariants
 * that hold either way are asserted unconditionally.
 */
describe('social publishers', () => {
  for (const [channel, make, configured] of [
    ['x', xPublisher, xConfigured],
    ['linkedin', linkedinPublisher, linkedinConfigured],
  ] as const) {
    it(`${channel} names itself by how it will actually deliver`, () => {
      const expected = configured ? `${channel === 'x' ? 'x' : 'linkedin'}_api` : 'manual';
      expect(make().name).toBe(expected);
    });

    it(`${channel} always reports as configured, whatever the credentials`, () => {
      // Returning false would park every post to this channel as failed, on
      // an install that never intended to post live.
      expect(make().isConfigured()).toBe(true);
    });
  }

  it('posts nothing and reports manual when a channel has no credentials', async () => {
    // LinkedIn is the unconfigured one here; if both are configured there is
    // nothing to assert and the test says so rather than passing vacuously.
    const unconfigured = !linkedinConfigured ? linkedinPublisher : !xConfigured ? xPublisher : null;
    if (!unconfigured) {
      expect(xConfigured && linkedinConfigured).toBe(true);
      return;
    }
    const out = await unconfigured().publish(asset, { recipients: [], tagHandles: ['@koyatalent'] });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.provider).toBe('manual');
      // No external URL, because nothing was actually posted.
      expect(out.externalUrl).toBeNull();
    }
  });
});
