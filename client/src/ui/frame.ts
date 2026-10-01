// ui/frame.ts — the one frame chrome (design §10). STUB: ctl-4 red phase.
import type { NavLayout, NavState, NavTab } from './nav';

export type FrameSize = 'side' | 'full' | 'bottom' | 'small';
export const FRAME_SIZES: readonly FrameSize[] = ['side', 'full', 'bottom', 'small'];
export interface FrameChrome {
  readonly root: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly breadcrumb: HTMLElement;
  readonly tabBar: HTMLElement;
  readonly tabStrip: HTMLElement;
  readonly body: HTMLElement;
  readonly feedback: HTMLElement;
  readonly hintSlot: HTMLElement;
}
export type FeedbackState =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly token: number; readonly text: string }
  | { readonly kind: 'ok' | 'error' | 'info'; readonly text: string };
export type FeedbackEvent =
  | { readonly kind: 'begin'; readonly token: number; readonly text: string }
  | { readonly kind: 'resolved'; readonly token: number; readonly text: string }
  | { readonly kind: 'failed'; readonly token: number; readonly text: string }
  | { readonly kind: 'info'; readonly text: string }
  | { readonly kind: 'clear' };
export const NO_FEEDBACK: FeedbackState = { kind: 'none' };
const todo = (): never => {
  throw new Error('ctl-4: not implemented');
};
export function createFrame(
  _doc: Document,
  _opts: { readonly id: string; readonly size: FrameSize },
): FrameChrome {
  return todo();
}
export function setFrameTitle(_f: FrameChrome, _title: string, _crumbs: readonly string[]): void {
  todo();
}
export function renderFrameTabs(
  _f: FrameChrome,
  _layout: NavLayout,
  _state: NavState,
  _label: (tab: NavTab) => string,
): void {
  todo();
}
export function feedbackStep(_s: FeedbackState, _e: FeedbackEvent): FeedbackState {
  return todo();
}
export function renderFeedback(_f: FrameChrome, _s: FeedbackState): void {
  todo();
}
