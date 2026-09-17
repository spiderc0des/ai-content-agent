import { describe, it, expect } from 'vitest';
import { parseAddressList } from '../lib/address-list';

/**
 * These are the shapes people actually paste into a recipient list. The rule
 * under test is not "parse email addresses" — it is "never silently lose one",
 * because nobody counts the rows afterwards and the people who did not receive
 * the newsletter have no way to tell you.
 */
describe('parseAddressList', () => {
  const emails = (s: string) => parseAddressList(s).valid.map((v) => v.email);

  it('reads one address per line', () => {
    expect(emails('ada@example.com\ngrace@example.com')).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
  });

  it('reads a comma-separated row', () => {
    expect(emails('ada@example.com, grace@example.com,katherine@example.com')).toEqual([
      'ada@example.com',
      'grace@example.com',
      'katherine@example.com',
    ]);
  });

  it('reads the display-name form and keeps the name', () => {
    const { valid } = parseAddressList('Ada Lovelace <ada@example.com>');
    expect(valid).toEqual([{ email: 'ada@example.com', name: 'Ada Lovelace' }]);
  });

  it('does not split a quoted name on its own comma', () => {
    const { valid, invalid } = parseAddressList('"Lovelace, Ada" <ada@example.com>');
    expect(invalid).toEqual([]);
    expect(valid).toEqual([{ email: 'ada@example.com', name: 'Lovelace, Ada' }]);
  });

  it('separates several display-name entries on one line', () => {
    const { valid } = parseAddressList('Ada <ada@example.com>, Grace <grace@example.com>');
    expect(valid.map((v) => v.email)).toEqual(['ada@example.com', 'grace@example.com']);
    expect(valid.map((v) => v.name)).toEqual(['Ada', 'Grace']);
  });

  it('reads a two-column spreadsheet paste as name + address, not as a failure', () => {
    const { valid, invalid } = parseAddressList('Ada Lovelace,ada@example.com\nGrace Hopper\tgrace@example.com');
    expect(invalid).toEqual([]);
    expect(valid).toEqual([
      { email: 'ada@example.com', name: 'Ada Lovelace' },
      { email: 'grace@example.com', name: 'Grace Hopper' },
    ]);
  });

  it('lowercases, so the same person cannot be added twice', () => {
    const { valid } = parseAddressList('Ada@Example.COM\nada@example.com');
    expect(valid).toEqual([{ email: 'ada@example.com', name: '' }]);
  });

  it('reports what it could not read instead of dropping it', () => {
    const { valid, invalid } = parseAddressList('ada@example.com\nnot-an-address\ngrace@example.com');
    expect(valid.map((v) => v.email)).toEqual(['ada@example.com', 'grace@example.com']);
    expect(invalid).toEqual(['not-an-address']);
  });

  it('rejects the near-misses that a looser check would wave through', () => {
    const { valid, invalid } = parseAddressList('ada@example\nada@.com\n@example.com\nada example.com');
    expect(valid).toEqual([]);
    expect(invalid).toHaveLength(4);
  });

  it('survives semicolons, blank lines and trailing punctuation', () => {
    expect(emails('ada@example.com;\n\n  grace@example.com .\n')).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
  });

  it('returns nothing for empty input rather than throwing', () => {
    expect(parseAddressList('')).toEqual({ valid: [], invalid: [] });
    expect(parseAddressList('   \n\n ')).toEqual({ valid: [], invalid: [] });
  });
});
