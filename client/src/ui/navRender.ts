// ui/navRender.ts — renders a nav layout into one persistent container (design §6). STUB: ctl-4 red phase.
import type { NavItem, NavLayout, NavState, NavTab } from './nav';

export interface NavRenderOptions {
  readonly frame: string;
  readonly fill: (el: HTMLElement, item: NavItem) => void;
  readonly labelledBy?: string;
}
const todo = (): never => {
  throw new Error('ctl-4: not implemented');
};
export function navItemId(_frame: string, _tab: string | null, _key: string): string {
  return todo();
}
export function navTabId(_frame: string, _tab: string): string {
  return todo();
}
export function renderNav(
  _container: HTMLElement,
  _layout: NavLayout,
  _state: NavState,
  _opts: NavRenderOptions,
): void {
  todo();
}
export function renderTabs(
  _strip: HTMLElement,
  _layout: NavLayout,
  _state: NavState,
  _opts: { readonly frame: string; readonly label: (tab: NavTab) => string },
): void {
  todo();
}
