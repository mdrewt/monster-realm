// ui/i18n/messageIds.ts — the i18n module's type SSOT: the `MessageId` literal union, the
// parameter table, and the compile-total `Catalog` shape (m24-s1, ADR-0256 D2/D4/D7).
//
// TYPES ONLY, ZERO IMPORTS. Everything the resolver, the catalogs and the compile suite agree on
// lives here, so a key that is misspelt, omitted from a locale, or handed to the wrong resolver
// is a `tsc` error and never a runtime blank (M24 §2.0, §2.3). The negative-compile suite
// (`i18nTypes.compile.test.ts`) proves each guarantee by spawning `tsc` on fixtures that must
// NOT compile — see ADR-0256 D3 for why that beats `@ts-expect-error`.
//
// KEY GRAMMAR (ADR-0256 D5): dot-separated segments `[a-z][a-zA-Z0-9]*`, at least two. The
// camelCase tail is deliberate — the M23 `OverlayId` stays verbatim inside a key
// (`a11y.overlay.boxView.title`, ADR-0205 D5), so the spec's own `[a-z0-9]+` is corrected here.

/** Every message the catalogs must define. S1 seeded the `chrome.*` namespace; S3 (ADR-0259)
 *  added `battle.*` and `pvp.*` as it migrated battleView.ts/pvpView.ts; S4 (ADR-0260) added
 *  `evolution.*`, `raising.*`, `box.*`, `trade.*` and `shop.*` for the five mid-density views;
 *  S5 (ADR-0261) added the tail — `tradePropose.*`, `dialogue.*`, `claim.*`, `leaderboard.*`,
 *  `errorOverlay.*`, `questLog.*`, `heal.*`, `privacy.*`, `evolutionNotice.*` — and gave three
 *  `chrome.*` keys their first call sites; S6 wires boot. Adding a literal here is what forces EVERY
 *  registered catalog to grow (the mapped `Catalog` below is total over this union). Keys are
 *  `<namespace>.<screen>.<element>` (M24 §2.3), semantic — named for what the string IS, never
 *  for the DOM mechanism that shows it (`battle.skill.accuracy`, not `accuracyTitle`). */
export type MessageId =
  | 'chrome.helpHint'
  | 'chrome.help.title'
  | 'chrome.rename.submit'
  | 'chrome.tradePropose.submit'
  | 'chrome.status.exportBlocked'
  | 'chrome.status.privacyOverlayBusy'
  | 'chrome.status.disconnected'
  | 'chrome.status.contentStale'
  | 'chrome.status.bugBundleBlocked'
  | 'chrome.status.healUnavailable'
  | 'battle.title'
  | 'battle.continueHint'
  | 'battle.swap.hint'
  | 'battle.pvp.waiting'
  | 'battle.weather.banner'
  | 'battle.card.you'
  | 'battle.card.opponent'
  | 'battle.card.level'
  | 'battle.card.hpLine'
  | 'battle.skill.pvpSubmit'
  | 'battle.skill.pveLabel'
  | 'battle.skill.accuracy'
  | 'battle.action.flee'
  | 'battle.recruit.noBait'
  | 'battle.recruit.submit'
  | 'battle.cure.placeholder'
  | 'battle.cure.option'
  | 'battle.cure.submit'
  | 'battle.swap.pvpSubmit'
  | 'battle.swap.pveLabel'
  | 'battle.outcome.victory'
  | 'battle.outcome.defeat'
  | 'battle.outcome.fled'
  | 'pvp.title.idle'
  | 'pvp.title.challenge'
  | 'pvp.incoming.label'
  | 'pvp.incoming.accept'
  | 'pvp.incoming.decline'
  | 'pvp.outgoing.label'
  | 'pvp.outgoing.cancel'
  | 'pvp.players.none'
  | 'pvp.players.heading'
  // m24-s4 (ADR-0260) — evolution.* : the evolution screen (evolutionView.ts).
  | 'evolution.title'
  | 'evolution.hint'
  | 'evolution.monsters.empty'
  | 'evolution.card.stats'
  | 'evolution.card.noPaths'
  | 'evolution.card.ready'
  | 'evolution.card.choosePrompt'
  | 'evolution.path.heading'
  | 'evolution.path.allMet'
  | 'evolution.gate.metRow'
  | 'evolution.gate.unmetRow'
  | 'evolution.choice.evolve'
  // m24-s4 — raising.* : the raising / inventory screen (raisingView.ts).
  | 'raising.title'
  | 'raising.monsters.heading'
  | 'raising.inventory.heading'
  | 'raising.monsters.empty'
  | 'raising.card.status'
  | 'raising.card.stats'
  | 'raising.card.care'
  | 'raising.card.train'
  | 'raising.inventory.empty'
  | 'raising.inventory.item'
  // m24-s4 — box.* : the party / box screen (boxView.ts).
  | 'box.title'
  | 'box.heal'
  | 'box.hint'
  | 'box.section.party'
  | 'box.section.box'
  | 'box.party.emptySlot'
  | 'box.box.empty'
  | 'box.card.rename'
  | 'box.card.stats'
  | 'box.card.evolveBadge'
  | 'box.card.toBox'
  | 'box.card.toParty'
  | 'box.rename.prompt'
  // m24-s4 — trade.* : the live-trade overlay (tradeView.ts); `tradePropose.*` is the dialog.
  | 'trade.status.none'
  | 'trade.side.offer'
  | 'trade.side.receive'
  | 'trade.side.card'
  | 'trade.side.currency'
  | 'trade.side.nothing'
  | 'trade.action.accept'
  | 'trade.action.reject'
  | 'trade.action.confirm'
  | 'trade.action.cancel'
  // m24-s4 — shop.* : the shop overlay (shopView.ts).
  | 'shop.title'
  | 'shop.noShop'
  | 'shop.forSale.empty'
  | 'shop.inventory.empty'
  | 'shop.buy.row'
  | 'shop.buy.submit'
  | 'shop.sell.row'
  | 'shop.sell.submit'
  | 'shop.sell.unsellable'
  // m24-s5 (ADR-0261) — tradePropose.* : the trade-proposal dialog (tradeProposeView.ts); its
  // submit label is the S1-seeded `chrome.tradePropose.submit`.
  | 'tradePropose.target.placeholder'
  // m24-s5 (ADR-0261) — dialogue.* : the NPC dialogue overlay (dialogueView.ts).
  | 'dialogue.action.shop'
  // m24-s5 (ADR-0261) — claim.* : the guest-claim overlay (claimView.ts). Its button and the
  // privacy heading below share English bytes today but are TWO keys (ADR-0261 D2).
  | 'claim.privacyButton'
  // m24-s5 (ADR-0261) — leaderboard.* : the ranked leaderboard overlay (leaderboardView.ts).
  | 'leaderboard.empty'
  | 'leaderboard.row'
  // m24-s5 (ADR-0261) — errorOverlay.* : the F9 error overlay (errorOverlayView.ts).
  | 'errorOverlay.footer'
  // m24-s5 (ADR-0261) — questLog.* : the quest log overlay (questLogView.ts).
  | 'questLog.entry'
  // m24-s5 (ADR-0261) — heal.* : the heal overlay (healView.ts).
  | 'heal.location'
  // m24-s5 (ADR-0261) — privacy.* : the privacy surface (privacyView.ts).
  | 'privacy.title'
  | 'privacy.close'
  | 'privacy.confirm.delete'
  | 'privacy.confirm.keep'
  // m24-s5 (ADR-0261) — evolutionNotice.* : the post-evolve reveal banner (evolutionNotice.ts).
  | 'evolutionNotice.ok'
  | 'evolutionNotice.species.fallback'
  | 'evolutionNotice.reveal.nicknamed'
  | 'evolutionNotice.reveal.anonymous';

/** The ONE hand-written parameter table (ADR-0256 D7): a key appears here iff its message takes
 *  parameters, and `ParamMessageId` is DERIVED from it — one table, not two lists to keep in
 *  sync. A key listed here that is not a `MessageId` fails to compile at the resolver's catalog
 *  indexing, so no separate subset assert is needed. */
export interface MessageParams {
  readonly 'chrome.status.disconnected': { readonly where: string };
  // m24-s3 (ADR-0259 D2/D3): every param below is MODEL DATA — affinity names, weather labels,
  // status names, species/skill/item names, player display names and counts — interpolated
  // verbatim, never catalogued (M24 §2.5: content stays English this milestone).
  readonly 'battle.weather.banner': { readonly label: string; readonly turns: number };
  readonly 'battle.card.level': { readonly level: number };
  readonly 'battle.card.hpLine': {
    readonly current: number;
    readonly max: number;
    readonly affinity: string;
  };
  readonly 'battle.skill.pvpSubmit': { readonly name: string; readonly affinity: string };
  readonly 'battle.skill.pveLabel': {
    readonly name: string;
    readonly power: number;
    readonly affinity: string;
  };
  readonly 'battle.skill.accuracy': { readonly accuracy: number };
  readonly 'battle.cure.option': {
    readonly name: string;
    readonly cureStatus: string;
    readonly count: number;
  };
  readonly 'battle.swap.pvpSubmit': { readonly species: string };
  readonly 'battle.swap.pveLabel': {
    readonly species: string;
    readonly current: number;
    readonly max: number;
  };
  readonly 'pvp.incoming.label': { readonly challenger: string };
  readonly 'pvp.outgoing.label': { readonly target: string };
  // m24-s4 (ADR-0260 D3): again MODEL DATA only — species/nick/item names, server-derived
  // tiers, stats, counts and prices. `bigint` where the model is bigint (trade currency, shop
  // prices): template interpolation of a bigint is byte-identical to the literal it replaced.
  readonly 'evolution.card.stats': {
    readonly level: number;
    readonly stage: number;
    readonly trust: string;
    readonly qualityTime: number;
    readonly nutrition: number;
  };
  readonly 'evolution.card.ready': { readonly species: string };
  readonly 'evolution.path.heading': { readonly species: string };
  readonly 'evolution.gate.metRow': {
    readonly label: string;
    readonly current: string;
    readonly required: string;
  };
  readonly 'evolution.gate.unmetRow': {
    readonly label: string;
    readonly current: string;
    readonly required: string;
  };
  readonly 'evolution.choice.evolve': { readonly species: string };
  readonly 'raising.card.status': {
    readonly level: number;
    readonly trust: string;
    readonly current: number;
    readonly max: number;
  };
  readonly 'raising.card.stats': {
    readonly attack: number;
    readonly defense: number;
    readonly speed: number;
    readonly spAttack: number;
    readonly spDefense: number;
  };
  readonly 'raising.card.train': { readonly name: string; readonly count: number };
  readonly 'raising.inventory.item': { readonly name: string; readonly count: number };
  readonly 'box.party.emptySlot': { readonly slot: number };
  readonly 'box.card.stats': {
    readonly species: string;
    readonly level: number;
    readonly current: number;
    readonly max: number;
    readonly percent: number;
  };
  readonly 'trade.side.card': {
    readonly nickname: string;
    readonly species: string;
    readonly level: number;
    readonly current: number;
    readonly max: number;
  };
  readonly 'trade.side.currency': { readonly amount: bigint };
  readonly 'shop.buy.row': { readonly name: string; readonly price: bigint };
  readonly 'shop.sell.row': {
    readonly name: string;
    readonly count: number;
    readonly price: bigint;
  };
  readonly 'shop.sell.unsellable': { readonly name: string; readonly count: number };
  // m24-s5 (ADR-0261 D5): MODEL DATA only, again — ranked numbers, a quest content id and step,
  // the heal model's own cost text, species/nickname names. The leaderboard DISPLAY NAME is
  // deliberately NOT a param (I18N-21): it renders in a sibling `<bdi>`, never through a catalog.
  readonly 'leaderboard.row': {
    readonly rating: number;
    readonly wins: number;
    readonly losses: number;
  };
  readonly 'questLog.entry': { readonly name: string; readonly step: number };
  readonly 'heal.location': { readonly cost: string };
  readonly 'evolutionNotice.species.fallback': { readonly id: number };
  readonly 'evolutionNotice.reveal.nicknamed': {
    readonly nickname: string;
    readonly from: string;
    readonly to: string;
  };
  readonly 'evolutionNotice.reveal.anonymous': { readonly from: string; readonly to: string };
}

/** Keys resolved by `tf(key, params)`. */
export type ParamMessageId = keyof MessageParams;

/** Keys resolved by `t(key)` — everything that is not parameterized. */
export type PlainMessageId = Exclude<MessageId, ParamMessageId>;

/**
 * The accessible-name keys `t()` also accepts. EMPTY TODAY (ADR-0256 D4): M23's
 * `ui/a11yCopy.ts` exports `a11yCopy: Readonly<Record<string, string>>`, whose `keyof` is
 * `string` — importing it would widen `t` to `(key: string) => string` and silently destroy
 * every totality guarantee in this file (the compile suite's `bad-t-wide` fixture is the oracle
 * for exactly that). `never` keeps `t(key: A11yKey | PlainMessageId)` byte-identical to M23 §2.8
 * while collapsing to `t(key: PlainMessageId)`, so the future flip is a pure widening.
 *
 * FOLLOW-UP (ADR-0256 consequences (a)): once `a11yCopy.ts` exports a literal-typed
 * `A11Y_COPY_EN`, set `A11yKey = keyof typeof A11Y_COPY_EN` here — no call site changes.
 */
export type A11yKey = never;

/** A locale's complete catalog: TOTAL over `MessageId` (omit one key → TS2741), with each
 *  parameterized key holding a closure over its declared params and every other key a plain
 *  string. `readonly` is the declared invariant; `Object.freeze` in each catalog makes it real. */
export type Catalog = {
  readonly [K in MessageId]: K extends ParamMessageId ? (p: MessageParams[K]) => string : string;
};

/** Type-level assert: no parameterized key may live in the `a11y.*` namespace — accessible
 *  names are plain strings by construction (M23 bans `{`/`}` in a11y values), so an `a11y.*`
 *  entry in `MessageParams` is a modelling error caught here at `tsc` time. Exported because
 *  `noUnusedLocals` would otherwise flag the alias (TS6196). */
export type AssertNoA11yParamKey = [Extract<ParamMessageId, `a11y.${string}`>] extends [never]
  ? true
  : never;
