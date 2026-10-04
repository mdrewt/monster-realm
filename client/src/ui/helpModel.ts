// ui/helpModel.ts — the generated Help (ctl-14, CTL14.1; design §9). Pure: no DOM, SDK or module
// state. Nothing here is written by hand: This screen is the hint bar of the context beneath Help
// (`hintBar`, the context table), All controls is every button and shortcut with its LIVE keys
// (`controlsModel`'s rows and labels, `glyph`), and the tab titles, goals and the "key names vs
// button names" note are catalog ids read in the active locale. A remap or a locale switch shows
// at the next build. The model is display-only: no callback or reducer field.
import type { Bindings } from '../input/bindings';
import { glyph } from '../input/glyphs';
import { controlsRows, rowLabel, slots } from './controlsModel';
import type { HintChip } from './hintBarModel';
import { t } from './i18n/resolver';

export const HELP_TABS = ['screen', 'controls', 'goals'] as const;
export type HelpTab = (typeof HELP_TABS)[number];

/** One line of Help: the keys that press it (none for a goal or an unbound shortcut) and what it does. */
export interface HelpRow {
  readonly keys: readonly string[];
  readonly action: string;
}

export interface HelpViewModel {
  readonly tabs: readonly {
    readonly tab: HelpTab;
    readonly title: string;
    readonly rows: readonly HelpRow[];
  }[];
  /** "Key names vs button names": shown on the All controls tab. */
  readonly note: string;
}

const TAB_TITLES: Readonly<Record<HelpTab, () => string>> = {
  screen: () => t('help.tab.screen'),
  controls: () => t('help.tab.controls'),
  goals: () => t('help.tab.goals'),
};

const GOALS: readonly (() => string)[] = [
  () => t('help.goal.recruit'),
  () => t('help.goal.battle'),
  () => t('help.goal.trade'),
];

/** Build Help for `screen`, the hint chips of the context beneath it, over the live `bindings`.
 *  Every call returns fresh objects. */
export function buildHelpViewModel(screen: readonly HintChip[], bindings: Bindings): HelpViewModel {
  const rows: Record<HelpTab, HelpRow[]> = {
    screen: screen.map((chip) => ({
      keys: chip.keycap === '' ? [] : [chip.keycap],
      action: chip.verb,
    })),
    controls: [...controlsRows('buttons'), ...controlsRows('shortcuts')].map((row) => ({
      keys: slots(bindings, row)
        .filter((code) => code !== undefined)
        .map(glyph),
      action: rowLabel(row),
    })),
    goals: GOALS.map((goal) => ({ keys: [], action: goal() })),
  };
  return {
    tabs: HELP_TABS.map((tab) => ({ tab, title: TAB_TITLES[tab](), rows: rows[tab] })),
    note: t('help.note.keysVsButtons'),
  };
}
