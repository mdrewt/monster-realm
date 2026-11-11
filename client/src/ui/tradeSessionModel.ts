// ui/tradeSessionModel.ts — the trade session editor's pure view model (M-trade-sessions ts-3).
// No DOM, SDK, resolver, clock or module state. Total: never throws on any input.
//
// A session is two sides, each edited only by its owner. The editor shows both, offers pickers over
// the viewer's own party monsters, item stacks and coins, and holds the viewer's unsent changes as a
// draft (`TradeOfferDraft`) until Update offer sends them.
//
// The picker's "unavailable" marks are a DISPLAY PROJECTION of game-core's `check_offered_monster`
// over facts this client can see. They never gate a send: the server decides, and refuses with its
// own reason. The two game-core numbers used here (`partySize`, `maxMonstersPerSide`) are injected
// from the client-wasm exports, never written as literals.
import type {
  StoreInventory,
  StoreItemRow,
  StoreMonsterPub,
  StorePlayer,
  StoreTradeItem,
  StoreTradeSession,
  StoreTradeSessionOffer,
} from '../net/store';
import type { NavItem } from './nav';
import { buildSideViewModel, type TradeCardViewModel, type TradeItemViewModel } from './tradeModel';

/** One side of the session as painted: the server's cards and lines, and that side's mark. */
export interface SessionSideVm {
  readonly cards: readonly TradeCardViewModel[];
  readonly items: readonly TradeItemViewModel[];
  readonly currency: bigint;
  readonly confirmed: boolean;
}

/** Why the picker marks a party monster unavailable, in game-core's `check_offered_monster` order. */
export type MonsterBlock = 'fainted' | 'inAnotherTrade' | 'inBattle';

export interface PickMonsterVm {
  readonly monsterId: bigint;
  /** The nickname, else the species name, then ` Lv.<level>`. */
  readonly label: string;
  readonly blocked: MonsterBlock | null;
}

export interface PickItemVm {
  readonly itemId: number;
  readonly name: string;
  readonly held: number;
}

/** One side as the viewer edits it. CANONICAL: monsterIds ascending, items by itemId, every qty
 *  at least 1. Every function here takes and returns the canonical form. */
export interface TradeOfferDraft {
  readonly monsterIds: readonly bigint[];
  readonly items: readonly StoreTradeItem[];
  readonly currency: bigint;
}

export interface TradeSessionVm {
  readonly kind: 'session';
  readonly sessionId: bigint;
  readonly revision: bigint;
  /** The other player's name, `#<hex8>` when it is empty or the player is unknown. */
  readonly partnerName: string;
  readonly mine: SessionSideVm;
  readonly theirs: SessionSideVm;
  /** The viewer's stored side. */
  readonly offer: TradeOfferDraft;
  /** The viewer's party monsters, by slot. */
  readonly monsters: readonly PickMonsterVm[];
  /** The viewer's item stacks that hold at least one, by itemId. */
  readonly items: readonly PickItemVm[];
  readonly balance: bigint;
  /** game-core's per-side monster cap. */
  readonly maxMonsters: number;
}

/** No session to show: none is bound, it closed, or the viewer is not in it. */
export interface NoTradeSessionVm {
  readonly kind: 'gone';
}

export type TradeSessionScreenVm = TradeSessionVm | NoTradeSessionVm;

export interface TradeSessionInput {
  readonly sessions: readonly StoreTradeSession[];
  readonly identity: string;
  readonly sessionId: bigint | null;
  readonly players: readonly StorePlayer[];
  readonly ownMonsters: readonly StoreMonsterPub[];
  readonly speciesMap: ReadonlyMap<number, { readonly name: string }>;
  readonly itemDefs: ReadonlyMap<number, StoreItemRow>;
  readonly inventory: readonly StoreInventory[];
  readonly balance: bigint;
  /** The viewer's monsters in an active legacy trade offer. */
  readonly legacyOfferMonsterIds: ReadonlySet<bigint>;
  /** The viewer's monsters in an ongoing battle. */
  readonly battleMonsterIds: ReadonlySet<bigint>;
  /** game-core's `PARTY_SIZE` (the `party_size()` export): a slot below it is a party slot. */
  readonly partySize: number;
  /** game-core's `MAX_TRADE_MONSTERS_PER_SIDE` (the `max_trade_monsters_per_side()` export). */
  readonly maxMonstersPerSide: number;
}

const GONE: NoTradeSessionVm = { kind: 'gone' };

const byBigint = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

const isIn = (session: StoreTradeSession, identity: string): boolean =>
  identity !== '' && (session.opener === identity || session.partner === identity);

/** The viewer's own side of `session`, and whether they confirmed it. */
function ownSide(
  session: StoreTradeSession,
  identity: string,
): { readonly offer: StoreTradeSessionOffer; readonly confirmed: boolean } {
  return session.opener === identity
    ? { offer: session.openerOffer, confirmed: session.openerConfirmed }
    : { offer: session.partnerOffer, confirmed: session.partnerConfirmed };
}

/** The sessions `identity` is in (defense in depth over the scoped view), ascending sessionId. */
export function ownSessions(
  sessions: readonly StoreTradeSession[],
  identity: string,
): readonly StoreTradeSession[] {
  return sessions
    .filter((session) => isIn(session, identity))
    .sort((a, b) => byBigint(a.sessionId, b.sessionId));
}

/** The session `identity` OPENED with `partner`, else undefined. */
export function openedSessionWith(
  sessions: readonly StoreTradeSession[],
  identity: string,
  partner: string,
): StoreTradeSession | undefined {
  return ownSessions(sessions, identity).find(
    (session) => session.opener === identity && session.partner === partner,
  );
}

/** The session between `identity` and `other`, either orientation, else undefined. */
export function sessionWith(
  sessions: readonly StoreTradeSession[],
  identity: string,
  other: string,
): StoreTradeSession | undefined {
  return ownSessions(sessions, identity).find((session) => partnerOf(session, identity) === other);
}

/** The other participant's identity hex. */
export function partnerOf(session: StoreTradeSession, identity: string): string {
  return session.opener === identity ? session.partner : session.opener;
}

/** An incoming session the viewer has not acted in: they are the partner, their side is empty and
 *  unconfirmed. */
export function incomingUntouched(session: StoreTradeSession, identity: string): boolean {
  if (identity === '' || session.partner !== identity || session.opener === identity) return false;
  const { monsterIds, items, currency } = session.partnerOffer;
  return (
    !session.partnerConfirmed && monsterIds.length === 0 && items.length === 0 && currency === 0n
  );
}

/** The viewer's monsters on their CONFIRMED sides: what the server locks against battles, care and
 *  the rest (lock-at-confirm). */
export function lockedSessionMonsterIds(
  sessions: readonly StoreTradeSession[],
  identity: string,
): ReadonlySet<bigint> {
  const locked = new Set<bigint>();
  for (const session of ownSessions(sessions, identity)) {
    const side = ownSide(session, identity);
    if (side.confirmed) for (const id of side.offer.monsterIds) locked.add(id);
  }
  return locked;
}

/** The ids in `before` that `sessions` no longer holds for `identity`, ascending. */
export function closedSessionIds(
  before: ReadonlySet<bigint>,
  sessions: readonly StoreTradeSession[],
  identity: string,
): readonly bigint[] {
  const open = new Set(ownSessions(sessions, identity).map((session) => session.sessionId));
  return [...before].filter((id) => !open.has(id)).sort(byBigint);
}

/** A stored side in canonical form. */
function canonical(offer: StoreTradeSessionOffer): TradeOfferDraft {
  return {
    monsterIds: [...offer.monsterIds].sort(byBigint),
    items: offer.items
      .filter((line) => line.qty >= 1)
      .map((line) => ({ itemId: line.itemId, qty: line.qty }))
      .sort((a, b) => a.itemId - b.itemId),
    currency: offer.currency,
  };
}

/** Whether two canonical drafts hold the same monsters, item lines and coins. */
export function sameOffer(a: TradeOfferDraft, b: TradeOfferDraft): boolean {
  return (
    a.currency === b.currency &&
    a.monsterIds.length === b.monsterIds.length &&
    a.monsterIds.every((id, i) => id === b.monsterIds[i]) &&
    a.items.length === b.items.length &&
    a.items.every((line, i) => line.itemId === b.items[i]?.itemId && line.qty === b.items[i]?.qty)
  );
}

function nameOf(players: readonly StorePlayer[], identity: string): string {
  const name = players.find((p) => p.identity === identity)?.name ?? '';
  return name !== '' ? name : `#${identity.slice(0, 8)}`;
}

function monsterLabel(
  m: StoreMonsterPub,
  speciesMap: ReadonlyMap<number, { readonly name: string }>,
): string {
  const base =
    m.nickname !== ''
      ? m.nickname
      : (speciesMap.get(m.speciesId)?.name ?? `Unknown (#${m.speciesId})`);
  return `${base} Lv.${m.level}`;
}

export function buildTradeSessionVm(i: TradeSessionInput): TradeSessionScreenVm {
  const mineIn = ownSessions(i.sessions, i.identity);
  const session = mineIn.find((s) => s.sessionId === i.sessionId);
  if (i.sessionId === null || session === undefined) return GONE;

  const own = ownSide(session, i.identity);
  const viewerIsOpener = session.opener === i.identity;
  const theirOffer = viewerIsOpener ? session.partnerOffer : session.openerOffer;
  const theirConfirmed = viewerIsOpener ? session.partnerConfirmed : session.openerConfirmed;
  const side = (offer: StoreTradeSessionOffer, confirmed: boolean): SessionSideVm => ({
    ...buildSideViewModel(offer.cards, offer.items, offer.currency, i.speciesMap, i.itemDefs),
    confirmed,
  });

  // What the viewer offers in their OTHER sessions; this session never counts.
  const elsewhere = new Set<bigint>();
  for (const other of mineIn) {
    if (other.sessionId === session.sessionId) continue;
    for (const id of ownSide(other, i.identity).offer.monsterIds) elsewhere.add(id);
  }
  const blockOf = (m: StoreMonsterPub): MonsterBlock | null => {
    if (m.currentHp === 0) return 'fainted';
    if (elsewhere.has(m.monsterId) || i.legacyOfferMonsterIds.has(m.monsterId)) {
      return 'inAnotherTrade';
    }
    return i.battleMonsterIds.has(m.monsterId) ? 'inBattle' : null;
  };

  return {
    kind: 'session',
    sessionId: session.sessionId,
    revision: session.revision,
    partnerName: nameOf(i.players, partnerOf(session, i.identity)),
    mine: side(own.offer, own.confirmed),
    theirs: side(theirOffer, theirConfirmed),
    offer: canonical(own.offer),
    monsters: i.ownMonsters
      .filter((m) => m.ownerIdentity === i.identity && m.partySlot < i.partySize)
      .sort((a, b) => a.partySlot - b.partySlot)
      .map((m) => ({
        monsterId: m.monsterId,
        label: monsterLabel(m, i.speciesMap),
        blocked: blockOf(m),
      })),
    items: i.inventory
      .filter((stack) => stack.ownerIdentity === i.identity && stack.count > 0)
      .sort((a, b) => a.itemId - b.itemId)
      .map((stack) => ({
        itemId: stack.itemId,
        name: i.itemDefs.get(stack.itemId)?.name ?? `Unknown (#${stack.itemId})`,
        held: stack.count,
      })),
    balance: i.balance,
    maxMonsters: i.maxMonstersPerSide,
  };
}

/** Everything the editor paints from `vm`, as one string: equal exactly when the paint would be
 *  equal (JSON quotes every name, so no name forges another vm). */
export function tradeSessionKey(vm: TradeSessionScreenVm): string {
  if (vm.kind === 'gone') return 'gone';
  const sideKey = (s: SessionSideVm) => [
    s.confirmed,
    s.currency.toString(),
    s.cards.map((c) => [
      c.monsterId.toString(),
      c.speciesName,
      c.nickname,
      c.level,
      c.currentHp,
      c.statHp,
    ]),
    s.items.map((line) => [line.itemId, line.name, line.qty]),
  ];
  return JSON.stringify([
    vm.sessionId.toString(),
    vm.revision.toString(),
    vm.partnerName,
    sideKey(vm.mine),
    sideKey(vm.theirs),
    vm.monsters.map((m) => [m.monsterId.toString(), m.label, m.blocked]),
    vm.items.map((item) => [item.itemId, item.name, item.held]),
    vm.balance.toString(),
    vm.maxMonsters,
  ]);
}

/** Toggle one monster in the draft. ADDING is refused (the same draft back) for a blocked monster,
 *  one that is not in the picker, or a draft already at the cap; an offered one always comes out. */
export function toggleMonster(
  vm: TradeSessionVm,
  draft: TradeOfferDraft,
  monsterId: bigint,
): TradeOfferDraft {
  if (draft.monsterIds.includes(monsterId)) {
    return { ...draft, monsterIds: draft.monsterIds.filter((id) => id !== monsterId) };
  }
  const pick = vm.monsters.find((m) => m.monsterId === monsterId);
  if (pick === undefined || pick.blocked !== null) return draft;
  if (draft.monsterIds.length >= vm.maxMonsters) return draft;
  return { ...draft, monsterIds: [...draft.monsterIds, monsterId].sort(byBigint) };
}

/** Change an item's offered quantity by `delta`, clamped to 0..held; 0 drops the line. */
export function stepItem(
  vm: TradeSessionVm,
  draft: TradeOfferDraft,
  itemId: number,
  delta: number,
): TradeOfferDraft {
  const held = vm.items.find((item) => item.itemId === itemId)?.held ?? 0;
  const had = draft.items.find((line) => line.itemId === itemId)?.qty ?? 0;
  const qty = Math.max(0, Math.min(held, had + Math.trunc(delta)));
  if (qty === had) return draft;
  const others = draft.items.filter((line) => line.itemId !== itemId);
  const items = qty === 0 ? others : [...others, { itemId, qty }];
  return { ...draft, items: items.sort((a, b) => a.itemId - b.itemId) };
}

/** Change the offered coins by `delta`, clamped to 0..balance. */
export function stepCurrency(
  vm: TradeSessionVm,
  draft: TradeOfferDraft,
  delta: bigint,
): TradeOfferDraft {
  const wanted = draft.currency + delta;
  const currency = wanted < 0n ? 0n : wanted > vm.balance ? vm.balance : wanted;
  return currency === draft.currency ? draft : { ...draft, currency };
}

/** The editor's rows in order. WHILE the viewer's side is confirmed there is exactly Cancel: a
 *  confirmed side cannot edit. A disabled row carries its `reason`: a `MonsterBlock`, `limit`
 *  (the draft is at the cap), `nothingToSend` or `unsent`. */
export function editorRows(vm: TradeSessionVm, draft: TradeOfferDraft): readonly NavItem[] {
  const cancel: NavItem = { key: 'cancel', enabled: true };
  if (vm.mine.confirmed) return [cancel];
  const atCap = draft.monsterIds.length >= vm.maxMonsters;
  const clean = sameOffer(draft, vm.offer);
  const off = (key: string, reason: string): NavItem => ({ key, enabled: false, reason });
  return [
    ...vm.monsters.map((m): NavItem => {
      const key = `monster-${m.monsterId}`;
      // An offered monster can always be taken out, whatever has happened to it since.
      if (draft.monsterIds.includes(m.monsterId)) return { key, enabled: true };
      if (m.blocked !== null) return off(key, m.blocked);
      return atCap ? off(key, 'limit') : { key, enabled: true };
    }),
    ...vm.items.map((item): NavItem => ({ key: `item-${item.itemId}`, enabled: true })),
    { key: 'coins', enabled: true },
    clean ? off('apply', 'nothingToSend') : { key: 'apply', enabled: true },
    // The editor confirms only what the server holds.
    clean ? { key: 'confirm', enabled: true } : off('confirm', 'unsent'),
    cancel,
  ];
}
