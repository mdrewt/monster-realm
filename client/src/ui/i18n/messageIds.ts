// ui/i18n/messageIds.ts — the i18n module's type SSOT: the `MessageId` literal union, the
// parameter table, and the compile-total `Catalog` shape.
//
// TYPES ONLY, ZERO IMPORTS. Everything the resolver, the catalogs and the compile suite agree on
// lives here, so a key that is misspelt, omitted from a locale, or handed to the wrong resolver
// is a `tsc` error and never a runtime blank (M24 §2.0, §2.3). The negative-compile suite
// (`i18nTypes.compile.test.ts`) proves each guarantee by spawning `tsc` on fixtures that must
// NOT compile — which, unlike `@ts-expect-error`, cannot pass on an unrelated error.
//
// KEY GRAMMAR: dot-separated segments `[a-z][a-zA-Z0-9]*`, at least two. The
// camelCase tail is deliberate — the M23 `OverlayId` stays verbatim inside a key
// (`a11y.overlay.boxView.title`), so the spec's own `[a-z0-9]+` is corrected here.

/** Every message the catalogs must define. S1 seeded the `chrome.*` namespace; S3
 *  added `battle.*` and `pvp.*` as it migrated battleView.ts/pvpView.ts; S4 added
 *  `evolution.*`, `raising.*`, `box.*`, `trade.*` and `shop.*` for the five mid-density views;
 *  S5 added the tail — `tradePropose.*`, `dialogue.*`, `claim.*`, `leaderboard.*`,
 *  `errorOverlay.*`, `questLog.*`, `heal.*`, `privacy.*`, `evolutionNotice.*` — and gave three
 *  `chrome.*` keys their first call sites; S6 wires boot; 21r-b2 grew `claim.*` and `privacy.*`
 *  with the claim overlay's and the privacy surface's own copy (claimModel.ts, privacyBanner.ts).
 *  Adding a literal here is what forces EVERY
 *  registered catalog to grow (the mapped `Catalog` below is total over this union). Keys are
 *  `<namespace>.<screen>.<element>` (M24 §2.3), semantic — named for what the string IS, never
 *  for the DOM mechanism that shows it (`battle.commands.waiting`, not `captionText`). */
export type MessageId =
  | 'chrome.chip.menu'
  | 'chrome.chip.help'
  // interact.* / key.* : the world interaction chip and picker (main.ts, ctl-10a).
  | 'interact.chip'
  | 'interact.choose'
  | 'interact.entry'
  | 'interact.verb.talk'
  | 'interact.verb.shop'
  | 'interact.verb.heal'
  | 'interact.verb.trade'
  | 'interact.verb.challenge'
  | 'interact.confirm.challenge'
  | 'interact.healer'
  | 'key.enter'
  // key.* / controls.* : keycap names (input/glyphs.ts) and Options › Controls (ui/controlsModel.ts, ctl-12).
  | 'key.numpadEnter'
  | 'key.backspace'
  | 'key.space'
  | 'key.escape'
  | 'key.arrowUp'
  | 'key.arrowDown'
  | 'key.arrowLeft'
  | 'key.arrowRight'
  | 'key.pageUp'
  | 'key.pageDown'
  | 'key.slash'
  | 'key.numpad'
  | 'controls.button.up'
  | 'controls.button.down'
  | 'controls.button.left'
  | 'controls.button.right'
  | 'controls.button.a'
  | 'controls.button.b'
  | 'controls.button.x'
  | 'controls.button.y'
  | 'controls.button.lb'
  | 'controls.button.rb'
  | 'controls.button.start'
  | 'controls.button.select'
  | 'controls.accel.storage'
  | 'controls.accel.bag'
  | 'controls.accel.party'
  | 'controls.accel.journal'
  | 'controls.accel.trades'
  | 'controls.accel.challenges'
  | 'controls.accel.rankings'
  | 'controls.accel.name'
  | 'controls.accel.account'
  | 'controls.accel.bugReport'
  | 'controls.accel.dismissError'
  | 'controls.capture.prompt'
  | 'controls.refused.reserved'
  | 'controls.refused.protected'
  | 'controls.cancelled'
  | 'controls.bound'
  | 'controls.swapped'
  | 'controls.swappedUnbound'
  | 'controls.swappedSlots'
  | 'chrome.help.title'
  | 'chrome.rename.submit'
  | 'chrome.tradePropose.submit'
  | 'chrome.status.exportBlocked'
  | 'chrome.status.privacyOverlayBusy'
  | 'chrome.status.disconnected'
  | 'chrome.status.contentStale'
  | 'chrome.status.bugBundleBlocked'
  | 'chrome.status.healUnavailable'
  | 'chrome.status.partyFull'
  | 'chrome.feedback.disconnected'
  | 'chrome.rename.updated'
  | 'chrome.session.expired.title'
  | 'chrome.session.expired.body'
  | 'chrome.session.unreachable.title'
  | 'chrome.session.unreachable.body'
  | 'chrome.session.continue'
  | 'chrome.session.confirmPrompt'
  | 'session.retry'
  | 'session.hint'
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
  | 'battle.commands.waiting'
  | 'battle.action.flee'
  | 'battle.recruit.listLabel'
  | 'battle.recruit.noBait'
  | 'battle.recruit.confirm'
  | 'battle.recruit.confirmNoBait'
  | 'battle.recruit.yes'
  | 'battle.recruit.no'
  | 'battle.cure.listLabel'
  | 'battle.cure.option'
  | 'battle.cure.target'
  | 'battle.swap.pvpSubmit'
  | 'battle.swap.pveLabel'
  | 'battle.outcome.victory'
  | 'battle.outcome.defeat'
  | 'battle.outcome.fled'
  // ctl-8i: the battle command list (battleView.ts).
  | 'battle.command.fight'
  | 'battle.command.recruit'
  | 'battle.command.swap'
  | 'battle.command.bag'
  | 'battle.command.run'
  | 'battle.commands.label'
  | 'battle.command.runPvpReason'
  | 'pvp.title.idle'
  | 'pvp.title.challenge'
  | 'pvp.incoming.label'
  | 'pvp.incoming.accept'
  | 'pvp.incoming.decline'
  | 'pvp.outgoing.label'
  | 'pvp.outgoing.cancel'
  // Evolution.* : the evolution screen (evolutionView.ts).
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
  // Raising.* : the raising / inventory screen (raisingView.ts).
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
  | 'raising.feedback.cared'
  // Box.* : the party / box screen (boxView.ts).
  | 'box.title'
  | 'box.hint'
  | 'box.section.party'
  | 'box.section.box'
  | 'box.party.emptySlot'
  | 'box.box.empty'
  | 'box.card.stats'
  | 'box.card.evolveBadge'
  | 'box.card.toBox'
  | 'box.card.toParty'
  | 'box.rename.prompt'
  | 'box.tab.party'
  | 'box.tab.storage'
  | 'box.sheet.summary'
  | 'box.sheet.nickname'
  | 'box.sheet.move'
  | 'box.feedback.movedToParty'
  | 'box.feedback.movedToBox'
  // ctl-8c: the sheet's Care / Feed… / Evolve… rows, the no-food reason, the food row, the Evolve
  // confirm and the fed line (boxView.ts).
  | 'box.sheet.care'
  | 'box.sheet.feed'
  | 'box.sheet.evolve'
  | 'box.sheet.feedNone'
  | 'box.feed.item'
  | 'box.evolve.confirm'
  | 'box.feedback.fed'
  // Trade.* : the live-trade overlay (tradeView.ts); `tradePropose.*` is the dialog.
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
  | 'trade.feedback.accepted'
  | 'trade.feedback.rejected'
  | 'trade.feedback.completed'
  | 'trade.feedback.cancelled'
  // Shop.* : the shop overlay (shopView.ts).
  | 'shop.title'
  | 'shop.noShop'
  | 'shop.forSale.empty'
  | 'shop.inventory.empty'
  | 'shop.buy.row'
  | 'shop.buy.submit'
  | 'shop.sell.row'
  | 'shop.sell.submit'
  | 'shop.sell.unsellable'
  | 'shop.feedback.buy.item'
  | 'shop.feedback.buy.count'
  | 'shop.feedback.sell.item'
  | 'shop.feedback.sell.count'
  // ctl-8a: the Buy | Sell tabs, the Y description slot's "none" mark, and the quantity and
  // confirm prompts of the D-pad shop (shopView.ts, painted by ui/screens/shopScreen.ts).
  | 'shop.tab.buy'
  | 'shop.tab.sell'
  | 'shop.description.none'
  | 'shop.qty.buy'
  | 'shop.qty.sell'
  | 'shop.confirm.buy'
  | 'shop.confirm.sell'
  // prompt.* : the Yes / No options every confirm shares (shopView.ts, healView.ts; ctl-8a).
  | 'prompt.yes'
  | 'prompt.no'
  // social.* : the Social frame's tab strip, action sheet and Yes / No questions (tradeView.ts's
  // `paintSocial`; ctl-8d), and the Players tab (leaderboardView.ts's `paintSocial`; ctl-8g).
  | 'social.tab.players'
  | 'social.tab.trades'
  | 'social.tab.challenges'
  | 'social.tab.rankings'
  | 'social.players.placeholder'
  | 'social.players.nearby'
  | 'social.players.none'
  | 'social.players.walkUp'
  | 'social.action.accept'
  | 'social.action.decline'
  | 'social.action.confirm'
  | 'social.action.cancel'
  | 'social.confirm.declineTrade'
  | 'social.confirm.confirmTrade'
  | 'social.confirm.declineChallenge'
  // tradePropose.* : the trade-proposal dialog (tradeProposeView.ts); its
  // submit label is the S1-seeded `chrome.tradePropose.submit`.
  | 'tradePropose.target.placeholder'
  | 'tradePropose.feedback.sent'
  | 'tradePropose.step.target'
  | 'tradePropose.step.offer'
  | 'tradePropose.step.coins'
  | 'tradePropose.step.ask'
  | 'tradePropose.step.review'
  | 'tradePropose.review.prompt'
  | 'tradePropose.review.incomplete'
  | 'tradePropose.review.yes'
  | 'tradePropose.review.no'
  // Dialogue.* : the NPC dialogue overlay (dialogueView.ts).
  | 'dialogue.action.shop'
  // Claim.* : the guest-claim overlay — its buttons (claimView.ts) and, since 21r-b2, its
  // titles, bodies, prompts and feedback lines (claimModel.ts). The privacy button and the
  // privacy heading below share English bytes today but are TWO keys.
  | 'claim.privacyButton'
  | 'claim.signInButton'
  | 'claim.joinButton'
  | 'claim.declineButton'
  | 'claim.declineConfirmButton'
  | 'claim.declineCancelButton'
  | 'claim.feedback.veto'
  | 'claim.nudge'
  | 'claim.decline.confirmPrompt'
  | 'claim.pending.title'
  | 'claim.pending.body'
  | 'claim.awaiting.title'
  | 'claim.awaiting.body'
  | 'claim.claimed.title'
  | 'claim.claimed.body'
  | 'claim.signInFailed.title'
  | 'claim.signInFailed.rejected'
  | 'claim.signInFailed.expired'
  | 'claim.signInFailed.declined'
  | 'claim.signInFailed.unreachable'
  | 'claim.signInFailed.fallback'
  | 'claim.reject.unusable.title'
  | 'claim.reject.unusable.body'
  | 'claim.reject.destination.title'
  | 'claim.reject.destination.body'
  | 'claim.reject.transient.title'
  | 'claim.reject.transient.body'
  | 'claim.reject.generic.title'
  | 'claim.reject.generic.body'
  // Leaderboard.* : the ranked leaderboard overlay (leaderboardView.ts).
  | 'leaderboard.empty'
  | 'leaderboard.row'
  // errorOverlay.* : the F9 error overlay (errorOverlayView.ts).
  | 'errorOverlay.footer'
  // questLog.* : the quest log overlay (questLogView.ts).
  | 'questLog.entry'
  // Heal.* : the heal overlay (healView.ts).
  | 'heal.location'
  // ctl-8a: the heal frame's question and the reason it is disabled with no bound healer.
  | 'heal.prompt.question'
  | 'heal.prompt.unavailable'
  // ctl-8e: the trade-propose wizard's Review summary (tradeProposeView.ts).
  | 'tradePropose.review.summary'
  // Privacy.* : the privacy surface — its heading and buttons (privacyView.ts) and, since
  // 21r-b2, its copy layer (privacyBanner.ts): the HUD countdown, status/notice lines, export
  // status lines and control labels.
  | 'privacy.title'
  | 'privacy.close'
  | 'privacy.confirm.delete'
  | 'privacy.confirm.keep'
  | 'privacy.countdown.dark'
  | 'privacy.countdown.due'
  | 'privacy.countdown.grace'
  | 'privacy.countdown.days'
  | 'privacy.countdown.hours'
  | 'privacy.countdown.minutes'
  | 'privacy.countdown.seconds'
  | 'privacy.notice.terminal'
  | 'privacy.notice.disconnected'
  | 'privacy.status.active'
  | 'privacy.status.unknown'
  | 'privacy.status.terminal'
  | 'privacy.export.none'
  | 'privacy.export.incomplete'
  | 'privacy.export.incompleteDark'
  | 'privacy.export.inconsistent'
  | 'privacy.export.complete'
  | 'privacy.action.delete'
  | 'privacy.confirm.prompt'
  | 'privacy.action.cancel'
  | 'privacy.action.export'
  | 'privacy.action.download'
  // evolutionNotice.* : the post-evolve reveal banner (evolutionNotice.ts).
  | 'evolutionNotice.ok'
  | 'evolutionNotice.species.fallback'
  | 'evolutionNotice.reveal.nicknamed'
  | 'evolutionNotice.reveal.anonymous'
  // menu.* : the main menu and its sub-lists (menuModel.ts, screens/mainMenuScreen.ts).
  | 'menu.title'
  | 'menu.monsters.title'
  | 'menu.monsters.desc'
  | 'menu.bag.title'
  | 'menu.bag.desc'
  | 'menu.journal.title'
  | 'menu.journal.desc'
  | 'menu.social.title'
  | 'menu.social.desc'
  | 'menu.profile.title'
  | 'menu.profile.desc'
  | 'menu.options.title'
  | 'menu.options.desc'
  | 'menu.close.title'
  | 'menu.close.desc'
  | 'menu.social.trades.title'
  | 'menu.social.trades.desc'
  | 'menu.social.challenges.title'
  | 'menu.social.challenges.desc'
  | 'menu.social.rankings.title'
  | 'menu.social.rankings.desc'
  | 'menu.profile.name.title'
  | 'menu.profile.name.desc'
  | 'menu.profile.account.title'
  | 'menu.profile.account.desc'
  | 'menu.profile.privacy.title'
  | 'menu.profile.privacy.desc'
  | 'menu.options.help.title'
  | 'menu.options.help.desc'
  | 'menu.disabled.inBattle'
  | 'menu.disabled.battleBag'
  // ctl-8f: the Bag frame (raisingView.ts) and the Journal detail (questLogView.ts).
  | 'bag.pocket.bait'
  | 'bag.pocket.food'
  | 'bag.pocket.medicine'
  | 'bag.pocket.other'
  | 'bag.action.feed'
  | 'bag.action.use'
  | 'bag.action.info'
  | 'bag.picker.title'
  | 'bag.feed.noMonsters'
  | 'journal.detail.step';

/** The ONE hand-written parameter table: a key appears here iff its message takes
 *  parameters, and `ParamMessageId` is DERIVED from it — one table, not two lists to keep in
 *  sync. A key listed here that is not a `MessageId` fails to compile at the resolver's catalog
 *  indexing, so no separate subset assert is needed. */
export interface MessageParams {
  readonly 'chrome.status.disconnected': { readonly where: string };
  readonly 'interact.chip': { readonly key: string; readonly verb: string; readonly name: string };
  readonly 'interact.choose': { readonly key: string };
  readonly 'interact.entry': { readonly verb: string; readonly name: string };
  readonly 'interact.confirm.challenge': { readonly name: string };
  readonly 'key.numpad': { readonly key: string };
  readonly 'controls.capture.prompt': { readonly label: string };
  readonly 'controls.swapped': {
    readonly key: string;
    readonly label: string;
    readonly otherKey: string;
    readonly otherLabel: string;
  };
  readonly 'controls.swappedSlots': {
    readonly key: string;
    readonly otherKey: string;
    readonly label: string;
  };
  readonly 'controls.swappedUnbound': {
    readonly key: string;
    readonly label: string;
    readonly otherLabel: string;
  };
  // Every param below is MODEL DATA — affinity names, weather labels,
  // status names, species/skill/item names, player display names and counts — interpolated
  // verbatim, never catalogued (M24 §2.5: content stays English this milestone).
  readonly 'battle.weather.banner': { readonly label: string; readonly turns: number };
  readonly 'battle.card.level': { readonly level: number };
  readonly 'battle.card.hpLine': {
    readonly current: number;
    readonly max: number;
    readonly affinity: string;
  };
  readonly 'battle.skill.pvpSubmit': {
    readonly name: string;
    readonly power: number;
    readonly affinity: string;
    readonly accuracy: number;
  };
  readonly 'battle.skill.pveLabel': {
    readonly name: string;
    readonly power: number;
    readonly affinity: string;
    readonly accuracy: number;
  };
  readonly 'battle.commands.waiting': { readonly name: string };
  readonly 'battle.recruit.confirm': { readonly bait: string };
  readonly 'battle.cure.option': {
    readonly name: string;
    readonly cureStatus: string;
    readonly count: number;
  };
  readonly 'battle.cure.target': { readonly species: string };
  readonly 'battle.swap.pvpSubmit': { readonly species: string };
  readonly 'battle.swap.pveLabel': {
    readonly species: string;
    readonly current: number;
    readonly max: number;
  };
  readonly 'pvp.incoming.label': { readonly challenger: string };
  readonly 'pvp.outgoing.label': { readonly target: string };
  // Again MODEL DATA only — species/nick/item names, server-derived
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
  readonly 'box.feed.item': { readonly name: string; readonly count: number };
  readonly 'box.evolve.confirm': { readonly name: string; readonly species: string };
  readonly 'box.feedback.fed': { readonly name: string };
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
  readonly 'shop.feedback.buy.item': {
    readonly qty: number;
    readonly name: string;
    readonly gold: bigint;
  };
  readonly 'shop.feedback.buy.count': { readonly qty: number };
  readonly 'shop.feedback.sell.item': {
    readonly qty: number;
    readonly name: string;
    readonly gold: bigint;
  };
  readonly 'shop.feedback.sell.count': { readonly qty: number };
  // ctl-8a: the D-pad shop's prompts — the item name, the chosen quantity and the total in gold
  // (unit price × quantity, bigint), all model data.
  readonly 'shop.qty.buy': { readonly name: string; readonly qty: number };
  readonly 'shop.qty.sell': { readonly name: string; readonly qty: number };
  readonly 'shop.confirm.buy': {
    readonly qty: number;
    readonly name: string;
    readonly gold: bigint;
  };
  readonly 'shop.confirm.sell': {
    readonly qty: number;
    readonly name: string;
    readonly gold: bigint;
  };
  // MODEL DATA only, again — ranked numbers, a quest content id and step,
  // the heal model's own cost text, species/nickname names. The leaderboard DISPLAY NAME is
  // deliberately NOT a param (I18N-21): it renders in a sibling `<bdi>`, never through a catalog.
  readonly 'leaderboard.row': {
    readonly rating: number;
    readonly wins: number;
    readonly losses: number;
  };
  readonly 'questLog.entry': { readonly name: string; readonly step: number };
  readonly 'heal.location': { readonly cost: string };
  readonly 'heal.prompt.question': { readonly cost: string };
  readonly 'tradePropose.review.summary': {
    readonly target: string;
    readonly monsters: number;
    readonly offer: string;
    readonly ask: string;
  };
  readonly 'evolutionNotice.species.fallback': { readonly id: number };
  readonly 'evolutionNotice.reveal.nicknamed': {
    readonly nickname: string;
    readonly from: string;
    readonly to: string;
  };
  readonly 'evolutionNotice.reveal.anonymous': { readonly from: string; readonly to: string };
  // 21r-b2 (privacyBanner.ts). `duration` is the ONE param that is not model data: it is the
  // countdown formatter's output, itself composed from the four catalogued unit closures, so both
  // halves of the sentence come from the same locale. `n` is the bigint group count the formatter
  // derived; `received` / `total` are the export assembly's chunk counts.
  readonly 'privacy.countdown.grace': { readonly duration: string };
  readonly 'privacy.countdown.days': { readonly n: bigint };
  readonly 'privacy.countdown.hours': { readonly n: bigint };
  readonly 'privacy.countdown.minutes': { readonly n: bigint };
  readonly 'privacy.countdown.seconds': { readonly n: bigint };
  readonly 'privacy.export.incomplete': { readonly received: number; readonly total: number };
  readonly 'privacy.export.complete': { readonly received: number };
  readonly 'journal.detail.step': { readonly step: number };
  readonly 'social.players.walkUp': { readonly name: string };
}

/** Keys resolved by `tf(key, params)`. */
export type ParamMessageId = keyof MessageParams;

/** Keys resolved by `t(key)` — everything that is not parameterized. */
export type PlainMessageId = Exclude<MessageId, ParamMessageId>;

/**
 * The accessible-name keys `t()` also accepts. EMPTY TODAY: M23's
 * `ui/a11yCopy.ts` exports `a11yCopy: Readonly<Record<string, string>>`, whose `keyof` is
 * `string` — importing it would widen `t` to `(key: string) => string` and silently destroy
 * every totality guarantee in this file (the compile suite's `bad-t-wide` fixture is the oracle
 * for exactly that). `never` keeps `t(key: A11yKey | PlainMessageId)` byte-identical to M23 §2.8
 * while collapsing to `t(key: PlainMessageId)`, so the future flip is a pure widening.
 *
 * FOLLOW-UP: once `a11yCopy.ts` exports a literal-typed
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
 *  entry in `MessageParams` is a modelling error caught here at `tsc` time (TS2344 on the
 *  `ExpectTrue` constraint). A bare conditional alias that resolves to `never` raises nothing,
 *  so the constraint is what makes this bite. Exported because `noUnusedLocals` would
 *  otherwise flag the alias (TS6196). */
type ExpectTrue<T extends true> = T;
export type AssertNoA11yParamKey = ExpectTrue<
  [Extract<ParamMessageId, `a11y.${string}`>] extends [never] ? true : false
>;
