# Koya Content Agent

From a raw idea or a source URL to reviewed, channel-ready content for LinkedIn,
X, and an email newsletter — with a human approval gate that nothing gets past
without.

Built for the Week 4 brief (`../aat-c3-week-4-content-agent/PRD.md`).

---

## Setup

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where it comes from |
| --- | --- |
| `ANTHROPIC_API_KEY` | platform.claude.com → API keys |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page |
| `SUPABASE_SERVICE_ROLE_KEY` | same page |
| `DATABASE_URL` | Supabase → Database → Connection string → **Transaction pooler** (port 6543) |
| `APP_URL` | `http://localhost:3000` |
| `CRON_SECRET` | any long random string; the publishing worker refuses to run without it |

> If your database password contains `@ % # / : ?`, percent-encode it. The app
> will tell you so by name rather than throwing "URI malformed" from inside a
> dependency.

Then, in the Supabase SQL editor, in order:

1. `sql/01-schema.sql` — tables, enums, indexes, RLS
2. `sql/02-triggers.sql` — the append-only and approval-gate triggers
3. Sign in once at `/login` — this creates a **pending** row that grants nothing
4. `sql/03-seed-users.sql` — edit the email, run it to activate yourself
5. `sql/04-verify.sql` — asserts the install; every line should print `ok`

```bash
npm run dev
```

### Running with no API key and no database

```bash
MOCK_ANTHROPIC=1 npm run scenarios   # the whole pipeline, from fixtures
```

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm test` | 71 unit tests |
| `npm run scenarios` | The 8 test scenarios from the brief, as a pass/fail table |
| `npm run sample-pack` | Regenerates `docs/sample-pack/` (mock layer, free) |
| `RUN_LIVE_DRIVE=1 npx vitest run test/scenarios/drive-e2e.manual.test.ts` | Drives one request end to end against the real API. Costs money; takes ~15 min |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Production build |

---

## How it works

See **`docs/ONE-PAGER.md`** for the short version, and `docs/TEST_EVIDENCE.md`
for what is proven and how.

```
idea → audit → research → retrieval → selection → plan
     → generate N options → evaluate → [auto-revise ×≤2]
     → AWAITING REVIEW ← the human gate (approve / reject / revise / select)
     → approve → package (LinkedIn / X / newsletter) → queue → published
```

---

## Design decisions worth knowing

**A request is many immutable versions, not one document.** `article_versions`
is INSERT-only, enforced by a trigger. A human edit is a new row. That is what
preserves the review history, and it means an evaluation, a claim, or a channel
asset can point at a version that can never change underneath it.

**The approval gate is in the database.** `guard_content_approval()` refuses to
let a request become `approved` except from `awaiting_review`, with a selected
option, recording the exact version and its content hash.
`guard_publication_insert()` refuses to queue an asset that did not come from
the approved version. `revoke_approval_on_new_version()` takes the approval away
if anyone writes a new version afterwards. None of this depends on a route
handler remembering to check.

**A partial unique index prevents double-posting.** `publications_one_live_per_channel`
turns a duplicate release into a duplicate-key error rather than a second post
on someone's feed.

**One file constructs every Anthropic request.** `lib/claude.ts` returns a
discriminated `ClaudeOutcome<T>` — a refusal, a rate limit, a truncated reply,
and an API error are distinguishable, and `stop_reason` is checked *before* the
content is trusted, because a refusal arrives as a 200 with empty content.

**One call per article option, not one call for all of them.** Sections of a
document must cohere, so one call is right there. Options must *differ*, and
generating them in one response reliably produces three variations on a theme.
It also means one refusal costs one option rather than the whole stage.

**Rules that can be checked are checked in code.** `lib/seo.ts` and
`lib/channel-rules.ts` compute the brief's numeric rules over the stored text.
The model's rubric scores are judgement on top.

**Every stage records its attempt.** `stage_runs` carries the model, the
Anthropic request id, the effort, the token counts, and the exact error, per
attempt, never overwritten. `/r/:id/log` shows it.

**The pipeline runs server-side, from one click.** `drivePipeline()`
(`lib/pipeline.ts`) runs every machine stage back to back and stops only when a
person is needed. The page follows along by polling
`/api/requests/:id/status`; it does not advance anything.

It was originally the other way round — a React component looped over
`fetch('/run')`, one stage at a time — and that is the single biggest thing
this project got wrong. It made a fifteen-minute pipeline exactly as reliable
as one browser tab staying open, awake and connected for fifteen minutes.
Requests parked mid-pipeline with nothing wrong with them, because the server
had finished a stage and the tab never asked for the next one; one sat at
`retrieving` for eight hours that way.

**Exactly one driver owns a request at a time.** A lock column claimed by a
conditional UPDATE (`sql/06-pipeline-lock.sql`), heartbeated between stages so
a slow run is not mistaken for a dead one, and reclaimable by
`/api/cron/resume` when a driver really did die. Without it, two clicks seven
seconds apart ran two pipelines over the same request: both spent nine minutes
of duplicate Claude calls, and the loser marked the whole request failed on a
status transition the winner had already made.

**End-of-stage transitions tolerate already being there.** `advanceStatus()`
treats "already at the target" as success where `setStatus()` throws. Strict is
right at the START of a stage — it stops a stage running against a request that
moved on — and wrong at the end, where it turns a harmless race into a failed
request.

**Publishing is behind an adapter.** Everything up to the queue is finished and
does not care who posts. `lib/publishers/manual.ts` is the honest implementation
of "saved into a clear publishing queue" — the content is approved, formatted,
scheduled, and released, and a person posts it. Live LinkedIn and X posting is
two new files in `lib/publishers/`.

---

## Known limitations

- **No live posting to LinkedIn or X yet** — by design, for now. See above.
- **The mock fixtures are not the real model.** `npm run scenarios` proves the
  logic and the rules; it does not prove that Claude writes well. That is what
  the sample pack and a real run are for.
- **Uploaded files are not supported** — supporting material is a URL or pasted
  notes. The schema has the columns (`sources.anthropic_file_id`, `mime`,
  `bytes`) for it.
