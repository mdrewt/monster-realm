// shell/views — the handles of the view instances built at boot. `main()` constructs each view
// with its handler closures and mounts the instance here; every other module reads a handle
// through its import, which is live. A handle is `undefined` until its view is mounted, and stays
// `undefined` when the element its view is built under is missing from the page. Module scope
// only declares the handles: every import is a type, so no view module loads from here.

import type { BoxView } from '../ui/boxView';
import type { ClaimView } from '../ui/claimView';
import type { ControlsView } from '../ui/controlsView';
import type { DialogueView } from '../ui/dialogueView';
import type { ErrorOverlayView } from '../ui/errorOverlayView';
import type { EvolutionNoticeBanner } from '../ui/evolutionNotice';
import type { EvolutionView } from '../ui/evolutionView';
import type { HealView } from '../ui/healView';
import type { HelpView } from '../ui/helpView';
import type { HintBarView } from '../ui/hintBar';
import type { LeaderboardView } from '../ui/leaderboardView';
import type { MenuView } from '../ui/menuView';
import type { PrivacyView } from '../ui/privacyView';
import type { ProfileView } from '../ui/profileView';
import type { PvpView } from '../ui/pvpView';
import type { QuestLogView } from '../ui/questLogView';
import type { RaisingView } from '../ui/raisingView';
import type { RenameView } from '../ui/renameView';
import type { SessionView } from '../ui/sessionView';
import type { ShopView } from '../ui/shopView';
import type { TradeSessionView } from '../ui/tradeSessionView';
import type { TradeView } from '../ui/tradeView';

/** Every boot-built handle, and the type of what is mounted in it. */
export interface ViewHandles {
  boxView: BoxView;
  raisingView: RaisingView;
  evolutionView: EvolutionView;
  dialogueView: DialogueView;
  questLogView: QuestLogView;
  healView: HealView;
  shopView: ShopView;
  tradeView: TradeView;
  pvpView: PvpView;
  leaderboardView: LeaderboardView;
  profileView: ProfileView;
  renameView: RenameView;
  tradeSessionView: TradeSessionView;
  helpView: HelpView;
  menuView: MenuView;
  claimView: ClaimView;
  privacyView: PrivacyView;
  controlsView: ControlsView;
  controlsSavedLine: (text: string, saved: boolean) => string;
  sessionView: SessionView;
  evolutionNoticeBanner: EvolutionNoticeBanner;
  errorOverlayView: ErrorOverlayView;
  hintBarView: HintBarView;
}

export let boxView: ViewHandles['boxView'] | undefined;
export let raisingView: ViewHandles['raisingView'] | undefined;
export let evolutionView: ViewHandles['evolutionView'] | undefined;
export let dialogueView: ViewHandles['dialogueView'] | undefined;
export let questLogView: ViewHandles['questLogView'] | undefined;
export let healView: ViewHandles['healView'] | undefined;
export let shopView: ViewHandles['shopView'] | undefined;
export let tradeView: ViewHandles['tradeView'] | undefined;
export let pvpView: ViewHandles['pvpView'] | undefined;
// The ranked leaderboard: a pure subscription view.
export let leaderboardView: ViewHandles['leaderboardView'] | undefined;
// The Profile screen: one frame whose sections are the rename form, the guest-claim prompt and
// the privacy surface. It is the registered overlay (GUARD_ONLY); the three section views are
// shown only through it.
export let profileView: ViewHandles['profileView'] | undefined;
// Profile's Name section: the rename form.
export let renameView: ViewHandles['renameView'] | undefined;
// The trade session editor: opened by Trade on a faced player, a Social › Trades row and the
// request sheet's Accept. It paints what its screen hands it.
export let tradeSessionView: ViewHandles['tradeSessionView'] | undefined;
// How to Play (Select): catalog copy, no reducer.
export let helpView: ViewHandles['helpView'] | undefined;
// The main menu: a nav-list screen that stays open beneath the overlay it opens.
export let menuView: ViewHandles['menuView'] | undefined;
// Profile's Account and Privacy sections.
export let claimView: ViewHandles['claimView'] | undefined;
export let privacyView: ViewHandles['privacyView'] | undefined;
// Controls, the remapping screen. Its `capturing` is what the keydown handler reads to hand a
// key to the capture instead of the router.
export let controlsView: ViewHandles['controlsView'] | undefined;
/** The controlsView module's `savedLine`, mounted with the view. */
export let controlsSavedLine: ViewHandles['controlsSavedLine'] | undefined;
// The session-lifecycle overlay: outside the overlay registry, driven by the connection's
// session state.
export let sessionView: ViewHandles['sessionView'] | undefined;
// The post-evolve reveal banner: not a registry overlay.
export let evolutionNoticeBanner: ViewHandles['evolutionNoticeBanner'] | undefined;
// The F9 error overlay.
export let errorOverlayView: ViewHandles['errorOverlayView'] | undefined;
export let hintBarView: ViewHandles['hintBarView'] | undefined;

/** Mount each handle present in `handles`. A handle the argument omits keeps its value, and
 *  nothing unmounts one. `main()` calls this right after it constructs each view. */
export function mountViews(handles: Partial<ViewHandles>): void {
  if (handles.boxView !== undefined) boxView = handles.boxView;
  if (handles.raisingView !== undefined) raisingView = handles.raisingView;
  if (handles.evolutionView !== undefined) evolutionView = handles.evolutionView;
  if (handles.dialogueView !== undefined) dialogueView = handles.dialogueView;
  if (handles.questLogView !== undefined) questLogView = handles.questLogView;
  if (handles.healView !== undefined) healView = handles.healView;
  if (handles.shopView !== undefined) shopView = handles.shopView;
  if (handles.tradeView !== undefined) tradeView = handles.tradeView;
  if (handles.pvpView !== undefined) pvpView = handles.pvpView;
  if (handles.leaderboardView !== undefined) leaderboardView = handles.leaderboardView;
  if (handles.profileView !== undefined) profileView = handles.profileView;
  if (handles.renameView !== undefined) renameView = handles.renameView;
  if (handles.tradeSessionView !== undefined) tradeSessionView = handles.tradeSessionView;
  if (handles.helpView !== undefined) helpView = handles.helpView;
  if (handles.menuView !== undefined) menuView = handles.menuView;
  if (handles.claimView !== undefined) claimView = handles.claimView;
  if (handles.privacyView !== undefined) privacyView = handles.privacyView;
  if (handles.controlsView !== undefined) controlsView = handles.controlsView;
  if (handles.controlsSavedLine !== undefined) controlsSavedLine = handles.controlsSavedLine;
  if (handles.sessionView !== undefined) sessionView = handles.sessionView;
  if (handles.evolutionNoticeBanner !== undefined) {
    evolutionNoticeBanner = handles.evolutionNoticeBanner;
  }
  if (handles.errorOverlayView !== undefined) errorOverlayView = handles.errorOverlayView;
  if (handles.hintBarView !== undefined) hintBarView = handles.hintBarView;
}
