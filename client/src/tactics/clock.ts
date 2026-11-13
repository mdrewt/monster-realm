// tactics/clock.ts — the PvP clock ring and the strike pips (bt-15 increment B, BT15.2): a radial ring
// on the WAITING unit's turn-bar chip that refills on every accepted submit (the server re-opens the
// window: a new `window_open_ms` and deadline — no client rule), turns amber at 10 s and red at 5 s
// (display thresholds, design §9.1), and one strike-pip row per player by name. Both players see
// both: the clock rows are public match state (design §6.2).
//
// `clockVM` is pure (the wall clock arrives as `nowMs`: the deadlines are server epoch instants, so
// `performance.now()` is not comparable); `renderClock` paints a view-model with createElement,
// textContent and attributes only. Every word comes from tactics/strings.ts. The shell memoises the
// VM and re-applies the ring after every turn-bar render (the chips are rebuilt), so the ring is
// shell state the frame pump writes — never part of the frame VM (a latch in a compute-then-write VM
// would never repaint).
//
// The pip count is an input: `strikesMax` is the loaded tuning's `autopass_forfeit`, which the caller
// reads through the rules port. Each player's entry carries it to the painter. The pips are
// presentation only; the forfeit itself is the server's.
import type { StoreBattleClock } from '../net/store';
import { structurallyEqual } from '../ui/battlePolicy';
import * as s from './strings';
import type { RuleSide } from './wasm';

export const CLOCK_AMBER_MS = 10_000;
export const CLOCK_RED_MS = 5_000;

export type ClockBand = 'ok' | 'amber' | 'red';
export interface ClockRingVM {
  readonly unitId: number;
  readonly side: RuleSide;
  /** Whole seconds left, never negative. */
  readonly secondsLeft: number;
  /** The window's remaining share, 0..1, rounded to 2 decimals (so an unchanged frame writes nothing). */
  readonly fraction: number;
  readonly band: ClockBand;
}
export interface StrikesVM {
  readonly side: RuleSide;
  readonly mine: boolean;
  readonly name: string;
  /** Auto-passes so far, never above `strikesMax`. */
  readonly strikes: number;
  /** The auto-pass count that forfeits the match: how many pips the row draws. */
  readonly strikesMax: number;
}
export interface ClockVM {
  readonly ring: ClockRingVM | null;
  readonly players: readonly StrikesVM[];
}
export type ClockRow = Pick<
  StoreBattleClock,
  'side' | 'player' | 'windowOpenMs' | 'deadlineMs' | 'autopassCount'
>;
export interface ClockInput {
  readonly kind: 'wild' | 'pvp';
  readonly clocks: readonly ClockRow[];
  readonly activeUnitId: number | null;
  readonly units: readonly { readonly unitId: number; readonly side: RuleSide }[];
  readonly mySide: RuleSide;
  readonly playerName: (identity: string) => string;
  readonly nowMs: number;
  /** The loaded tuning's `autopass_forfeit`. */
  readonly strikesMax: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const sideOrder = (side: RuleSide): number => (side === 'A' ? 0 : 1);

function bandOf(remainingMs: number): ClockBand {
  if (remainingMs <= CLOCK_RED_MS) return 'red';
  if (remainingMs <= CLOCK_AMBER_MS) return 'amber';
  return 'ok';
}

/** The ring of the active unit's side's OPEN window (both fields non-null), else null. */
function ringOf(input: ClockInput): ClockRingVM | null {
  if (input.activeUnitId === null) return null;
  const unit = input.units.find((u) => u.unitId === input.activeUnitId);
  if (unit === undefined) return null;
  const row = input.clocks.find(
    (c) => c.side === unit.side && c.windowOpenMs !== null && c.deadlineMs !== null,
  );
  if (row === undefined || row.windowOpenMs === null || row.deadlineMs === null) return null;
  // Epoch instants are exact in a double (the stillThereSeconds precedent); no 32-bit op touches them.
  const deadline = Number(row.deadlineMs);
  const remaining = deadline - input.nowMs;
  const length = deadline - Number(row.windowOpenMs);
  const raw = length > 0 ? clamp(remaining / length, 0, 1) : 0;
  return {
    unitId: unit.unitId,
    side: unit.side,
    secondsLeft: Math.max(0, Math.ceil(remaining / 1000)),
    fraction: Math.round(raw * 100) / 100,
    band: bandOf(remaining),
  };
}

/** null for a wild battle (PvE shows only the "Still there?" countdown). */
export function clockVM(input: ClockInput): ClockVM | null {
  if (input.kind === 'wild') return null;
  const players = [...input.clocks]
    .sort((a, b) => sideOrder(a.side) - sideOrder(b.side))
    .map(
      (c): StrikesVM => ({
        side: c.side,
        mine: c.side === input.mySide,
        name: input.playerName(c.player),
        strikes: clamp(c.autopassCount, 0, input.strikesMax),
        strikesMax: input.strikesMax,
      }),
    );
  return { ring: ringOf(input), players };
}

// --- the DOM ------------------------------------------------------------------------------------

const RING = 'tactics-clock-ring';

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function paintRing(turnbar: HTMLElement, ring: ClockRingVM | null): void {
  const chip =
    ring === null
      ? null
      : turnbar.querySelector<HTMLElement>(
          `.tactics-chip:not(.tactics-chip--ghost)[data-unit-id="${ring.unitId}"]`,
        );
  // Every ring that is not THE ring goes (another chip, a ghost, a null ring); the kept one is reused.
  let kept: HTMLElement | null = null;
  for (const node of turnbar.querySelectorAll<HTMLElement>(`.${RING}`)) {
    if (chip !== null && kept === null && node.parentElement === chip) kept = node;
    else node.remove();
  }
  if (ring === null || chip === null) return;
  const node = kept ?? el('span', RING);
  node.setAttribute('role', 'img');
  node.setAttribute('data-band', ring.band);
  node.setAttribute('data-fraction', String(Math.round(ring.fraction * 100)));
  node.style.setProperty('--clock-fraction', String(ring.fraction));
  node.setAttribute('aria-label', s.clockRing(ring.secondsLeft));
  if (kept === null) chip.appendChild(node);
}

function paintPlayer(p: StrikesVM): HTMLElement {
  const row = el('span', 'tactics-player');
  row.setAttribute('data-side', p.side);
  row.setAttribute('data-mine', p.mine ? 'true' : 'false');
  const name = el('span', 'tactics-player-name');
  name.textContent = p.name;
  const pips = el('span', 'tactics-strikes');
  pips.setAttribute('role', 'img');
  pips.setAttribute('aria-label', s.clockStrikes(p.name, p.strikes, p.strikesMax));
  for (let i = 0; i < p.strikesMax; i++) {
    const pip = el('span', 'tactics-strike');
    if (i < p.strikes) pip.classList.add('tactics-strike--hit');
    pips.appendChild(pip);
  }
  row.append(name, pips);
  return row;
}

/** The last players list painted into a strip element: an equal list writes nothing (its nodes stay). */
const PLAYERS = new WeakMap<HTMLElement, readonly StrikesVM[]>();

function paintPlayers(strip: HTMLElement, players: readonly StrikesVM[]): void {
  const last = PLAYERS.get(strip);
  if (last !== undefined && structurallyEqual(last, players)) return;
  PLAYERS.set(strip, players);
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', s.playersLabel());
  strip.replaceChildren(...players.map(paintPlayer));
  strip.hidden = players.length === 0;
}

/** Paints `vm`: the ring onto its chip inside `turnbar` (every other ring removed), the strike rows
 *  into `players` (emptied and hidden for a null VM). Idempotent. */
export function renderClock(turnbar: HTMLElement, players: HTMLElement, vm: ClockVM | null): void {
  paintRing(turnbar, vm === null ? null : vm.ring);
  paintPlayers(players, vm === null ? [] : vm.players);
}
