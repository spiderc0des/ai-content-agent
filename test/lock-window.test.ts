import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockIsLive } from '../lib/queries';

const QUERIES = readFileSync(join(process.cwd(), 'lib', 'queries.ts'), 'utf8');

/**
 * One staleness window, used by both the database and the interface.
 *
 * It was written twice and the copies drifted. The reclaim window was
 * tightened from twenty minutes to three; lockIsLive() — which the delete
 * guard, the reset guard and the "Running…" badge all use — kept its own
 * hardcoded twenty. The result: the database would happily let a new driver
 * take a lock while the interface insisted the pipeline was still running on
 * it, so a request could not be deleted or reset for another seventeen
 * minutes after it was already fair game. A real request sat undeletable with
 * a heartbeat 1,182 seconds old.
 */
describe('the lock staleness window is defined once', () => {
  it('has no second hardcoded window in lockIsLive', () => {
    const at = QUERIES.indexOf('export function lockIsLive(');
    const body = QUERIES.slice(at, at + 700);
    expect(body).toContain('LOCK_STALE_AFTER_MS');
    // The literal that used to live here.
    expect(body).not.toMatch(/20 \* 60 \* 1000/);
  });

  it('derives the SQL interval from the same number', () => {
    expect(QUERIES).toMatch(/const LOCK_STALE_AFTER_MS = /);
    expect(QUERIES).toMatch(/const LOCK_STALE_AFTER = `\$\{LOCK_STALE_AFTER_MS\}/);
  });

  it('calls a lock dead once it is past that window', () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    expect(lockIsLive({ pipeline_lock_at: old, pipeline_heartbeat_at: old })).toBe(false);
  });

  it('still calls a freshly beating lock live', () => {
    const now = new Date();
    expect(lockIsLive({ pipeline_lock_at: now, pipeline_heartbeat_at: now })).toBe(true);
  });

  it('treats an unlocked request as free', () => {
    expect(lockIsLive({ pipeline_lock_at: null, pipeline_heartbeat_at: null })).toBe(false);
  });
});
