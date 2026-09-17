import 'server-only';
import nodemailer from 'nodemailer';
import { env, emailEnabled } from './env';
import {
  emailShell,
  markdownToEmailHtml,
  markdownToPlainText,
  p as para,
  button,
  escapeHtml,
} from './email-layout';

/**
 * Sending mail, for the two things this app actually sends:
 *
 *   1. the newsletter — to an admin-managed email group, at release
 *   2. the invitation — the sign-in link, to the person being invited
 *
 * Gmail SMTP, the same transport week 3 uses, and for the same reason: an
 * email API provider's sandbox only delivers to the account owner's own
 * address until a domain is verified with DNS records, and a real
 * subscriber's inbox is exactly what fails without one. Gmail sends from an
 * address you already own with no verification step, at the cost of the
 * "from" address always being the literal Gmail address with only the display
 * name customisable.
 */

const transport = emailEnabled
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
      // One connection reused across a batch rather than one per message.
      // Gmail throttles hard on connection churn, and a newsletter is the
      // one place this app sends more than a single mail at a time.
      pool: true,
      maxConnections: 1,
      maxMessages: 50,
    })
  : null;

/** Gmail rejects a "from" it does not own — only the display name is ours. */
const FROM = emailEnabled ? `"${env.MAIL_FROM_NAME}" <${env.GMAIL_USER}>` : null;

/** The bare address, for recognising our own copy in the accepted list. */
const SELF = (env.GMAIL_USER ?? '').toLowerCase();

/** Recorded against a delivery, so a stored provider id can be read later. */
export const EMAIL_PROVIDER = 'gmail';

export type EmailOutcome =
  | { sent: true; providerId: string | null; accepted: number; rejected: string[] }
  | { sent: false; skipped: true; reason: string }
  | { sent: false; skipped: false; reason: string };

/**
 * Gmail caps the recipients on a single message, and a rejection part-way
 * through a large BCC takes the whole message with it. Fifty keeps each
 * message comfortably inside the limit and means one bad address costs one
 * batch rather than the entire send.
 */
const BCC_BATCH_SIZE = 50;

/**
 * Sends both parts, always.
 *
 * `text` is not a fallback nobody sees. It is what a screen reader reads, what
 * a watch notification shows, what a plain-text client renders — and a message
 * with no text part scores measurably worse with spam filters, which for a
 * newsletter is the failure that costs the most. So the signature makes it
 * impossible to send HTML without also writing the text.
 */
async function send(
  envelope: { to?: string; bcc?: string[] },
  subject: string,
  text: string,
  html: string,
): Promise<EmailOutcome> {
  if (!transport || !FROM) {
    return {
      sent: false,
      skipped: true,
      reason: 'No mail provider configured (GMAIL_USER / GMAIL_APP_PASSWORD unset).',
    };
  }
  try {
    const info = await transport.sendMail({
      from: FROM,
      // A BCC-only message still needs a To, or a share of clients file it
      // as suspicious and some servers refuse it outright. The sender's own
      // address is the conventional answer — which does mean the sending
      // account receives a copy of each batch. That is a useful side effect
      // (you see what went out) as long as it is not counted as a delivery,
      // which is what the accepted-list filter below is for.
      to: envelope.to ?? FROM,
      bcc: envelope.bcc,
      subject,
      text,
      html,
    });
    // A BCC-only message carries the sender's own address in To, so the
    // server accepts it too and nodemailer counts it. Left in, a newsletter
    // to fifty people reports fifty-one delivered — and the number that is
    // wrong by one is the number nobody checks.
    const accepted = (Array.isArray(info.accepted) ? info.accepted : [])
      .map((a) => addressOf(a))
      .filter((a) => a && a !== SELF);

    return {
      sent: true,
      providerId: info.messageId ?? null,
      accepted: accepted.length,
      rejected: (Array.isArray(info.rejected) ? info.rejected : [])
        .map((a) => addressOf(a))
        .filter((a) => a && a !== SELF),
    };
  } catch (err) {
    return { sent: false, skipped: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * nodemailer returns either a bare string or an envelope object in
 * accepted/rejected, depending on the transport and the address form.
 */
function addressOf(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim().toLowerCase();
  if (entry && typeof entry === 'object' && 'address' in entry) {
    return String((entry as { address: unknown }).address).trim().toLowerCase();
  }
  return String(entry).trim().toLowerCase();
}

export interface NewsletterSendResult {
  sent: boolean;
  skipped: boolean;
  /** Addresses the server accepted across every batch. */
  accepted: number;
  /** Addresses it refused, named so they can be fixed in the group. */
  rejected: string[];
  /** The first message id, for the publication row. */
  providerId: string | null;
  reason?: string;
}

/**
 * The newsletter, to a whole email group.
 *
 * **BCC, never To.** A newsletter addressed to the list would disclose every
 * subscriber's address to every other subscriber — a privacy breach that
 * cannot be walked back once it has landed in two hundred inboxes, and the
 * single most common way a mailout goes wrong. The To is the sender's own
 * address; the list rides in BCC, in batches.
 *
 * Partial success is reported honestly rather than rounded to "sent" or
 * "failed": with five hundred subscribers across ten batches, one batch
 * failing is neither.
 */
export async function sendNewsletter(params: {
  subject: string;
  /** The newsletter body, in the markdown subset. */
  bodyMd: string;
  preheader: string;
  recipients: { email: string; name: string }[];
  /** The list's name, so the footer can say what they subscribed to. */
  groupName: string;
}): Promise<NewsletterSendResult> {
  if (!emailEnabled) {
    return {
      sent: false,
      skipped: true,
      accepted: 0,
      rejected: [],
      providerId: null,
      reason: 'No mail provider configured (GMAIL_USER / GMAIL_APP_PASSWORD unset).',
    };
  }
  if (!params.recipients.length) {
    return {
      sent: false,
      skipped: false,
      accepted: 0,
      rejected: [],
      providerId: null,
      reason: 'the recipient list is empty',
    };
  }

  // No "read it online" link. There is no reader-facing page in this system
  // and the brief does not ask for one — the newsletter IS the delivery, and
  // the whole of it is in this mail. A link into the app would send a
  // subscriber to a sign-in wall, and past it to the request workspace with
  // every draft, evaluation and source decision on display.
  const html = emailShell({
    title: params.subject,
    preheader: params.preheader,
    body: markdownToEmailHtml(params.bodyMd),
    footnote:
      `You are receiving this because you are on the “${escapeHtml(params.groupName)}” list. ` +
      'Reply to this email to unsubscribe.',
  });

  const text =
    `${markdownToPlainText(params.bodyMd)}\n\n` +
    `—\nYou are receiving this because you are on the "${params.groupName}" list. ` +
    `Reply to this email to unsubscribe.`;

  const addresses = params.recipients.map((r) => r.email);
  let accepted = 0;
  const rejected: string[] = [];
  const failures: string[] = [];
  let providerId: string | null = null;

  for (let i = 0; i < addresses.length; i += BCC_BATCH_SIZE) {
    const batch = addresses.slice(i, i + BCC_BATCH_SIZE);
    const outcome = await send({ bcc: batch }, params.subject, text, html);

    if (outcome.sent) {
      accepted += outcome.accepted;
      rejected.push(...outcome.rejected);
      providerId ??= outcome.providerId;
    } else {
      // The whole batch is lost, so every address in it counts as rejected —
      // reporting only the accepted count would quietly hide fifty people.
      rejected.push(...batch);
      failures.push(outcome.reason);
    }
  }

  return {
    sent: accepted > 0,
    skipped: false,
    accepted,
    rejected,
    providerId,
    reason: failures.length ? failures[0] : undefined,
  };
}

/**
 * The invitation. The link signs the person in — so it is a credential, and
 * it is never written to the events table or any log (see the invite route).
 *
 * Says plainly that the account activates on first sign-in, because otherwise
 * the first thing an invited person meets is an access screen that reads as
 * the invite having failed.
 */
export async function sendInvite(params: {
  toEmail: string;
  fullName: string;
  invitedBy: string;
  link: string;
}): Promise<EmailOutcome> {
  const name = escapeHtml(params.fullName);
  const by = escapeHtml(params.invitedBy);

  return send(
    { to: params.toEmail },
    "You're invited to the Koya Content Agent",
    `Hi ${params.fullName},\n\n` +
      `${params.invitedBy} has invited you to the Koya Content Agent, where Koya Talent ` +
      `researches, writes and publishes content.\n\n` +
      `Accept your invitation: ${params.link}\n\n` +
      `That link signs you in, so please don't forward it. It expires soon — if it has, ` +
      `ask ${params.invitedBy} to send a new one.\n\n` +
      `Your access is set up already and switches on the first time you sign in.\n\n` +
      `Koya Talent`,
    emailShell({
      title: "You're invited",
      preheader: `${params.invitedBy} invited you to the Koya Content Agent.`,
      body:
        para(`Hi ${name},`) +
        para(
          `<strong>${by}</strong> has invited you to the Koya Content Agent, where Koya Talent ` +
            'researches, writes and publishes content.',
        ) +
        button({ label: 'Accept invitation', href: params.link }) +
        para('Your access is set up already and switches on the first time you sign in.', true),
      footnote:
        `This link signs you in, so please don't forward it. It expires soon — if it has, ` +
        `ask ${by} to send a new one.`,
    }),
  );
}
