// tactics/tacticsBattle.ts — the tactical battle SHELL (BT10.1, BT10.3-BT10.6): composes the turn
// bar, the board, the per-side info boxes, the ticker, the turn banner and the dock into one
// constructed overlay root, and implements `BattleOpsView` (the D-pad / A / B contract).
//
// Overlay a11y wiring: this view is a CONSTRUCTED shell, exactly like ui/battleView.ts, and follows
// that file's header. Its root is `document.createElement`'d here and appended into the parent it
// is handed; every ARIA attribute on the root comes from `openOverlayA11y`, never from a literal in
// this file. `wasVisible` is read as the FIRST statement of `show()` (a re-open would otherwise
// re-schedule the deferred focus and drag it off whatever the player Tabbed to); `hide()` calls
// `closeOverlayA11y` every time, deliberately unguarded (it is a documented no-op with no record);
// and the open is the LAST statement of the open path, after the display write. It reuses the
// `battleView` overlay id, so bt-12 must guarantee the legacy BattleView is hidden before
// TacticsBattle.show() and that the frame's dismiss handle targets the active view.
//
// Imperative shell over pure modules: the cursor memory, the selection, the danger toggle and the
// Playback queue live here; everything drawn is rebuilt from the last view-model on every paint.
// It owns no game rule (the overlay tile sets and the next round's order are inputs), reads time
// only through `deps.now`, and reads reduced motion through `deps.reduceMotion()` on every
// render/ingest (never cached).
import type { EventPayload } from '../module_bindings/types';
import { closeOverlayA11y, openOverlayA11y } from '../ui/overlayA11y';
import type { BattleOp, BattleOpsView } from '../ui/screens/battleScreen';
import {
  buildBoard,
  type CursorMemory,
  cursorFor,
  type Dir,
  moveCursor,
  type OverlaySets,
  type TacticalUnit,
  type Tile,
  unitAt,
} from './boardModel';
import { renderBoard } from './boardRender';
import { infoBoxes, renderInfoBoxes } from './hud';
import { Playback, planBeats, showsTurnBanner } from './presentation';
import * as s from './strings';
import { Ticker, type TickerNames, tickerLine } from './ticker';
import { renderTurnBar, turnBarVM } from './turnBar';

export interface TacticsBattleVM {
  readonly battleId: bigint;
  readonly kind: 'wild' | 'pvp';
  readonly width: number;
  readonly height: number;
  readonly units: readonly TacticalUnit[];
  readonly activeUnitId: number | null;
  readonly round: number;
  readonly initiative: readonly number[];
  readonly turnIdx: number;
  readonly nextInitiative: readonly number[];
  readonly readyUnitIds: ReadonlySet<number>;
  readonly surgeStartRound: number;
  readonly wildRoundCap: number;
  readonly overlays: OverlaySets;
  readonly draftedAp: number;
  readonly targetUnitId: number | null;
}
export interface TacticsBattleDeps {
  readonly now: () => number;
  readonly reduceMotion: () => boolean;
  readonly names: TickerNames;
}

function div(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

const isOwnActive = (u: TacticalUnit): boolean => u.mine && u.state === 'Active';

export class TacticsBattle implements BattleOpsView {
  readonly #deps: TacticsBattleDeps;
  readonly #root: HTMLElement;
  readonly #titleEl: HTMLElement;
  readonly #turnbarEl: HTMLElement;
  readonly #boardEl: HTMLElement;
  readonly #hudEl: HTMLElement;
  readonly #bannerEl: HTMLElement;
  readonly #dockEl: HTMLElement;
  readonly #ticker: Ticker;
  readonly #playback: Playback;

  #visible = false;
  #battleId: bigint | null = null;
  #vm: TacticsBattleVM | null = null;
  #memory: CursorMemory = new Map();
  #selected: number | null = null;
  #cursor: Tile | null = null;
  #dangerOn = false;

  constructor(parent: HTMLElement, deps: TacticsBattleDeps) {
    this.#deps = deps;
    this.#playback = new Playback(deps.now);

    this.#root = div('mr-frame mr-shell mr-shell--top mr-shell--battle tactics-battle');
    this.#root.style.display = 'none';

    // The OVERLAY_A11Y initialFocusSelector anchor; tabindex -1 makes it programmatically
    // focusable without adding a permanent tab stop. Its text is resolved in show().
    this.#titleEl = document.createElement('h2');
    this.#titleEl.className = 'tactics-title';
    this.#titleEl.setAttribute('data-testid', 'battle-title');
    this.#titleEl.setAttribute('tabindex', '-1');

    this.#turnbarEl = div('tactics-turnbar');
    this.#turnbarEl.setAttribute('role', 'group');

    const field = div('tactics-field');
    this.#boardEl = div('tactics-board');
    this.#hudEl = div('tactics-hud');
    this.#bannerEl = div('tactics-banner');
    this.#bannerEl.hidden = true;
    field.append(this.#boardEl, this.#hudEl, this.#bannerEl);

    this.#root.append(this.#titleEl, this.#turnbarEl, field);
    this.#ticker = new Ticker(this.#root);
    this.#dockEl = div('tactics-dock');
    this.#dockEl.setAttribute('role', 'group');
    this.#root.appendChild(this.#dockEl);
    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(): void {
    const wasVisible = this.#visible;
    this.#visible = true;
    // Resolved on every show(), not in the constructor: the locale may be switched after boot.
    this.#titleEl.textContent = s.battleTitle();
    this.#paint();
    this.#root.style.display = 'flex';
    if (!wasVisible) openOverlayA11y('battleView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    this.#playback.skip();
    this.#syncPlaying();
    closeOverlayA11y('battleView', null);
  }

  render(vm: TacticsBattleVM): void {
    if (this.#battleId !== vm.battleId) this.#startBattle(vm.battleId);
    this.#vm = vm;
    this.#paint();
  }

  /** Every event is a ticker line NOW (whatever the motion mode); its beats queue for playback. */
  ingest(events: readonly EventPayload[]): void {
    if (events.length === 0) return;
    // Atomic: every line and every beat is computed BEFORE anything is committed, so an event the
    // client cannot render throws with the ticker and the playback untouched.
    const lines = events.map((ev) => tickerLine(ev, this.#deps.names));
    const beats = planBeats(events, { reduceMotion: this.#deps.reduceMotion() });
    for (const line of lines) this.#ticker.push(line);
    // A hidden view plays nothing (the log above is still complete for when it returns).
    if (this.#visible) this.#playback.enqueue(beats);
    this.#syncPlaying();
  }

  /** Advances the playback queue (the caller's frame loop). */
  tick(): void {
    this.#playback.tick();
    this.#syncPlaying();
  }

  get dangerOn(): boolean {
    return this.#dangerOn;
  }

  get cursor(): Tile | null {
    return this.#cursor === null ? null : { x: this.#cursor.x, y: this.#cursor.y };
  }

  /** The selected own unit, or null when there is none (or it has left the board). */
  get selectedUnitId(): number | null {
    const id = this.#selected;
    if (id === null || this.#vm === null) return id;
    return this.#vm.units.some((u) => u.unitId === id && isOwnActive(u)) ? id : null;
  }

  toggleDanger(): void {
    this.#dangerOn = !this.#dangerOn;
    this.#paint();
  }

  /** Select the next (+1) / previous (-1) own Active unit in input order, wrapping. */
  cycleUnit(dir: -1 | 1): void {
    const vm = this.#vm;
    if (vm === null) return;
    const own = vm.units.filter(isOwnActive);
    if (own.length === 0) return;
    const at = own.findIndex((u) => u.unitId === this.#selected);
    const next =
      at === -1
        ? (own[dir > 0 ? 0 : own.length - 1] as TacticalUnit)
        : (own[(at + dir + own.length) % own.length] as TacticalUnit);
    this.#selected = next.unitId;
    this.#cursor = cursorFor(this.#memory, next, vm.width, vm.height);
    this.#paint();
  }

  applyBattleOp(op: BattleOp): void {
    switch (op.kind) {
      case 'move':
        this.#moveCursor(op.dir);
        return;
      case 'back':
        // B is the SKIP key in bt-10: it drains the playback when one runs, else does nothing.
        if (this.#playback.playing()) {
          this.#playback.skip();
          this.#syncPlaying();
        }
        return;
      case 'activate':
        // The command menu is bt-11's.
        return;
      default:
        op satisfies never;
    }
  }

  #moveCursor(dir: Dir): void {
    const vm = this.#vm;
    if (vm === null) return;
    const from = this.#cursor ?? { x: 0, y: 0 };
    const key = this.#selected ?? -1;
    const moved = moveCursor(this.#memory, key, from, dir, vm.width, vm.height);
    const to = moved.get(key) ?? from;
    this.#cursor = to;
    if (this.#selected !== null) this.#memory = moved;
    this.#paint();
  }

  /** Pointer mirror of the D-pad: the cursor goes to the clicked tile. */
  #pointTo(tile: Tile): void {
    this.#cursor = tile;
    if (this.#selected !== null) {
      const next = new Map(this.#memory);
      next.set(this.#selected, tile);
      this.#memory = next;
    }
    this.#paint();
  }

  /** A different battle starts from scratch: nothing of the last one may leak into it. */
  #startBattle(battleId: bigint): void {
    this.#battleId = battleId;
    this.#memory = new Map();
    this.#selected = null;
    this.#cursor = null;
    this.#dangerOn = false;
    this.#ticker.clear();
    this.#playback.skip();
    this.#syncPlaying();
  }

  #syncPlaying(): void {
    this.#root.classList.toggle('tactics-battle--playing', this.#playback.playing());
  }

  #paint(): void {
    const vm = this.#vm;
    if (vm === null) return;
    this.#root.classList.toggle('tactics--reduced', this.#deps.reduceMotion());

    // Nothing selected yet, or the selected unit is no longer an own Active one (KO'd, recruited,
    // gone): select the first own Active unit, with its remembered (else current) tile.
    if (this.selectedUnitId === null) {
      const first = vm.units.find(isOwnActive);
      this.#selected = first?.unitId ?? null;
      if (first !== undefined) this.#cursor = cursorFor(this.#memory, first, vm.width, vm.height);
    }

    renderBoard(
      this.#boardEl,
      buildBoard({
        width: vm.width,
        height: vm.height,
        units: vm.units,
        activeUnitId: vm.activeUnitId,
        cursor: this.#cursor,
        overlays: vm.overlays,
        dangerOn: this.#dangerOn,
      }),
      (tile) => this.#pointTo(tile),
    );

    // Hovered = the Active target if there is one, else the unit under the cursor.
    const target =
      vm.targetUnitId === null
        ? null
        : vm.units.find((u) => u.unitId === vm.targetUnitId && u.state === 'Active');
    const under = this.#cursor === null ? null : unitAt(vm.units, this.#cursor);
    renderInfoBoxes(
      this.#hudEl,
      infoBoxes(vm.units, {
        activeUnitId: vm.activeUnitId,
        focusUnitId: (target ?? under)?.unitId ?? null,
        draftedAp: vm.draftedAp,
      }),
    );

    renderTurnBar(
      this.#turnbarEl,
      turnBarVM({
        kind: vm.kind,
        round: vm.round,
        initiative: vm.initiative,
        turnIdx: vm.turnIdx,
        nextInitiative: vm.nextInitiative,
        units: vm.units,
        readyUnitIds: vm.readyUnitIds,
        surgeStartRound: vm.surgeStartRound,
        wildRoundCap: vm.wildRoundCap,
      }),
    );
    this.#turnbarEl.setAttribute('aria-label', s.turnbarLabel());
    this.#dockEl.setAttribute('aria-label', s.dockLabel());
    this.#paintBanner(vm);
  }

  /** The turn banner: shown for the current initiative unit iff it is not READY and not AI. */
  #paintBanner(vm: TacticsBattleVM): void {
    const id = vm.initiative[vm.turnIdx];
    const unit =
      id === undefined ? undefined : vm.units.find((u) => u.unitId === id && u.state === 'Active');
    const shown =
      unit !== undefined &&
      showsTurnBanner({ mine: unit.mine, ready: vm.readyUnitIds.has(unit.unitId), ai: unit.ai });
    this.#bannerEl.hidden = !shown;
    this.#bannerEl.textContent = shown ? s.bannerTurn(this.#deps.names.unit(unit.unitId)) : '';
  }
}
