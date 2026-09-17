const TONE: Record<string, string> = {
  draft: 'badge',
  blocked: 'badge badge-warning',
  researching: 'badge badge-accent',
  retrieving: 'badge badge-accent',
  selecting: 'badge badge-accent',
  planning: 'badge badge-accent',
  generating: 'badge badge-accent',
  evaluating: 'badge badge-accent',
  revising: 'badge badge-accent',
  awaiting_review: 'badge badge-warning',
  approved: 'badge badge-success',
  rejected: 'badge badge-danger',
  packaging: 'badge badge-accent',
  ready: 'badge badge-success',
  queued: 'badge badge-success',
  published: 'badge badge-success',
  failed: 'badge badge-danger',
  archived: 'badge',
};

const LABEL: Record<string, string> = {
  awaiting_review: 'awaiting review',
};

export default function StatusPill({ status }: { status: string }) {
  return <span className={TONE[status] ?? 'badge'}>{LABEL[status] ?? status.replace(/_/g, ' ')}</span>;
}
