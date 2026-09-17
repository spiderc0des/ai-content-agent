import { parseMarkdownSubset, type Run } from '@/lib/markdown-subset';

/**
 * Renders the markdown subset the system prompt allows, so the reviewer reads
 * the article rather than its syntax. External links open in a new tab and
 * carry rel="noreferrer" — they point at third-party sources the model found,
 * which is exactly the case that warrants it.
 */
export default function MarkdownBody({ body }: { body: string }) {
  const blocks = parseMarkdownSubset(body);

  const runs = (rs: Run[]) =>
    rs.map((r, i) => {
      const inner = r.bold ? <b key={i}>{r.text}</b> : <span key={i}>{r.text}</span>;
      if (!r.href) return inner;
      return (
        <a key={i} href={r.href} target="_blank" rel="noreferrer noopener">
          {r.text}
        </a>
      );
    });

  return (
    <div className="markdown-body">
      {blocks.map((b, i) => {
        if (b.type === 'h1') return <h1 key={i}>{b.text}</h1>;
        if (b.type === 'h2') return <h2 key={i}>{b.text}</h2>;
        if (b.type === 'h3') return <h3 key={i}>{b.text}</h3>;
        if (b.type === 'quote') return <blockquote key={i}>{runs(b.runs)}</blockquote>;
        if (b.type === 'ul') {
          return (
            <ul key={i}>
              {b.items.map((item, j) => (
                <li key={j}>{runs(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{runs(b.runs)}</p>;
      })}
    </div>
  );
}
