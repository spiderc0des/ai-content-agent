/**
 * Turning pasted text into email addresses.
 *
 * Pure — no database, no 'server-only' — because this is guesswork about human
 * input, and guesswork is exactly what needs tests. The shapes people actually
 * paste, all of which turn up in one list sooner or later:
 *
 *   ada@example.com
 *   Ada Lovelace <ada@example.com>
 *   "Lovelace, Ada" <ada@example.com>
 *   ada@example.com, grace@example.com
 *   Ada Lovelace,ada@example.com          ← a two-column spreadsheet paste
 *   Ada Lovelace<TAB>ada@example.com      ← the same thing, tab-separated
 *
 * Anything it cannot read is RETURNED rather than dropped, so the caller can
 * name the lines that were skipped. Silently losing two addresses out of a
 * paste of two hundred is the failure mode worth designing against — nobody
 * counts the rows afterwards, and the two people who never got the newsletter
 * have no way to tell you.
 */

export interface ParsedAddresses {
  valid: { email: string; name: string }[];
  /** Fragments that were not addresses, for reporting back. */
  invalid: string[];
}

/**
 * Deliberately stricter than the RFC and looser than a full parser: one @, no
 * whitespace or separators, and a dot in the domain. The aim is to catch a
 * typo in a pasted list, not to adjudicate exotic-but-legal addresses.
 */
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>".]+\.[^\s@,;<>".]{2,}$/;

/** `Name <email>` or `"Name" <email>` — the display-name form. */
const ANGLED = /^\s*(?:"([^"]*)"|([^<]*?))\s*<\s*([^<>\s]+)\s*>\s*$/;

const isEmail = (s: string) => EMAIL.test(s.trim().toLowerCase());

export function parseAddressList(input: string): ParsedAddresses {
  const valid: { email: string; name: string }[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  const add = (email: string, name: string) => {
    const key = email.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    valid.push({ email: key, name: name.trim().slice(0, 120) });
  };

  // Newlines and semicolons always separate entries. Commas do not, always:
  // a comma is both a separator AND part of "Lovelace, Ada", so it is only
  // consulted once the angle-bracket form has been ruled out.
  for (const rawLine of input.split(/[\n\r;]+/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.includes('<') && line.includes('>')) {
      for (const entry of splitAngled(line)) {
        const m = entry.match(ANGLED);
        const email = (m ? m[3]! : entry).trim();
        if (!isEmail(email)) {
          invalid.push(entry.trim());
          continue;
        }
        add(email, m ? (m[1] ?? m[2] ?? '') : '');
      }
      continue;
    }

    const parts = line
      .split(/[,\t]+/)
      .map((p) => p.trim().replace(/^[,\s]+|[,\s.]+$/g, ''))
      .filter(Boolean);
    const emails = parts.filter(isEmail);

    // Exactly one address on a line with other text is the spreadsheet shape:
    // the other columns are the person's name. Treating them as failures
    // would report half of a perfectly good two-column paste as invalid.
    if (emails.length === 1 && parts.length > 1) {
      add(emails[0]!, parts.filter((p) => !isEmail(p)).join(' '));
      continue;
    }

    for (const part of parts) {
      if (isEmail(part)) add(part, '');
      else invalid.push(part);
    }
  }

  return { valid, invalid };
}

/**
 * One line of angle-bracket entries into separate entries, splitting only
 * BETWEEN them — never inside one, where the commas belong to the name.
 */
function splitAngled(line: string): string[] {
  return line
    .split(/>\s*[,;]?\s*/)
    .map((p, i, a) => (i < a.length - 1 ? `${p}>` : p))
    .map((p) => p.trim())
    .filter(Boolean);
}
