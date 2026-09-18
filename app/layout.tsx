import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { cookies, headers } from 'next/headers';
import './globals.css';
import { sessionEmail, currentUser } from '@/lib/auth';
import { PATHNAME_HEADER } from '@/lib/verified-identity';
import MobileNav, { type NavLink } from './MobileNav';
import ThemeToggle from './ThemeToggle';

const font = Plus_Jakarta_Sans({ subsets: ['latin'], display: 'swap' });

export const metadata: Metadata = {
  title: 'Koya Content Agent',
  description: 'From a raw idea to reviewed, channel-ready content.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Two different questions, and the difference matters: is there a session
  // at all (sessionEmail), and is it an activated app_users row
  // (currentUser). Someone pending has the first and not the second — and
  // they still need the header, because that is where "sign out" lives.
  const [email, user, cookieStore, headerList] = await Promise.all([
    sessionEmail(),
    currentUser(),
    cookies(),
    headers(),
  ]);

  // The public article page is the one surface with no sign-in, and it gets no
  // app chrome: a header offering Review, Queue and Admin is meaningless to
  // someone arriving from a newsletter, and reads as an invitation to poke at
  // a tool that is not theirs.
  const isReaderPage = (headerList.get(PATHNAME_HEADER) ?? '').startsWith('/read/');
  const initial = email ? email[0]!.toUpperCase() : '?';

  const theme = cookieStore.get('theme')?.value;

  // Built once and handed to BOTH the desktop row and the mobile panel, so
  // the two cannot drift apart as capabilities change.
  const links: NavLink[] = user
    ? [
        { href: '/new', label: 'New request' },
        { href: '/requests', label: user.is_admin ? 'All requests' : 'My requests' },
        ...(user.is_reviewer || user.is_admin ? [{ href: '/review', label: 'Review' }] : []),
        ...(user.is_publisher || user.is_admin ? [{ href: '/queue', label: 'Queue' }] : []),
        ...(user.is_admin ? [{ href: '/admin', label: 'Admin' }] : []),
      ]
    : [];

  return (
    <html lang="en" data-theme={theme === 'dark' || theme === 'light' ? theme : undefined}>
      <body className={font.className}>
        {!isReaderPage && (
        <header
          className="sticky top-0 z-10 border-b"
          style={{ borderColor: 'var(--rule)', background: 'var(--card)' }}
        >
          {/* Full-bleed on purpose: the bar uses the whole window width, and
              the wordmark and nav sit at its outer edges rather than tucked
              into the content column. */}
          <div className="flex w-full items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <a
              href={email ? '/requests' : '/login'}
              className="flex shrink-0 items-center gap-2 font-semibold tracking-tight no-underline"
              style={{ color: 'var(--ink)' }}
            >
              <span
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold text-white"
                style={{ background: 'var(--accent)' }}
              >
                K
              </span>
              {/* The wordmark is the first thing to go on a narrow screen — the
                mark alone still identifies the app. */}
              <span className="hidden sm:inline">Koya Content Agent</span>
            </a>

            {email ? (
              <div className="flex items-center gap-1">
                <nav className="hidden items-center gap-1 text-sm md:flex">
                  {links.map((l) => (
                    <a
                      key={l.href}
                      href={l.href}
                      className="rounded-md px-3 py-1.5 no-underline transition-colors hover:underline"
                      style={{ color: 'var(--ink-soft)' }}
                    >
                      {l.label}
                    </a>
                  ))}
                </nav>
                <MobileNav links={links} />
                <span className="ml-2 inline-flex">
                  <ThemeToggle current={theme ?? 'system'} />
                </span>
                <a
                  href="/profile"
                  title={email}
                  className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold no-underline transition-colors"
                  style={{ borderColor: 'var(--rule)', color: 'var(--ink-soft)' }}
                >
                  {initial}
                </a>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <ThemeToggle current={theme ?? 'system'} />
                <a href="/login" className="btn btn-primary">
                  Sign in
                </a>
              </div>
            )}
          </div>
        </header>
        )}

        {/* Wide enough for the request workspace to use columns; the list
            pages re-narrow themselves. The reader page brings its own. */}
        {isReaderPage ? (
          children
        ) : (
          <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">{children}</main>
        )}
      </body>
    </html>
  );
}
