// shell/feedback — where a message goes: the toast, the world hint, the announcer, the error ring
// and its overlay. Every other module sends a message through a function here and uses the two
// rings and the live region through their own methods. Only this module assigns the bindings it
// declares: another module changes one by calling a function here. Four of those functions serve
// the boot and the frame loop in `main.ts`: the hint host's install (`installHintHost`), the mount
// of the two elements built at boot (`mountFeedback`), the announcement pump
// (`pumpAnnouncements`) and the reconnect reset (`resetStatusNotice`). Module scope constructs
// the rings and the announcer: it registers no listener, writes nothing to the document and
// resolves no catalog string.

import { t } from '../ui/a11yCopy';
import { type A11ySnapshot, announcementsFor } from '../ui/announcements';
import type { OutcomeLine } from '../ui/boxView';
import { buildErrorOverlayModel } from '../ui/errorOverlayModel';
import { ErrorRing, type ErrorSource, normalizeError } from '../ui/errorRing';
import { EventRing } from '../ui/eventRing';
import { channelOf, type MessageKind, outranks, type SinkKind } from '../ui/feedbackPolicy';
import { COALESCE_WINDOW_MS, LiveRegion } from '../ui/liveRegion';
import type { OverlayId } from '../ui/overlayRegistry';
import { STATUS_NOTICE_INITIAL, type StatusNoticeState, statusNoticeStep } from '../ui/statusModel';
import { NO_TOAST, renderToast, type ToastChrome, type ToastState, toastStep } from '../ui/toast';
import { errorOverlayView } from './views';

/** What the world hint reaches up for: the main menu sits above this module in the shell's
 *  import order, so `main.ts` hands it in. */
export interface HintHost {
  /** Whether the main menu is the top frame. */
  readonly menuOnTop: () => boolean;
  /** Repaint the main menu. */
  readonly repaintMenu: () => void;
}

const hintPortMissing = (): never => {
  throw new Error('shell/feedback: the hint host is not installed');
};
// The installed hint host. Until `installHintHost` runs, each member throws.
let hintPort: HintHost = { menuOnTop: hintPortMissing, repaintMenu: hintPortMissing };

/** Install the hint host. `main.ts` calls this once, at its own module scope, before it registers
 *  its first listener. */
export function installHintHost(host: HintHost): void {
  hintPort = host;
}

// A view's paint threw, or an adapter threw while observing a batch. Logged every time, and
// surfaced like an uncaught frame error (tagged, deduped on the message: a held D-pad repeats the
// same step every 100 ms, a failing observe repeats on every batch, and the error ring is small).
export let lastPaintErrorMessage: string | null = null;
export function reportPaintError(err: unknown): void {
  console.error('[screen] paint error', err);
  let message: string;
  try {
    message = `screen paint: ${normalizeError('uncaught', err).message}`;
  } catch {
    message = 'screen paint: [unstringifiable error]';
  }
  if (message === lastPaintErrorMessage) return;
  lastPaintErrorMessage = message;
  pushError('uncaught', message);
}

// --- the message sinks: the status surface and its channels ----------------------
// Every message a sink here shows names its `MessageKind`, and `feedbackPolicy` picks the
// channel: an outcome is a timed toast (`#toast`, above every frame), a persistent state
// is the world hint (`#status`, the world line, or the main menu's strip while the menu is on
// top, WF1-A9). `main()` builds `statusEl` and the toast and mounts them here before it opens the
// connection (no lifecycle callback can ever report into the void). textContent ONLY:
// server-supplied SenderError text must never become markup.
export let statusEl: HTMLElement | undefined;
export let toastChrome: ToastChrome | undefined;
export let toastState: ToastState = NO_TOAST;
/** The standing world hints, one per kind, newest last; the shown one is the top of WF1-A9's
 *  precedence (`topHint`). `saidHint` is the last hint text given to the live region, so a repaint
 *  on another host never says it again; `menuHint` is the hint the menu's strip last painted. */
export let worldHints: ReadonlyArray<{ readonly kind: MessageKind; readonly text: string }> = [];
export let saidHint: string | null = null;
export let menuHint: string | null = null;

/** Show `text` on its policy channel: THE one seam every shell message goes through, so no view
 *  picks a channel. A hint kind paints on `hintHost`, the open frame's own strip, when
 *  the caller has one (Controls' refused key), else it is a world hint. */
export function route(kind: SinkKind, text: string, hintHost?: (text: string) => void): void {
  if (channelOf(kind) !== 'hint') showToast(text);
  else if (hintHost !== undefined) hintHost(text);
  else setWorldHint(kind, text);
}

/** Surface a user-visible failure on `line` (the sending frame's outcome line) or, when there is
 *  none or its frame was left (the per-sink guard: the line does not paint), on its policy
 *  channel; plus console.error for logs and the error ring either way. */
export function reportError(kind: SinkKind, text: string, line?: OutcomeLine): void {
  if (line?.(text, 'error') !== true) route(kind, text);
  console.error('[status]', text);
  // unify UI/reducer failures into the error ring so the F9 bundle captures them.
  pushError('reducer', text);
}

/** Paint a toast and queue it for the live region: spoken once by the frame pump, clear of the
 *  announcements that land beside it (ui/statusModel.ts statusNoticeStep). */
export function showToast(text: string): void {
  queueNotice(text, paintToast(text));
}

/** Queue `text` for the live region: the frame pump speaks it clear of the announcements that land
 *  beside it (ui/statusModel.ts statusNoticeStep). */
export function queueNotice(text: string, nowMs: number): void {
  statusNotice = statusNoticeStep(
    statusNotice,
    { kind: 'queue', text, nowMs },
    COALESCE_WINDOW_MS,
  ).state;
}

/** Paint `text` on the toast, timed from now; returns that now. */
export function paintToast(text: string): number {
  const nowMs = performance.now();
  toastState = toastStep(toastState, { kind: 'show', text, nowMs });
  if (toastChrome !== undefined) renderToast(toastChrome, toastState);
  return nowMs;
}

/** The frame pump's toast expiry, through the injected frame clock. */
export function tickToast(nowMs: number): void {
  const next = toastStep(toastState, { kind: 'tick', nowMs });
  if (next === toastState) return;
  toastState = next;
  if (toastChrome !== undefined) renderToast(toastChrome, toastState);
}

/** A persistent hint stands until its state ends; a new one of its kind replaces it, and any new
 *  hint overwrites a `download-blocked` ("until overwritten"). The shown hint is said once per new
 *  text and painted on the host the stack picks. */
export function setWorldHint(kind: MessageKind, text: string): void {
  worldHints = [
    ...worldHints.filter((h) => h.kind !== kind && h.kind !== 'download-blocked'),
    { kind, text },
  ];
  paintWorldHint();
}

/** The shown world hint: the highest WF1-A9 rank, the newer of two equals; null when none stands. */
function topHint(): string | null {
  let top: { readonly kind: MessageKind; readonly text: string } | null = null;
  for (const h of worldHints) if (top === null || outranks(h.kind, top.kind)) top = h;
  return top?.text ?? null;
}

/** The world hint's text when the main menu, on top, hosts it on its strip; else null. */
export function hintOnMenu(): string | null {
  return hintPort.menuOnTop() ? topHint() : null;
}

/** Paint the world hint on its host: the menu's strip while the menu is on top, else `#status`
 *  (above every shell, so it stays readable while a frame without a seam strip is open). Runs on
 *  every stack sync, so it writes only on a change. */
export function paintWorldHint(): void {
  const shown = topHint();
  if (shown !== saidHint) {
    saidHint = shown;
    if (shown !== null) announceNow(shown);
  }
  const onMenu = hintOnMenu();
  const text = shown === null || onMenu !== null ? '' : shown;
  if (statusEl !== undefined && statusEl.textContent !== text) statusEl.textContent = text;
  if (onMenu !== menuHint) {
    menuHint = onMenu;
    hintPort.repaintMenu();
  }
}

/** On reconnect: the link states and the toast are stale; `content-stale` stands until reload. */
export function resetFeedbackSinks(): void {
  worldHints = worldHints.filter((h) => h.kind === 'content-stale');
  toastState = NO_TOAST;
  if (toastChrome !== undefined) renderToast(toastChrome, toastState);
  paintWorldHint();
}

// A status NOTICE is an outcome that is not an error — a conversation the server ended for a
// reason, a quest completed. It goes to the toast (textContent only, never markup) and is queued
// for the live region, spoken by the frame pump clear of the announcements that land beside it
// (ui/statusModel.ts statusNoticeStep: why and when).
export let statusNotice: StatusNoticeState = STATUS_NOTICE_INITIAL;
/** An announcement made outside the frame pump since its last frame: the pump treats it as a
 *  transition, so a queued notice is held clear of it and a notice it clobbered is said again. */
export let announcedSinceFrame = false;

/** Announce through the live region from outside the frame pump (a refusal, a request line, a
 *  view's own announcement) and let the pump know. */
export function announceNow(text: string): void {
  liveRegion.announce(text, performance.now());
  announcedSinceFrame = true;
}

// --- F9 bug-bundle observability rings + error overlay -----------
// The rings are the SESSION buffer (survive reconnect/zone-switch — only the emit
// latches re-baseline). tMs comes from Date.now() in production; the rings inject the
// clock so their unit tests stay deterministic. `main()` mounts the overlay (`shell/views.ts`).
export const eventRing = new EventRing(() => Date.now());
export const errorRing = new ErrorRing(() => Date.now());
/** The newest ring sequence the error toast showed when it was last dismissed. */
export let toastDismissedSeq = -1;

/** Dismiss the error toast (world B or F8): what it showed is not listed again. */
export function dismissErrorToast(): void {
  toastDismissedSeq = errorRing
    .snapshot()
    .reduce((max, r) => Math.max(max, r.tSeq), toastDismissedSeq);
  errorOverlayView?.dismiss();
}
// Re-entrancy guard: if rendering the overlay itself throws and re-enters pushError,
// short-circuit so a render fault cannot recurse into a stack overflow.
export let handlingError = false;

/** Record an error into the ring and reflect it in the overlay. TOTAL (never throws to
 *  the caller): a render/ring fault routes to console.error. */
export function pushError(source: ErrorSource, raw: unknown): void {
  if (handlingError) return;
  handlingError = true;
  try {
    errorRing.push(source, raw);
    if (errorOverlayView) {
      // The movement breadcrumb is BUNDLE-bound, never OVERLAY-bound. This ring
      // IS the overlay's source (newest 8), so unfiltered the 16 capped breadcrumbs would
      // surface silent rejections (M2 §3) and evict real errors from the visible window.
      // The toast lists the errors since its last dismissal: a dismissed one stays gone.
      errorOverlayView.render(
        buildErrorOverlayModel(
          errorRing
            .snapshot()
            .filter((r) => r.tSeq > toastDismissedSeq && !r.message.startsWith(MOVE_REJECT_PREFIX)),
        ),
      );
      if (!errorOverlayView.visible) errorOverlayView.show();
    }
  } catch (e) {
    console.error('[obs] pushError', e);
  } finally {
    handlingError = false;
  }
}

/** The prefix of a movement-rejection breadcrumb in the error ring. The one constant feeds the
 *  breadcrumb's formatter and the overlay's filter in `pushError`, so they cannot drift apart. */
export const MOVE_REJECT_PREFIX = 'movement-reject ';

// The ONE announcer: the app's single `LiveRegion`, flushed once per frame by `pumpAnnouncements`
// (a live region nothing flushes is permanently silent).
export const liveRegion = new LiveRegion();
export let lastA11ySnapshot: A11ySnapshot = { topOverlay: null, message: '' };

/** What the frame loop hands the announcement pump: its own locals, and reads of modules this
 *  one may not import. The pump calls each function member where the frame loop called it. */
export interface AnnouncementFrame {
  /** The frame's clock reading. */
  readonly now: number;
  /** The stack's top frame when there is one, else null. */
  readonly topOverlay: () => OverlayId | null;
  /** The countdown line `pumpStillThere` returned this frame, or null. */
  readonly countdownSaid: string | null;
  /** The focus return of a world edge, called once the edge is announced. */
  readonly returnFocus: () => void;
}

/** The frame loop's announcement edge and notice step. The world branch and announcementsFor are
 *  disjoint by construction (the reducer emits only when next.topOverlay is non-null), so neither
 *  transition is ever uttered twice. The top is the stack's top frame when there is one (a screen
 *  opened over the menu is announced). */
export function pumpAnnouncements({
  now,
  topOverlay,
  countdownSaid,
  returnFocus,
}: AnnouncementFrame): void {
  const top = topOverlay();
  const nextSnapshot: A11ySnapshot = { topOverlay: top, message: '' };
  const edges = announcementsFor(lastA11ySnapshot, nextSnapshot);
  for (const m of edges) liveRegion.announce(m, now);
  const worldEdge = lastA11ySnapshot.topOverlay !== null && top === null;
  if (worldEdge) {
    liveRegion.announce(t('a11y.world.region'), now);
    returnFocus();
  }
  lastA11ySnapshot = nextSnapshot;
  if (countdownSaid !== null) liveRegion.announce(countdownSaid, now);
  // A queued status notice is spoken clear of the transitions above and of anything
  // announced outside the pump since the last frame (statusNoticeStep holds it a full
  // coalescing window past them, and re-queues one they clobbered).
  const notice = statusNoticeStep(
    statusNotice,
    {
      kind: 'frame',
      nowMs: now,
      transitionAnnounced:
        edges.length > 0 || worldEdge || announcedSinceFrame || countdownSaid !== null,
    },
    COALESCE_WINDOW_MS,
  );
  announcedSinceFrame = false;
  statusNotice = notice.state;
  if (notice.speak !== null) liveRegion.announce(notice.speak, now);
  liveRegion.flush(now);
}

/** The two elements `main()` builds at boot: the world line and the toast region. */
export interface FeedbackMounts {
  statusEl: HTMLElement;
  toastChrome: ToastChrome;
}

/** Mount each element present in `mounts`. One the argument omits keeps its value. */
export function mountFeedback(mounts: Partial<FeedbackMounts>): void {
  if (mounts.statusEl !== undefined) statusEl = mounts.statusEl;
  if (mounts.toastChrome !== undefined) toastChrome = mounts.toastChrome;
}

/** On reconnect: a notice queued on the dropped link is stale. */
export function resetStatusNotice(): void {
  statusNotice = STATUS_NOTICE_INITIAL;
}
