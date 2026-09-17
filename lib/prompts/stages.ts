import { RUBRIC } from './rules';

/**
 * One prompt per pipeline stage. Kept apart from system.ts because these are
 * per-call instructions — only the system prompt is worth caching.
 */

/** 0 · Pre-flight audit. Cheap, and it saves an expensive research run. */
export const AUDIT_PROMPT = `
You are grading a content request before an expensive research and writing
pipeline runs on it. You are not writing anything yet.

Decide whether there is enough here to research a topic and write a useful,
grounded article.

readiness:
  "ready"   — the idea and audience are specific enough to research and write.
  "thin"    — workable, but the output will be generic. Say what would sharpen
              it. The pipeline WILL still run on a thin request.
  "blocked" — genuinely cannot proceed: the idea is empty, incoherent, or
              asks for something no amount of research would resolve.

Be reluctant to block. "Thin" is the usual answer for a vague request; a block
stops the user's work entirely and should be reserved for requests that cannot
be worked at all.

Also propose a primary keyword and a few secondary keywords from the idea, even
when the user supplied their own — the planner will compare them.

For "fields", grade each of: raw_idea, target_audience, source_url,
supporting_notes, primary_keyword.
`.trim();

/** 1 · Research. Web search + fetch; returns prose, not structured output. */
export function researchPrompt(): string {
  return `
You are researching a topic so that a grounded article can be written about it.

Use web search to find strong, credible, current sources. Prefer primary
sources, original research, and recognised publications over listicles and SEO
filler.

FETCHING IS THE POINT OF THIS STEP, not a bonus. A URL you only saw in search
results cannot be quoted later — only text you actually fetched can. So:

- Fetch every source you intend to rely on. Aim for at least four fetched
  successfully before you write the brief.
- Many publishers block automated fetching. A fetch that returns an error,
  a paywall, a consent page, or a near-empty body is a source you do NOT have.
  When that happens, go find another source on the same point and fetch that
  one instead. Do not simply move on with fewer.
- If a topic's best-known sources are all behind blocks, search again with
  different wording to surface material that is openly readable: official and
  government pages, standards bodies, company engineering blogs, primary
  research posted by its authors, established news outlets, and documentation.

Then write a research brief covering:
- What the best sources actually say, with the exact URL of each.
- Where sources disagree, and which is better supported.
- Specific facts, numbers, and quotations worth using, each attributed to its URL.
- What you could NOT find — gaps a writer should know about before drafting.

Quote exactly when you quote. Never paraphrase a number.

Do not write the article. Do not outline it. Research only.
`.trim();
}

/** 2 · Per-source digest. Citations on, structured output off. */
export function digestPrompt(context: string): string {
  return `
Extract only the material in this source that bears on the content request
below. Quote the exact sentences — never paraphrase a fact, figure, or claim.

For each extracted point, give the exact quote and one line on why it matters
for this request. Do not summarise the whole source. If nothing in it is
relevant, say so plainly and stop.

THE CONTENT REQUEST
${context}
`.trim();
}

/** 3 · Selection — the brief's "choose the sources or excerpts that matter". */
export const SELECTION_PROMPT = `
You are choosing which source excerpts will actually be used to write an
article. Everything you keep becomes the evidence base; everything you drop is
unavailable to the writer.

For each excerpt decide keep true/false, score its relevance from 0 to 1, and
say why in one line.

Keep an excerpt when it: supports a claim the article needs, gives a concrete
number or example, or represents a view the article must engage with.

Drop an excerpt when it: repeats another excerpt, is off-topic, is marketing
copy with no substance, or is too vague to support any specific claim.

Be selective. A tight evidence base produces a better-grounded article than a
large one. Keeping everything is a failure of this step.

But keeping NOTHING is a worse one. Selectivity is about proportion, not about
a fixed bar: when you are given forty excerpts, keeping six is right; when you
are given four, keeping the best two is right. Never return an empty set —
if the evidence is thin, say so in coverage_gaps and keep the strongest of
what you have. An article written from a narrow evidence base and honest about
its limits beats no article at all.

Then list coverage_gaps: what this evidence base does NOT cover that the
article will need. The writer has to know what it cannot claim.
`.trim();

/** 4 · Planning. Produces the outline and the distinct angles. */
export function planPrompt(optionCount: number): string {
  return `
Plan an article from the selected source excerpts.

Produce:
- A primary keyword and relevant secondary keywords. If the request already
  names a primary keyword, keep it unless it is clearly wrong for the material.
- A one-sentence thesis.
- An outline: H2 sections, H3 subheaders where needed, the key points under
  each, and the excerpt_ids that support each section. A section with no
  supporting excerpt_ids should not be in the outline.
- Let each section's depth reflect how strongly the sources support it.
- link_targets: 2 to 3 URLs drawn from the source material, each with anchor
  text. Never invent a URL.
- Exactly ${optionCount} angles, numbered option_index 1 to ${optionCount}.

The angles are the important part. They must be genuinely DIFFERENT
approaches to the same material — a different argument, a different reader
problem, or a different structure — not three phrasings of one idea. For each,
say in why_it_differs what makes it distinct from the others. A reviewer is
going to pick one of these, so give them a real choice.
`.trim();
}

/** 5 · Generation. One call per option. */
export function generatePrompt(params: {
  angle: string;
  whyItDiffers: string;
  optionIndex: number;
  wordCountTarget: number | null;
}): string {
  return `
Write the article for option ${params.optionIndex}.

THIS OPTION'S ANGLE
${params.angle}

WHAT MAKES IT DIFFERENT
${params.whyItDiffers}

Commit to this angle. Do not hedge toward the other options — a reviewer is
comparing distinct takes, and three near-identical drafts waste the comparison.

${
  params.wordCountTarget
    ? `Target roughly ${params.wordCountTarget} words. Being 15% either side is fine; padding to hit the number is not.`
    : 'Write to the length the source material supports — no padding.'
}

Every excerpt_id you cite in "claims" must be one of the excerpt ids given to
you below. An id that is not in that list will be rejected and the claim
downgraded to unsupported.
`.trim();
}

/** 6 · Evaluation — against the brief's rubric. */
export const EVALUATE_PROMPT = `
You are evaluating a draft article before a human reviews it. Be a demanding
editor, not a supportive one: your job is to find what is wrong while it is
still cheap to fix.

${RUBRIC}

Pay particular attention to source grounding and factual consistency. You have
the article's own claims list and the full set of selected excerpts. Check the
claims against the excerpts rather than against your own knowledge:

- A claim marked "grounded" whose excerpt does not actually support it is an
  unsupported claim. List it.
- A specific fact, number, or quotation in the body that is not in the claims
  list at all is an unsupported claim. List it.
- Do not flag genuine common knowledge as unsupported.

status:
  "pass"   — publishable after a human look. Minor nits only.
  "revise" — has real problems, but the draft is a usable starting point.
  "reject" — fundamentally wrong topic, or so poorly grounded that revising it
             would mean rewriting it.

Be honest. A draft with invented facts is not a "revise" because the prose is
good — unsupported claims are the thing this step exists to catch.
`.trim();

/** 7 · Revision. */
export function revisePrompt(instruction: string, fromHuman: boolean): string {
  return `
Rewrite this article to fix the problems identified below. Produce the complete
article, not a diff and not a description of your changes.

${fromHuman ? "THE REVIEWER'S INSTRUCTION — this takes priority over everything else" : 'THE EVALUATION FOUND'}
${instruction}

Keep what works. This is a revision, not a fresh start: preserve the angle, the
structure that earned its place, and the sentences the evaluation did not
criticise. Fix what was named.

Remove every unsupported claim — do not try to rescue one by softening its
wording. If a point needs a source you do not have, cut the point and add it to
"gaps".

Re-list every claim in the claims array for the NEW text. Claims from the
previous draft do not carry over.
`.trim();
}

/** 8 · Channel packaging. */
export function channelPrompt(channel: 'linkedin' | 'x' | 'newsletter', rules: string): string {
  return `
Adapt the approved article for ${channel === 'x' ? 'X' : channel === 'linkedin' ? 'LinkedIn' : 'the email newsletter'}.

${rules}

This is an adaptation, not a summary. Pick the one idea from the article that
works best on this platform and build the post around it. A compressed version
of the whole article reads like a compressed version of the whole article.

Stay inside the article's factual boundaries: every fact here must already
appear in the article. You have no new sources, so you cannot make a new claim.

Return both the structured parts AND the assembled text ready to paste, with
the parts joined the way a reader should see them.
`.trim();
}
