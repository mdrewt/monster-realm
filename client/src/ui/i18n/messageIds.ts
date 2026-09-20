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
 *  added `battle.*` and `pvp.*` as it migrated battleView.ts/pvpView.ts; S4–S6 add `menu.*`, …
 *  as they migrate the remaining call sites. Adding a literal here is what forces EVERY
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
  | 'pvp.players.heading';

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
