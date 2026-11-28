// shell/frames — the context stack and what sits on it: the one player open (`openFrame`, which
// pushes the frame first and only then shows its view), the syncs that mirror the server-owned
// overlays into the stack and pop a player frame whose view closed (`syncStack`, and
// `reconcileStack` on each batch), the three mirrored-frame tables, the screen host that paints
// each open frame, the overlay gate (`overlayVerdict`), the movement gate (`movementGate`), the
// outcome edge that A's grace and the results auto-advance read, and the focus each close leaves.
//
// Only this module assigns the stack and its latches. `main.ts` changes them only by calling it:
// the opens and the syncs, and three owner functions, the reconnect sweep (`sweepForReconnect`)
// and the frame loop's results auto-advance (`takeResultsAutoContinue`) and care-readiness tick
// (`pumpCareReadiness`). `shell/battleFrame.ts` reads the stack and clears the outcome edge
// through the battle port, whose clear `main.ts` installs as this module's `clearOutcomeEdge`. Its
// module scope builds the three tables, the open registry and the screen host; it registers
// nothing, writes nothing to the document and resolves no string.

import { CAPS } from '../tactics/presentation';
import { decideBattleOverlay } from '../ui/battleModel';
import { outcomeOnTop, renderableBattle, shouldAutoContinue } from '../ui/battlePolicy';
import {
  baseFor,
  contextStep,
  type Edge,
  type FrameId,
  hiddenPops,
  isMirrored,
  MIRRORED_IDS,
  type MirroredId,
  mirrorServerEdges,
  movementEnabled,
  openEdge,
  reconcile,
  reconnectSweep,
  SOCIAL_FRAME,
  SOCIAL_PANELS,
  type Stack,
  type Command as StackCommand,
  type UpperFrame,
  WORLD_STACK,
} from '../ui/contextStack';
import type { LeaderboardView } from '../ui/leaderboardView';
import { type CanOpenVerdict, canOpen, type OverlayId } from '../ui/overlayRegistry';
import type { PvpView } from '../ui/pvpView';
import { SCREEN_ADAPTERS, ScreenHost } from '../ui/screens/index';
import type { SocialPanelId } from '../ui/screens/types';
import type { TradeView } from '../ui/tradeView';
import {
  activeBattleView,
  battleFrameShown,
  battleSynced,
  dismissedBattleId,
  hideAllBattleViews,
  resultsAwaitDrain,
  resultsPanel,
} from './battleFrame';
import { paintWorldHint, reportPaintError } from './feedback';
import { held, inputRouter } from './inputState';
import { screenCtx } from './screenContext';
import { identity, sessionGateBlocks, store } from './session';
import { dialogueView, leaderboardView, menuView, pvpView, tradeView } from './views';

// The three tables of the overlays the visibility mirror still sees (so-2): the server-owned
// battle and dialogue (`MIRRORED_IDS`), which show themselves on server edges. A player frame's
// probe, hide and view travel with its open instead (`openFrame`'s `FrameOpen`). Three small
// tables, never merged into one registry: each dialogue row is intentionally the byte-identical
// thunk of its own key, because a copy-pasted sibling thunk
// (`battleView: () => dialogueView?.visible ?? false`) type-checks perfectly while reading,
// hiding or lending the wrong overlay; the battle rows (bt-12) go through the ONE set of
// battle-frame helpers `shell/battleFrame.ts` exports, since three views can own that frame.
// Typed total over `MirroredId`, so a dropped row is a COMPILE error.

// the probe table: whether each mirrored overlay is shown.
const overlayProbes: Readonly<Record<MirroredId, () => boolean>> = {
  battleView: () => battleFrameShown(),
  dialogueView: () => dialogueView?.visible ?? false,
};

// the force-hide handle table, the WRITE mirror of `overlayProbes`. `dialogueView` is the SOLE
// `undefined` entry and must stay that way: hiding a live conversation client-side strands the
// server `player_conversation` row. Only the stack's `close` commands reach it, through `hideFrame`.
const overlayHandles: Readonly<Record<MirroredId, (() => void) | undefined>> = {
  battleView: () => hideAllBattleViews(),
  dialogueView: undefined,
};

// the view-lending table: each mirrored overlay's view instance, which the screen host hands to
// that frame's adapter to paint after a step (CTL7C.2). Undefined until main() builds the views.
const screenViews: Readonly<Record<MirroredId, () => unknown>> = {
  battleView: () => activeBattleView(),
  dialogueView: () => dialogueView,
};

/** What a player frame's open registers (so-2): whether its view shows, the view's own hide path,
 *  and the view the screen host lends the frame's adapter. It travels with the open, never as a
 *  table row. */
export interface FrameOpen {
  readonly probe: () => boolean;
  readonly hide: () => void;
  readonly view: () => unknown;
}

/** The registration of every player frame opened this session, by frame id (`openFrame`). */
const frameOpens = new Map<FrameId, FrameOpen>();

/** A view's registration: its own `visible` and `hide()`, read through the ONE binding `view`, so a
 *  call site names its view once. */
export function frameOpenOf(
  view: () => { readonly visible: boolean; hide(): void } | undefined,
): FrameOpen {
  return { probe: () => view()?.visible ?? false, hide: () => view()?.hide(), view };
}

// The screen host (ui/screens/index.ts) keeps each open frame's adapter state and paints every
// step, and every state a batch changed, into the frame's view. A paint that throws is reported
// and never costs the key its result. A player frame is lent the view its open registered (the
// Social frame its three panels as one view).
export const screenHost = new ScreenHost(
  SCREEN_ADAPTERS,
  (id) => (isMirrored(id) ? screenViews[id]() : frameOpens.get(id)?.view()),
  reportPaintError,
);

// the ONE gate binder. Returns the VERDICT, not a boolean: each call site spells
// `.kind === 'allow'` itself, deliberately, so no single `!` can invert every gate at once. Reads the stack on EVERY
// call (`shownOverlays`), never a cache.
//
// The main menu stays open beneath the screen it opens (ctl-5), so it never blocks another
// overlay: it is left out of the visible set for every target but itself.
export function overlayVerdict(id: OverlayId): CanOpenVerdict {
  const visible = shownOverlays();
  return canOpen(id, id === 'menuView' ? visible : visible.filter((v) => v !== 'menuView'));
}

/** The overlays shown right now (so-2: read off the stack): each mirrored one by its probe, and
 *  each player frame on the stack whose view shows, the Social frame as its shown panels. */
export function shownOverlays(): OverlayId[] {
  const shown: OverlayId[] = MIRRORED_IDS.filter((id) => overlayProbes[id]());
  for (const id of upperIds()) {
    if (id === SOCIAL_FRAME) shown.push(...SOCIAL_PANELS.filter(panelShown));
    else if (!isMirrored(id) && frameOpens.get(id)?.probe() === true) shown.push(id);
  }
  return shown;
}

// The context stack (ui/contextStack.ts) owns the player's frames (so-2): every player open
// pushes its frame FIRST and only then shows the view (`openFrame`). `syncStack()` derives the
// base from the store, mirrors the server-owned overlays (the battle and the dialogue, which show
// themselves on server edges) into it, and pops a player frame whose view closed itself, so every
// reader that syncs first sees the battle row and those overlays as they are right now. A push of
// a new frame (and a change of base kind) clears the held directions (B14). Synced at the top and
// tail of every keydown, before every keyup, at the top of every frame, after every player open
// and at the tail of every batch; a movementGate() read never syncs, and `__game().stack` only
// reads it. Server truth is reconciled into it on every batch (`reconcileStack`), which closes
// what a battle or a conversation drops. The sync also keeps two
// things that follow the stack: when a terminal outcome first topped it (A's grace), and the
// battle refusal line, cleared once the base is the world again.
export let contextStack: Stack = WORLD_STACK;
function runStackCommands(commands: readonly StackCommand[]): void {
  for (const command of commands) {
    switch (command.kind) {
      case 'clearHeld':
        held.clear();
        // The menu-side twin: a push or a change of base kind also ends any auto-repeat, so a key
        // held into a battle never repeats into a frame the battle keeps (a suspended dialogue).
        inputRouter.resetRepeat();
        break;
      case 'close':
        hideFrame(command.id);
        break;
      default:
        command satisfies never;
    }
  }
}
/** When the terminal outcome frame now on top was first mirrored (performance.now), else null:
 *  A continues it only after `OUTCOME_CONTINUE_GRACE_MS` (CTL6C.2). */
export let outcomeShownAtMs: number | null = null;
/** The shown edge (`outcomeShownAtMs`) the results auto-advance already popped for, so the pop runs
 *  once per edge (bt-12, BT12.4); null whenever the outcome is not on top, with the edge. */
let autoContinuedAtMs: number | null = null;
export function syncStack(): void {
  const prevBase = contextStack[0];
  const ongoing = store.ongoingBattle(identity);
  const base = baseFor(
    ongoing === undefined
      ? undefined
      : { battleId: ongoing.battleId.toString(), outcome: ongoing.outcome },
  );
  const apply = (edge: Edge): void => {
    const next = contextStep(contextStack, edge);
    contextStack = next.stack;
    runStackCommands(next.commands);
  };
  apply({ kind: 'base', base });
  const mirrored = MIRRORED_IDS.filter((id) => overlayProbes[id]());
  for (const edge of mirrorServerEdges(contextStack, mirrored, prevBase)) {
    apply(edge);
    // A reopened frame's adapter starts over (from what it remembers, when it opted in).
    if (edge.kind === 'push') screenHost.opened(edge.frame);
    inputRouter.resetRepeat(); // a held key never repeats into a pushed or popped frame
  }
  // A player view that closed itself (its own close button or Escape, a lifecycle hide) takes its
  // frame with it. Only pops: a player frame is pushed by its open alone.
  for (const edge of hiddenPops(contextStack, shownPlayerFrames())) {
    apply(edge);
    inputRouter.resetRepeat();
  }
  const outcomeUp = outcomeOnTop(contextStack);
  // ts-6b-7.3: while the results wait for the shell's playback the outcome is not yet shown — A's
  // grace and the auto-advance start when the results panel does (the frame pump).
  if (!outcomeUp || resultsAwaitDrain !== null) {
    outcomeShownAtMs = null;
    autoContinuedAtMs = null;
  } else outcomeShownAtMs ??= performance.now();
  menuView?.setCovered(menuPlace() === 'covered');
  // The world hint follows the top frame (WF1-A9): the menu's strip while it is on top.
  paintWorldHint();
  judgeCloseFocus();
}

/** The frame ids of the stack's upper frames, bottom first (the base excluded). */
export function upperIds(): FrameId[] {
  const [, ...upper] = contextStack;
  return upper.map((f) => (f.kind === 'textEntry' ? f.owner : f.id));
}

/** The player frames on the stack whose view shows, by the probe their open registered. */
function shownPlayerFrames(): FrameId[] {
  return upperIds().filter((id) => !isMirrored(id) && frameOpens.get(id)?.probe() === true);
}

/** Whether a Social panel shows. */
export function panelShown(panel: SocialPanelId): boolean {
  return socialPanelView(panel)?.visible ?? false;
}

/** Hide what a frame shows through the view's own hide path, so its close callbacks run (CTL3.3);
 *  never a hidden one. A mirrored frame's handle is its table row; a player frame's is the one its
 *  open registered (the Social frame's hides whichever of its panels shows). */
export function hideFrame(id: FrameId): void {
  if (isMirrored(id)) {
    if (overlayProbes[id]()) overlayHandles[id]?.();
    return;
  }
  const open = frameOpens.get(id);
  if (open?.probe() === true) open.hide();
}

/** The overlay the announcer names as on top: the top frame's (the Social frame's is its shown
 *  panel), else the first shown mirrored overlay, else null. */
export function topOverlay(): OverlayId | null {
  const top = upperIds().at(-1);
  if (top === undefined) return MIRRORED_IDS.find((id) => overlayProbes[id]()) ?? null;
  return top === SOCIAL_FRAME ? (SOCIAL_PANELS.find(panelShown) ?? null) : top;
}

/** Where the main menu sits on the context stack: the top frame, under another, or absent. */
export function menuPlace(): 'top' | 'covered' | 'absent' {
  const ids = upperIds();
  if (!ids.includes('menuView')) return 'absent';
  return ids.at(-1) === 'menuView' ? 'top' : 'covered';
}

/** The batch-time reconcile (CTL3.1): mirror first, so an overlay shown since the last sync is
 *  on the stack, then pop what the battle and the conversation drop and close those overlays. */
export function reconcileStack(): void {
  syncStack();
  // The terminal outcome this batch will show: refreshBattle's own decision, read without
  // committing it, so what the outcome drops closes BEFORE the outcome shows (and takes focus).
  // bt-17: an anchor without its tactical row is not a battle the client can show (the 1v1 view is
  // gone) — `renderableBattle` is the predicate `refreshBattle` shares, so such a terminal anchor
  // never counts as a shown outcome here while that function dismisses it in the same batch.
  const latest = store.latestPlayerBattle(identity);
  const outcome =
    identity !== '' &&
    latest !== undefined &&
    latest.outcome !== 'Ongoing' &&
    renderableBattle(latest, store.tacticalBattle(latest.battleId))
      ? decideBattleOverlay(latest, { dismissedBattleId, synced: battleSynced }).action.kind
      : 'hide';
  const next = reconcile(contextStack, {
    ongoingBattleId: store.ongoingBattle(identity)?.battleId.toString(),
    outcomeShown: outcome === 'show',
    conversation: store.ownConversation(identity) !== undefined,
  });
  // A drop here raises no mirror edge: a held key must not repeat into the frame it uncovers.
  if (next.stack.length !== contextStack.length) inputRouter.resetRepeat();
  contextStack = next.stack;
  runStackCommands(next.commands);
}

/** The ONE movement gate (CTL2.3): false under any frame, on a battle base (even with the
 *  battle overlay hidden — B17), while the session terminal owns the screen and while the world
 *  picker or action sheet (ctl-10a) or a request sheet (ctl-13) is open. */
function movementGate(): boolean {
  return worldBaseLive() && !screenHost.sheetOpen;
}

/** The world base takes input: the movement gate before the world sheet (ctl-10a) is counted.
 *  Anything else (a frame, a battle base, the session terminal) closes that sheet. It reads the
 *  stack as it stands (so-2): a gate read pushes, pops, shows and hides no frame. */
function worldBaseLive(): boolean {
  const live = movementEnabled(contextStack, sessionGateBlocks());
  if (!live) screenHost.closeSheet();
  return live;
}

// The two gates, exported by name: each declaration keeps its column-0 `function` header, which
// main.dispatch.test.ts reads with the body below it.
export { movementGate, worldBaseLive };

/** A Social panel's view (undefined until main() builds it). */
export function socialPanelView(
  panel: SocialPanelId,
): TradeView | PvpView | LeaderboardView | undefined {
  switch (panel) {
    case 'tradeView':
      return tradeView;
    case 'pvpView':
      return pvpView;
    case 'leaderboardView':
      return leaderboardView;
  }
}

/** The ONE player open (so-2): the frame is pushed FIRST (over a battle, stamped with it; a frame
 *  already on the stack is not pushed again, `contextStep`'s dedup), and only then does `show` show
 *  its view, so no player view is shown off the stack. `open` registers the frame's probe, hide and
 *  view. The base it stamps from is the one the caller's last sync left (every keydown, pointer
 *  press and batch syncs first). The closing sync, which runs even when `show` throws, takes off a
 *  frame whose show did not take (and what the show hid).
 *  Returns the frame when it is the top frame, else undefined. */
export function openFrame(id: FrameId, open: FrameOpen, show: () => void): UpperFrame | undefined {
  frameOpens.set(id, open);
  const next = contextStep(contextStack, openEdge(contextStack, id));
  if (next.stack !== contextStack) {
    contextStack = next.stack;
    runStackCommands(next.commands);
    // A reopened frame's adapter starts over (from what it remembers, when it opted in).
    screenHost.opened(contextStack[contextStack.length - 1] as UpperFrame);
    inputRouter.resetRepeat(); // a held key never repeats into a pushed frame
  }
  try {
    show();
  } finally {
    syncStack();
  }
  const top = contextStack[contextStack.length - 1];
  return top.kind === 'screen' && top.id === id ? top : undefined;
}

/** Open the screen `id` and seat its adapter, so its first paint is at the open. */
export function openSeated(id: FrameId, open: FrameOpen, show: () => void): void {
  const frame = openFrame(id, open, show);
  if (frame !== undefined) screenHost.seat(frame, screenCtx);
}

/** The Social frame when it is the stack's top frame, else undefined. */
export function topSocialFrame(): UpperFrame | undefined {
  const top = contextStack[contextStack.length - 1];
  return top.kind === 'screen' && top.id === SOCIAL_FRAME ? top : undefined;
}

/** Nothing is over the world: no frame and no world sheet. The editor of a face-to-face open the
 *  player is waiting on opens only then, so it never covers what they opened meanwhile. */
export const worldIsBare = (): boolean =>
  contextStack[contextStack.length - 1].kind === 'world' && !screenHost.sheetOpen;

// the stale-focus discriminator.
// After a close, real Chromium leaves document.activeElement on a node INSIDE the hidden
// overlay for up to ~200 ms (its blur fixup is async, and closeOverlayA11y's explicit
// restore to <body> is a no-op there because <body> carries no tabindex) — so the close
// edge reads a stale anchor and focus never returns to the world.
// Inline `style.display = 'none'` is this repo's ONE hiding idiom — every overlay in both
// shell families hides that way — so the ancestor walk is the exact discriminator, and it
// is engine-independent. `checkVisibility()` was rejected: this happy-dom version does not
// implement it, which would make the unit-tier proof vacuous. The walk cannot match the
// always-on hint-bar chips (they and every ancestor are display-visible), so the D4
// no-steal guarantee survives — pinned by S5T-FOCUS-NO-STEAL.
export function inHiddenSubtree(start: Element | null): boolean {
  for (let el = start; el instanceof HTMLElement; el = el.parentElement) {
    if (el.style.display === 'none') return true;
  }
  return false;
}
export const focusInsideHiddenSubtree = (): boolean => inHiddenSubtree(document.activeElement);
/** Focus nowhere a player can use it: on <body> (or nothing), or stranded in a hidden subtree. */
export const focusAdrift = (): boolean => {
  const a = document.activeElement;
  return a === null || a === document.body || focusInsideHiddenSubtree();
};

// A close is judged by the first sync that sees it (the closing task on every keydown, dispatch and
// batch path), not by the frame edge a rAF later, where a move made since (the chip blurred, rb-19)
// would read as a close that left focus adrift. Not while the session terminal holds the screen: the
// terminal's own focus is not the close's, so the first sync after it lifts judges.
let syncedTop: OverlayId | null = null;
export let closeLeftFocusAdrift = false;
function judgeCloseFocus(): void {
  if (sessionGateBlocks()) return;
  const top = topOverlay();
  if (syncedTop !== null && top === null) closeLeftFocusAdrift = focusAdrift();
  syncedTop = top;
}

/** Null the outcome edge, so A's grace and the results auto-advance start again at the first sync
 *  that sees the outcome on top with no results waiting for the playback. The battle port's
 *  `clearOutcomeEdge`: the results wait for the tactical shell's playback. */
export function clearOutcomeEdge(): void {
  outcomeShownAtMs = null;
  autoContinuedAtMs = null;
}

/** The frame loop's results auto-advance at `now`: true once per shown edge, when the outcome frame
 *  has been on top for the results cap and the results panel is what it shows. The edge is marked
 *  taken before it returns; `main()` then pops the outcome. */
export function takeResultsAutoContinue(now: number): boolean {
  if (
    shouldAutoContinue(outcomeShownAtMs, now, resultsPanel?.visible === true, CAPS.resultsMs) &&
    autoContinuedAtMs !== outcomeShownAtMs
  ) {
    autoContinuedAtMs = outcomeShownAtMs;
    return true;
  }
  return false;
}

/** The reconnect sweep: sync, then pop every frame `reconnectSweep` names and close it through its
 *  view's own hide path. */
export function sweepForReconnect(): void {
  syncStack();
  const swept = reconnectSweep(contextStack);
  // A drop here raises no mirror edge: a held key must not repeat into the frame it uncovers.
  if (swept.stack.length !== contextStack.length) inputRouter.resetRepeat();
  contextStack = swept.stack;
  runStackCommands(swept.commands);
}

// qf-3: the Monsters sheet's Care readiness follows the WALL clock, which no batch or button moves,
// so while the box frame is open the frame loop re-observes the stack about once a second (the
// host's same-object contract keeps a still readiness paint-free; a cooldown that just elapsed
// repaints the row enabled with nobody pressing anything). The per-batch observe in `main.ts`'s
// last batch listener stays the main path; this tick only closes the idle gap.
const CARE_READINESS_TICK_MS = 1000;
let lastCareTickAtMs = 0;

/** The frame loop's care-readiness tick at `now`: while the box frame is on the stack, the open
 *  frames' adapters observe it again once `CARE_READINESS_TICK_MS` has passed since the last
 *  tick. */
export function pumpCareReadiness(now: number): void {
  if (now - lastCareTickAtMs >= CARE_READINESS_TICK_MS && upperIds().includes('boxView')) {
    lastCareTickAtMs = now;
    screenHost.observe(contextStack, screenCtx);
  }
}
