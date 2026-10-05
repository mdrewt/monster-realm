// ui/frame.ts — the one frame chrome every screen renders through (design §10, CTL4.6): a title
// bar (title, breadcrumb, a tab strip flanked by LB/RB slots), an internally scrolling body, one
// feedback line and a hint-bar slot, in four sizes. Unwired until the screens adopt it.
//
// The kit writes only caller text. Glyphs — the breadcrumb separator, the LB/RB slot letters,
// the feedback marks — are CSS pseudo-elements keyed on classes and `data-` attributes.
//
// The feedback line is a pure, token-guarded machine (`feedbackStep`, no DOM) plus a thin render:
// success is shown only when the caller resolves the action that is still pending, so the line
// never claims an undelivered success (pgcc-a B7). It is not a live region; `#a11y-live` is.
import type { NavLayout, NavState, NavTab } from './nav';
import { checkFrameId, renderTabs } from './navRender';

export type FrameSize = 'side' | 'full' | 'bottom' | 'small';
/** Side panel, full, bottom box, small (a prompt or sheet). */
export const FRAME_SIZES: readonly FrameSize[] = ['side', 'full', 'bottom', 'small'];

export interface FrameChrome {
  /** The frame id: the id prefix of the title and of the nav items and tabs rendered in it. */
  readonly id: string;
  readonly root: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly breadcrumb: HTMLElement;
  /** The LB slot, the tab strip and the RB slot; hidden unless a tabs layout is shown. */
  readonly tabBar: HTMLElement;
  readonly tabStrip: HTMLElement;
  /** The region that scrolls when the content outgrows the frame. */
  readonly body: HTMLElement;
  readonly feedback: HTMLElement;
  readonly hintSlot: HTMLElement;
}

function part(doc: Document, parent: HTMLElement, className: string): HTMLElement {
  const el = doc.createElement('div');
  el.className = className;
  parent.appendChild(el);
  return el;
}

function buttonSlot(doc: Document, parent: HTMLElement, button: 'LB' | 'RB'): void {
  const slot = part(doc, parent, 'mr-frame-tabslot');
  slot.dataset.button = button;
  slot.setAttribute('aria-hidden', 'true');
}

export function createFrame(
  doc: Document,
  opts: { readonly id: string; readonly size: FrameSize },
): FrameChrome {
  if (!FRAME_SIZES.includes(opts.size)) throw new Error(`frame: unknown size ${opts.size}`);
  checkFrameId(opts.id);
  const root = doc.createElement('div');
  root.className = `mr-frame mr-frame--${opts.size}`;
  root.dataset.size = opts.size;

  const bar = part(doc, root, 'mr-frame-titlebar');
  const titleEl = part(doc, bar, 'mr-frame-title');
  titleEl.id = `${opts.id}-title`;
  const breadcrumb = doc.createElement('ol');
  breadcrumb.className = 'mr-frame-breadcrumb';
  bar.appendChild(breadcrumb);
  const tabBar = part(doc, bar, 'mr-frame-tabs');
  tabBar.hidden = true;
  buttonSlot(doc, tabBar, 'LB');
  const tabStrip = part(doc, tabBar, 'mr-frame-tabstrip');
  tabStrip.setAttribute('role', 'tablist');
  buttonSlot(doc, tabBar, 'RB');

  return {
    id: opts.id,
    root,
    titleEl,
    breadcrumb,
    tabBar,
    tabStrip,
    body: part(doc, root, 'mr-frame-body'),
    feedback: part(doc, root, 'mr-frame-feedback'),
    hintSlot: part(doc, root, 'mr-frame-hints'),
  };
}

export function setFrameTitle(f: FrameChrome, text: string, crumbs: readonly string[]): void {
  f.titleEl.textContent = text;
  const doc = f.breadcrumb.ownerDocument;
  const items = crumbs.map((crumb) => {
    const li = doc.createElement('li');
    li.className = 'mr-frame-crumb';
    li.textContent = crumb;
    return li;
  });
  f.breadcrumb.replaceChildren(...items);
}

/** The tab strip of a frame showing `layout`: shown only for a tabs layout with a tab. */
export function renderFrameTabs(
  f: FrameChrome,
  layout: NavLayout,
  state: NavState,
  label: (tab: NavTab) => string,
): void {
  renderTabs(f.tabStrip, layout, state, { frame: f.id, label });
  f.tabBar.hidden = layout.kind !== 'tabs' || layout.tabs.length === 0;
}

export type FeedbackState =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly token: number; readonly text: string }
  | { readonly kind: 'ok' | 'error' | 'info'; readonly text: string };
/** Tokens are caller-unique per action (e.g. a counter): a reused token would let a late
 *  resolution of the earlier action settle the later one. */
export type FeedbackEvent =
  | { readonly kind: 'begin'; readonly token: number; readonly text: string }
  | { readonly kind: 'resolved'; readonly token: number; readonly text: string }
  | { readonly kind: 'failed'; readonly token: number; readonly text: string }
  | { readonly kind: 'info'; readonly text: string }
  | { readonly kind: 'clear' };
export const NO_FEEDBACK: FeedbackState = { kind: 'none' };

/** `ok` is reachable only by resolving the pending action's own token; a resolution or failure
 *  for anything else (superseded, cleared, interrupted by info, already settled) is ignored. */
export function feedbackStep(s: FeedbackState, e: FeedbackEvent): FeedbackState {
  switch (e.kind) {
    case 'begin':
      return { kind: 'pending', token: e.token, text: e.text };
    case 'resolved':
    case 'failed':
      if (s.kind !== 'pending' || s.token !== e.token) return s;
      return { kind: e.kind === 'resolved' ? 'ok' : 'error', text: e.text };
    case 'info':
      return { kind: 'info', text: e.text };
    case 'clear':
      return s.kind === 'none' ? s : NO_FEEDBACK;
  }
}

/** What the live region should say when the line goes from `prev` to `next`: the new text when the
 *  visible line changed (its kind or its words), else null — the line itself is not a live region,
 *  so a caller announces this once per change. A token alone is not a visible change. */
export function feedbackAnnouncement(prev: FeedbackState, next: FeedbackState): string | null {
  if (next.kind === 'none' || next.text === '') return null;
  if (prev.kind === next.kind && prev.text === next.text) return null;
  return next.text;
}

export function renderFeedback(f: FrameChrome, s: FeedbackState): void {
  if (s.kind === 'none') {
    delete f.feedback.dataset.feedback;
    f.feedback.textContent = '';
    return;
  }
  f.feedback.dataset.feedback = s.kind;
  f.feedback.textContent = s.text;
}
