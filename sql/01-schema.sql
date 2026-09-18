-- ════════════════════════════════════════════════════════════════════════════
-- Koya Content Agent — schema
--
-- Run this first, in the Supabase SQL editor. Idempotent: safe to re-run.
-- Then 02-triggers.sql, then 03-seed-users.sql, then 04-verify.sql.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─── Enums ──────────────────────────────────────────────────────────────────

-- The request lifecycle. One dimension: where in the pipeline this is.
-- There is exactly one `failed` status, not research_failed/generation_failed/…
-- Which stage died lives in content_requests.failed_stage, the stage_runs row,
-- and the events row. Eleven failure statuses would multiply the transition
-- table by eleven and teach nobody anything the stage column doesn't.
do $$ begin create type request_status as enum (
  'draft',            -- intake saved, nothing run
  'blocked',          -- pre-flight audit says the intake cannot be worked
  'researching',
  'retrieving',
  'selecting',
  'planning',
  'generating',
  'evaluating',
  'revising',         -- machine or human-instructed rewrite loop
  'awaiting_review',  -- THE HUMAN GATE. Everything above is machine-driven.
  'approved',
  'rejected',
  'packaging',        -- channel assets being produced
  'ready',            -- assets exist, nothing queued yet
  'queued',           -- >=1 publication row queued/scheduled
  'published',        -- every queued publication reached 'published'
  'failed',           -- a stage died; failed_stage says which
  'archived'
); exception when duplicate_object then null; end $$;

do $$ begin create type pipeline_stage as enum (
  'audit','research','retrieval','selection','planning',
  'generation','evaluation','revision','review','packaging','publishing'
); exception when duplicate_object then null; end $$;

do $$ begin create type run_status as enum ('pending','running','ok','failed','skipped');
exception when duplicate_object then null; end $$;

do $$ begin create type eval_status as enum ('pass','revise','reject');
exception when duplicate_object then null; end $$;

do $$ begin create type review_action as enum ('approve','reject','revise','select');
exception when duplicate_object then null; end $$;

do $$ begin create type channel as enum ('linkedin','x','newsletter');
exception when duplicate_object then null; end $$;

do $$ begin create type publication_state as enum (
  'queued','scheduled','publishing','published','failed','canceled'
); exception when duplicate_object then null; end $$;

do $$ begin create type rubric_criterion as enum (
  'topic_relevance','source_grounding','factual_consistency','audience_fit',
  'tone','seo_fit','channel_fit','clarity','completeness'
); exception when duplicate_object then null; end $$;

do $$ begin create type claim_support as enum ('grounded','unsupported','common_knowledge');
exception when duplicate_object then null; end $$;

do $$ begin create type source_kind as enum ('web','upload','pasted');
exception when duplicate_object then null; end $$;

-- ─── People ─────────────────────────────────────────────────────────────────

-- The allowlist. Supabase Auth will create a session for ANY email that asks
-- for a magic link; this table is what actually gates access. Capabilities are
-- independent booleans, not an exclusive role enum — a person can hold any
-- combination.
create table if not exists app_users (
  id                 uuid primary key,          -- matches auth.users.id
  email              text not null unique,
  full_name          text not null default '',
  is_creator         boolean not null default true,   -- submit requests, run the pipeline
  is_reviewer        boolean not null default false,  -- approve/reject/revise/select
  is_publisher       boolean not null default false,  -- queue/schedule/publish
  is_admin           boolean not null default false,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  invited_at         timestamptz,
  invited_by         text,
  first_signed_in_at timestamptz,
  constraint app_users_active_needs_a_capability
    check (not active or is_creator or is_reviewer or is_publisher or is_admin)
);

-- ─── The request ────────────────────────────────────────────────────────────

create table if not exists content_requests (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  status              request_status not null default 'draft',
  version             int not null default 1,   -- optimistic lock

  -- intake: the input of record, denormalised on purpose
  title_hint          text not null default '',
  raw_idea            text not null,
  target_audience     text not null,
  source_url          text,
  supporting_notes    text not null default '',
  primary_keyword     text not null default '', -- may be empty; the planner proposes one
  secondary_keywords  text[] not null default '{}',
  desired_tone        text not null default '',
  word_count_target   int,
  channels_wanted     channel[] not null default '{linkedin,x,newsletter}',
  option_count        int not null default 3 check (option_count between 1 and 5),
  deadline_at         timestamptz,

  intake_hash         text not null,
  author_id           uuid not null references app_users(id),

  -- pre-flight audit
  readiness           text check (readiness in ('ready','thin','blocked')),
  audit_json          jsonb,

  -- pipeline bookkeeping
  failed_stage        pipeline_stage,
  failed_reason       text,
  revision_round      int not null default 0,
  -- One, not two. Measured over real runs: the FIRST revision raised the
  -- evaluation score every single time (19/19, +0.40 average). The second
  -- raised it by +0.13 and failed to improve 6 times in 16 — while costing a
  -- revision call and a re-evaluation, about four minutes of the run, on every
  -- request. Raise it per request when the topic is worth the wait.
  max_revision_rounds int not null default 1,

  -- the human gate's outputs
  selected_article_id   uuid,      -- FK added after articles exists (circular)
  reviewer_id           uuid references app_users(id),
  approved_at           timestamptz,
  approved_version_id   uuid,      -- the exact article_version approved
  approved_content_hash text,
  rejected_reason       text,

  deleted_at          timestamptz  -- soft delete: a hard delete would fight the
                                   -- immutable events/versions tables
);
create index if not exists content_requests_status_idx  on content_requests (status, updated_at desc);
create index if not exists content_requests_author_idx  on content_requests (author_id, updated_at desc);

-- ─── Stage runs — the debuggability spine ───────────────────────────────────

-- Why this exists when `events` already does: events is narrative and has no
-- uniqueness or query shape for "is research done for this request?".
-- stage_runs is the resumable state of the pipeline — a retry is attempt + 1,
-- never an overwrite — and it carries the Claude request id, effort, and token
-- counts per stage, so a bad output traces back to one API call.
create table if not exists stage_runs (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references content_requests(id) on delete cascade,
  stage             pipeline_stage not null,
  attempt           int not null default 1,
  status            run_status not null default 'pending',
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  duration_ms       int,
  model             text,
  claude_request_id text,
  effort            text,
  input_tokens      int,
  output_tokens     int,
  cache_read_tokens int,
  cache_write_tokens int,
  failure_reason    text check (failure_reason in
                      ('refusal','rate_limit','invalid_response','api_error','validation','internal')),
  error             text,
  detail            jsonb not null default '{}',
  unique (request_id, stage, attempt)
);
create index if not exists stage_runs_request_idx on stage_runs (request_id, started_at);
create index if not exists stage_runs_failed_idx  on stage_runs (status, started_at desc) where status = 'failed';

-- ─── Sources, excerpts, selection ───────────────────────────────────────────
-- Three concerns, three failure modes: "found it", "read it", "decided it
-- matters".

create table if not exists sources (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references content_requests(id) on delete cascade,
  kind           source_kind not null,
  url            text,
  domain         text,
  title          text not null default '',
  author         text,
  published_at   date,
  fetched_at     timestamptz,
  -- which stage_run discovered it, so "where did this come from" is
  -- answerable without reading logs
  discovered_by  uuid references stage_runs(id),
  filename       text,
  mime           text,
  bytes          int,
  anthropic_file_id text,
  raw_text       text,
  digest_md      text,          -- Claude's relevance-only read
  citations_json jsonb,
  status         text not null default 'discovered'
                   check (status in ('discovered','fetching','fetched','digesting','digested','failed','rejected')),
  error          text,
  created_at     timestamptz not null default now(),
  unique (request_id, url)      -- the same URL found twice is one source
);
create index if not exists sources_request_idx on sources (request_id, created_at);

-- Excerpts are EXACT quotes with the API's own char_location/page_location
-- locator. That is what makes source grounding checkable rather than asserted:
-- an unsupported-claim finding can point at the absence of a matching excerpt.
create table if not exists source_excerpts (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references sources(id) on delete cascade,
  request_id       uuid not null references content_requests(id) on delete cascade,
  ordinal          int not null,
  quote            text not null,               -- exact text, never a paraphrase
  locator          jsonb not null default '{}',
  gist             text not null default '',    -- one-line why-this-matters
  -- filled by the selection stage; null = never considered
  selected         boolean,
  relevance        numeric(3,2) check (relevance between 0 and 1),
  selection_reason text,
  selected_by      uuid references stage_runs(id),
  unique (source_id, ordinal)
);
create index if not exists source_excerpts_selected_idx on source_excerpts (request_id) where selected;

-- ─── Plan ───────────────────────────────────────────────────────────────────

-- Append-only. A re-plan after a human "revise" writes plan_no + 1; every
-- article version records which plan it was written against, so "why does
-- draft 2 have a different structure" is answerable.
create table if not exists content_plans (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references content_requests(id) on delete cascade,
  plan_no            int not null,
  stage_run_id       uuid references stage_runs(id),
  primary_keyword    text not null,
  secondary_keywords text[] not null default '{}',
  thesis             text not null,
  outline_json       jsonb not null,               -- [{h2, h3s[], key_points[], excerpt_ids[]}]
  angles_json        jsonb not null,               -- one entry per article option
  link_targets_json  jsonb not null default '[]',
  created_at         timestamptz not null default now(),
  unique (request_id, plan_no)
);

-- ─── Articles: the multi-option + revision-history core ─────────────────────

-- The option. Identity only: "the contrarian angle". Never holds prose, so
-- option 2 stays option 2 across all its revisions and the UI tabs never
-- reshuffle.
create table if not exists articles (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references content_requests(id) on delete cascade,
  option_index       int not null,
  angle              text not null,
  plan_id            uuid references content_plans(id),
  current_version_id uuid,                  -- pointer, not content; FK added below
  discarded_at       timestamptz,           -- reviewer set this option aside
  created_at         timestamptz not null default now(),
  unique (request_id, option_index)
);

-- The prose. INSERT-ONLY, enforced by a trigger in 02-triggers.sql. A human
-- edit in the review UI is an INSERT with origin='human_edited', not an
-- UPDATE. This is what preserves review history (PRD test 4) without a
-- separate history table — and it means evaluations, claims, and channel
-- assets can all point at a version_id that can never change.
create table if not exists article_versions (
  id                   uuid primary key default gen_random_uuid(),
  article_id           uuid not null references articles(id) on delete cascade,
  request_id           uuid not null references content_requests(id) on delete cascade,
  revision_no          int not null,          -- 1 = first generation
  parent_version_id    uuid references article_versions(id),
  origin               text not null check (origin in
                         ('generated','auto_revised','human_revised','human_edited')),
  revision_instruction text,
  evaluation_id        uuid,                  -- the eval that triggered this rewrite

  title          text not null,
  slug           text not null default '',
  dek            text not null default '',
  body_md        text not null,               -- H1 + H2/H3 markdown, the whole article
  word_count     int not null default 0,
  reading_time_s int,

  seo_json       jsonb not null default '{}', -- OUR deterministic check, not Claude's
  seo_pass       boolean,
  assumptions    jsonb not null default '[]',
  gaps           jsonb not null default '[]',

  content_hash      text not null,
  model             text,
  claude_request_id text,
  stage_run_id      uuid references stage_runs(id),
  created_at        timestamptz not null default now(),
  created_by        uuid references app_users(id),  -- null for machine revisions
  unique (article_id, revision_no)
);
create index if not exists article_versions_request_idx on article_versions (request_id, created_at desc);

do $$ begin
  alter table articles add constraint articles_current_version_fk
    foreign key (current_version_id) references article_versions(id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table content_requests add constraint requests_selected_article_fk
    foreign key (selected_article_id) references articles(id);
exception when duplicate_object then null; end $$;

-- ─── Source → claim attribution (per version) ───────────────────────────────
-- Per version, because a rewrite changes which sources back which sentence.
--
-- Claims are produced BY the generation call as structured output, not
-- extracted afterwards by a second model pass: a model asked to enumerate its
-- claims and point each at an excerpt id produces far better grounding than a
-- post-hoc extractor guessing at sentence boundaries. It is not
-- self-certifying — the evaluator independently returns unsupported_claims,
-- and a claim whose excerpt_ids don't resolve to selected excerpts of this
-- request is downgraded in TypeScript before insert.
create table if not exists article_claims (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references article_versions(id) on delete cascade,
  ordinal     int not null,
  claim_text  text not null,               -- the sentence as it appears in body_md
  section_key text not null default '',    -- which H2 it sits under
  support     claim_support not null,
  created_at  timestamptz not null default now(),
  unique (version_id, ordinal)
);

create table if not exists claim_citations (
  claim_id   uuid not null references article_claims(id) on delete cascade,
  excerpt_id uuid not null references source_excerpts(id),
  source_id  uuid not null references sources(id),
  quote      text not null,   -- the evidence as it stood when the claim was written
  primary key (claim_id, excerpt_id)
);
create index if not exists claim_citations_source_idx on claim_citations (source_id);

-- Coarse rollup for the "which sources informed this output" UI, so the
-- byline doesn't need a three-way join per render.
create table if not exists article_version_sources (
  version_id  uuid not null references article_versions(id) on delete cascade,
  source_id   uuid not null references sources(id),
  claim_count int not null default 0,
  primary key (version_id, source_id)
);

-- ─── Evaluation ─────────────────────────────────────────────────────────────

-- unique (version_id) is the whole "history is preserved" story on this side:
-- you cannot re-score a version, only score a NEW one. A flaky evaluation call
-- is retried as a new stage_runs attempt, so this row is inserted only after a
-- successful parse — never as a placeholder.
create table if not exists evaluations (
  id            uuid primary key default gen_random_uuid(),
  version_id    uuid not null references article_versions(id) on delete cascade,
  request_id    uuid not null references content_requests(id) on delete cascade,
  status        eval_status not null,
  overall_score numeric(4,2) not null,
  summary       text not null default '',
  unsupported_claims        jsonb not null default '[]',
  sections_needing_revision jsonb not null default '[]',
  recommended_changes       jsonb not null default '[]',
  raw_json      jsonb not null,
  model             text,
  claude_request_id text,
  stage_run_id      uuid references stage_runs(id),
  created_at    timestamptz not null default now(),
  unique (version_id)
);

-- Normalised so "how did Source Grounding trend across three revisions" is a
-- query, not a jsonb dig.
create table if not exists evaluation_scores (
  evaluation_id uuid not null references evaluations(id) on delete cascade,
  criterion     rubric_criterion not null,
  score         int not null check (score between 1 and 5),
  note          text not null default '',
  primary key (evaluation_id, criterion)
);

-- ─── Human review (append-only) ─────────────────────────────────────────────

create table if not exists reviews (
  id          bigserial primary key,
  request_id  uuid not null references content_requests(id) on delete cascade,
  version_id  uuid references article_versions(id),  -- what they were looking at
  article_id  uuid references articles(id),          -- for 'select'
  action      review_action not null,
  note        text not null default '',
  instruction text,
  reviewer_id uuid not null references app_users(id),
  from_status request_status not null,
  to_status   request_status not null,
  at          timestamptz not null default now(),
  constraint revise_needs_an_instruction
    check (action <> 'revise' or coalesce(instruction,'') <> ''),
  constraint select_needs_an_article
    check (action <> 'select' or article_id is not null)
);
create index if not exists reviews_request_idx on reviews (request_id, id desc);

-- ─── Channel assets ─────────────────────────────────────────────────────────
-- Append-only for the same reason article versions are: an asset that was
-- queued must still read as it did when it was queued.
create table if not exists channel_assets (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references content_requests(id) on delete cascade,
  version_id   uuid not null references article_versions(id),  -- the approved one
  channel      channel not null,
  asset_no     int not null,               -- regeneration = asset_no + 1
  body         text not null,
  subject      text,                       -- newsletter only
  preheader    text,
  cta          text not null default '',
  hashtags     text[] not null default '{}',
  payload_json jsonb not null default '{}',-- the structure Claude returned (PAS parts etc.)
  rules_json   jsonb not null default '{}',-- OUR deterministic rule check results
  rules_pass   boolean not null default false,
  edited_by    uuid references app_users(id),
  model             text,
  claude_request_id text,
  stage_run_id      uuid references stage_runs(id),
  created_at   timestamptz not null default now(),
  unique (request_id, channel, asset_no),
  constraint x_hashtag_cap check (
    channel <> 'x' or array_length(hashtags,1) is null or array_length(hashtags,1) <= 2),
  constraint newsletter_needs_subject check (
    channel <> 'newsletter' or coalesce(subject,'') <> '')
);

-- ─── Publishing queue ───────────────────────────────────────────────────────
-- Scheduling is a column, not a table: "scheduled" is a queue row with a
-- future timestamp. A second table would need the same uniqueness, the same
-- retry columns, and the same cron.
create table if not exists publications (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references content_requests(id) on delete cascade,
  asset_id      uuid not null references channel_assets(id),
  channel       channel not null,
  state         publication_state not null default 'queued',
  scheduled_for timestamptz,                -- null = publish at the next tick
  queued_by     uuid not null references app_users(id),
  queued_at     timestamptz not null default now(),
  -- claimed by the worker; FOR UPDATE SKIP LOCKED + this column makes a
  -- double-send impossible without an advisory lock
  locked_at     timestamptz,
  attempts      int not null default 0,
  last_error    text,
  published_at  timestamptz,
  provider      text,                       -- 'manual','linkedin_api','x_api',…
  provider_id   text,
  external_url  text,
  canceled_at   timestamptz,
  cancel_reason text
);

-- ONE live publication per request per channel. This is the "no duplicate
-- post" guarantee, at the database, not in a route handler — a double-publish
-- becomes a duplicate-key error rather than a second post on someone's feed.
create unique index if not exists publications_one_live_per_channel
  on publications (request_id, channel)
  where state <> 'canceled' and state <> 'failed';

create index if not exists publications_due_idx
  on publications (scheduled_for)
  where state in ('queued','scheduled');

-- ─── Events ─────────────────────────────────────────────────────────────────

create table if not exists events (
  id          bigserial primary key,
  request_id  uuid references content_requests(id) on delete cascade,
  at          timestamptz not null default now(),
  actor       text not null default 'system',
  stage       pipeline_stage,
  step        text not null,
  ok          boolean not null,
  duration_ms int,
  detail      jsonb not null default '{}'
);
create index if not exists events_request_idx on events (request_id, id desc);
create index if not exists events_failed_idx  on events (at desc) where ok = false;

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Enabled with ZERO policies, deliberately. All real access is service-role
-- from route handlers, where authorisation actually lives (lib/auth.ts). This
-- is a second line of defence: if the anon key ever reaches a query path it
-- shouldn't, it reads nothing.
do $$
declare t text;
begin
  foreach t in array array[
    'app_users','content_requests','stage_runs','sources','source_excerpts',
    'content_plans','articles','article_versions','article_claims',
    'claim_citations','article_version_sources','evaluations',
    'evaluation_scores','reviews','channel_assets','publications','events'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
