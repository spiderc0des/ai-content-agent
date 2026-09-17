import { describe, it, expect } from 'vitest';
import { manualPublisher } from '../lib/publishers/manual';
import { newsletterPublisher } from '../lib/publishers/newsletter';
import { xPublisher } from '../lib/publishers/x';
import { linkedinPublisher } from '../lib/publishers/linkedin';
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
 * The two live publishers, in the state this install is actually in: apps not
 * yet registered. What matters here is that an unconfigured channel degrades
 * to manual rather than failing — an installation without connected accounts
 * is a supported way to run this, not a broken one.
 */
describe('social publishers without credentials', () => {
  for (const [name, make] of [
    ['x', xPublisher],
    ['linkedin', linkedinPublisher],
  ] as const) {
    it(`${name} falls back to manual, and says so`, async () => {
      const p = make();
      expect(p.name).toBe('manual');
      // Not "unconfigured" — that would park every post as failed.
      expect(p.isConfigured()).toBe(true);

      const out = await p.publish(asset, { recipients: [], tagHandles: ['@koyatalent'] });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.provider).toBe('manual');
        // No external URL, because nothing was actually posted.
        expect(out.externalUrl).toBeNull();
      }
    });
  }
});
