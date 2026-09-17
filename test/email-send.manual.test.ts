import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sendNewsletter } from '../lib/email';

/**
 * A real send, to a real inbox, over real SMTP.
 *
 * Gated behind EMAIL_SEND_TO so it can never run in the normal suite — a test
 * that emails people when someone types `npm test` is a mistake waiting for
 * an audience.
 */
describe.skipIf(!process.env.EMAIL_SEND_TO)('sendNewsletter over real SMTP', () => {
  it('delivers to the address in EMAIL_SEND_TO', async () => {
    const a = JSON.parse(readFileSync('/tmp/asset.json', 'utf8')) as {
      subject: string;
      preheader: string;
      body: string;
    };

    const result = await sendNewsletter({
      subject: a.subject,
      bodyMd: a.body,
      preheader: a.preheader,
      recipients: [{ email: process.env.EMAIL_SEND_TO!, name: '' }],
      groupName: 'SMTP delivery test',
    });

    console.log('result:', JSON.stringify(result, null, 1));
    expect(result.sent).toBe(true);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([]);
  }, 60_000);
});
