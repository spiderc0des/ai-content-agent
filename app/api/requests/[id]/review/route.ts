import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { requireUser, canReview } from '@/lib/auth';
import { ReviewActionSchema } from '@/lib/schemas';
import {
  getRequest,
  getArticles,
  getVersion,
  getCurrentVersions,
  recordReview,
  contentFingerprint,
  claimPipelineLock,
} from '@/lib/queries';
import { driveAndContinue } from '@/lib/continue-run';
import { errorResponse, withEventLog } from '@/lib/api-helpers';
import type { RequestStatus } from '@/lib/db-schemas';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/requests/:id/review — the human gate.
 *
 * All four actions the brief requires live here: approve, reject, revise, and
 * select. Nothing publishes or schedules without passing through an approve.
 *
 * This route computes the target status and hands everything to
 * recordReview(), which writes the transition and the audit row in one
 * transaction. The rules that must never be bypassed — approve only from
 * awaiting_review, approve only with a selected option, approve only with the
 * exact version and hash recorded — are enforced by guard_content_approval()
 * in the database, so they hold even if this file has a bug.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const user = await requireUser('reviewer');
    const row = await getRequest(id);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = ReviewActionSchema.parse(await request.json());

    if (!canReview(row, body.action)) {
      return NextResponse.json(
        {
          error: `Cannot '${body.action}' a request that is '${row.status}'. Reviews happen while a request is awaiting review.`,
        },
        { status: 409 },
      );
    }

    // Which option is being acted on. `select` names it explicitly; the other
    // actions inherit whatever was selected earlier.
    const articleId = body.article_id ?? row.selected_article_id;

    // …and which exact text. A review always refers to a specific version, so
    // the audit trail records what the reviewer was actually looking at.
    const versionId = await resolveVersionId(id, articleId, body.version_id);

    if (body.action === 'approve') {
      if (!articleId) {
        return NextResponse.json(
          { error: 'Select which article option you are approving first.' },
          { status: 400 },
        );
      }
      if (!versionId) {
        return NextResponse.json(
          { error: 'That option has no draft to approve.' },
          { status: 400 },
        );
      }
    }

    const toStatus: RequestStatus =
      body.action === 'approve'
        ? 'approved'
        : body.action === 'reject'
          ? 'rejected'
          : body.action === 'revise'
            ? 'revising'
            : 'awaiting_review'; // 'select' leaves the request at the gate

    // The fingerprint of exactly what was approved. Re-checked before
    // publishing, and invalidated by the revoke-approval trigger if anyone
    // writes a new version afterwards.
    let approvedContentHash: string | null = null;
    if (body.action === 'approve' && versionId) {
      const version = await getVersion(versionId);
      if (!version) {
        return NextResponse.json({ error: 'That version no longer exists.' }, { status: 409 });
      }
      approvedContentHash = contentFingerprint(version.title, version.body_md);
    }

    const { request: updated, review } = await withEventLog(
      id,
      user.email,
      `review_${body.action}`,
      async () =>
        recordReview({
          requestId: id,
          reviewerId: user.id,
          action: body.action,
          articleId,
          versionId,
          note: body.note,
          instruction: body.action === 'revise' ? body.instruction : null,
          expectedVersion: body.expected_version,
          toStatus,
          approvedContentHash,
        }),
      {
        stage: 'review',
        successDetail: (r) => ({
          action: body.action,
          from: r.review.from_status,
          to: r.review.to_status,
        }),
      },
    );

    // Both of these hand back to the machine, so hand back to the machine
    // rather than parking the request and waiting for another click:
    //
    //   revise  → rewrite, then re-evaluate, then back to review
    //   approve → produce the three channel assets
    //
    // The whole point of the review gate is that it is the ONE place a person
    // is needed. Making them click again afterwards to start work that needs
    // no further input from them is just a second gate with no decision in it.
    if (body.action === 'revise' || body.action === 'approve') {
      const claimed = await claimPipelineLock(id, user.email);
      if (claimed) {
        after(async () => {
          await driveAndContinue(id, user.email);
        });
      }
      return NextResponse.json({
        review,
        request: updated,
        continuing: Boolean(claimed),
        message: claimed
          ? body.action === 'approve'
            ? 'Approved. Preparing the channel assets now.'
            : 'Revising now — this will come back for review.'
          : 'Approved, but the pipeline is already busy; it will pick this up.',
      });
    }

    return NextResponse.json({ review, request: updated });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * The version a review refers to: the one the client named if it named one,
 * otherwise the current version of the option being acted on.
 */
async function resolveVersionId(
  requestId: string,
  articleId: string | null,
  named: string | null,
): Promise<string | null> {
  if (named) return named;
  if (!articleId) return null;

  const articles = await getArticles(requestId);
  const article = articles.find((a) => a.id === articleId);
  if (article?.current_version_id) return article.current_version_id;

  const versions = await getCurrentVersions(requestId);
  return versions.find((v) => v.article_id === articleId)?.id ?? null;
}
