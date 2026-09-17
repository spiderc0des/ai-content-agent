import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { QueuePublicationSchema } from '@/lib/schemas';
import {
  getRequest,
  getLatestAssets,
  getVersion,
  queuePublication,
  syncPublishStatus,
  contentFingerprint,
  getEmailGroup,
  recipientsOf,
} from '@/lib/queries';
import { errorResponse, withEventLog } from '@/lib/api-helpers';
import { composeXPost } from '@/lib/publishers/compose';

export const dynamic = 'force-dynamic';

/**
 * POST /api/requests/:id/publish — queue approved assets for release.
 *
 * Three separate things have to be true, and each is checked by a different
 * mechanism on purpose:
 *   • the reviewer approved      — guard_publication_insert(), in the database
 *   • the text has not changed   — the content hash, here
 *   • nothing is queued twice    — publications_one_live_per_channel, an index
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const user = await requireUser('publisher');
    const row = await getRequest(id);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = QueuePublicationSchema.parse(await request.json());
    if (row.version !== body.expected_version) {
      return NextResponse.json(
        { error: 'This request changed while you were looking at it. Reload and try again.', code: 'VERSION_CONFLICT' },
        { status: 409 },
      );
    }
    if (!row.approved_version_id || !row.approved_content_hash) {
      return NextResponse.json(
        { error: 'Nothing has been approved for this request.' },
        { status: 409 },
      );
    }

    // The approved text must still be the text. A new version would have
    // revoked the approval via the trigger, but an explicit check here names
    // the problem instead of leaving a confusing 409 from a constraint.
    const approved = await getVersion(row.approved_version_id);
    if (!approved) {
      return NextResponse.json({ error: 'The approved version no longer exists.' }, { status: 409 });
    }
    if (contentFingerprint(approved.title, approved.body_md) !== row.approved_content_hash) {
      return NextResponse.json(
        { error: 'The approved content has changed since it was approved. It needs a fresh approval.' },
        { status: 409 },
      );
    }

    const assets = await getLatestAssets(id);
    const scheduledFor = body.scheduled_for ? new Date(body.scheduled_for) : null;

    // A uuid in the run log is a second lookup for whoever is reading it.
    const groupNames = new Map<string, string>();
    const groupNameFor = (gid: string | null | undefined) => (gid ? groupNames.get(gid) : null);

    const queued = await withEventLog(
      id,
      user.email,
      'queue_publications',
      async () => {
        const out = [];
        for (const channel of body.channels) {
          const asset = assets.find((a) => a.channel === channel);
          if (!asset) throw new Error(`There is no ${channel} asset to queue.`);
          if (!asset.rules_pass) {
            throw new Error(
              `The ${channel} asset does not pass its formatting rules. Regenerate it before queueing.`,
            );
          }

          // A newsletter needs somewhere to go. Checked before anything is
          // written, because a queued newsletter with no list looks correct
          // right up until release, when it silently sends to nobody.
          let emailGroupId: string | null = null;
          if (channel === 'newsletter') {
            emailGroupId = body.targets?.newsletter?.email_group_id ?? null;
            if (!emailGroupId) {
              throw new Error('Pick a recipient list before queueing the newsletter.');
            }
            const group = await getEmailGroup(emailGroupId);
            if (!group || group.archived_at) {
              throw new Error('That recipient list no longer exists.');
            }
            groupNames.set(emailGroupId, group.name);
            const recipients = await recipientsOf(emailGroupId);
            if (!recipients.length) {
              throw new Error(
                `"${group.name}" has no subscribed addresses in it, so this would send to nobody.`,
              );
            }
          }

          const tagHandles =
            channel === 'x' || channel === 'linkedin'
              ? (body.targets?.[channel]?.tag_handles ?? [])
              : [];

          // Tagged accounts are part of the post, so they are part of X's 280.
          // The asset passed its rule check before these existed, so this is
          // the first moment the real number is knowable — and the last moment
          // anyone is looking. Left to the worker, a post two characters over
          // fails at 3am, having been queued hours earlier with no sign of it.
          if (channel === 'x' && tagHandles.length) {
            const composed = composeXPost(asset.body, tagHandles);
            if (!composed.ok) throw new Error(composed.error);
          }

          out.push(
            await queuePublication({
              requestId: id,
              assetId: asset.id,
              channel,
              scheduledFor,
              queuedBy: user.id,
              emailGroupId,
              tagHandles,
            }),
          );
        }
        return out;
      },
      {
        stage: 'publishing',
        // Who each channel was aimed at, not just how many rows were written.
        // "queued: 3" tells you nothing you could not see from the queue; the
        // question anyone actually brings to the log afterwards is which list
        // a newsletter went to and who got tagged on a post.
        successDetail: (r) => ({
          queued: r.length,
          channels: r.map((p) => p.channel),
          newsletter_list:
            groupNameFor(r.find((p) => p.channel === 'newsletter')?.email_group_id) ?? undefined,
          linkedin_tagged: r.find((p) => p.channel === 'linkedin')?.tag_handles?.length
            ? r.find((p) => p.channel === 'linkedin')!.tag_handles
            : undefined,
          x_tagged: r.find((p) => p.channel === 'x')?.tag_handles?.length
            ? r.find((p) => p.channel === 'x')!.tag_handles
            : undefined,
          scheduled_for: scheduledFor?.toISOString(),
        }),
      },
    );

    const updated = await syncPublishStatus(id);
    return NextResponse.json({ publications: queued, status: updated?.status ?? row.status });
  } catch (err) {
    return errorResponse(err);
  }
}
