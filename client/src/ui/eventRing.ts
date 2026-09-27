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

/** Discriminated union of the 6 playtest-event payloads (kind + minimal fields, no PII). */
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
  | { readonly kind: 'rankedMatch'; readonly battleId: string; readonly ratingDelta: number };

/** A stamped event: the payload plus the ring-added envelope (tSeq monotonic, tMs from clock). */
export type PlaytestEvent = PlaytestEventPayload & {
  readonly tSeq: number;
  readonly tMs: number;
};

// --- constructors (emitted by main.ts) --------------------------------------

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
