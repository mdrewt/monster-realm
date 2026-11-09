// ui/menuModel.ts — the main-menu entry table (design §5, CTL5.1). Pure data: no DOM, SDK or
// module state. Navigation is the nav kit's (`ui/nav.ts`) and the menu's rules are the screen's
// (`ui/screens/mainMenuScreen.ts`); this file only says which entries exist, in which order, what
// they are called and what each one opens.
//
// Every title and description is a thunk over a literal catalog id, so the same table renders in
// whichever locale is active when it is read, and catalogParity's DYNAMIC-KEY / DEAD-KEY checks see
// each id at its call site.
//
// The menu is one flat list (#586 D3): each leaf opens one frame and Close closes the menu. Social
// opens the 4-tab Social frame directly, on the tab the screen picks (uif-15b); Profile opens the one
// Profile screen, on its Name section (uif-16b); How to Play and Controls sit at the root where the
// Options sub-list was (uif-15c).
// No leaf starts a trade or a challenge: both start face to face (A on the player you face,
// ctl-10b); Social only answers them.
import type { FrameId } from './contextStack';
import { t } from './i18n/resolver';

/** The frames a menu leaf opens. */
export type MenuTarget = Extract<
  FrameId,
  | 'boxView'
  | 'raisingView'
  | 'questLogView'
  | 'social'
  | 'profileView'
  | 'helpView'
  | 'controlsView'
>;

interface MenuRowText {
  readonly key: string;
  readonly title: () => string;
  readonly description: () => string;
}
/** A to open an overlay above the menu. */
export interface MenuLeaf extends MenuRowText {
  readonly kind: 'open';
  readonly target: MenuTarget;
}
/** A to close the menu. */
export interface MenuClose extends MenuRowText {
  readonly kind: 'close';
}
export type MenuEntry = MenuLeaf | MenuClose;

/** The root list, in display order. */
export const MENU_ENTRIES: readonly MenuEntry[] = [
  {
    kind: 'open',
    key: 'monsters',
    title: () => t('menu.monsters.title'),
    description: () => t('menu.monsters.desc'),
    target: 'boxView',
  },
  {
    kind: 'open',
    key: 'bag',
    title: () => t('menu.bag.title'),
    description: () => t('menu.bag.desc'),
    target: 'raisingView',
  },
  {
    kind: 'open',
    key: 'journal',
    title: () => t('menu.journal.title'),
    description: () => t('menu.journal.desc'),
    target: 'questLogView',
  },
  {
    kind: 'open',
    key: 'social',
    title: () => t('menu.social.title'),
    description: () => t('menu.social.desc'),
    target: 'social',
  },
  {
    kind: 'open',
    key: 'profile',
    title: () => t('menu.profile.title'),
    description: () => t('menu.profile.desc'),
    target: 'profileView',
  },
  {
    kind: 'open',
    key: 'help',
    title: () => t('menu.help.title'),
    description: () => t('menu.help.desc'),
    target: 'helpView',
  },
  {
    kind: 'open',
    key: 'controls',
    title: () => t('menu.controls.title'),
    description: () => t('menu.controls.desc'),
    target: 'controlsView',
  },
  {
    kind: 'close',
    key: 'close',
    title: () => t('menu.close.title'),
    description: () => t('menu.close.desc'),
  },
];

/** The menu's title (its frame title). */
export const menuTitle = (): string => t('menu.title');

/** `labels` with the Social row badged while a trade or challenge request waits (ctl-13, CTL13.2):
 *  the badge is text, so a screen reader reads it. The SAME object when nothing changes. */
export function withRequestBadge(
  labels: Readonly<Record<string, string>>,
  waiting: boolean,
): Readonly<Record<string, string>> {
  const social = labels.social;
  if (!waiting || social === undefined) return labels;
  return { ...labels, social: `${social} (${t('chrome.badge.request')})` };
}
