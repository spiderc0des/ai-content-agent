import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { requireUser, AuthError, canViewRequest, canRunPipeline } from '@/lib/auth';
import {
  getRequest,
  getArticles,
  getCurrentVersions,
  getVersionHistory,
  getEvaluationFor,
  getVersionSources,
  getClaims,
  getSources,
  getExcerpts,
  getLatestPlan,
  getLatestAssets,
  getPublications,
  listEmailGroups,
  getReviews,
  getStageRuns,
  lockIsLive,
} from '@/lib/queries';
import { nextStage, progressOf } from '@/lib/pipeline';
import NotAuthorized from '../../NotAuthorized';
import StatusPill from '../../StatusPill';
import Workspace, { type WorkspaceData } from './Workspace';

export const dynamic = 'force-dynamic';

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) redirect('/login');
    if (err instanceof AuthError) return <NotAuthorized message={err.message} />;
    throw err;
  }

  const request = await getRequest(id);
  if (!request) notFound();
  if (!canViewRequest(user, request)) {
    return <NotAuthorized message="This request belongs to someone else." />;
  }

  // Everything the workspace needs, assembled here in the Server Component so
  // the client does no data fetching of its own.
  const [
    articles,
    versions,
    sources,
    excerpts,
    plan,
    assets,
    publications,
    reviews,
    stageRuns,
    emailGroups,
  ] = await Promise.all([
    getArticles(id),
    getCurrentVersions(id),
    getSources(id),
    getExcerpts(id),
    getLatestPlan(id),
    getLatestAssets(id),
    getPublications(id),
    getReviews(id),
    getStageRuns(id),
    listEmailGroups(),
  ]);
  // Archived groups are excluded above, but one already attached to a queued
  // publication still has to be nameable — otherwise a scheduled newsletter
  // shows a blank where its recipient list should be.
  const groupNameById = new Map(emailGroups.map((g) => [g.id, g.name]));
  // The most recent attempt, whatever it is — this is what lets the page say
  // "still running" vs. "nothing has happened in 47 minutes" without anyone
  // having to go and query the database to find out.
  const lastRun = stageRuns[stageRuns.length - 1] ?? null;

  const options: WorkspaceData['options'] = await Promise.all(
    articles.map(async (article) => {
      const version = versions.find((v) => v.article_id === article.id) ?? null;
      // These four are independent reads — none depends on another's result —
      // but they were awaited one at a time. Over a remote pooler that's
      // ~150ms of round-trip latency apiece, so per article this was ~600ms
      // of pure waiting for nothing; Promise.all bounds it to the slowest of
      // the four instead of their sum. With 3 options that was the dominant
      // cost of opening this page at all.
      const [history, evaluation, versionSources, claims] = await Promise.all([
        getVersionHistory(article.id),
        version ? getEvaluationFor(version.id) : Promise.resolve(null),
        version ? getVersionSources(version.id) : Promise.resolve([]),
        version ? getClaims(version.id) : Promise.resolve([]),
      ]);

      return {
        articleId: article.id,
        optionIndex: article.option_index,
        angle: article.angle,
        discarded: Boolean(article.discarded_at),
        version: version
          ? {
              id: version.id,
              revisionNo: version.revision_no,
              origin: version.origin,
              title: version.title,
              dek: version.dek,
              bodyMd: version.body_md,
              wordCount: version.word_count,
              seoPass: version.seo_pass,
              seoChecks:
                (version.seo_json as { checks?: { label: string; pass: boolean; detail: string; required: boolean }[] })
                  ?.checks ?? [],
              assumptions: version.assumptions,
              gaps: version.gaps,
            }
          : null,
        history: history.map((h) => ({
          id: h.id,
          revisionNo: h.revision_no,
          origin: h.origin,
          instruction: h.revision_instruction,
          wordCount: h.word_count,
          createdAt: h.created_at.toISOString(),
        })),
        evaluation: evaluation
          ? {
              status: evaluation.status,
              overallScore: Number(evaluation.overall_score),
              summary: evaluation.summary,
              scores: evaluation.scores.map((s) => ({
                criterion: s.criterion,
                score: s.score,
                note: s.note,
              })),
              unsupportedClaims: (evaluation.unsupported_claims ?? []) as {
                claim_text: string;
                why: string;
              }[],
              sectionsNeedingRevision: (evaluation.sections_needing_revision ?? []) as {
                section_key: string;
                problem: string;
              }[],
              recommendedChanges: (evaluation.recommended_changes ?? []) as string[],
            }
          : null,
        sources: versionSources,
        claims: claims.map((c) => ({
          claimText: c.claim_text,
          sectionKey: c.section_key,
          support: c.support,
        })),
      };
    }),
  );

  const data: WorkspaceData = {
    request: {
      id: request.id,
      version: request.version,
      status: request.status,
      rawIdea: request.raw_idea,
      titleHint: request.title_hint,
      targetAudience: request.target_audience,
      sourceUrl: request.source_url,
      primaryKeyword: request.primary_keyword,
      readiness: request.readiness,
      clarifyingQuestions:
        (request.audit_json as { clarifying_questions?: string[] })?.clarifying_questions ?? [],
      blockingReason: (request.audit_json as { blocking_reason?: string })?.blocking_reason ?? null,
      failedStage: request.failed_stage,
      failedReason: request.failed_reason,
      revisionRound: request.revision_round,
      maxRevisionRounds: request.max_revision_rounds,
      selectedArticleId: request.selected_article_id,
      approvedVersionId: request.approved_version_id,
      channelsWanted: request.channels_wanted,
      progress: progressOf(request.status),
      nextStage: nextStage(request),
      updatedAt: request.updated_at.toISOString(),
      running: lockIsLive(request),
      lastRun: lastRun
        ? {
            stage: lastRun.stage,
            status: lastRun.status,
            startedAt: lastRun.started_at.toISOString(),
            finishedAt: lastRun.finished_at?.toISOString() ?? null,
          }
        : null,
    },
    capabilities: {
      canRun: canRunPipeline(user, request),
      canReview: user.is_reviewer || user.is_admin,
      canPublish: user.is_publisher || user.is_admin,
    },
    plan: plan
      ? {
          primaryKeyword: plan.primary_keyword,
          secondaryKeywords: plan.secondary_keywords,
          thesis: plan.thesis,
        }
      : null,
    sourceCount: sources.length,
    excerptCount: excerpts.length,
    selectedExcerptCount: excerpts.filter((e) => e.selected).length,
    allSources: sources.map((s) => ({
      id: s.id,
      title: s.title,
      url: s.url,
      domain: s.domain,
      status: s.status,
      error: s.error,
    })),
    options,
    assets: assets.map((a) => ({
      id: a.id,
      channel: a.channel,
      assetNo: a.asset_no,
      body: a.body,
      subject: a.subject,
      preheader: a.preheader,
      cta: a.cta,
      hashtags: a.hashtags,
      rulesPass: a.rules_pass,
      rulesChecks:
        (a.rules_json as { checks?: { label: string; pass: boolean; detail: string; required: boolean }[] })
          ?.checks ?? [],
    })),
    publications: publications.map((p) => ({
      id: p.id,
      channel: p.channel,
      state: p.state,
      scheduledFor: p.scheduled_for?.toISOString() ?? null,
      publishedAt: p.published_at?.toISOString() ?? null,
      lastError: p.last_error,
      attempts: p.attempts,
      emailGroupName: p.email_group_id ? (groupNameById.get(p.email_group_id) ?? 'an archived list') : null,
      tagHandles: p.tag_handles,
      recipientCount:
        (p.recipients_json as { count?: number } | null)?.count ?? null,
    })),
    emailGroups: emailGroups.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.member_count,
    })),
    reviews: reviews.map((r) => ({
      id: r.id,
      action: r.action,
      note: r.note,
      instruction: r.instruction,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      at: r.at.toISOString(),
      by: r.reviewer_name || r.reviewer_email || 'someone',
      // Which option the decision was about. A 'select' row is ENTIRELY
      // about this — without it the entry says nothing at all.
      optionIndex:
        articles.find((a) => a.id === r.article_id)?.option_index ?? null,
    })),
  };

  return (
    <div>
      <div className="mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">
            {request.title_hint || request.raw_idea.slice(0, 80)}
          </h1>
          <StatusPill status={request.status} />
          <Link
            href={`/r/${id}/log`}
            className="btn btn-ghost btn-sm ml-auto"
          >
            Run log
          </Link>
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          For {request.target_audience}
          {request.primary_keyword && ` · keyword “${request.primary_keyword}”`}
        </p>
      </div>

      <Workspace data={data} />
    </div>
  );
}
