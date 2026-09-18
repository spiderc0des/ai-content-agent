import { z } from 'zod';
import { CHANNELS, RUBRIC_CRITERIA } from './schemas';

/**
 * Zod parsers for every row that comes OUT of Postgres.
 *
 * The point: a renamed or dropped column fails loudly, once, here — naming
 * the column — instead of surfacing as `undefined` in a template three
 * layers away. Every query in lib/queries.ts parses its rows through these.
 */

export const REQUEST_STATUSES = [
  'draft',
  'blocked',
  'researching',
  'retrieving',
  'selecting',
  'planning',
  'generating',
  'evaluating',
  'revising',
  'awaiting_review',
  'approved',
  'rejected',
  'packaging',
  'ready',
  'queued',
  'published',
  'failed',
  'archived',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const PIPELINE_STAGES = [
  'audit',
  'research',
  'retrieval',
  'selection',
  'planning',
  'generation',
  'evaluation',
  'revision',
  'review',
  'packaging',
  'publishing',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** The machine stages, in the order the pipeline runs them. */
export const MACHINE_STAGES = [
  'audit',
  'research',
  'retrieval',
  'selection',
  'planning',
  'generation',
  'evaluation',
] as const;

const dateish = z.coerce.date();
const nullableDate = z.coerce.date().nullable();

export const AppUserRow = z.object({
  id: z.string().uuid(),
  email: z.string(),
  full_name: z.string(),
  is_creator: z.boolean(),
  is_reviewer: z.boolean(),
  is_publisher: z.boolean(),
  is_admin: z.boolean(),
  active: z.boolean(),
  created_at: dateish,
  invited_at: nullableDate,
  invited_by: z.string().nullable(),
  first_signed_in_at: nullableDate,
});
export type AppUserRow = z.infer<typeof AppUserRow>;

export const ContentRequestRow = z.object({
  id: z.string().uuid(),
  created_at: dateish,
  updated_at: dateish,
  status: z.enum(REQUEST_STATUSES),
  version: z.number().int(),

  title_hint: z.string(),
  raw_idea: z.string(),
  target_audience: z.string(),
  source_url: z.string().nullable(),
  supporting_notes: z.string(),
  primary_keyword: z.string(),
  secondary_keywords: z.array(z.string()),
  desired_tone: z.string(),
  word_count_target: z.number().int().nullable(),
  channels_wanted: z.array(z.enum(CHANNELS)),
  option_count: z.number().int(),
  research_depth: z.enum(['quick', 'standard', 'deep']),
  deadline_at: nullableDate,

  intake_hash: z.string(),
  author_id: z.string().uuid(),

  readiness: z.enum(['ready', 'thin', 'blocked']).nullable(),
  audit_json: z.unknown().nullable(),

  failed_stage: z.enum(PIPELINE_STAGES).nullable(),
  failed_reason: z.string().nullable(),
  revision_round: z.number().int(),
  max_revision_rounds: z.number().int(),

  selected_article_id: z.string().uuid().nullable(),
  reviewer_id: z.string().uuid().nullable(),
  approved_at: nullableDate,
  approved_version_id: z.string().uuid().nullable(),
  approved_content_hash: z.string().nullable(),
  rejected_reason: z.string().nullable(),

  deleted_at: nullableDate,

  // Set while a server-side driver owns this request (lib/pipeline.ts
  // drivePipeline). See sql/06-pipeline-lock.sql for why.
  pipeline_lock_at: nullableDate,
  pipeline_lock_by: z.string().nullable(),
  pipeline_heartbeat_at: nullableDate,
});
export type ContentRequestRow = z.infer<typeof ContentRequestRow>;

export const StageRunRow = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  stage: z.enum(PIPELINE_STAGES),
  attempt: z.number().int(),
  status: z.enum(['pending', 'running', 'ok', 'failed', 'skipped']),
  started_at: dateish,
  finished_at: nullableDate,
  duration_ms: z.number().int().nullable(),
  model: z.string().nullable(),
  claude_request_id: z.string().nullable(),
  effort: z.string().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  cache_read_tokens: z.number().int().nullable(),
  cache_write_tokens: z.number().int().nullable(),
  failure_reason: z
    .enum(['refusal', 'rate_limit', 'invalid_response', 'api_error', 'validation', 'internal'])
    .nullable(),
  error: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type StageRunRow = z.infer<typeof StageRunRow>;

export const SourceRow = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  kind: z.enum(['web', 'upload', 'pasted']),
  url: z.string().nullable(),
  domain: z.string().nullable(),
  title: z.string(),
  author: z.string().nullable(),
  published_at: z.coerce.date().nullable(),
  fetched_at: nullableDate,
  discovered_by: z.string().uuid().nullable(),
  filename: z.string().nullable(),
  mime: z.string().nullable(),
  bytes: z.number().int().nullable(),
  anthropic_file_id: z.string().nullable(),
  raw_text: z.string().nullable(),
  digest_md: z.string().nullable(),
  citations_json: z.unknown().nullable(),
  status: z.enum([
    'discovered',
    'fetching',
    'fetched',
    'digesting',
    'digested',
    'failed',
    'rejected',
  ]),
  error: z.string().nullable(),
  created_at: dateish,
});
export type SourceRow = z.infer<typeof SourceRow>;

export const SourceExcerptRow = z.object({
  id: z.string().uuid(),
  source_id: z.string().uuid(),
  request_id: z.string().uuid(),
  ordinal: z.number().int(),
  quote: z.string(),
  locator: z.record(z.string(), z.unknown()),
  gist: z.string(),
  selected: z.boolean().nullable(),
  relevance: z.coerce.number().nullable(),
  selection_reason: z.string().nullable(),
  selected_by: z.string().uuid().nullable(),
});
export type SourceExcerptRow = z.infer<typeof SourceExcerptRow>;

export const ContentPlanRow = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  plan_no: z.number().int(),
  stage_run_id: z.string().uuid().nullable(),
  primary_keyword: z.string(),
  secondary_keywords: z.array(z.string()),
  thesis: z.string(),
  outline_json: z.unknown(),
  angles_json: z.unknown(),
  link_targets_json: z.unknown(),
  created_at: dateish,
});
export type ContentPlanRow = z.infer<typeof ContentPlanRow>;

export const ArticleRow = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  option_index: z.number().int(),
  angle: z.string(),
  plan_id: z.string().uuid().nullable(),
  current_version_id: z.string().uuid().nullable(),
  discarded_at: nullableDate,
  created_at: dateish,
});
export type ArticleRow = z.infer<typeof ArticleRow>;

export const ArticleVersionRow = z.object({
  id: z.string().uuid(),
  article_id: z.string().uuid(),
  request_id: z.string().uuid(),
  revision_no: z.number().int(),
  parent_version_id: z.string().uuid().nullable(),
  origin: z.enum(['generated', 'auto_revised', 'human_revised', 'human_edited']),
  revision_instruction: z.string().nullable(),
  evaluation_id: z.string().uuid().nullable(),
  title: z.string(),
  slug: z.string(),
  dek: z.string(),
  body_md: z.string(),
  word_count: z.number().int(),
  reading_time_s: z.number().int().nullable(),
  seo_json: z.record(z.string(), z.unknown()),
  seo_pass: z.boolean().nullable(),
  assumptions: z.array(z.string()),
  gaps: z.array(z.string()),
  content_hash: z.string(),
  model: z.string().nullable(),
  claude_request_id: z.string().nullable(),
  stage_run_id: z.string().uuid().nullable(),
  created_at: dateish,
  created_by: z.string().uuid().nullable(),
});
export type ArticleVersionRow = z.infer<typeof ArticleVersionRow>;

export const ArticleClaimRow = z.object({
  id: z.string().uuid(),
  version_id: z.string().uuid(),
  ordinal: z.number().int(),
  claim_text: z.string(),
  section_key: z.string(),
  support: z.enum(['grounded', 'unsupported', 'common_knowledge']),
  created_at: dateish,
});
export type ArticleClaimRow = z.infer<typeof ArticleClaimRow>;

export const EvaluationRow = z.object({
  id: z.string().uuid(),
  version_id: z.string().uuid(),
  request_id: z.string().uuid(),
  status: z.enum(['pass', 'revise', 'reject']),
  overall_score: z.coerce.number(),
  summary: z.string(),
  unsupported_claims: z.unknown(),
  sections_needing_revision: z.unknown(),
  recommended_changes: z.unknown(),
  raw_json: z.unknown(),
  model: z.string().nullable(),
  claude_request_id: z.string().nullable(),
  stage_run_id: z.string().uuid().nullable(),
  created_at: dateish,
});
export type EvaluationRow = z.infer<typeof EvaluationRow>;

export const EvaluationScoreRow = z.object({
  evaluation_id: z.string().uuid(),
  criterion: z.enum(RUBRIC_CRITERIA),
  score: z.number().int(),
  note: z.string(),
});
export type EvaluationScoreRow = z.infer<typeof EvaluationScoreRow>;

export const ReviewRow = z.object({
  id: z.coerce.number().int(),
  request_id: z.string().uuid(),
  version_id: z.string().uuid().nullable(),
  article_id: z.string().uuid().nullable(),
  action: z.enum(['approve', 'reject', 'revise', 'select']),
  note: z.string(),
  instruction: z.string().nullable(),
  reviewer_id: z.string().uuid(),
  from_status: z.enum(REQUEST_STATUSES),
  to_status: z.enum(REQUEST_STATUSES),
  at: dateish,
});
export type ReviewRow = z.infer<typeof ReviewRow>;

export const ChannelAssetRow = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  version_id: z.string().uuid(),
  channel: z.enum(CHANNELS),
  asset_no: z.number().int(),
  body: z.string(),
  subject: z.string().nullable(),
  preheader: z.string().nullable(),
  cta: z.string(),
  hashtags: z.array(z.string()),
  payload_json: z.record(z.string(), z.unknown()),
  rules_json: z.record(z.string(), z.unknown()),
  rules_pass: z.boolean(),
  edited_by: z.string().uuid().nullable(),
  model: z.string().nullable(),
  claude_request_id: z.string().nullable(),
  stage_run_id: z.string().uuid().nullable(),
  created_at: dateish,
});
export type ChannelAssetRow = z.infer<typeof ChannelAssetRow>;

export const PublicationRow = z.object({
  id: z.string().uuid(),
  request_id: z.string().uuid(),
  asset_id: z.string().uuid(),
  channel: z.enum(CHANNELS),
  state: z.enum(['queued', 'scheduled', 'publishing', 'published', 'failed', 'canceled']),
  scheduled_for: nullableDate,
  queued_by: z.string().uuid(),
  queued_at: dateish,
  locked_at: nullableDate,
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  published_at: nullableDate,
  provider: z.string().nullable(),
  provider_id: z.string().nullable(),
  external_url: z.string().nullable(),
  canceled_at: nullableDate,
  cancel_reason: z.string().nullable(),
  email_group_id: z.string().uuid().nullable(),
  tag_handles: z.array(z.string()),
  recipients_json: z.unknown().nullable(),
});
export type PublicationRow = z.infer<typeof PublicationRow>;

export const EmailGroupRow = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  created_by: z.string().uuid(),
  created_at: dateish,
  archived_at: nullableDate,
});
export type EmailGroupRow = z.infer<typeof EmailGroupRow>;

export const EmailGroupMemberRow = z.object({
  id: z.string().uuid(),
  group_id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  added_by: z.string().uuid().nullable(),
  added_at: dateish,
  unsubscribed_at: nullableDate,
});
export type EmailGroupMemberRow = z.infer<typeof EmailGroupMemberRow>;

export const EventRow = z.object({
  id: z.coerce.number().int(),
  request_id: z.string().uuid().nullable(),
  at: dateish,
  actor: z.string(),
  stage: z.enum(PIPELINE_STAGES).nullable(),
  step: z.string(),
  ok: z.boolean(),
  duration_ms: z.number().int().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type EventRow = z.infer<typeof EventRow>;
