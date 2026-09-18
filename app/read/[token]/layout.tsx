/**
 * The reader's layout: no app chrome.
 *
 * The root layout renders a header with Review, Queue and Admin in it, which
 * to someone arriving from a newsletter is both meaningless and an invitation
 * to go poking. A reader gets the page and nothing else.
 */
export default function ReadLayout({ children }: { children: React.ReactNode }) {
  return <div style={{ background: 'var(--paper)', minHeight: '100vh' }}>{children}</div>;
}
