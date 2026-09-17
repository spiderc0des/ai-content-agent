import Link from 'next/link';

/**
 * Shown for a 403: the person IS signed in, so sending them to /login would
 * loop them back here. The message has to name the actual problem instead.
 */
export default function NotAuthorized({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-md">
      <div className="panel panel-warning mb-4">{message}</div>
      <Link href="/requests" className="btn">Back to requests</Link>
    </div>
  );
}
