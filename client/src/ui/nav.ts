// ui/nav.ts — the pure navigation core (design §6). STUB: ctl-4 red phase.
import type { VButton } from '../input/buttons';

export interface NavItem {
  readonly key: string;
  readonly enabled: boolean;
  readonly reason?: string;
}
export type ItemLayout =
  | { readonly kind: 'list'; readonly items: readonly NavItem[] }
  | { readonly kind: 'grid'; readonly items: readonly NavItem[]; readonly cols: number };
export interface NavTab {
  readonly key: string;
  readonly layout: ItemLayout;
}
export type NavLayout = ItemLayout | { readonly kind: 'tabs'; readonly tabs: readonly NavTab[] };

export interface NavState {
  readonly tab: string | null;
  readonly item: string | null;
  readonly perTab: Readonly<Record<string, string>>;
}
export interface NavInput {
  readonly button: VButton;
  readonly repeat: boolean;
}
export type NavOutcome =
  | { readonly kind: 'moved' }
  | { readonly kind: 'none' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'activate'; readonly tab: string | null; readonly key: string }
  | {
      readonly kind: 'disabled';
      readonly tab: string | null;
      readonly key: string;
      readonly reason: string | undefined;
    };
export type NavMemory = ReadonlyMap<string, NavState>;

const todo = (): never => {
  throw new Error('ctl-4: not implemented');
};
export const EMPTY_NAV_MEMORY: NavMemory = new Map();
export function list(_items: readonly NavItem[]): ItemLayout {
  return todo();
}
export function grid(_items: readonly NavItem[], _cols: number): ItemLayout {
  return todo();
}
export function tabs(_tabs: readonly NavTab[]): NavLayout {
  return todo();
}
export function navInit(_layout: NavLayout, _remembered?: NavState): NavState {
  return todo();
}
export function navFocus(
  _layout: NavLayout,
  _state: NavState,
  _target: { readonly tab?: string; readonly item?: string },
): NavState {
  return todo();
}
export function navStep(
  _layout: NavLayout,
  _state: NavState,
  _input: NavInput,
): { state: NavState; outcome: NavOutcome } {
  return todo();
}
export function navReconcile(_prev: NavLayout, _next: NavLayout, _state: NavState): NavState {
  return todo();
}
export function rememberNav(_mem: NavMemory, _frame: string, _state: NavState): NavMemory {
  return todo();
}
export function recallNav(_mem: NavMemory, _frame: string): NavState | undefined {
  return todo();
}
