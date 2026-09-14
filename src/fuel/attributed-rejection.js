/**
 * AttributedRejection
 *
 * Error wrapper produced by sandscript when a registered handler throws
 * (sync) or its returned Promise rejects (async). Carries the calling
 * SS context slot and a diagnostic snapshot captured at the moment of
 * the throw / rejection, so embedders never have to bridge slot identity
 * across the async boundary themselves.
 *
 * Shape is part of sandscript's public surface:
 *
 *   .cause       — the original error the handler threw (set via the
 *                  standard Error { cause } option, so devtools and
 *                  any library that walks .cause chains unwrap it
 *                  natively).
 *   .slot        — the SS context slot that called the handler.
 *   .diagnostic  — engine.captureSlotDiagnostic(slot) output, captured
 *                  atomically with the catch — no other slot activity
 *                  occurs between throw and capture.
 *   .message     — copied from the original error's message.
 *
 * Wrap behavior is symmetric: sync throws and async rejections both
 * produce an AttributedRejection, so embedder catch sites never branch
 * on `instanceof` to read the slot.
 *
 * Happy path cost: zero. Wrapping only runs on the throw/reject path.
 */
/**
 * Symbol stamped on the original thrown object the first time it
 * flows through a wrap that builds an AttributedRejection. Inner
 * wraps stash; outer wraps observe the stamp and skip — so the
 * attribution sticks with the slot that originated the throw,
 * never with a slot that merely had it on its call stack.
 *
 * Exported so tests can verify the de-duplication contract without
 * importing the wrap site.
 */
export const ATTRIBUTED_SYMBOL = Symbol.for('sandscript.attributedRejection');

/**
 * True if `cause` has already been attributed by an inner wrap.
 * Non-object causes (primitives, null) cannot be stamped; they
 * fall through and the outer wrap re-stashes — that's acceptable
 * because primitive throws have no identity to preserve in the
 * first place.
 *
 * @param {*} cause
 * @returns {boolean}
 */
export function isAttributed(cause) {
  return !!(cause && typeof cause === 'object' && cause[ATTRIBUTED_SYMBOL]);
}

/**
 * Mark `cause` as attributed. No-op for non-objects.
 *
 * @param {*} cause
 */
export function markAttributed(cause) {
  if (cause && typeof cause === 'object') {
    try {
      cause[ATTRIBUTED_SYMBOL] = true;
    } catch (_e) {
      // Frozen / sealed errors silently skip the mark; outer wraps
      // will re-stash. Acceptable: a frozen error is rare and the
      // worst case is a single redundant stash.
    }
  }
}

export class AttributedRejection extends Error {
  constructor(cause, slot, diagnostic) {
    const message = (cause && typeof cause === 'object' && 'message' in cause)
      ? cause.message
      : String(cause);
    super(message, { cause });
    this.name = 'AttributedRejection';
    this.slot = slot;
    this.diagnostic = diagnostic;
  }
}
