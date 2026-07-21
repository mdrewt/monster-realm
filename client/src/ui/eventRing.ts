// ui/eventRing.ts — bounded, PII-free session event buffer for the F9 bug bundle (pt-b1).
//
// Source-of-truth: M-playtest-b F9 bug-bundle event ring (EARS U-1 bounded FIFO, U-3 no-PII).
//
// The ring is a FIFO buffer of playtest events. `tSeq` is a monotonic counter (starts at 1,
// increments per push, NEVER reset — not by eviction, not by clear()) so the timeline is
// unambiguous across evictions. `tMs` is stamped from an INJECTED clock (never Date.now()
// directly) so tests are deterministic and the netcode-determinism precedent holds.
//
// U-3 (no-PII): payloads carry only ids/hex/counts — never a player name. The `connect`
// variant carries the identity-hex (allowed); `disconnect` is bare (identity-free).

export const EVENT_RING_CAP = 256;

export type IdentityHex = string;

/** Discriminated union of the 14 playtest-event payloads (kind + minimal fields, no PII). */
export type PlaytestEventPayload =
  | { readonly kind: 'connect'; readonly identity: IdentityHex }
  | { readonly kind: 'disconnect' }
  | { readonly kind: 'zoneChange'; readonly fromZone: number; readonly toZone: number }
  | { readonly kind: 'battleStart'; readonly battleId: string; readonly isPvp: boolean }
  | {
      readonly kind: 'battleEnd';
      readonly battleId: string;
      readonly outcome: string;
      readonly turnCount: number;
    }
  | { readonly kind: 'preRecruitHp'; readonly battleId: string; readonly hpPermille: number }
  | { readonly kind: 'recruitAttempt'; readonly battleId: string; readonly baitItemId: number }
  | { readonly kind: 'recruitResult'; readonly battleId: string; readonly success: boolean }
  | { readonly kind: 'boxOpen' }
  | { readonly kind: 'monsterRelease'; readonly speciesId: number }
  | { readonly kind: 'reCatch'; readonly speciesId: number }
  | { readonly kind: 'tradePropose'; readonly tradeId: string }
  | { readonly kind: 'tradeConfirm'; readonly tradeId: string }
  | { readonly kind: 'rankedMatch'; readonly battleId: string; readonly ratingDelta: number };

/** A stamped event: the payload plus the ring-added envelope (tSeq monotonic, tMs from clock). */
export type PlaytestEvent = PlaytestEventPayload & {
  readonly tSeq: number;
  readonly tMs: number;
};

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// --- 6 core constructors (emitted by main.ts at pt-b1) ---------------------

export function makeConnect(identity: IdentityHex): PlaytestEventPayload {
  return { kind: 'connect', identity };
}

export function makeDisconnect(): PlaytestEventPayload {
  return { kind: 'disconnect' };
}

export function makeZoneChange(fromZone: number, toZone: number): PlaytestEventPayload {
  return { kind: 'zoneChange', fromZone, toZone };
}

export function makeBattleStart(battleId: string, isPvp: boolean): PlaytestEventPayload {
  return { kind: 'battleStart', battleId, isPvp };
}

export function makeBattleEnd(
  battleId: string,
  outcome: string,
  turnCount: number,
): PlaytestEventPayload {
  return { kind: 'battleEnd', battleId, outcome, turnCount };
}

export function makeRankedMatch(battleId: string, ratingDelta: number): PlaytestEventPayload {
  return { kind: 'rankedMatch', battleId, ratingDelta };
}

// --- 8 parked constructors (exported + tested; emitted later by pt-b1b) -----

/** permille = clamp(round(cur/max*1000), 0, 1000); max<=0 => 0 (div-safe, never NaN/Infinity). */
export function makePreRecruitHp(
  battleId: string,
  currentHp: number,
  maxHp: number,
): PlaytestEventPayload {
  const hpPermille = maxHp <= 0 ? 0 : clamp(Math.round((currentHp / maxHp) * 1000), 0, 1000);
  return { kind: 'preRecruitHp', battleId, hpPermille };
}

export function makeRecruitAttempt(battleId: string, baitItemId: number): PlaytestEventPayload {
  return { kind: 'recruitAttempt', battleId, baitItemId };
}

export function makeRecruitResult(battleId: string, success: boolean): PlaytestEventPayload {
  return { kind: 'recruitResult', battleId, success };
}

export function makeBoxOpen(): PlaytestEventPayload {
  return { kind: 'boxOpen' };
}

export function makeMonsterRelease(speciesId: number): PlaytestEventPayload {
  return { kind: 'monsterRelease', speciesId };
}

export function makeReCatch(speciesId: number): PlaytestEventPayload {
  return { kind: 'reCatch', speciesId };
}

export function makeTradePropose(tradeId: string): PlaytestEventPayload {
  return { kind: 'tradePropose', tradeId };
}

export function makeTradeConfirm(tradeId: string): PlaytestEventPayload {
  return { kind: 'tradeConfirm', tradeId };
}

// The PvP-vs-wild classifier is defined ONCE, canonically, in battleModel.ts
// (ptc5e-3 SSOT — it is a battle-model concept). Re-exported here so this module's
// consumers (main.ts, the F9 bundle) keep a single import site. The canonical fn
// is structurally typed, so this re-export adds no net/store type coupling.
export { isPvpBattle } from './battleModel';

/**
 * Bounded FIFO event buffer. Oldest-evicted at cap; `tSeq` monotonic from 1 and never reused
 * (survives eviction and clear); `tMs` from the injected clock. `snapshot()` returns a fresh
 * defensive copy oldest→newest so callers cannot mutate the buffer.
 */
export class EventRing {
  readonly #now: () => number;
  readonly #cap: number;
  #buf: PlaytestEvent[] = [];
  #seq = 0;

  constructor(now: () => number, cap = EVENT_RING_CAP) {
    this.#now = now;
    this.#cap = cap;
  }

  push(payload: PlaytestEventPayload): void {
    this.#seq += 1;
    const event = { ...payload, tSeq: this.#seq, tMs: this.#now() } as PlaytestEvent;
    this.#buf.push(event);
    if (this.#buf.length > this.#cap) {
      this.#buf.shift();
    }
  }

  snapshot(): readonly PlaytestEvent[] {
    return this.#buf.slice();
  }

  clear(): void {
    this.#buf = [];
  }
}
