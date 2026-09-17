/**
 * The brief's three reference documents, transcribed as prompt text.
 *
 * These live here rather than being read from the assets/ folder at runtime
 * for the same reason week 3 kept its prompts in TypeScript: a file read at
 * request time depends on the deployed bundle containing a path that the
 * bundler has no reason to trace, and it fails in production only.
 *
 * lib/seo.ts and lib/channel-rules.ts enforce the checkable half of these
 * rules in code. The text below is what tells the model to aim for them in
 * the first place — the two must be kept in step.
 */

/** assets/seo-best-practices.md */
export const SEO_RULES = `
SEO BEST PRACTICES — the article must follow all of these.

Keyword integration
- Take the primary keyword from the content idea.
- Include the primary keyword in the article title.
- Include the primary keyword in the first 100 words.
- Use the reference articles to identify long-tail and short-tail keywords.
- Use relevant secondary keywords in the body and in section headers.

Structure
- Exactly one H1 title.
- H2 section headers. H3 subheaders where they are needed.
- Short paragraphs of 2 to 3 sentences. Never more than 3.
- Let the depth of each main section reflect the strength and complexity of
  the source material — do not pad a section the sources barely support.

Enrichment
- Include 2 to 3 relevant internal or external links. Not one, not four.
  Every link must point at a URL that appears in the reviewed source material
  or in the plan's link targets. Never invent a URL.
- Keep the writing readable for a broad audience.
- Keep every claim grounded in reviewed source material.
`.trim();

/** assets/channel-formatting-rules.md — LinkedIn */
export const LINKEDIN_RULES = `
LINKEDIN POST RULES
- Use the PAS copywriting structure: problem, agitation, solution.
- Keep paragraphs short (1 to 3 sentences).
- Use bullets or simple symbols when they improve clarity.
- Use a small number of relevant emojis, and only when they fit the brand
  voice. Five or fewer in the whole post. None is fine.
- End with a clear call to action.
`.trim();

/**
 * assets/channel-formatting-rules.md — X
 *
 * The length instruction is deliberately not "stay under 280".
 *
 * Every X asset this pipeline has ever failed, failed on one thing: the
 * character count. Nine attempts, seven failures, overshooting from 286 to
 * 490 — and nothing else on the checklist ever missed. Models cannot count
 * characters, which is the same reason word counts are measured in code
 * rather than asked for (lib/channel-rules.ts).
 *
 * So the target given here is ~180, well inside the real limit. A model
 * aiming at 280 and missing by 10% fails; one aiming at 180 and missing by
 * the same 10% still lands comfortably under. The 280 is stated too, as the
 * measured limit rather than the goal.
 */
export const X_RULES = `
X POST RULES
- Lead with the main benefit, insight, or hook. The first line is the hook.
- Keep the post focused on ONE core idea.
- Use line breaks for readability.
- Use no more than 1 to 2 relevant hashtags. Never three.
- Tag another account only if the tag adds value.

LENGTH — this is the rule X posts fail most often.
- Aim for about 180 characters in total, including the hashtag.
- 280 is a hard ceiling that is MEASURED after you answer, not a target. A
  post of 290 characters is rejected outright, however good it is.
- Two or three short lines is the right shape. If you are writing a third
  sentence, you have gone past it.
- Cut adjectives and throat-clearing before cutting the idea.
`.trim();

/** assets/channel-formatting-rules.md — Email newsletter */
export const NEWSLETTER_RULES = `
EMAIL NEWSLETTER RULES
- A strong subject line with a clear benefit or a point of intrigue.
- A short intro of 1 to 3 sentences. Not four.
- A main value section that is easy to skim, using **bold lead-ins** and
  bullets.
- NEVER use markdown headings in a newsletter. No "#", no "##", no "###".
  A newsletter is a letter, not an article: a heading renders at the size of
  the subject line, which reads as a second article stapled inside the first,
  and a plain-text client shows the hash marks literally.
  Write "**The reality check.** Nigeria's only attempt at a big wind farm…"
  where an article would have written "## The Reality Check".
- An optional secondary item, such as a quick tip, link, or update.
- A clear call to action.
- A friendly sign-off.
- Write as if speaking to a smart, busy reader who trusts you to send
  something useful.
- Between 250 and 600 words. This is a hard band: count on the long side of
  250 rather than risk falling under it.
`.trim();

/** assets/content-evaluation-rubric.md */
export const RUBRIC = `
CONTENT EVALUATION RUBRIC

topic_relevance     — The content answers the request and stays focused on the
                      intended topic.
source_grounding    — Claims, examples, and recommendations connect back to
                      reviewed source material.
factual_consistency — The content avoids contradictions, unsupported claims,
                      and invented details.
audience_fit        — The content speaks to the target audience at the right
                      level of depth.
tone                — The style matches the brand and the channel.
seo_fit             — The article uses the primary keyword, relevant secondary
                      keywords, clear headings, and useful links.
channel_fit         — Each adapted output follows the platform formatting rules.
clarity             — The content is easy to read, skimmable, and direct.
completeness        — The output includes every required section or channel asset.

Score each criterion from 1 to 5, where 1 is unusable and 5 is publishable
as-is. Return a score for every one of the nine criteria — never omit one.
`.trim();

export const CHANNEL_RULES = {
  linkedin: LINKEDIN_RULES,
  x: X_RULES,
  newsletter: NEWSLETTER_RULES,
} as const;
