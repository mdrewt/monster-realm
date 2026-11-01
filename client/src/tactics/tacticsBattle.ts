// tactics/tacticsBattle.ts — the tactical battle SHELL (BT10.1, BT10.3-BT10.6; bt-11: BT11.1-BT11.6):
// composes the turn bar, the board, the per-side info boxes, the ticker, the turn banner and the dock
// (the command menu, the plan strip with its AP pips and badges, the forecast panel in its Projected
// wrapper, the pointer twins of X / LB / RB) into one constructed overlay root, and implements
// `BattleOpsView` (the D-pad / A / B / X / LB / RB / Start contract).
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
// Imperative shell over pure modules: the cursor memory, the selection, the danger toggle, the
// Playback queue, the per-unit DRAFTS, the menu / aim MODE and the in-flight commit keys live here;
// everything drawn is rebuilt from the last view-model on every paint. It owns no game rule: every
// band, target, cost, label, recruit target, forecast number and projected position comes out of
// `deps.rules()` (the wasm port, bound lazily) through the pure models (commandModel.ts, draft.ts,
// queueStrip.ts, provisionalBoard.ts, forecast.ts); it reads time only through `deps.now`, and reads
// reduced motion through `deps.reduceMotion()` on every render/ingest (never cached). A frame is
// computed in full — every rules call — BEFORE the DOM is written, so a rules throw leaves the
// previous frame intact and propagates (the atomic-ingest precedent); every input op is atomic too:
// a throw anywhere in it restores the shell state the op started from (REV 6.2 C17).
//
// Three boards per paint (plan REV 5 A24 + REV 6.1 C1/C6/C10): the COST board (the live rows with the
// planning unit's own draft applied) costs its steps, bands and recruit targets; the AIM board (the
// projection up to the unit's turn — own plans and, in PvE, each wild's plan applied in initiative
// order — with the unit's own live row and then its draft) seats its skill aims and its forecast; the
// DANGER board (the live rows with every own plan applied, every enemy held) feeds danger and intents.
import type { EventPayload, QueuedAction } from '../module_bindings/types';
import type { HintBattle } from '../ui/hintBarModel';
import { closeOverlayA11y, openOverlayA11y } from '../ui/overlayA11y';
import type { BattleOp, BattleOpsView } from '../ui/screens/battleScreen';
import {
  type BoardVM,
  buildBoard,
  type CursorMemory,
  cursorFor,
  type Dir,
  moveCursor,
  spriteSlug,
  type TacticalUnit,
  type Tile,
  unitAt,
} from './boardModel';
import { renderBoard } from './boardRender';
import {
  endLabel,
  type MenuContext,
  type MenuRow,
  menuRows,
  moveBand,
  recruitTargets,
  type SkillAim,
  skillRows,
} from './commandModel';
import { applyPlan, type Draft, emptyDraft, pop, push, toWire, withRow } from './draft';
import { forecastVM } from './forecast';
import { type InfoBoxesVM, infoBoxes, renderInfoBoxes } from './hud';
import { Playback, planBeats, showsTurnBanner } from './presentation';
import { type PlanInput, project } from './provisionalBoard';
import { type Badge, type StripVM, stripVM } from './queueStrip';
import * as s from './strings';
import { Ticker, type TickerNames, tickerLine } from './ticker';
import { renderTurnBar, type TurnBarVM, turnBarVM } from './turnBar';
import {
  type ActionTarget,
  type Cell,
  isBlocked,
  type OverlayQuery,
  type OverlaysOut,
  overlaySets,
  type QueuedActionRule,
  type RulesBoard,
  type RulesUnit,
  type TacticsRules,
  type TurnBudget,
  type UnitRow,
} from './wasm';

/** A bait the player holds (an inventory row whose item def has `recruitBonus > 0`; bt-12 builds it). */
export interface BaitOption {
  readonly itemId: number;
  readonly name: string;
  readonly count: number;
  /** The item's `recruitBonus` (permille), the rules' `bait_bonus`. */
  readonly bonus: number;
}
export interface TacticsBattleVM {
  readonly battleId: bigint;
  readonly kind: 'wild' | 'pvp';
  readonly width: number;
  readonly height: number;
  readonly units: readonly TacticalUnit[];
  /** The current initiative unit of EITHER side (`Waiting(U)` / the AI or READY unit executing). */
  readonly activeUnitId: number | null;
  readonly round: number;
  readonly initiative: readonly number[];
  readonly turnIdx: number;
  readonly nextInitiative: readonly number[];
  readonly surgeStartRound: number;
  readonly wildRoundCap: number;
  readonly targetUnitId: number | null;
  /** bt-11: the raw `battle_unit` rows the rules read (bt-12: `unitRowOf` over `my_battle_units`);
   *  every overlay, band, forecast and projection is computed from it through `deps.rules`. */
  readonly board: RulesBoard;
  /** bt-11: this player's READY plans by unit id (`my_battle_queue`); the turn bar's lock derives from it. */
  readonly readyPlans: ReadonlyMap<number, readonly QueuedActionRule[]>;
  /** bt-11: the baits held (the Recruit sub-list and the forecast's bait selector). */
  readonly baits: readonly BaitOption[];
  /** bt-11: no recruit headroom (the Recruit row greys with "Party full"). */
  readonly partyFull: boolean;
}
export interface TacticsBattleDeps {
  readonly now: () => number;
  readonly reduceMotion: () => boolean;
  readonly names: TickerNames;
  /** bt-11: the rules port, bound LAZILY on first use (main.ts: `bindTacticsRules(pkg)`). */
  readonly rules: () => TacticsRules;
  /** bt-11: a unit's plan to `submit_queue` (binding-shaped entries) — a live commit or a pre-queue. */
  readonly onSubmitQueue: (
    battleId: bigint,
    unitId: number,
    entries: readonly QueuedAction[],
  ) => void;
  /** bt-11: the confirmed "Clear plan" row → `cancel_queue`. */
  readonly onCancelQueue: (battleId: bigint, unitId: number) => void;
}

/** Where the player's input goes (plan REV 5 A29). A menu level holds its cursor row; an aim holds
 *  what it aims at by identity (never by index), so a changed list cannot shift it silently. */
type Mode =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'menu';
      readonly level: 'root' | 'skills' | 'bait' | 'clear';
      readonly index: number;
    }
  | { readonly kind: 'aimMove' }
  | { readonly kind: 'aimSkill'; readonly skillId: number; readonly aimKey: string }
  | { readonly kind: 'aimRecruit'; readonly bait: number | null; readonly targetId: number };
const IDLE: Mode = { kind: 'idle' };

/** One row of the painted menu (its label and reason already resolved). */
interface MenuRowVM {
  readonly key: string;
  readonly label: string;
  readonly reason: string | null;
  readonly enabled: boolean;
  readonly sub: boolean;
}
/** One painted strip chip: its label, the rules' cost, the badge and its word, the bait note. */
interface StripChipVM {
  readonly action: string;
  readonly label: string;
  readonly cost: number | null;
  /** The pips' accessible name (resolved here, A30), or null when no pips are drawn. */
  readonly costLabel: string | null;
  readonly badge: Badge;
  readonly badgeWord: string;
  readonly note: string | null;
}
/** One painted forecast line: its text (resolved), whether it leads with the Projected tilde, and
 *  the skull it holds instead of text. */
interface PanelLine {
  readonly id: string;
  readonly text: string;
  readonly tilde: boolean;
  readonly skull: { readonly kind: 'full' | 'hollow'; readonly label: string } | null;
}
interface PanelVM {
  readonly label: string;
  readonly lines: readonly PanelLine[];
  /** The Projected wrapper (a pre-queued aim), or null on a live turn. */
  readonly projected: {
    readonly label: string;
    readonly assumes: string | null;
    readonly enemies: string | null;
  } | null;
}
/** What every own unit plans and what the board holds, computed once per paint (REV 6.1 C12). */
interface ProjectInputs {
  /** The rest of this round, then the next: the turns the projection walks. */
  readonly order: readonly number[];
  /** One plan per own Active unit: its mode-valid draft, else its READY row (A28). */
  readonly plans: readonly PlanInput[];
  /** The wilds whose live `block_pct` is 100 (asleep / frozen): they do not act. */
  readonly blocked: ReadonlySet<number>;
  readonly baitHeld: ReadonlyMap<number, number>;
  readonly baitPlanned: ReadonlyMap<number, number>;
}
/** What the planning unit's frame knows, computed once per paint from the rules. */
interface Planning {
  readonly unitId: number;
  readonly mode: 'live' | 'prequeue';
  readonly draft: Draft;
  readonly ctx: MenuContext;
  readonly end: 'endTurn' | 'guard';
  readonly hasReady: boolean;
  /** The last drafted Move's destination (the ghost), or null. */
  readonly ghost: Cell | null;
  /** The budget the draft leaves (the start budget when it is empty or refused). */
  readonly budget: TurnBudget;
  readonly draftedAp: number;
  /** The projection up to this unit's turn with its own live row, then its draft: skill aims and
   *  the forecast are seated on it (the strip's legality chain starts from the same projection). */
  readonly aimBoard: RulesBoard;
  /** PvP: the enemies that act before this unit (their plans are secret). */
  readonly hidden: ReadonlySet<number>;
  /** The model of the plan the strip shows (the draft, else the READY row). */
  readonly strip: StripVM;
}
/** A whole frame, computed before any DOM write. */
interface Frame {
  readonly mode: Mode;
  readonly selected: number | null;
  readonly cursor: Tile | null;
  readonly board: BoardVM;
  readonly ghost: {
    readonly unitId: number;
    readonly tile: Cell;
    readonly slug: string | null;
  } | null;
  readonly info: InfoBoxesVM;
  readonly turnBar: TurnBarVM;
  readonly banner: string | null;
  readonly menu: { readonly rows: readonly MenuRowVM[]; readonly index: number } | null;
  readonly strip: { readonly chips: readonly StripChipVM[]; readonly locked: boolean };
  readonly panel: PanelVM | null;
  readonly hint: HintBattle;
  readonly reduced: boolean;
}

function div(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

const isOwnActive = (u: TacticalUnit): boolean => u.mine && u.state === 'Active';
const sameTile = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;
const aimKeyOf = (target: ActionTarget): string =>
  target === 'SelfTarget' ? 'self' : `u:${target.Unit}`;
const inflightKey = (vm: TacticsBattleVM): string => `${vm.battleId}:${vm.round}:${vm.turnIdx}`;
/** A unit's planning mode: live on its own waiting turn without a READY row, else pre-queue (A28). */
const modeOf = (vm: TacticsBattleVM, unitId: number): 'live' | 'prequeue' =>
  vm.activeUnitId === unitId && !vm.readyPlans.has(unitId) ? 'live' : 'prequeue';
/** A tile in A1 notation (column letter, 1-based row) — display formatting, not a rule. */
const a1 = (tile: Cell): string => String.fromCharCode(0x41 + tile.x) + String(tile.y + 1);
/** U+007E and U+2014 as code points (the Projected prefix and the hidden-number line). */
const TILDE = String.fromCharCode(0x7e);
const EM_DASH = String.fromCharCode(0x2014);
const NUMERIC_LINES: ReadonlySet<string> = new Set([
  'hit',
  'damage',
  'type',
  'flank',
  'guard',
  'recruit',
  'recruitLines',
]);
/** An empty overlays answer (the parts a query did not run). */
const NO_OVERLAYS: OverlaysOut = {
  reach1: [],
  reach2: [],
  range: [],
  aoe: [],
  danger: [],
  shield: [],
  intents: [],
};
/** A panel-line writer: a numeric line (hit, damage, a factor, the odds) leads with the Projected
 *  tilde on a pre-queued aim; `numeric` overrides the id's default (an Immune word, a dash). */
const panelLine =
  (lines: PanelLine[], mode: 'live' | 'prequeue') =>
  (id: string, text: string, numeric: boolean = NUMERIC_LINES.has(id)): void => {
    lines.push({ id, text, tilde: mode === 'prequeue' && numeric, skull: null });
  };

/** The chip label of one planned action (every word from the catalog or the names dependency). */
function chipLabel(action: QueuedActionRule, names: TickerNames): string {
  if (action === 'Flee') return s.menuFlee();
  if (action === 'EndTurn') return s.menuEndTurn();
  if ('Move' in action) return s.menuMove();
  if ('Skill' in action) return names.skill(action.Skill.skill_id);
  if ('Item' in action) return names.item(action.Item.item_id);
  return s.menuRecruit();
}
const chipAction = (action: QueuedActionRule): string =>
  typeof action === 'string' ? action : (Object.keys(action)[0] ?? '');

/** `vm.units` and `vm.board.units` describe the same battle, or the frame is refused (REV 5 A30). */
function checkAgreement(vm: TacticsBattleVM): void {
  const units = new Map(vm.units.map((u) => [u.unitId, u]));
  for (const row of vm.board.units) {
    const u = units.get(row.id);
    if (u === undefined) throw new Error(`tactics: board row ${row.id} has no unit view-model`);
    if (u.x !== row.pos.x || u.y !== row.pos.y || u.curHp !== row.cur_hp || u.state !== row.state) {
      throw new Error(`tactics: unit ${row.id} disagrees with its board row`);
    }
    units.delete(row.id);
  }
  const extra = units.keys().next();
  if (!extra.done) throw new Error(`tactics: unit ${extra.value} has no board row`);
}

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
  #mode: Mode = IDLE;
  /** The drafts by unit id, each with the mode it was drafted in (a flip drops it, A28). */
  #drafts = new Map<number, { readonly draft: Draft; readonly mode: 'live' | 'prequeue' }>();
  /** The turn key at which a unit's last commit was sent: further commits wait for a new key. */
  #inflight = new Map<number, string>();
  /** The last `activeUnitId` seen: the selection follows it when it CHANGES to an own unit. */
  #lastActive: number | null = null;
  #hint: HintBattle = { start: 'endTurn', undo: false };
  #menuOpen = false;
  #rules: TacticsRules | null = null;

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
    checkAgreement(vm);
    if (this.#battleId !== vm.battleId) this.#startBattle(vm.battleId);
    // The frame is computed from the NEW vm before any state or DOM moves (A30): a throw leaves
    // the shell exactly as it was.
    const frame = this.#compute(vm);
    this.#vm = vm;
    this.#commit(frame);
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

  /** What the hint bar shows for the selected unit (BT11.6): Start's verb and whether B undoes. */
  hint(): HintBattle {
    return this.#hint;
  }

  toggleDanger(): void {
    this.#atomic(() => {
      this.#dangerOn = !this.#dangerOn;
      this.#paint();
    });
  }

  /** Select the next (+1) / previous (-1) own Active unit in input order, wrapping; closes any
   *  open menu or aim (the next A is that unit's). */
  cycleUnit(dir: -1 | 1): void {
    this.#atomic(() => {
      const vm = this.#vm;
      if (vm === null) return;
      const own = vm.units.filter(isOwnActive);
      if (own.length === 0) return;
      const at = own.findIndex((u) => u.unitId === this.#selected);
      const next =
        at === -1
          ? (own[dir > 0 ? 0 : own.length - 1] as TacticalUnit)
          : (own[(at + dir + own.length) % own.length] as TacticalUnit);
      this.#select(next, vm);
      this.#paint();
    });
  }

  applyBattleOp(op: BattleOp): void {
    this.#atomic(() => {
      switch (op.kind) {
        case 'move':
          this.#move(op.dir);
          return;
        case 'back':
          this.#back();
          return;
        case 'activate':
          this.#activate();
          return;
        case 'danger':
          this.toggleDanger();
          return;
        case 'cycle':
          this.cycleUnit(op.dir);
          return;
        case 'start':
          this.#start();
          return;
        default:
          op satisfies never;
      }
    });
  }

  // --- input ---------------------------------------------------------------------------------

  /** Every input op runs here (REV 6.2 C17): a throw anywhere in it — a rules call, the paint, a
   *  throwing submit sink — restores the shell state the op started from and propagates. The
   *  in-flight keys are NOT restored: a plan that was sent stays sent. */
  #atomic<T>(fn: () => T): T {
    const saved = {
      mode: this.#mode,
      cursor: this.#cursor,
      selected: this.#selected,
      memory: this.#memory,
      dangerOn: this.#dangerOn,
      drafts: new Map(this.#drafts),
      lastActive: this.#lastActive,
    };
    try {
      return fn();
    } catch (err) {
      this.#mode = saved.mode;
      this.#cursor = saved.cursor;
      this.#selected = saved.selected;
      this.#memory = saved.memory;
      this.#dangerOn = saved.dangerOn;
      this.#drafts = saved.drafts;
      this.#lastActive = saved.lastActive;
      throw err;
    }
  }

  #select(unit: TacticalUnit, vm: TacticsBattleVM): void {
    this.#selected = unit.unitId;
    this.#cursor = cursorFor(this.#memory, unit, vm.width, vm.height);
    this.#mode = IDLE;
  }

  #move(dir: Dir): void {
    const vm = this.#vm;
    if (vm === null) return;
    const step = dir === 'Up' || dir === 'Left' ? -1 : 1;
    const mode = this.#mode;
    switch (mode.kind) {
      case 'menu': {
        const p = this.#planning(vm);
        const rows = p === null ? 0 : this.#menuRows(p, mode.level).length;
        if (rows > 0) this.#mode = { ...mode, index: (mode.index + step + rows) % rows };
        break;
      }
      case 'aimMove': {
        const from = this.#cursor ?? { x: 0, y: 0 };
        const moved = moveCursor(new Map(), -1, from, dir, vm.width, vm.height);
        this.#cursor = moved.get(-1) ?? from;
        break;
      }
      case 'aimSkill':
      case 'aimRecruit':
        this.#stepAim(mode, dir, step);
        break;
      case 'idle':
        this.#moveCursor(dir);
        return;
      default:
        mode satisfies never;
    }
    this.#paint();
  }

  /** In an aim, the D-pad steps the aim list (wrapping); Left / Right in a recruit aim cycle the bait. */
  #stepAim(mode: Extract<Mode, { kind: 'aimSkill' | 'aimRecruit' }>, dir: Dir, step: -1 | 1): void {
    const p = this.#planning(this.#vm as TacticsBattleVM);
    if (p === null) return;
    if (mode.kind === 'aimSkill') {
      const aims = this.#skillAims(p, mode.skillId);
      if (aims.length === 0) return;
      const at = Math.max(
        0,
        aims.findIndex((a) => aimKeyOf(a.target) === mode.aimKey),
      );
      const next = aims[(at + step + aims.length) % aims.length] as SkillAim;
      this.#mode = { ...mode, aimKey: aimKeyOf(next.target) };
      return;
    }
    if (dir === 'Left' || dir === 'Right') {
      const baits = this.#baits();
      const at = baits.findIndex((b) => b === mode.bait);
      const next = baits[(Math.max(0, at) + step + baits.length) % baits.length];
      this.#mode = { ...mode, bait: next === undefined ? null : next };
      return;
    }
    const targets = recruitTargets(p.ctx);
    if (targets.length === 0) return;
    const at = Math.max(0, targets.indexOf(mode.targetId));
    this.#mode = {
      ...mode,
      targetId: targets[(at + step + targets.length) % targets.length] as number,
    };
  }

  /** The bait choices: no bait (null) then every held bait, in the VM's order. */
  #baits(): readonly (number | null)[] {
    const vm = this.#vm;
    const held = vm === null ? [] : vm.baits.filter((b) => b.count > 0).map((b) => b.itemId);
    return [null, ...held];
  }

  #back(): void {
    // B is the SKIP key while a beat plays: it drains the playback and nothing else moves.
    if (this.#playback.playing()) {
      this.#playback.skip();
      this.#syncPlaying();
      return;
    }
    const mode = this.#mode;
    switch (mode.kind) {
      case 'menu':
        this.#mode = mode.level === 'root' ? IDLE : { kind: 'menu', level: 'root', index: 0 };
        break;
      case 'aimMove':
        this.#mode = { kind: 'menu', level: 'root', index: 0 };
        break;
      case 'aimSkill':
        this.#mode = { kind: 'menu', level: 'skills', index: 0 };
        break;
      case 'aimRecruit':
        this.#mode = { kind: 'menu', level: 'bait', index: 0 };
        break;
      case 'idle': {
        // Pop the last drafted chip, for free, in PvE and PvP alike.
        const id = this.selectedUnitId;
        const held = id === null ? undefined : this.#drafts.get(id);
        if (id === null || held === undefined) return;
        const popped = pop(held.draft);
        if (popped.actions.length === 0) this.#drafts.delete(id);
        else this.#drafts.set(id, { draft: popped, mode: held.mode });
        break;
      }
      default:
        mode satisfies never;
    }
    this.#paint();
  }

  #activate(): void {
    const vm = this.#vm;
    if (vm === null) return;
    const mode = this.#mode;
    switch (mode.kind) {
      case 'idle': {
        const under = this.#cursor === null ? null : unitAt(vm.units, this.#cursor);
        if (under === null || !isOwnActive(under)) return;
        if (under.unitId !== this.#selected) this.#select(under, vm);
        this.#mode = { kind: 'menu', level: 'root', index: 0 };
        break;
      }
      case 'menu':
        this.#chooseRow(mode.index);
        return;
      case 'aimMove':
        this.#confirmMove();
        return;
      case 'aimSkill':
      case 'aimRecruit':
        this.#confirmAim();
        return;
      default:
        mode satisfies never;
    }
    this.#paint();
  }

  /** A on the menu row at `index` (or a click on it): a sub-list, an aim, or an action. */
  #chooseRow(index: number): void {
    const vm = this.#vm;
    const mode = this.#mode;
    if (vm === null || mode.kind !== 'menu') return;
    const p = this.#planning(vm);
    if (p === null) {
      this.#mode = IDLE;
      this.#paint();
      return;
    }
    const rows = this.#menuRows(p, mode.level);
    const row = rows[index];
    if (row === undefined || !row.enabled) return;
    switch (mode.level) {
      case 'root':
        this.#chooseRoot(p, row.key);
        return;
      case 'skills': {
        const skillId = Number(row.key.slice('skill:'.length));
        const first = this.#skillAims(p, skillId)[0];
        if (first === undefined) return;
        this.#mode = { kind: 'aimSkill', skillId, aimKey: aimKeyOf(first.target) };
        break;
      }
      case 'bait': {
        const bait = row.key === 'bait:none' ? null : Number(row.key.slice('bait:'.length));
        const first = recruitTargets(p.ctx)[0];
        if (first === undefined) return;
        this.#mode = { kind: 'aimRecruit', bait, targetId: first };
        break;
      }
      case 'clear':
        if (row.key === 'clearYes') {
          this.#deps.onCancelQueue(vm.battleId, p.unitId);
          // The sent plan is gone: the next submit for this unit is a new round-trip (C18).
          this.#inflight.delete(p.unitId);
        }
        this.#mode = IDLE;
        break;
      default:
        mode.level satisfies never;
    }
    this.#paint();
  }

  #chooseRoot(p: Planning, key: string): void {
    switch (key) {
      case 'move':
        this.#mode = { kind: 'aimMove' };
        break;
      case 'skills':
        this.#mode = { kind: 'menu', level: 'skills', index: 0 };
        break;
      case 'recruit':
        this.#mode = { kind: 'menu', level: 'bait', index: 0 };
        break;
      case 'flee':
        this.#commitOrAppend(p, 'Flee');
        return;
      case 'end':
        this.#commitOrAppend(p, 'EndTurn');
        return;
      case 'submit':
        if (p.draft.actions.length > 0) this.#send(p.unitId, p.draft.actions);
        this.#mode = IDLE;
        break;
      case 'clear':
        this.#mode = { kind: 'menu', level: 'clear', index: 0 };
        break;
      default:
        return;
    }
    this.#paint();
  }

  /** A on a Move aim: the tile in the band drafts a Move of that band's strides (reach1 → 1,
   *  reach2 → 2; the sets are exclusive); anything else drafts nothing and the aim stays. */
  #confirmMove(): void {
    const vm = this.#vm;
    const at = this.#cursor;
    if (vm === null || at === null) return;
    const p = this.#planning(vm);
    if (p === null) return;
    const band = moveBand(p.ctx);
    let strides = 0;
    if (band.reach1.some((t) => sameTile(t, at))) strides = 1;
    else if (band.reach2.some((t) => sameTile(t, at))) strides = 2;
    if (strides === 0) return;
    this.#append(p, { Move: { x: at.x, y: at.y, strides } });
    this.#mode = IDLE;
    this.#paint();
  }

  #confirmAim(): void {
    const vm = this.#vm;
    const mode = this.#mode;
    if (vm === null) return;
    const p = this.#planning(vm);
    if (p === null) return;
    if (mode.kind === 'aimSkill') {
      const aim = this.#currentAim(p, mode);
      if (aim === null) return;
      this.#commitOrAppend(p, { Skill: { skill_id: mode.skillId, target: aim.target } });
      return;
    }
    if (mode.kind === 'aimRecruit') {
      const target = this.#currentRecruit(p, mode);
      if (target === null) return;
      this.#commitOrAppend(p, { Recruit: { target, bait: mode.bait } });
    }
  }

  /** An irreversible action: on a live turn it submits the draft and itself at once; in a pre-queue
   *  it is appended (Start submits). Either way the menu closes. */
  #commitOrAppend(p: Planning, action: QueuedActionRule): void {
    if (p.mode === 'live') this.#send(p.unitId, [...p.draft.actions, action]);
    else this.#append(p, action);
    this.#mode = IDLE;
    this.#paint();
  }

  #append(p: Planning, action: QueuedActionRule): void {
    this.#drafts.set(p.unitId, { draft: push(p.draft, action), mode: p.mode });
  }

  /** Send `actions` for `unitId` — once per turn key (A28): the sink is called FIRST (a throw keeps
   *  the draft), the draft cleared after. */
  #send(unitId: number, actions: readonly QueuedActionRule[]): void {
    const vm = this.#vm;
    if (vm === null) return;
    const key = inflightKey(vm);
    if (this.#inflight.get(unitId) === key) return;
    this.#deps.onSubmitQueue(vm.battleId, unitId, toWire(actions));
    this.#inflight.set(unitId, key);
    this.#drafts.delete(unitId);
  }

  /** Start: on a live turn End Turn / Guard (the draft plus EndTurn); for a pre-queue Submit. */
  #start(): void {
    const vm = this.#vm;
    if (vm === null) return;
    const p = this.#planning(vm);
    if (p === null) return;
    if (p.mode === 'live') this.#send(p.unitId, [...p.draft.actions, 'EndTurn']);
    else if (p.draft.actions.length > 0) this.#send(p.unitId, p.draft.actions);
    this.#mode = IDLE;
    this.#paint();
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

  /** Pointer mirror of the D-pad: the cursor goes to the clicked tile; in an aim a legal tile
   *  confirms (a skill aim also answers a click on the target's LIVE tile, where its sprite is
   *  drawn — the aim itself sits on the projected one); at rest an own unit's tile selects it and
   *  opens its menu. Atomic like every op. */
  #pointTo(tile: Tile): void {
    this.#atomic(() => this.#pointToInner(tile));
  }

  #pointToInner(tile: Tile): void {
    const vm = this.#vm;
    if (vm === null) return;
    const mode = this.#mode;
    if (mode.kind === 'aimMove') {
      this.#cursor = tile;
      this.#confirmMove();
      this.#paint();
      return;
    }
    if (mode.kind === 'aimSkill' || mode.kind === 'aimRecruit') {
      const p = this.#planning(vm);
      if (p !== null) {
        if (mode.kind === 'aimSkill') {
          const liveTileOf = (target: ActionTarget): Tile | null => {
            if (target === 'SelfTarget') return null;
            const u = vm.units.find((x) => x.unitId === target.Unit);
            return u === undefined ? null : { x: u.x, y: u.y };
          };
          const aim = this.#skillAims(p, mode.skillId).find((a) => {
            const live = liveTileOf(a.target);
            return sameTile(a.aim, tile) || (live !== null && sameTile(live, tile));
          });
          if (aim !== undefined) {
            this.#mode = { ...mode, aimKey: aimKeyOf(aim.target) };
            this.#confirmAim();
            return;
          }
        } else {
          const target = recruitTargets(p.ctx).find((id) => {
            const row = p.ctx.costBoard.units.find((u) => u.id === id);
            return row !== undefined && sameTile(row.pos, tile);
          });
          if (target !== undefined) {
            this.#mode = { ...mode, targetId: target };
            this.#confirmAim();
            return;
          }
        }
      }
      this.#paint();
      return;
    }
    this.#cursor = tile;
    if (this.#selected !== null) {
      const next = new Map(this.#memory);
      next.set(this.#selected, tile);
      this.#memory = next;
    }
    const under = unitAt(vm.units, tile);
    if (under !== null && isOwnActive(under)) {
      if (under.unitId !== this.#selected) this.#select(under, vm);
      this.#cursor = tile;
      this.#mode = { kind: 'menu', level: 'root', index: 0 };
    } else if (mode.kind === 'menu') {
      this.#mode = IDLE;
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
    this.#mode = IDLE;
    this.#drafts = new Map();
    this.#inflight = new Map();
    this.#lastActive = null;
    this.#ticker.clear();
    this.#playback.skip();
    this.#syncPlaying();
  }

  #syncPlaying(): void {
    this.#root.classList.toggle('tactics-battle--playing', this.#playback.playing());
  }

  // --- the frame -------------------------------------------------------------------------------

  #rulesPort(): TacticsRules {
    if (this.#rules === null) this.#rules = this.#deps.rules();
    return this.#rules;
  }

  /** The mode-valid draft of `unitId` (a draft made in the other mode is dropped, A28). */
  #draftOf(unitId: number, mode: 'live' | 'prequeue'): Draft {
    const held = this.#drafts.get(unitId);
    return held === undefined || held.mode !== mode ? emptyDraft(unitId) : held.draft;
  }

  /** The projection's inputs, once per paint (REV 6.1 C9/C12): the turn order, one plan per own
   *  Active unit (the draft replaces the READY row), the asleep wilds read from the LIVE board's
   *  intents (never a board a draft already changed, C6), and the bait counts over those plans. */
  #projectInputs(vm: TacticsBattleVM): ProjectInputs {
    const rules = this.#rulesPort();
    const order = [...vm.initiative.slice(vm.turnIdx), ...vm.nextInitiative];
    const plans: PlanInput[] = [];
    const baitPlanned = new Map<number, number>();
    for (const u of vm.units) {
      if (!isOwnActive(u)) continue;
      const draft = this.#draftOf(u.unitId, modeOf(vm, u.unitId)).actions;
      const actions = draft.length > 0 ? draft : (vm.readyPlans.get(u.unitId) ?? []);
      if (actions.length === 0) continue;
      plans.push({ unitId: u.unitId, actions });
      for (const a of actions) {
        if (typeof a === 'object' && 'Recruit' in a && a.Recruit.bait !== null) {
          baitPlanned.set(a.Recruit.bait, (baitPlanned.get(a.Recruit.bait) ?? 0) + 1);
        }
      }
    }
    const live = rules.overlays(vm.board, this.#nullQuery());
    const blocked = new Set(live.intents.filter((i) => isBlocked(i.block_pct)).map((i) => i.unit));
    const baitHeld = new Map(vm.baits.map((b) => [b.itemId, b.count]));
    return { order, plans, blocked, baitHeld, baitPlanned };
  }

  /** The query for danger and intents (no selection): the fresh budget is its unused basis. */
  #nullQuery(): OverlayQuery {
    return {
      viewer: this.#deps.names.mySide,
      selected: null,
      skill_id: null,
      aim: null,
      budget: this.#rulesPort().freshBudget(),
    };
  }

  /** Everything the frame knows about the selected unit's plan, or null without a selection. */
  #planning(vm: TacticsBattleVM, inputs: ProjectInputs = this.#projectInputs(vm)): Planning | null {
    const id = this.selectedUnitId;
    if (id === null) return null;
    const row = vm.board.units.find((u) => u.id === id);
    const view = vm.units.find((u) => u.unitId === id);
    if (row === undefined || view === undefined) return null;
    const rules = this.#rulesPort();
    const hasReady = vm.readyPlans.has(id);
    const mode = modeOf(vm, id);
    const draft = this.#draftOf(id, mode);
    const startBudget = mode === 'live' ? row.budget : rules.freshBudget();
    const live = rules.unit(row);
    // The cost board: the live rows with this unit's own draft (bands, costs, recruit targets).
    const costBoard = applyPlan(rules, vm.board, id, draft.actions);
    // The act / aim board: the projection up to this unit's turn, the unit itself at its LIVE row
    // (an enemy plan that would KO it must not grey its menu, C10), then its draft.
    const upTo = project(rules, vm.board, {
      kind: vm.kind,
      mySide: this.#deps.names.mySide,
      order: inputs.order,
      plans: inputs.plans,
      blocked: inputs.blocked,
      wilds: true,
      upTo: id,
    });
    const actBoard = withRow(upTo.board, row);
    const aimBoard = applyPlan(rules, actBoard, id, draft.actions);
    const shown: readonly QueuedActionRule[] =
      draft.actions.length > 0 ? draft.actions : (vm.readyPlans.get(id) ?? []);
    const strip = stripVM({
      rules,
      liveBoard: vm.board,
      actBoard,
      unit: live,
      startBudget,
      actions: shown,
      mode,
      partyFull: vm.partyFull,
      baitHeld: inputs.baitHeld,
      baitPlanned: inputs.baitPlanned,
    });
    // The menu budget and the HUD's drafted spend come from the DRAFT only (C2): a READY row that
    // the next action would replace never feeds them.
    const drafted = draft.actions.length > 0;
    const budget = drafted ? (strip.remaining ?? startBudget) : startBudget;
    const draftedAp = drafted ? (strip.total ?? 0) : 0;
    const projected = costBoard.units.find((u) => u.id === id) as UnitRow;
    const unit: RulesUnit = rules.unit(projected);
    const ctx: MenuContext = {
      kind: vm.kind,
      mode,
      rules,
      costBoard,
      aimBoard,
      unit,
      budget,
      actions: draft.actions,
      partyFull: vm.partyFull,
      hasReady,
    };
    const lastMove = [...draft.actions].reverse().find((a) => typeof a === 'object' && 'Move' in a);
    const ghost =
      lastMove !== undefined && typeof lastMove === 'object' && 'Move' in lastMove
        ? { x: lastMove.Move.x, y: lastMove.Move.y }
        : null;
    return {
      unitId: id,
      mode,
      draft,
      ctx,
      end: endLabel(ctx),
      hasReady,
      ghost,
      budget,
      draftedAp,
      aimBoard,
      hidden: upTo.hidden,
      strip,
    };
  }

  #skillAims(p: Planning, skillId: number): readonly SkillAim[] {
    return skillRows(p.ctx).find((r) => r.skillId === skillId)?.aims ?? [];
  }

  #currentAim(p: Planning, mode: Extract<Mode, { kind: 'aimSkill' }>): SkillAim | null {
    const aims = this.#skillAims(p, mode.skillId);
    return aims.find((a) => aimKeyOf(a.target) === mode.aimKey) ?? aims[0] ?? null;
  }

  #currentRecruit(p: Planning, mode: Extract<Mode, { kind: 'aimRecruit' }>): number | null {
    const targets = recruitTargets(p.ctx);
    if (targets.length === 0) return null;
    return targets.includes(mode.targetId) ? mode.targetId : (targets[0] as number);
  }

  /** The rows of one menu level, labels and reasons resolved. */
  #menuRows(p: Planning, level: 'root' | 'skills' | 'bait' | 'clear'): MenuRowVM[] {
    const names = this.#deps.names;
    const ap = this.#rulesPort().freshBudget().ap;
    const reasonOf = (code: Parameters<typeof s.reasonLabel>[0] | null): string | null =>
      code === null ? null : s.reasonLabel(code, ap);
    switch (level) {
      case 'root':
        return menuRows(p.ctx).map((r: MenuRow) => ({
          key: r.id,
          label: s.menuRowLabel(r.id, p.end),
          reason: reasonOf(r.reason),
          enabled: r.enabled,
          sub: r.sub,
        }));
      case 'skills':
        return skillRows(p.ctx).map((r) => ({
          key: `skill:${r.skillId}`,
          label: names.skill(r.skillId),
          reason: reasonOf(r.reason),
          enabled: r.enabled,
          sub: true,
        }));
      case 'bait': {
        const vm = this.#vm as TacticsBattleVM;
        const rows: MenuRowVM[] = [
          { key: 'bait:none', label: s.menuNoBait(), reason: null, enabled: true, sub: true },
        ];
        for (const b of vm.baits) {
          if (b.count <= 0) continue;
          rows.push({
            key: `bait:${b.itemId}`,
            label: b.name,
            reason: null,
            enabled: true,
            sub: true,
          });
        }
        return rows;
      }
      case 'clear':
        return [
          { key: 'clearYes', label: s.menuClearYes(), reason: null, enabled: true, sub: false },
          { key: 'clearNo', label: s.menuClearNo(), reason: null, enabled: true, sub: false },
        ];
      default:
        return level satisfies never;
    }
  }

  /** The mode after the vm is applied (A28 / A30): the selection follows a NEW own active unit; a
   *  gone unit, skill, aim or bait falls back; drafts of units that left or flipped mode drop. */
  #reconcile(vm: TacticsBattleVM): void {
    // The selection follows the turn when the active unit CHANGES to an own one.
    if (vm.activeUnitId !== this.#lastActive) {
      this.#lastActive = vm.activeUnitId;
      const active = vm.units.find((u) => u.unitId === vm.activeUnitId);
      if (active !== undefined && isOwnActive(active)) this.#select(active, vm);
    }
    // Nothing selected yet, or the selected unit is no longer an own Active one (KO'd, recruited,
    // gone): select the first own Active unit, with its remembered (else current) tile.
    if (this.selectedUnitId === null) {
      const first = vm.units.find(isOwnActive);
      this.#selected = first?.unitId ?? null;
      if (first !== undefined) this.#cursor = cursorFor(this.#memory, first, vm.width, vm.height);
      this.#mode = IDLE;
    }
    for (const id of [...this.#drafts.keys()]) {
      const u = vm.units.find((x) => x.unitId === id);
      if (u === undefined || !isOwnActive(u)) this.#drafts.delete(id);
    }
    // A READY row acknowledges the round-trip: the next submit (a replacement) may go (C18). When
    // the row being replaced is still present this re-arms at once, so only the FIRST send of a
    // turn is guarded against a double press — game-core replaces the plan, so a repeat is harmless.
    for (const id of [...this.#inflight.keys()]) {
      if (vm.readyPlans.has(id)) this.#inflight.delete(id);
    }
  }

  /** The frame for `vm` under the current state, with the selection reconciled first (A28 / A30):
   *  computed on a COPY of the mutable selection so a throw below leaves the shell untouched. */
  #compute(vm: TacticsBattleVM): Frame {
    const saved = {
      selected: this.#selected,
      cursor: this.#cursor,
      mode: this.#mode,
      lastActive: this.#lastActive,
      drafts: new Map(this.#drafts),
      inflight: new Map(this.#inflight),
      vm: this.#vm,
    };
    this.#vm = vm;
    try {
      this.#reconcile(vm);
      return this.#frame(vm);
    } catch (err) {
      this.#selected = saved.selected;
      this.#cursor = saved.cursor;
      this.#mode = saved.mode;
      this.#lastActive = saved.lastActive;
      this.#drafts = saved.drafts;
      this.#inflight = saved.inflight;
      this.#vm = saved.vm;
      throw err;
    }
  }

  /** Every rules call of a frame happens here; the DOM is written only by `#commit`. */
  #frame(vm: TacticsBattleVM): Frame {
    const rules = this.#rulesPort();
    const inputs = this.#projectInputs(vm);
    const p = this.#planning(vm, inputs);
    let mode = this.#mode;
    if (p === null) mode = IDLE;
    // Revalidate the mode against the live lists (A30).
    let aim: SkillAim | null = null;
    let recruitTarget: number | null = null;
    let cursor = this.#cursor;
    if (p !== null) {
      if (mode.kind === 'menu') {
        const rows = this.#menuRows(p, mode.level);
        if (rows.length === 0)
          mode = mode.level === 'root' ? IDLE : { kind: 'menu', level: 'root', index: 0 };
        else if (mode.index >= rows.length) mode = { ...mode, index: 0 };
      } else if (mode.kind === 'aimSkill') {
        aim = this.#currentAim(p, mode);
        if (aim === null) mode = { kind: 'menu', level: 'skills', index: 0 };
        else {
          mode = { ...mode, aimKey: aimKeyOf(aim.target) };
          cursor = aim.aim;
        }
      } else if (mode.kind === 'aimRecruit') {
        const target = this.#currentRecruit(p, mode);
        const bait = this.#baits().includes(mode.bait) ? mode.bait : null;
        if (target === null) mode = { kind: 'menu', level: 'bait', index: 0 };
        else {
          mode = { ...mode, targetId: target, bait };
          recruitTarget = target;
          const row = p.ctx.costBoard.units.find((u) => u.id === target);
          if (row !== undefined) cursor = row.pos;
        }
      }
    }

    // The overlays (A24 / C6): reach and shield on the cost board with the draft's remaining budget;
    // range and aoe on the aim board while a skill is aimed; danger and intents on the danger board
    // (every own plan applied, every enemy held at its live tile).
    const viewer = this.#deps.names.mySide;
    const dangerBoard = project(rules, vm.board, {
      kind: vm.kind,
      mySide: viewer,
      order: inputs.order,
      plans: inputs.plans,
      blocked: inputs.blocked,
      wilds: false,
    }).board;
    const dangerOut = rules.overlays(dangerBoard, this.#nullQuery());
    let reachOut: OverlaysOut = NO_OVERLAYS;
    let aimOut: OverlaysOut = NO_OVERLAYS;
    if (p !== null) {
      const base = { viewer, selected: p.unitId, budget: p.budget };
      reachOut = rules.overlays(p.ctx.costBoard, { ...base, skill_id: null, aim: null });
      if (mode.kind === 'aimSkill' && aim !== null) {
        aimOut = rules.overlays(p.aimBoard, { ...base, skill_id: mode.skillId, aim: aim.aim });
      }
    }
    const overlays = overlaySets({
      reach1: reachOut.reach1,
      reach2: reachOut.reach2,
      shield: reachOut.shield,
      range: aimOut.range,
      aoe: aimOut.aoe,
      danger: dangerOut.danger,
      intents: dangerOut.intents,
    });
    const board = buildBoard({
      width: vm.width,
      height: vm.height,
      units: vm.units,
      activeUnitId: vm.activeUnitId,
      cursor,
      overlays,
      dangerOn: this.#dangerOn,
    });
    const ghostUnit = p === null ? undefined : vm.units.find((u) => u.unitId === p.unitId);
    const ghost =
      p !== null && p.ghost !== null && ghostUnit !== undefined
        ? { unitId: p.unitId, tile: p.ghost, slug: spriteSlug(ghostUnit.speciesName) }
        : null;

    // Hovered = the Active target if there is one, else the unit under the cursor.
    const target =
      vm.targetUnitId === null
        ? null
        : vm.units.find((u) => u.unitId === vm.targetUnitId && u.state === 'Active');
    const under = cursor === null ? null : unitAt(vm.units, cursor);
    const info = infoBoxes(vm.units, {
      activeUnitId: vm.activeUnitId,
      focusUnitId: (target ?? under)?.unitId ?? null,
      draftedAp: p !== null && p.unitId === vm.activeUnitId ? p.draftedAp : 0,
    });
    const turnBar = turnBarVM({
      kind: vm.kind,
      round: vm.round,
      initiative: vm.initiative,
      turnIdx: vm.turnIdx,
      nextInitiative: vm.nextInitiative,
      units: vm.units,
      readyUnitIds: new Set(vm.readyPlans.keys()),
      surgeStartRound: vm.surgeStartRound,
      wildRoundCap: vm.wildRoundCap,
    });
    // The turn banner: shown for the current initiative unit iff it is not READY and not AI.
    const currentId = vm.initiative[vm.turnIdx];
    const current =
      currentId === undefined
        ? undefined
        : vm.units.find((u) => u.unitId === currentId && u.state === 'Active');
    const banner =
      current !== undefined &&
      showsTurnBanner({
        mine: current.mine,
        ready: vm.readyPlans.has(current.unitId),
        ai: current.ai,
      })
        ? s.bannerTurn(this.#deps.names.unit(current.unitId))
        : null;

    const menu =
      p !== null && mode.kind === 'menu'
        ? { rows: this.#menuRows(p, mode.level), index: mode.index }
        : null;
    const names = this.#deps.names;
    const strip = {
      chips:
        p === null
          ? []
          : p.strip.chips.map((ch) => ({
              action: chipAction(ch.action),
              label: chipLabel(ch.action, names),
              cost: ch.cost,
              costLabel: ch.cost !== null && ch.cost > 0 ? s.chipCost(ch.cost) : null,
              badge: ch.badge,
              badgeWord: s.badgeLabel(ch.badge),
              note: ch.onlyHeld === null ? null : s.badgeOnlyHeld(ch.onlyHeld),
            })),
      locked: p !== null && p.hasReady && p.draft.actions.length === 0,
    };
    let panel: PanelVM | null = null;
    if (p !== null && mode.kind === 'aimSkill' && aim !== null) {
      panel = this.#skillPanel(vm, p, mode.skillId, aim);
    } else if (p !== null && mode.kind === 'aimRecruit' && recruitTarget !== null) {
      panel = this.#recruitPanel(vm, p, recruitTarget, mode.bait);
    }
    const hint: HintBattle =
      p === null
        ? { start: 'endTurn', undo: false }
        : {
            start: p.mode === 'live' ? p.end : 'submit',
            undo: p.draft.actions.length > 0,
          };
    return {
      mode,
      selected: this.#selected,
      cursor,
      board,
      ghost,
      info,
      turnBar,
      banner,
      menu,
      strip,
      panel,
      hint,
      reduced: this.#deps.reduceMotion(),
    };
  }

  /** The Projected wrapper of a pre-queued aim (A31): the label, the assumption about the aimed
   *  target's tile, and in PvP the enemies-hold caveat. Null on a live turn. */
  #projectedOf(
    vm: TacticsBattleVM,
    p: Planning,
    target: { readonly id: number; readonly tile: Cell } | null,
  ): PanelVM['projected'] {
    if (p.mode !== 'prequeue') return null;
    return {
      label: s.projectedLabel(),
      assumes:
        target === null
          ? null
          : s.projectedAssumes(this.#deps.names.unit(target.id), a1(target.tile)),
      enemies: vm.kind === 'pvp' ? s.projectedEnemiesHold() : null,
    };
  }

  /** The forecast panel of a skill aim: the rules' forecast of the attacker at its drafted tile on
   *  the AIM board against the aimed target there (a Burst: its first hit), shaped by `forecastVM`;
   *  a hidden PvP target prints its hit line and a dash. */
  #skillPanel(vm: TacticsBattleVM, p: Planning, skillId: number, aim: SkillAim): PanelVM {
    const rules = this.#rulesPort();
    const names = this.#deps.names;
    const targetId = aim.target === 'SelfTarget' ? aim.hits[0] : aim.target.Unit;
    const attackerRow = p.aimBoard.units.find((u) => u.id === p.unitId);
    const targetRow =
      targetId === undefined ? undefined : p.aimBoard.units.find((u) => u.id === targetId);
    const projectedTarget = targetId !== undefined && targetRow !== undefined;
    const lines: PanelLine[] = [];
    const line = panelLine(lines, p.mode);
    if (projectedTarget && attackerRow !== undefined) {
      const f = rules.forecast(
        rules.unit(attackerRow),
        rules.unit(targetRow),
        skillId,
        rules.flank(p.aimBoard, p.unitId, targetId),
      );
      const fv = forecastVM(f);
      line('vs', s.forecastVs(names.unit(targetId)));
      if (!fv.hits) line('miss', s.forecastMiss());
      else if (p.hidden.has(targetId)) {
        line('hit', s.forecastHit(fv.hitPct));
        line('damage', EM_DASH, false); // a secret plan: no number, so no tilde
      } else {
        line('hit', s.forecastHit(fv.hitPct));
        line('damage', s.forecastDamage(fv.min, fv.max));
        for (const item of fv.lines) {
          switch (item.kind) {
            case 'type':
              // Immune prints a word, not a factor: no tilde (R6.6).
              if (item.effectiveness === 'Immune') line('type', s.forecastTypeImmune(), false);
              else line('type', s.forecastType(item.num, item.den));
              break;
            case 'stab':
              line('stab', s.forecastStab());
              break;
            case 'flank':
              line('flank', s.forecastFlank(item.num, item.den));
              break;
            case 'guard':
              line('guard', s.forecastGuard(item.num, item.den));
              break;
            default:
              item satisfies never;
          }
        }
        if (fv.skull !== 'none') {
          lines.push({
            id: 'skull',
            text: '',
            tilde: false,
            skull: {
              kind: fv.skull,
              label: fv.skull === 'full' ? s.forecastLethal() : s.forecastLethalMax(),
            },
          });
        }
        if (fv.firstStand) line('firstStand', s.forecastFirstStand());
        if (fv.status !== null) line('status', s.forecastStatus(s.statusLabel(fv.status)));
      }
    }
    return {
      label: s.forecastLabel(),
      lines,
      projected: this.#projectedOf(
        vm,
        p,
        projectedTarget ? { id: targetId, tile: targetRow.pos } : null,
      ),
    };
  }

  /** The forecast panel of a recruit aim: the rules' odds for the target as it stands on the COST
   *  board (recruit needs adjacency now, C11) with the chosen bait's bonus; the line items are the
   *  rules' four fields as given. */
  #recruitPanel(vm: TacticsBattleVM, p: Planning, targetId: number, bait: number | null): PanelVM {
    const rules = this.#rulesPort();
    const names = this.#deps.names;
    const lines: PanelLine[] = [];
    const line = panelLine(lines, p.mode);
    const targetRow = p.ctx.costBoard.units.find((u) => u.id === targetId);
    let target: { readonly id: number; readonly tile: Cell } | null = null;
    if (targetRow !== undefined) {
      target = { id: targetId, tile: targetRow.pos };
      const t = rules.unit(targetRow);
      const held = vm.baits.find((b) => b.itemId === bait);
      const odds = rules.recruitOdds(t.kit.stats.hp, t.cur_hp, held?.bonus ?? 0);
      line('vs', s.forecastVs(names.unit(targetId)));
      if ('Ok' in odds) {
        line('recruit', s.forecastRecruit(odds.Ok.pct));
        line(
          'recruitLines',
          s.forecastRecruitLines(odds.Ok.base, odds.Ok.bait, odds.Ok.weakened, odds.Ok.pct),
        );
      }
      line('bait', s.forecastBait(held === undefined ? s.menuNoBait() : held.name));
    }
    return { label: s.forecastLabel(), lines, projected: this.#projectedOf(vm, p, target) };
  }

  /** Recompute and repaint from the current vm (after an op). */
  #paint(): void {
    const vm = this.#vm;
    if (vm === null) return;
    this.#commit(this.#compute(vm));
  }

  // --- the DOM ---------------------------------------------------------------------------------

  #commit(frame: Frame): void {
    this.#mode = frame.mode;
    this.#cursor = frame.cursor;
    this.#hint = frame.hint;
    this.#root.classList.toggle('tactics--reduced', frame.reduced);
    renderBoard(this.#boardEl, frame.board, (tile) => this.#pointTo(tile));
    if (frame.ghost !== null) this.#paintGhost(frame.ghost);
    renderInfoBoxes(this.#hudEl, frame.info);
    renderTurnBar(this.#turnbarEl, frame.turnBar);
    this.#turnbarEl.setAttribute('aria-label', s.turnbarLabel());
    this.#bannerEl.hidden = frame.banner === null;
    this.#bannerEl.textContent = frame.banner ?? '';
    this.#paintDock(frame);
  }

  /** The planned Move's ghost: a dashed sprite on the destination cell, inside the grid
   *  (shell-owned DOM: boardRender.ts paints only what the board view-model holds). */
  #paintGhost(ghost: NonNullable<Frame['ghost']>): void {
    const grid = this.#boardEl.querySelector<HTMLElement>('.tactics-grid');
    if (grid === null) return;
    const el = div('tactics-ghost');
    el.setAttribute('data-unit-id', String(ghost.unitId));
    el.setAttribute('aria-label', s.ghostLabel());
    el.style.setProperty('grid-column', String(ghost.tile.x + 1));
    el.style.setProperty('grid-row', String(ghost.tile.y + 1));
    const sprite = div('tactics-sprite');
    if (ghost.slug === null) sprite.classList.add('tactics-sprite--none');
    else sprite.style.backgroundImage = `url("assets/monster-${ghost.slug}.png")`;
    el.appendChild(sprite);
    grid.appendChild(el);
  }

  #paintDock(frame: Frame): void {
    const dock = this.#dockEl;
    dock.setAttribute('aria-label', s.dockLabel());

    const buttons = div('tactics-dock-buttons');
    const button = (className: string, label: string, onClick: () => void): HTMLElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = className;
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };
    const danger = button('tactics-dock-danger', s.dockDanger(), () => this.toggleDanger());
    danger.setAttribute('aria-pressed', this.#dangerOn ? 'true' : 'false');
    buttons.append(
      danger,
      button('tactics-dock-prev', s.dockPrevUnit(), () => this.cycleUnit(-1)),
      button('tactics-dock-next', s.dockNextUnit(), () => this.cycleUnit(1)),
    );

    const children: HTMLElement[] = [buttons];
    let menuEl: HTMLElement | null = null;
    if (frame.menu !== null) {
      menuEl = this.#paintMenu(frame.menu);
      children.push(menuEl);
    }
    children.push(this.#paintStrip(frame.strip));
    if (frame.panel !== null) children.push(this.#paintPanel(frame.panel));
    dock.replaceChildren(...children);

    // Focus: the listbox while a menu is open (A36), the title anchor when it closes. Only on the
    // open / close edges and while open — never otherwise (the turn bar must never recentre).
    if (menuEl !== null) {
      menuEl.focus({ preventScroll: true });
      this.#menuOpen = true;
    } else if (this.#menuOpen) {
      this.#menuOpen = false;
      this.#titleEl.focus({ preventScroll: true });
    }
  }

  /** The plan strip: one chip per step — its label, the rules' AP cost as pips (none for a null or
   *  zero cost), its badge (the word in title and name; the glyph is CSS) and the bait note. */
  #paintStrip(strip: Frame['strip']): HTMLElement {
    const el = div('tactics-strip');
    el.setAttribute('aria-label', s.queueLabel());
    if (strip.locked) el.classList.add('tactics-strip--locked');
    const span = (className: string): HTMLSpanElement => {
      const x = document.createElement('span');
      x.className = className;
      return x;
    };
    for (const chip of strip.chips) {
      const c = span('tactics-chip');
      c.setAttribute('data-action', chip.action);
      const label = span('tactics-chip-label');
      label.textContent = chip.label;
      c.appendChild(label);
      if (chip.cost !== null && chip.cost > 0 && chip.costLabel !== null) {
        const pips = span('tactics-pips');
        pips.setAttribute('role', 'group');
        pips.setAttribute('aria-label', chip.costLabel);
        for (let i = 0; i < chip.cost; i++) pips.appendChild(span('tactics-pip tactics-pip--full'));
        c.appendChild(pips);
      }
      const badge = span(`tactics-badge tactics-badge--${chip.badge}`);
      badge.setAttribute('role', 'img');
      badge.setAttribute('title', chip.badgeWord);
      badge.setAttribute('aria-label', chip.badgeWord);
      c.appendChild(badge);
      if (chip.note !== null) {
        const note = span('tactics-chip-note');
        note.textContent = chip.note;
        c.appendChild(note);
      }
      el.appendChild(c);
    }
    return el;
  }

  /** The forecast panel, wrapped in the Projected frame on a pre-queued aim: each numeric line
   *  leads with its own tilde node, a skull line holds the skull image, a hidden number is a dash. */
  #paintPanel(panel: PanelVM): HTMLElement {
    const el = div('tactics-forecast');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', panel.label);
    for (const line of panel.lines) {
      const row = document.createElement('span');
      row.className = 'tactics-forecast-line';
      row.setAttribute('data-line', line.id);
      if (line.tilde) {
        const tilde = document.createElement('span');
        tilde.className = 'tactics-tilde';
        tilde.setAttribute('aria-hidden', 'true');
        tilde.textContent = TILDE;
        row.appendChild(tilde);
      }
      if (line.skull !== null) {
        const skull = document.createElement('span');
        skull.className = `tactics-skull tactics-skull--${line.skull.kind}`;
        skull.setAttribute('role', 'img');
        skull.setAttribute('aria-label', line.skull.label);
        row.appendChild(skull);
      } else {
        row.appendChild(document.createTextNode(line.text));
      }
      el.appendChild(row);
    }
    if (panel.projected === null) return el;
    const wrap = div('tactics-projected');
    const text = (className: string, value: string): HTMLSpanElement => {
      const x = document.createElement('span');
      x.className = className;
      x.textContent = value;
      return x;
    };
    wrap.appendChild(text('tactics-projected-label', panel.projected.label));
    wrap.appendChild(el);
    if (panel.projected.assumes !== null) {
      wrap.appendChild(text('tactics-projected-assumes', panel.projected.assumes));
    }
    if (panel.projected.enemies !== null) {
      wrap.appendChild(text('tactics-projected-enemies', panel.projected.enemies));
    }
    return wrap;
  }

  #paintMenu(menu: NonNullable<Frame['menu']>): HTMLElement {
    const list = div('tactics-menu');
    list.setAttribute('role', 'listbox');
    list.setAttribute('tabindex', '0');
    list.setAttribute('aria-label', s.menuLabel());
    menu.rows.forEach((row, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tactics-menu-row';
      el.id = `tactics-menu-row-${row.key.replace(/[^A-Za-z0-9]/g, '-')}`;
      el.setAttribute('role', 'option');
      el.setAttribute('data-row', row.key);
      el.setAttribute('aria-selected', i === menu.index ? 'true' : 'false');
      if (row.sub) el.setAttribute('data-sub', 'true');
      if (!row.enabled) el.setAttribute('aria-disabled', 'true');
      const label = document.createElement('span');
      label.className = 'tactics-menu-label';
      label.textContent = row.label;
      el.appendChild(label);
      if (row.reason !== null) {
        const reason = document.createElement('span');
        reason.className = 'tactics-reason';
        reason.textContent = row.reason;
        el.appendChild(reason);
      }
      el.addEventListener('click', () => {
        this.#atomic(() => {
          if (this.#mode.kind !== 'menu') return;
          this.#mode = { ...this.#mode, index: i };
          this.#chooseRow(i);
        });
      });
      if (i === menu.index) list.setAttribute('aria-activedescendant', el.id);
      list.appendChild(el);
    });
    return list;
  }
}
