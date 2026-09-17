'use client';
import { useRouter } from 'next/navigation';

/**
 * Three states, not two: light, dark, and follow-the-system.
 *
 * The cookie is what layout.tsx reads server-side, so the choice survives a
 * reload with no flash of the wrong theme. "System" is the absence of the
 * cookie rather than a value, which is why choosing it clears it.
 *
 * The icon carries the state and the label is in the tooltip: at this size a
 * word is wider than the control itself, and the three icons (sun / moon /
 * half-filled circle) are conventional enough to read without one.
 */
const ORDER = ['system', 'light', 'dark'] as const;
type Theme = (typeof ORDER)[number];

const LABEL: Record<Theme, string> = {
  system: 'Following your system theme',
  light: 'Light theme',
  dark: 'Dark theme',
};

export default function ThemeToggle({ current }: { current: string }) {
  const router = useRouter();
  const theme: Theme = (ORDER as readonly string[]).includes(current)
    ? (current as Theme)
    : 'system';
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;

  function apply() {
    // max-age 0 removes the cookie, which is what "system" means — there is
    // no stored preference to read, so the CSS media query decides.
    document.cookie =
      next === 'system'
        ? 'theme=; path=/; max-age=0'
        : `theme=${next}; path=/; max-age=31536000`;
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={apply}
      title={`${LABEL[theme]} — switch to ${next === 'system' ? 'system' : next}`}
      aria-label={`${LABEL[theme]}. Switch to ${next === 'system' ? 'system' : next} theme.`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors"
      style={{ color: 'var(--ink-soft)' }}
    >
      {theme === 'light' && (
        // Sun
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="10" cy="10" r="3.5" />
          <path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6L16 16M16 4l-1.4 1.4M5.4 14.6L4 16" />
        </svg>
      )}
      {theme === 'dark' && (
        // Moon
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <path d="M16.5 11.8A7 7 0 0 1 8.2 3.5a7 7 0 1 0 8.3 8.3z" />
        </svg>
      )}
      {theme === 'system' && (
        // Half-filled circle: neither one nor the other, i.e. whatever the OS says.
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="10" cy="10" r="7" />
          <path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor" stroke="none" />
        </svg>
      )}
    </button>
  );
}
