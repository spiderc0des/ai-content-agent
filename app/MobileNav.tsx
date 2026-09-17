'use client';
import { useState } from 'react';

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The nav links, collapsed behind a hamburger below `md` — the same links
 * stay an inline row at `md` and above (see app/layout.tsx, `hidden md:flex`).
 * The avatar is small enough to stay visible at every width, so it is not
 * duplicated in here.
 *
 * Takes the links rather than deriving them, so the desktop row and this
 * panel cannot drift apart: layout.tsx builds the list once and hands the
 * same array to both.
 */
export default function MobileNav({ links }: { links: NavLink[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors"
        style={{ color: 'var(--ink-soft)' }}
      >
        {open ? (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M4 4l12 12M16 4L4 16" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        )}
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full flex flex-col border-b px-4 py-2"
          style={{
            borderColor: 'var(--rule)',
            background: 'var(--paper)',
            boxShadow: 'var(--shadow)',
          }}
        >
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-2.5 text-sm no-underline transition-colors"
              style={{ color: 'var(--ink-soft)' }}
            >
              {l.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
