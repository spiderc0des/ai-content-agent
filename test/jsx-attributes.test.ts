import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A guard against a bug that reached production.
 *
 * `<a href="/login' className='btn btn-primary">` is valid TypeScript, valid
 * JSX, and compiles without a murmur — it is simply an anchor whose href is
 * the string `/login' className='btn btn-primary`. Nothing in tsc, the
 * bundler, or the test suite looks at it. The only symptom is a link that
 * 404s, and you find it by hovering.
 *
 * It came from a regex rewriting quote styles across a file: the pattern
 * matched from the CLOSING quote of one attribute to the OPENING quote of the
 * next, collapsing two attributes into one string. Any future bulk edit can
 * do the same thing, so the shape is asserted rather than trusted.
 */

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') tsxFiles(p, out);
    } else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const files = tsxFiles('app');

describe('JSX attributes', () => {
  it('finds files to check, so a broken glob cannot make this vacuously pass', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('never has one attribute swallowed into another attribute’s value', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // A quoted attribute value containing `something=` is nearly always two
      // attributes that lost the quote between them.
      for (const m of src.matchAll(
        /\s(href|src|action|value|placeholder|title|alt|id|type|rel|target)="([^"\n]*\b(?:className|href|style|onClick|id|type|rel|target|src)=[^"\n]*)"/g,
      )) {
        offenders.push(`${file}: ${m[1]}="${m[2]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps internal links as clean paths', () => {
    const bad: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\s(?:href|action)="(\/[^"\n]*)"/g)) {
        const value = m[1]!;
        // A path with a quote, a space, or an equals sign in it is not a path.
        if (/["'\s]|=/.test(value)) bad.push(`${file}: ${value}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
