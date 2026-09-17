import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { z } from 'zod';
import { requireUser, canRunPipeline } from '@/lib/auth';
import {
  getRequest,
  upsertSource,
  resumeWithPastedSource,
  claimPipelineLock,
  logEvent,
} from '@/lib/queries';
import { drivePipeline } from '@/lib/pipeline';
import { errorResponse } from '@/lib/api-helpers';
import { requiredText, optionalHttpUrl, firstIssue } from '@/lib/validation';
import { assessSource } from '@/lib/source-quality';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * POST /api/requests/:id/sources — add source material by hand.
 *
 * The escape hatch for the one failure this pipeline cannot engineer its way
 * out of: research finds real, relevant sources and every publisher refuses to
 * be fetched. There is no way to recover quotes from those pages — web_search
 * hands back only opaque `encrypted_content`, and attaches no cited_text — so
 * the honest options are to write ungrounded (never) or to ask a person for
 * text they can see and we cannot.
 *
 * What lands here is text, not a URL to go fetch: a URL would hit the same
 * wall that caused the block. The URL is optional and used only for
 * attribution, so the finished article still cites where the words came from.
 *
 * The pasted text then takes the ordinary path — retrieval digests it into
 * exact-quote excerpts, selection ranks them, and the grounding join refuses
 * any claim that does not resolve to one. A hand-pasted source is held to
 * exactly the same standard as a fetched page; it is only the transport that
 * differs.
 */
const Body = z.object({
  title: requiredText('A title for this source', 2, 200),
  text: requiredText('The source text', 200, 200_000),
  url: optionalHttpUrl('The source URL'),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const user = await requireUser('creator');
    const row = await getRequest(id);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (!canRunPipeline(user, row)) {
      return NextResponse.json(
        { error: 'Only the author (or an admin) can add sources to this request.' },
        { status: 403 },
      );
    }
    if (row.status !== 'blocked' && row.status !== 'failed') {
      return NextResponse.json(
        {
          error: `Sources can only be added by hand to a blocked or failed request; this one is '${row.status}'.`,
        },
        { status: 409 },
      );
    }

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    }
    const { title, text, url } = parsed.data;

    // The same check a fetched page gets. Someone who pastes a cookie banner
    // or a "verify you are human" page has pasted the block itself, and
    // letting that through would put the request straight back where it was —
    // except now with a source that looks legitimate.
    const verdict = assessSource({ title, text });
    if (!verdict.usable) {
      return NextResponse.json(
        {
          error: `That does not look like readable source material — ${verdict.reason}. Paste the article's own text.`,
        },
        { status: 400 },
      );
    }

    await upsertSource({
      requestId: id,
      kind: 'pasted',
      url: url || null,
      title,
      discoveredBy: null,
      rawText: text,
      status: 'fetched',
    });

    await logEvent({
      requestId: id,
      actor: user.email,
      stage: 'research',
      step: 'source_added_by_hand',
      ok: true,
      detail: { title, url: url || null, characters: text.length },
    });

    const resumed = await resumeWithPastedSource(id);

    // Carry straight on rather than making them find the Run button again:
    // adding the source IS the decision, and the pipeline has everything it
    // needs. If someone else's run holds the lock, the source is still saved.
    // claimPipelineLock returns the claimed ROW, not a boolean — coerce it
    // here rather than letting a whole content_requests row leak into the
    // response body under a field named `resumed`.
    const running = Boolean(await claimPipelineLock(id, user.email));
    if (running) after(async () => void (await drivePipeline(id, user.email)));

    return NextResponse.json(
      {
        ok: true,
        status: resumed.status,
        version: resumed.version,
        resumed: running,
        message: running
          ? 'Source added. Picking up from retrieval.'
          : 'Source added. A run is already in progress; it will be used there.',
      },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
