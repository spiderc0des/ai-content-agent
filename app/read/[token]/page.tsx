import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { createHash } from 'node:crypto';
import MarkdownBody from '../../MarkdownBody';
import { getPublicArticle, recordArticleView } from '@/lib/queries';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * The article, to anyone with the link.
 *
 * The only page in this system without a sign-in, and deliberately the
 * thinnest: a title, a standfirst, the prose. No options, no evaluation, no
 * sources panel, no author, no request id, no navigation into the app. The
 * query behind it selects the approved version and nothing else, so there is
 * no adjacent data for a future edit to leak by accident.
 *
 * It is also outside the app's own chrome. `app/layout.tsx` renders a header
 * with Review, Queue and Admin links, which would be meaningless to a reader
 * and an invitation to the curious; this route group has its own layout.
 */
export default async function ReadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const article = await getPublicArticle(token);
  if (!article) notFound();

  const headerList = await headers();

  /**
   * Who read it, without recording who.
   *
   * A salted hash of address, browser and today's date. It is enough to stop a
   * refresh counting twice, it cannot be reversed to a person, and it changes
   * every midnight so it cannot follow anyone across days. The salt is a
   * secret this deployment already has.
   */
  const fingerprint = createHash('sha256')
    .update(
      [
        env.CRON_SECRET ?? env.APP_URL,
        headerList.get('x-forwarded-for') ?? 'unknown',
        headerList.get('user-agent') ?? 'unknown',
        new Date().toISOString().slice(0, 10),
      ].join('|'),
    )
    .digest('hex');

  // A counter must never be the reason a reader sees an error.
  await recordArticleView({
    requestId: article.requestId,
    versionId: article.versionId,
    visitorDay: fingerprint,
    referrer: headerList.get('referer'),
  }).catch(() => {});

  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:py-16">
      <p
        className="mb-6 text-[11px] font-bold uppercase tracking-[0.14em]"
        style={{ color: 'var(--accent)' }}
      >
        Koya Talent
      </p>

      <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">{article.title}</h1>
      {article.dek && (
        <p className="mt-3 text-lg" style={{ color: 'var(--ink-soft)' }}>
          {article.dek}
        </p>
      )}
      <p className="mt-4 text-sm" style={{ color: 'var(--ink-faint)' }}>
        {article.publishedAt
          ? article.publishedAt.toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : ''}
        {article.wordCount ? ` · ${Math.max(1, Math.round(article.wordCount / 220))} min read` : ''}
      </p>

      <article className="markdown-body mt-8">
        <MarkdownBody body={article.bodyMd} />
      </article>
    </main>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const article = await getPublicArticle(token);
  if (!article) return { title: 'Not found' };
  return {
    title: article.title,
    description: article.dek || undefined,
    // This link gets pasted into LinkedIn and X, which render a card from it.
    openGraph: { title: article.title, description: article.dek || undefined, type: 'article' },
    // Nothing here should turn up in a search index — the article's canonical
    // home is wherever it was actually published.
    robots: { index: false, follow: false },
  };
}
