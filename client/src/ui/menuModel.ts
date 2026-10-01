// ui/menuModel.ts — the main-menu entry table (design §5, CTL5.1). Pure data: no DOM, SDK or
// module state. Navigation is the nav kit's (`ui/nav.ts`) and the menu's rules are the screen's
// (`ui/screens/mainMenuScreen.ts`); this file only says which entries exist, in which order, what
// they are called and what each one opens.
//
// Every title and description is a thunk over a literal catalog id, so the same table renders in
// whichever locale is active when it is read, and catalogParity's DYNAMIC-KEY / DEAD-KEY checks see
// each id at its call site.
//
// Until the ctl-8 screens land, each leaf opens a legacy overlay and the groups are one-level
// sub-lists inside the menu frame. Interact, Evolve and Offer a Trade are reachable by their
// hotkeys only until ctl-8/ctl-10 give them a home.
import { t } from './i18n/resolver';
import type { OverlayId } from './overlayRegistry';

/** The legacy overlays a menu leaf opens. */
export type MenuTarget = Extract<
  OverlayId,
  | 'boxView'
  | 'raisingView'
  | 'questLogView'
  | 'tradeView'
  | 'pvpView'
  | 'leaderboardView'
  | 'renameView'
  | 'claimView'
  | 'privacyView'
  | 'helpView'
>;

export type MenuGroupKey = 'social' | 'profile' | 'options';

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
/** A to enter a one-level sub-list. */
export interface MenuGroup extends MenuRowText {
  readonly kind: 'group';
  readonly key: MenuGroupKey;
  readonly children: readonly MenuLeaf[];
}
/** A to close the menu. */
export interface MenuClose extends MenuRowText {
  readonly kind: 'close';
}
export type MenuEntry = MenuLeaf | MenuGroup | MenuClose;

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
    kind: 'group',
    key: 'social',
    title: () => t('menu.social.title'),
    description: () => t('menu.social.desc'),
    children: [
      {
        kind: 'open',
        key: 'trades',
        title: () => t('menu.social.trades.title'),
        description: () => t('menu.social.trades.desc'),
        target: 'tradeView',
      },
      {
        kind: 'open',
        key: 'challenges',
        title: () => t('menu.social.challenges.title'),
        description: () => t('menu.social.challenges.desc'),
        target: 'pvpView',
      },
      {
        kind: 'open',
        key: 'rankings',
        title: () => t('menu.social.rankings.title'),
        description: () => t('menu.social.rankings.desc'),
        target: 'leaderboardView',
      },
    ],
  },
  {
    kind: 'group',
    key: 'profile',
    title: () => t('menu.profile.title'),
    description: () => t('menu.profile.desc'),
    children: [
      {
        kind: 'open',
        key: 'name',
        title: () => t('menu.profile.name.title'),
        description: () => t('menu.profile.name.desc'),
        target: 'renameView',
      },
      {
        kind: 'open',
        key: 'account',
        title: () => t('menu.profile.account.title'),
        description: () => t('menu.profile.account.desc'),
        target: 'claimView',
      },
      {
        kind: 'open',
        key: 'privacy',
        title: () => t('menu.profile.privacy.title'),
        description: () => t('menu.profile.privacy.desc'),
        target: 'privacyView',
      },
    ],
  },
  {
    kind: 'group',
    key: 'options',
    title: () => t('menu.options.title'),
    description: () => t('menu.options.desc'),
    children: [
      {
        kind: 'open',
        key: 'help',
        title: () => t('menu.options.help.title'),
        description: () => t('menu.options.help.desc'),
        target: 'helpView',
      },
    ],
  },
  {
    kind: 'close',
    key: 'close',
    title: () => t('menu.close.title'),
    description: () => t('menu.close.desc'),
  },
];

/** The menu's title (the root's frame title and every sub-list's breadcrumb). */
export const menuTitle = (): string => t('menu.title');

/** The group entry for `key`, or undefined. */
export function menuGroup(key: MenuGroupKey): MenuGroup | undefined {
  return MENU_ENTRIES.find((e): e is MenuGroup => e.kind === 'group' && e.key === key);
}
