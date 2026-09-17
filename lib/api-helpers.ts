import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AuthError } from './auth';
import { ConflictError, VersionConflictError, logEvent } from './queries';
import type { PipelineStage } from './db-schemas';

/**
 * One place that turns a thrown error into an HTTP response, so every route
 * reports failures the same, debuggable way. The rule applies here too:
 * whoever calls this has already logged an `events` row for the failed step
 * before this function runs.
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ZodError) {
    // The first message, as the error — not a generic "Invalid request" with
    // the useful part buried in a list. Every rule in lib/validation.ts
    // writes its message for the person who has to fix the field, so the
    // message IS the error; `issues` stays for a form that wants to show
    // them all at once.
    return NextResponse.json(
      {
        error: err.issues[0]?.message ?? 'Something in that request is not valid.',
        issues: err.issues.map((i) => i.message),
      },
      { status: 400 },
    );
  }
  if (err instanceof VersionConflictError) {
    return NextResponse.json(
      // The current version rides along so the caller can retry against it
      // rather than pre-fetching one before every write.
      { error: err.message, code: 'VERSION_CONFLICT', currentVersion: err.currentVersion },
      { status: 409 },
    );
  }
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: err.message, code: 'CONFLICT' }, { status: 409 });
  }

  // A database CHECK or trigger firing is a real, expected outcome here —
  // guard_content_approval() and guard_publication_insert() are the approval
  // gate, and their messages already say exactly what was wrong. Surfacing
  // them as a 409 with the message intact beats a generic 500.
  const message = err instanceof Error ? err.message : 'Unknown error';
  if (/cannot approve|cannot queue|asset derives from|append-only/i.test(message)) {
    return NextResponse.json({ error: message, code: 'GATE_REFUSED' }, { status: 409 });
  }

  console.error(err);
  return NextResponse.json({ error: message }, { status: 500 });
}

/**
 * Log a step, run it, log the outcome — every route follows this shape.
 *
 * The failure row is written BEFORE this function re-throws, not in a catch
 * block three layers up that might itself fail to reach the database.
 */
export async function withEventLog<T>(
  requestId: string | null,
  actor: string,
  step: string,
  fn: () => Promise<T>,
  opts: { stage?: PipelineStage; successDetail?: (result: T) => Record<string, unknown> } = {},
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    await logEvent({
      requestId,
      actor,
      stage: opts.stage ?? null,
      step,
      ok: true,
      durationMs: Date.now() - startedAt,
      detail: opts.successDetail ? opts.successDetail(result) : undefined,
    });
    return result;
  } catch (err) {
    await logEvent({
      requestId,
      actor,
      stage: opts.stage ?? null,
      step,
      ok: false,
      durationMs: Date.now() - startedAt,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
