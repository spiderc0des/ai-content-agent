import { describe, it, expect } from 'vitest';
import { groundClaims, groundingSummary } from '../lib/grounding';

const SELECTED = ['a', 'b'];

describe('groundClaims', () => {
  it('keeps a claim that cites a selected excerpt', () => {
    const [c] = groundClaims(
      [{ claim_text: 'x', section_key: '', support: 'grounded', excerpt_ids: ['a'] }],
      SELECTED,
    );
    expect(c.support).toBe('grounded');
    expect(c.excerpt_ids).toEqual(['a']);
  });

  it('downgrades a grounded claim citing an excerpt that was dropped', () => {
    const [c] = groundClaims(
      [{ claim_text: 'x', section_key: '', support: 'grounded', excerpt_ids: ['zzz'] }],
      SELECTED,
    );
    expect(c.support).toBe('unsupported');
    expect(c.excerpt_ids).toEqual([]);
  });

  it('downgrades a grounded claim citing nothing', () => {
    const [c] = groundClaims(
      [{ claim_text: 'x', section_key: '', support: 'grounded', excerpt_ids: [] }],
      SELECTED,
    );
    expect(c.support).toBe('unsupported');
  });

  it('keeps the resolvable half of a mixed citation list', () => {
    const [c] = groundClaims(
      [{ claim_text: 'x', section_key: '', support: 'grounded', excerpt_ids: ['a', 'nope', 'b'] }],
      SELECTED,
    );
    expect(c.support).toBe('grounded');
    expect(c.excerpt_ids).toEqual(['a', 'b']);
  });

  it('does not flag common knowledge as unsupported', () => {
    const [c] = groundClaims(
      [{ claim_text: 'The sky is blue.', section_key: '', support: 'common_knowledge', excerpt_ids: [] }],
      SELECTED,
    );
    expect(c.support).toBe('common_knowledge');
  });

  it('treats an unrecognised support value as unsupported rather than trusting it', () => {
    const [c] = groundClaims(
      [{ claim_text: 'x', section_key: '', support: 'definitely_true', excerpt_ids: ['a'] }],
      SELECTED,
    );
    expect(c.support).toBe('unsupported');
  });

  it('summarises the mix', () => {
    const claims = groundClaims(
      [
        { claim_text: '1', section_key: '', support: 'grounded', excerpt_ids: ['a'] },
        { claim_text: '2', section_key: '', support: 'grounded', excerpt_ids: [] },
        { claim_text: '3', section_key: '', support: 'common_knowledge', excerpt_ids: [] },
      ],
      SELECTED,
    );
    expect(groundingSummary(claims)).toEqual({
      total: 3,
      grounded: 1,
      unsupported: 1,
      common_knowledge: 1,
    });
  });
});
