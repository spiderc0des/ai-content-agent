import { describe, it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { emailShell, markdownToEmailHtml, markdownToPlainText, divider } from '../lib/email-layout';
import { button } from '../lib/email-layout';

/**
 * Not a test — a render. Writes the newsletter template to a file so the
 * styling can be looked at in a browser, using a real generated asset rather
 * than lorem. Gated behind an env var so it never runs in the normal suite.
 */
describe.skipIf(!process.env.EMAIL_PREVIEW)('email preview', () => {
  it('renders a real newsletter asset', () => {
    const a = JSON.parse(readFileSync('/tmp/asset.json', 'utf8')) as {
      subject: string;
      preheader: string;
      body: string;
    };
    const html = emailShell({
      title: a.subject,
      preheader: a.preheader,
      body:
        markdownToEmailHtml(a.body) +
        divider() +
        button({ label: 'Read it online', href: 'https://example.com/r/demo' }),
      footnote:
        'You are receiving this because you are on the “Monthly newsletter subscribers” list. Reply to this email to unsubscribe.',
    });
    writeFileSync('/tmp/newsletter-preview.html', html);
    writeFileSync('/tmp/newsletter-preview.txt', markdownToPlainText(a.body));
    console.log('wrote /tmp/newsletter-preview.html');
  });
});
