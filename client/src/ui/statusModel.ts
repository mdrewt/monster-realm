// ui/statusModel.ts — pure status-message view model (M13.5b, ADR-0085 D1).
//
// Reduces SDK reducer-promise rejections and subscription-error payloads to the
// user-visible status-line strings. LAYERING NOTE: this is a pure MODEL (no DOM,
// no SDK import, no timers) — net/connection.ts may import it without creating a
// net→view dependency; the DOM write (textContent) lives in main.ts's reportError.

/** The three routing buckets a rejection can land in (internal — unexported). */
type ErrorKind = 'sender' | 'internal' | 'unknown';

/**
 * Classify via `err.name` EQUALITY, not `instanceof` (ADR-0085 C9): the SDK's
 * SenderError/InternalError classes may be duplicated across bundle chunks or
 * realms, where `instanceof` silently fails; the `name` string survives both.
 * No dynamic RegExp anywhere (project ban).
 */
function classifyReducerError(err: unknown): ErrorKind {
  if (typeof err === 'object' && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (name === 'SenderError') return 'sender';
    if (name === 'InternalError') return 'internal';
  }
  return 'unknown';
}

/**
 * Reduce a reducer-promise rejection to the status-line text. TOTAL and NEVER
 * empty (the status line must never be visible-with-empty-text).
 *
 * - SenderError (a reducer `Err(...)` — the server's user-addressed reason) passes
 *   its message through: `"${where}: ${message}"`, or `"${where}: rejected"` when
 *   the message is empty/missing.
 * - InternalError → `"${where}: server error"` — the detail is NEVER included
 *   (no-leak: internal messages can carry stack/state a user must not see).
 * - Anything else → `"${where}: unexpected error"` — no String(err) coercion
 *   (no "[object Object]", no raw-string leakage).
 */
export function reduceErrorMessage(err: unknown, where: string): string {
  // try/catch (review RT-05): `.name`/`.message` may be hostile accessors (a
  // throwing getter, a Proxy trap). This function runs inside promise `.catch`
  // handlers — a throw here would escape as an unhandled rejection and the user
  // would see NO feedback at all. Total means total: a probe throw → generic.
  try {
    switch (classifyReducerError(err)) {
      case 'sender': {
        const message = (err as { message?: unknown }).message;
        if (typeof message === 'string' && message !== '') return `${where}: ${message}`;
        return `${where}: rejected`;
      }
      case 'internal':
        return `${where}: server error`;
      case 'unknown':
        return `${where}: unexpected error`;
    }
  } catch {
    return `${where}: unexpected error`;
  }
}

/**
 * Extract the user-visible message from a subscription onError context (ADR-0085
 * C7). TOTAL: the SDK's ErrorContextInterface carries `ctx.event` (an Error), but
 * the shape is fallback-guarded so a payload surprise degrades to the generic
 * 'subscription error' rather than throwing inside the onError callback. Only a
 * non-empty string `event.message` passes through.
 */
export function subscriptionErrorMessage(ctx: unknown): string {
  // Same RT-05 totality guard as reduceErrorMessage: `.event`/`.message` may be
  // hostile accessors, and this runs inside the SDK's onError callback.
  try {
    if (typeof ctx === 'object' && ctx !== null) {
      const event = (ctx as { event?: unknown }).event;
      if (typeof event === 'object' && event !== null) {
        const message = (event as { message?: unknown }).message;
        if (typeof message === 'string' && message !== '') return message;
      }
    }
    return 'subscription error';
  } catch {
    return 'subscription error';
  }
}
