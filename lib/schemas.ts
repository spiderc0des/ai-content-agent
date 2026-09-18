import { z } from 'zod';
import {
  requiredText,
  optionalText,
  optionalHttpUrl,
  optionalFutureDate,
  futureDate,
} from './validation';

/**
 * Every shape that crosses a boundary: the intake form, and the nine
 * structured outputs Claude returns.
 *
 * These are deliberately SIMPLE: objects, strings, enums, numbers, arrays.
 * No .refine(), no .length(), no .min() on the LLM-output schemas — those do
 * not survive conversion to a JSON schema, so they either silently do nothing
 * or break the request. Every count and length rule is checked in TypeScript
 * after parsing (lib/seo.ts, lib/channel-rules.ts, lib/claude.ts), where the
 * error message can name the actual problem instead of reading
 * "invalid_response".
 */

export const CHANNELS = ['linkedin', 'x', 'newsletter'] as const;
export type Channel = (typeof CHANNELS)[number];

export const RUBRIC_CRITERIA = [
  'topic_relevance',
  'source_grounding',
  'factual_consistency',
  'audience_fit',
  'tone',
  'seo_fit',
  'channel_fit',
  'clarity',
  'completeness',
] as const;
export type RubricCriterion = (typeof RUBRIC_CRITERIA)[number];

/** Human-facing labels for the rubric, straight from the brief's asset. */
export const CRITERION_LABELS: Record<RubricCriterion, string> = {
  topic_relevance: 'Topic Relevance',
  source_grounding: 'Source Grounding',
  factual_consistency: 'Factual Consistency',
  audience_fit: 'Audience Fit',
  tone: 'Tone',
  seo_fit: 'SEO Fit',
  channel_fit: 'Channel Fit',
  clarity: 'Clarity',
  completeness: 'Completeness',
};

/* ═══════════════════════════════════════════════════════════════════════════
   Intake — what the content manager submits.

   The brief requires three fields: a raw idea, the target audience, and any
   supporting material or source URL. Everything else is ours, and optional.
   ═══════════════════════════════════════════════════════════════════════════ */

export const IntakeSchema = z.object({
  raw_idea: requiredText('The idea', 10, 4000),
  target_audience: requiredText('The target audience', 3, 300),
  source_url: optionalHttpUrl('The source URL'),
  supporting_notes: optionalText(4000),
  title_hint: optionalText(200),
  primary_keyword: optionalText(120),
  secondary_keywords: z
    .array(optionalText(120))
    .max(15, 'That is more secondary keywords than an article can use — keep it under 15.')
    .default([])
    .transform((ks) => ks.filter(Boolean)),
  desired_tone: optionalText(300),
  word_count_target: z.coerce
    .number({ message: 'The word count target has to be a number.' })
    .int('The word count target has to be a whole number.')
    .min(200, 'Under 200 words is too short to be an article.')
    .max(5000, 'Over 5000 words is longer than this pipeline writes well.')
    .nullable()
    .default(null),
  channels_wanted: z
    .array(z.enum(CHANNELS))
    .min(1, 'Pick at least one channel — otherwise there is nothing to produce.')
    .default([...CHANNELS]),
  option_count: z.coerce
    .number({ message: 'The number of options has to be a number.' })
    .int()
    .min(1, 'Ask for at least one option.')
    .max(5, 'Five options is the most this will write in one run.')
    .default(3),
  // How hard research works. The most expensive dial in the pipeline — see
  // lib/research-depth.ts for what each setting actually changes.
  research_depth: z.enum(['quick', 'standard', 'deep']).default('standard'),
  // A deadline that has already passed cannot be met, and nothing downstream
  // would ever flag it — the review queue just sorts it to the top forever.
  deadline_at: optionalFutureDate('The deadline'),
});
export type Intake = z.infer<typeof IntakeSchema>;

/** The intake as flat text, for prompts and for hashing. */
/**
 * Operator settings that describe HOW to run, not WHAT to write.
 *
 * Kept out of the prompt text. `research_depth` travels on the intake so the
 * pipeline can size its effort from it, but telling the model "research_depth:
 * quick" is noise at best — it is an instruction to this system, not context
 * about the article.
 */
const NOT_FOR_THE_MODEL = new Set([
  // How hard research works. An instruction to this system, not context
  // about the article.
  'research_depth',

  // How many articles the PIPELINE will produce, by making this many separate
  // calls. A single writer is producing one article and has no use for it —
  // and telling it otherwise produced exactly the failure you would expect:
  // an article containing a section headed "Editor's Note: Why This Is One
  // Article, Not Three Options", addressed to whoever commissioned the work
  // rather than to the reader.
  //
  // The planner still gets the count, because planning N distinct angles is
  // genuinely its job — but it receives it as an explicit argument to
  // planPrompt(), not smuggled in through the intake text every call shares.
  'option_count',
]);

export function intakeAsText(intake: Partial<Intake>): string {
  return Object.entries(intake)
    .filter(([k]) => !NOT_FOR_THE_MODEL.has(k))
    .map(([k, v]) => {
      const value = Array.isArray(v) ? v.join(', ') : v;
      return `${k}: ${value === null || value === undefined || value === '' ? '(not given)' : value}`;
    })
    .join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
   0 · Pre-flight audit
   ═══════════════════════════════════════════════════════════════════════════ */

export const RequestAuditSchema = z.object({
  readiness: z.enum(['ready', 'thin', 'blocked']),
  fields: z.array(
    z.object({
      key: z.string(),
      verdict: z.enum(['sufficient', 'thin', 'missing']),
      why: z.string(),
    }),
  ),
  suggested_primary_keyword: z.string().nullable(),
  suggested_secondary_keywords: z.array(z.string()),
  clarifying_questions: z.array(z.string()),
  blocking_reason: z.string().nullable(),
});
export type RequestAudit = z.infer<typeof RequestAuditSchema>;

/* ═══════════════════════════════════════════════════════════════════════════
   3 · Source selection — "choose the sources or excerpts that matter"
   ═══════════════════════════════════════════════════════════════════════════ */

export const SelectionSchema = z.object({
  selections: z.array(
    z.object({
      excerpt_id: z.string(),
      keep: z.boolean(),
      relevance: z.number(),
      reason: z.string(),
    }),
  ),
  coverage_gaps: z.array(z.string()), // what the sources do NOT cover
});
export type Selection = z.infer<typeof SelectionSchema>;

/* ═══════════════════════════════════════════════════════════════════════════
   4 · Plan
   ═══════════════════════════════════════════════════════════════════════════ */

export const ContentPlanSchema = z.object({
  primary_keyword: z.string(),
  secondary_keywords: z.array(z.string()),
  thesis: z.string(),
  outline: z.array(
    z.object({
      h2: z.string(),
      h3s: z.array(z.string()),
      key_points: z.array(z.string()),
      excerpt_ids: z.array(z.string()),
    }),
  ),
  angles: z.array(
    z.object({
      option_index: z.number(),
      angle: z.string(),
      why_it_differs: z.string(),
    }),
  ),
  link_targets: z.array(
    z.object({
      url: z.string(),
      anchor: z.string(),
      kind: z.enum(['internal', 'external']),
    }),
  ),
});
export type ContentPlan = z.infer<typeof ContentPlanSchema>;

/* ═══════════════════════════════════════════════════════════════════════════
   5 / 7 · Article draft and revision — the same shape, so a revision is
   substitutable for a generation everywhere downstream.
   ═══════════════════════════════════════════════════════════════════════════ */

export const ArticleDraftSchema = z.object({
  title: z.string(),
  dek: z.string(),
  body_md: z.string(),
  claims: z.array(
    z.object({
      claim_text: z.string(),
      section_key: z.string(),
      support: z.enum(['grounded', 'unsupported', 'common_knowledge']),
      excerpt_ids: z.array(z.string()),
    }),
  ),
  assumptions: z.array(z.string()),
  gaps: z.array(z.string()),
});
export type ArticleDraft = z.infer<typeof ArticleDraftSchema>;

/* ═══════════════════════════════════════════════════════════════════════════
   6 · Evaluation — the rubric from the brief, as an enum so a missing or
   invented criterion is a parse failure rather than a hole in the UI.
   ═══════════════════════════════════════════════════════════════════════════ */

export const EvaluationSchema = z.object({
  status: z.enum(['pass', 'revise', 'reject']),
  overall_score: z.number(),
  summary: z.string(),
  scores: z.array(
    z.object({
      criterion: z.enum(RUBRIC_CRITERIA),
      score: z.number(),
      note: z.string(),
    }),
  ),
  unsupported_claims: z.array(z.object({ claim_text: z.string(), why: z.string() })),
  sections_needing_revision: z.array(z.object({ section_key: z.string(), problem: z.string() })),
  recommended_changes: z.array(z.string()),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

/* ═══════════════════════════════════════════════════════════════════════════
   8 · Channel packaging — one schema per channel, because the formatting
   rules differ structurally, not just in length.
   ═══════════════════════════════════════════════════════════════════════════ */

// PAS: problem, agitation, solution — required by the brief's LinkedIn rules.
export const LinkedInSchema = z.object({
  hook: z.string(),
  problem: z.string(),
  agitation: z.string(),
  solution: z.string(),
  bullets: z.array(z.string()),
  cta: z.string(),
  body: z.string(), // the assembled post, as it would be pasted
});
export type LinkedInPost = z.infer<typeof LinkedInSchema>;

export const XPostSchema = z.object({
  hook: z.string(),
  single_idea: z.string(),
  body: z.string(),
  hashtags: z.array(z.string()),
});
export type XPost = z.infer<typeof XPostSchema>;

export const NewsletterSchema = z.object({
  subject: z.string(),
  preheader: z.string(),
  intro: z.string(),
  main_section_md: z.string(),
  secondary_item_md: z.string().nullable(),
  cta: z.string(),
  sign_off: z.string(),
  body_md: z.string(), // the assembled newsletter
});
export type Newsletter = z.infer<typeof NewsletterSchema>;

export const CHANNEL_SCHEMAS = {
  linkedin: LinkedInSchema,
  x: XPostSchema,
  newsletter: NewsletterSchema,
} as const;

/* ═══════════════════════════════════════════════════════════════════════════
   Request bodies for the route handlers.
   ═══════════════════════════════════════════════════════════════════════════ */

export const ReviewActionSchema = z
  .object({
    action: z.enum(['approve', 'reject', 'revise', 'select']),
    article_id: z.string().uuid().nullable().default(null),
    version_id: z.string().uuid().nullable().default(null),
    note: optionalText(2000),
    instruction: optionalText(2000),
    expected_version: z.coerce.number().int().positive(),
  })
  // Checked here rather than in the database alone so the message names the
  // problem before a round trip. The CHECK constraints in 01-schema.sql are
  // still the floor.
  .refine((v) => v.action !== 'revise' || v.instruction.length > 0, {
    message: 'a revise needs an instruction saying what to change',
    path: ['instruction'],
  })
  .refine((v) => v.action !== 'select' || Boolean(v.article_id), {
    message: 'a select needs the article option being chosen',
    path: ['article_id'],
  })
  .refine((v) => v.action !== 'reject' || v.note.length > 0, {
    message: 'a reject needs a reason',
    path: ['note'],
  });
export type ReviewActionInput = z.infer<typeof ReviewActionSchema>;

/**
 * Who each channel's post is aimed at, chosen when it is queued.
 *
 * Keyed by channel rather than flat, because the two kinds of targeting are
 * not interchangeable and a flat `{ email_group_id, tag_handles }` would let a
 * caller attach a recipient list to an X post. The database refuses that too;
 * this makes the shape unable to express it in the first place.
 */
export const PublishTargetsSchema = z
  .object({
    newsletter: z
      .object({ email_group_id: z.string().uuid('Pick a recipient list.').nullable().optional() })
      .optional(),
    linkedin: z.object({ tag_handles: z.array(z.string()).max(10).optional() }).optional(),
    x: z.object({ tag_handles: z.array(z.string()).max(10).optional() }).optional(),
  })
  .optional();

export const QueuePublicationSchema = z.object({
  channels: z
    .array(z.enum(CHANNELS))
    .min(1, 'Pick at least one channel to publish.'),
  targets: PublishTargetsSchema,
  // Null means "release at the next worker tick", which is a real choice.
  // A date in the PAST is not: it looks like scheduling and behaves like
  // publishing immediately, which is the one thing a person scheduling
  // something is trying not to do.
  scheduled_for: z
    .union([futureDate('The publish time'), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v ? v : null)),
  expected_version: z.coerce.number().int().positive(),
});
