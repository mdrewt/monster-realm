// ui/tradeProposeModel.ts — pure view model for the trade-PROPOSE overlay (pt-c2, ADR-0134).
//
// No DOM, no SDK, no side-effects. TOTAL — never throws on any input. It is called
// from the KeyO handler AND from live DOM input/change listeners; a throw here would
// starve sibling store batch-listeners (store.ts one-way flow).
//
// D3 (ADR-0134): this is a PROJECTION + non-degeneracy gate, NOT a validation SSOT. It
// does NOT re-implement server validation (join / self-trade / balance / ownership /
// active-trade). The server is the reject-not-clamp SSOT. `canSubmit` mirrors only the
// server's `total_assets >= 1` non-degeneracy gate (validate_proposal, rules.rs:52-61),
// so it never permits an EmptyOffer server-reject — it is a UX gate, not a balance SSOT.
//
// D5: currency parse is a digit-only ASCII scan → BigInt (never Number()/parseInt). The
// model keeps monsterId as bigint end-to-end; main.ts constructs the SDK Identity at the
// boundary (the model never imports the SDK) — targetIdentity stays a plain string here.

import type { StoreMonsterPub, StorePlayer } from '../net/store';

/** A selectable trade counterparty — identity is the <option> value, label the display text. */
export interface TradeProposeTarget {
  readonly identity: string;
  readonly label: string;
}

/** An offerable own-monster — monsterId stays bigint; label is nickname/species + level. */
export interface TradeProposeMonster {
  readonly monsterId: bigint;
  readonly label: string;
}

/** The projected lists that render() paints into the overlay. */
export interface TradeProposeLists {
  readonly targets: readonly TradeProposeTarget[];
  readonly offerableMonsters: readonly TradeProposeMonster[];
}

/** The live draft read from the DOM (raw currency strings, checked monster ids). */
export interface TradeProposeDraft {
  readonly targetIdentity: string;
  readonly selectedMonsterIds: readonly bigint[];
  readonly offerCurrency: string;
  readonly requestCurrency: string;
}

/** The typed cross-boundary args main.ts hands to reducers.proposeTrade (D4). Identity
 *  stays a plain string; main.ts wraps it in `new Identity(...)` at the SDK boundary. */
export interface TradeProposeArgs {
  readonly targetIdentity: string;
  readonly initiatorMonsterIds: readonly bigint[];
  readonly initiatorCurrency: bigint;
  readonly counterpartyCurrency: bigint;
}

/** The submission verdict: can we submit, the parsed currencies, and the typed args
 *  (null when !canSubmit — the single source of the submit-enable + #submit() gate). */
export interface TradeProposeSubmission {
  readonly canSubmit: boolean;
  readonly offerCurrency: bigint;
  readonly requestCurrency: bigint;
  readonly args: TradeProposeArgs | null;
}

/** A minimal species-name projection — accepts StoreSpeciesRow or the test `{ name }`. */
type SpeciesNameRow = { readonly name: string };

/**
 * Build the render lists from the store projections.
 * - `targets` = allPlayers MINUS self (`identity !== ownIdentity`) MINUS empty-identity rows;
 *   label = `name` or `'(unnamed)'`; sorted lexicographically by identity (deterministic).
 *   When `ownIdentity === ''` the target list is EMPTY (D3 / D7 L-1 analog) — the model is
 *   safe even if called before the KeyO identity guard runs.
 * - `offerableMonsters` = ownMonsters; label = nickname (else species name via speciesMap,
 *   else `Unknown (#id)`) + level; monsterId kept as bigint; sorted ascending by monsterId.
 * TOTAL — never throws.
 */
export function buildProposeLists(
  allPlayers: readonly StorePlayer[],
  ownMonsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, SpeciesNameRow>,
  ownIdentity: string,
): TradeProposeLists {
  // D3 / D7 L-1: an empty own-identity means the caller is not joined — no valid targets.
  const targets: TradeProposeTarget[] =
    ownIdentity === ''
      ? []
      : allPlayers
          .filter((p) => p.identity !== '' && p.identity !== ownIdentity)
          .map((p) => ({ identity: p.identity, label: p.name !== '' ? p.name : '(unnamed)' }))
          .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

  const offerableMonsters: TradeProposeMonster[] = ownMonsters
    .map((m) => ({ monsterId: m.monsterId, label: monsterLabel(m, speciesMap) }))
    // BigInt comparator — Number(monsterId) would truncate ids past MAX_SAFE_INTEGER.
    .sort((a, b) => (a.monsterId < b.monsterId ? -1 : a.monsterId > b.monsterId ? 1 : 0));

  return { targets, offerableMonsters };
}

/** nickname → species name → `Unknown (#id)`, always suffixed with the level. */
function monsterLabel(m: StoreMonsterPub, speciesMap: ReadonlyMap<number, SpeciesNameRow>): string {
  const base =
    m.nickname !== ''
      ? m.nickname
      : (speciesMap.get(m.speciesId)?.name ?? `Unknown (#${m.monsterId})`);
  return `${base} Lv.${m.level}`;
}

/**
 * Parse a raw currency `<input type=number>.value` into a bigint.
 * Digit-only ASCII scan → `BigInt(s)`; everything else (`''`, `'-1'`, `'0.5'`, `'1.9'`,
 * `'abc'`, `'1,000'`, `'1e30'`, `' 5 '`, `'0x5'`) → `0n`. NEVER `Number()`/`parseInt`
 * (both silently truncate). TOTAL — never throws.
 */
export function parseCurrency(raw: string): bigint {
  // Literal regex (no `new RegExp()` — ReDoS ban): non-empty all-ASCII-digits only.
  if (!/^[0-9]+$/.test(raw)) return 0n;
  return BigInt(raw);
}

/**
 * Build the submission verdict from the rendered targets + the live draft.
 * - `canSubmit` = target non-empty AND present in `targets` AND at least one of
 *   {≥1 selectedMonsterId, offerCurrency > 0n, requestCurrency > 0n}. Mirrors the server
 *   `total_assets >= 1` non-degeneracy gate (D3) — a "request gold, give nothing" offer is
 *   server-valid and allowed; an empty offer is blocked.
 * - `args` = the typed shape when canSubmit, else `null`.
 * TOTAL — never throws.
 */
export function buildProposeSubmission(
  targets: readonly TradeProposeTarget[],
  draft: TradeProposeDraft,
): TradeProposeSubmission {
  const offerCurrency = parseCurrency(draft.offerCurrency);
  const requestCurrency = parseCurrency(draft.requestCurrency);

  const targetValid =
    draft.targetIdentity !== '' && targets.some((t) => t.identity === draft.targetIdentity);
  const hasAsset =
    draft.selectedMonsterIds.length > 0 || offerCurrency > 0n || requestCurrency > 0n;
  const canSubmit = targetValid && hasAsset;

  const args: TradeProposeArgs | null = canSubmit
    ? {
        targetIdentity: draft.targetIdentity,
        initiatorMonsterIds: [...draft.selectedMonsterIds],
        initiatorCurrency: offerCurrency,
        counterpartyCurrency: requestCurrency,
      }
    : null;

  return { canSubmit, offerCurrency, requestCurrency, args };
}
