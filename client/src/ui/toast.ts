// ui/toast.ts — the toast channel (uif-4, UIF4.2): ONE anchored `.mr-toast` region, above frames
// and battle roots, out of the flow (it moves nothing) and click-through, that shows an outcome
// for TOAST_MS and then hides.
//
// A pure step over an injected clock (`nowMs` per call, the liveRegion pattern: no timer, no
// Date.now) plus a thin render. The region is NOT a live region: `#a11y-live` stays the one
// announcer, and the caller speaks the text. The kit writes only caller text (textContent).

export const TOAST_MS = 4000;

export type ToastState =
  | { readonly kind: 'none' }
  | { readonly kind: 'shown'; readonly text: string; readonly untilMs: number };
export const NO_TOAST: ToastState = { kind: 'none' };

export type ToastEvent =
  | { readonly kind: 'show'; readonly text: string; readonly nowMs: number }
  | { readonly kind: 'tick'; readonly nowMs: number }
  | { readonly kind: 'clear' };

/** A newer show replaces the text and restarts the dwell; a tick hides it once `nowMs` reaches
 *  `untilMs`; an unchanged state is returned as the same reference, so a caller can skip a paint. */
export function toastStep(s: ToastState, e: ToastEvent): ToastState {
  switch (e.kind) {
    case 'show':
      return { kind: 'shown', text: e.text, untilMs: e.nowMs + TOAST_MS };
    case 'tick':
      return s.kind === 'shown' && e.nowMs >= s.untilMs ? NO_TOAST : s;
    case 'clear':
      return s.kind === 'none' ? s : NO_TOAST;
  }
}

export interface ToastChrome {
  readonly root: HTMLElement;
}

export function createToast(doc: Document, parent: HTMLElement): ToastChrome {
  const root = doc.createElement('div');
  root.id = 'toast';
  root.className = 'mr-toast';
  root.hidden = true;
  parent.appendChild(root);
  return { root };
}

export function renderToast(t: ToastChrome, s: ToastState): void {
  const text = s.kind === 'shown' ? s.text : '';
  t.root.hidden = s.kind !== 'shown';
  t.root.textContent = text;
}
