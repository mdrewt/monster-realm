// ui/helpModel.ts — How to Play's content (uif-14, UIF14.1-UIF14.4). Pure: no DOM, SDK or module
// state. Two tabs: Introduction (a short, spoiler-free blurb about the game) and Encyclopedia (the
// game's special terms and mechanics, each with a definition and the entries related to it). Every
// string is a catalog id read in the active locale, through a thunk over a LITERAL id (the catalog
// parity scan cannot follow a computed one), so a locale switch shows at the next build. The model is
// display-only: no callback or reducer field.
import { t } from './i18n/resolver';

export const HELP_TABS = ['intro', 'encyclopedia'] as const;
export type HelpTab = (typeof HELP_TABS)[number];

/** The Encyclopedia's entries, in list order. */
export const ENTRY_KEYS = [
  'party',
  'storage',
  'recruit',
  'bait',
  'evolution',
  'essence',
  'affinity',
  'status',
  'ap',
  'initiative',
  'queue',
  'idle',
  'stance',
  'guard',
  'deploy',
  'ranked',
] as const;
export type EntryKey = (typeof ENTRY_KEYS)[number];

export interface HelpEntry {
  readonly key: EntryKey;
  readonly term: string;
  readonly definition: string;
  /** The entries the detail names as related mechanics: at least one, never the entry itself. */
  readonly related: readonly EntryKey[];
}

export interface HelpViewModel {
  readonly tabs: readonly { readonly tab: HelpTab; readonly title: string }[];
  readonly intro: { readonly paragraphs: readonly string[] };
  readonly entries: readonly HelpEntry[];
}

const TAB_TITLES: Readonly<Record<HelpTab, () => string>> = {
  intro: () => t('help.tab.intro'),
  encyclopedia: () => t('help.tab.encyclopedia'),
};

const PARAGRAPHS: readonly (() => string)[] = [() => t('help.intro.p1'), () => t('help.intro.p2')];

interface EntrySource {
  readonly term: () => string;
  readonly definition: () => string;
  readonly related: readonly EntryKey[];
}

const ENTRIES: Readonly<Record<EntryKey, EntrySource>> = {
  party: {
    term: () => t('help.entry.party.term'),
    definition: () => t('help.entry.party.def'),
    related: ['storage', 'deploy', 'recruit'],
  },
  storage: {
    term: () => t('help.entry.storage.term'),
    definition: () => t('help.entry.storage.def'),
    related: ['party', 'recruit'],
  },
  recruit: {
    term: () => t('help.entry.recruit.term'),
    definition: () => t('help.entry.recruit.def'),
    related: ['bait', 'storage', 'ap'],
  },
  bait: {
    term: () => t('help.entry.bait.term'),
    definition: () => t('help.entry.bait.def'),
    related: ['recruit'],
  },
  evolution: {
    term: () => t('help.entry.evolution.term'),
    definition: () => t('help.entry.evolution.def'),
    related: ['essence', 'affinity'],
  },
  essence: {
    term: () => t('help.entry.essence.term'),
    definition: () => t('help.entry.essence.def'),
    related: ['evolution', 'affinity'],
  },
  affinity: {
    term: () => t('help.entry.affinity.term'),
    definition: () => t('help.entry.affinity.def'),
    related: ['essence', 'evolution'],
  },
  status: {
    term: () => t('help.entry.status.term'),
    definition: () => t('help.entry.status.def'),
    related: ['initiative', 'guard'],
  },
  ap: {
    term: () => t('help.entry.ap.term'),
    definition: () => t('help.entry.ap.def'),
    related: ['queue', 'guard', 'recruit'],
  },
  initiative: {
    term: () => t('help.entry.initiative.term'),
    definition: () => t('help.entry.initiative.def'),
    related: ['queue', 'ap'],
  },
  queue: {
    term: () => t('help.entry.queue.term'),
    definition: () => t('help.entry.queue.def'),
    related: ['ap', 'initiative', 'idle'],
  },
  idle: {
    term: () => t('help.entry.idle.term'),
    definition: () => t('help.entry.idle.def'),
    related: ['queue', 'ranked'],
  },
  stance: {
    term: () => t('help.entry.stance.term'),
    definition: () => t('help.entry.stance.def'),
    related: ['recruit', 'guard'],
  },
  guard: {
    term: () => t('help.entry.guard.term'),
    definition: () => t('help.entry.guard.def'),
    related: ['ap', 'status'],
  },
  deploy: {
    term: () => t('help.entry.deploy.term'),
    definition: () => t('help.entry.deploy.def'),
    related: ['party', 'ranked'],
  },
  ranked: {
    term: () => t('help.entry.ranked.term'),
    definition: () => t('help.entry.ranked.def'),
    related: ['deploy', 'idle'],
  },
};

/** Build How to Play in the active locale. Every call returns fresh objects. */
export function buildHelpViewModel(): HelpViewModel {
  return {
    tabs: HELP_TABS.map((tab) => ({ tab, title: TAB_TITLES[tab]() })),
    intro: { paragraphs: PARAGRAPHS.map((p) => p()) },
    entries: ENTRY_KEYS.map((key) => ({
      key,
      term: ENTRIES[key].term(),
      definition: ENTRIES[key].definition(),
      related: [...ENTRIES[key].related],
    })),
  };
}
