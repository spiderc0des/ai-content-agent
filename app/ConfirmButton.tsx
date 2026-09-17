'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * A button that asks before it acts.
 *
 * Reveal-in-place rather than `window.confirm()`: the native dialog cannot
 * name the thing being acted on, cannot be styled to match the theme, and
 * reads as a browser warning rather than as part of the app.
 *
 * It asks the question and offers the two answers. Naming the specific item
 * in the question is what makes it a real check; a paragraph underneath is
 * not, so `detail` is carried as the trigger's tooltip instead of taking up
 * half the panel.
 *
 * Used for the actions that are hard or impossible to walk back: approving
 * (which is what lets anything reach a channel at all), rejecting, deleting,
 * and scheduling a publish.
 *
 * Two layouts, because the question has to fit where the button lives:
 *
 *   inline  — the panel replaces the button and takes the full width of its
 *             container. Right when the button sits in a column of its own
 *             (the review panel, the queue).
 *   popover — the button stays put and the panel floats beneath it, right
 *             aligned, at a fixed width. Right when the button is one chip in
 *             a tight row (a list item): an inline panel there either bursts
 *             out of the row or reflows every sibling.
 */
export default function ConfirmButton({
  label,
  confirmLabel,
  question,
  detail,
  tone = 'default',
  layout = 'inline',
  disabled,
  busy,
  busyLabel,
  onConfirm,
  className,
  title,
}: {
  label: string;
  /** The button inside the confirmation. Says what will happen, not "OK". */
  confirmLabel: string;
  question: string;
  /** What the person should know before saying yes. */
  detail?: string;
  tone?: 'default' | 'primary' | 'danger';
  layout?: 'inline' | 'popover';
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  title?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // A floating panel that cannot be dismissed with Escape is a trap — the
  // trigger is behind it, and on a list row there is nowhere obvious to
  // click. Only for the popover: the inline panel keeps its Cancel in view.
  /**
   * Close the confirmation if the action stops being available while it is
   * open — unticking the last channel, say. Otherwise the panel sits there
   * asking a question about a selection that no longer exists, and its
   * wording degrades into nonsense like "Schedule Nothing selected for…".
   */
  useEffect(() => {
    if (confirming && disabled) setConfirming(false);
  }, [confirming, disabled]);

  useEffect(() => {
    if (!confirming || layout !== 'popover') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setConfirming(false);
    }
    function onDown(e: MouseEvent) {
      if (!popoverRef.current?.contains(e.target as Node)) setConfirming(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [confirming, layout]);

  const toneClass =
    tone === 'danger' ? 'btn btn-danger' : tone === 'primary' ? 'btn btn-primary' : 'btn';

  // The RESTING button is quiet even for a destructive action; the danger
  // styling belongs on the confirmation, where the consequence is spelled
  // out. A solid red button repeated down every row of a list reads as a
  // warning about the list itself.
  const restingClass = tone === 'danger' ? 'btn btn-ghost' : toneClass;

  const trigger = (
    <button
      type="button"
      className={`${restingClass} ${className ?? ''}`}
      style={tone === 'danger' ? { color: 'var(--danger)' } : undefined}
      disabled={disabled || busy}
      title={title ?? detail}
      aria-expanded={confirming}
      onClick={() => setConfirming(true)}
    >
      {busy ? (busyLabel ?? 'Working…') : label}
    </button>
  );

  // The question and the two buttons, nothing else. An explanatory paragraph
  // here is read once and skipped forever after, and it makes a row-level
  // confirmation twice the size of the row it belongs to. `detail` survives as
  // the button's tooltip for the one time someone wants it.
  const body = (
    <>
      <p className="font-semibold" style={{ color: 'var(--warning)' }}>
        {question}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={`${toneClass} btn-sm`}
          disabled={busy}
          onClick={async () => {
            setConfirming(false);
            await onConfirm();
          }}
        >
          {busy ? (busyLabel ?? 'Working…') : confirmLabel}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </div>
    </>
  );

  if (layout === 'popover') {
    return (
      <div className="relative" ref={popoverRef}>
        {trigger}
        {confirming && (
          <div
            className="panel panel-warning absolute right-0 top-full z-30 mt-1 w-64 max-w-[min(18rem,calc(100vw-2rem))] text-left"
            style={{ background: 'var(--card)', boxShadow: 'var(--shadow)' }}
            role="alertdialog"
            aria-label={question}
          >
            {body}
          </div>
        )}
      </div>
    );
  }

  if (!confirming) return trigger;

  return (
    <div className="panel panel-warning w-full" role="alertdialog" aria-label={question}>
      {body}
    </div>
  );
}
