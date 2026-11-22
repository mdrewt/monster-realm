// shell/screenContext — what a screen adapter reads: the one `screenCtx` every adapter builds its
// view model from, the shop, heal location, tab or trade session each open bound, and the motion
// preference. Every other module reads them through its import, which is live. Only this module
// assigns the `bound*` bindings: an opener binds through `bindShop`, `bindHealLocation`,
// `bindSocialTab`, `bindMonstersTab` or `bindTradeSession`; a reconnect clears the first four
// through `unbindForReconnect`; the trade session unbinds through `unbindTradeSession`. Module
// scope constructs the motion preference, whose media-query change listener is the one listener a
// shell module's scope creates. It registers nothing on `store`, `window` or `document`, writes
// nothing to the document and resolves no catalog string.

import { motionPreferenceFromWindow } from '../render/motionPreference';
import type { MonstersTab } from '../ui/monstersModel';
import type { ScreenContext, SocialTab } from '../ui/screens/types';
import { bindings } from './inputState';
import { identity, store } from './session';

// The one motion preference, constructed once: its change listener lives for the page.
// `.reduceMotion` is a live getter, so each read takes the current value (the frame loop reads it
// every frame), never a snapshot taken at boot.
export const motionPreference = motionPreferenceFromWindow();

// Which shop and which heal location the visible overlay is bound to, so a refresh batch never
// swaps a bound view back to the first-row default. Every open rebinds them; both keep their
// value after the frame closes and clear on reconnect, when the store reset invalidates the ids.
export let boundShopId: number | null = null;
export let boundHealLocationId: number | null = null;
/** The greet-then-shop open binds the shop it is about to show. */
export function bindShop(shopId: number): void {
  boundShopId = shopId;
}
/** An interaction with a healer binds the heal frame to that location. */
export function bindHealLocation(locationId: number): void {
  boundHealLocationId = locationId;
}

// The Social tab the last Social open asked for (null: a plain open). Like the two ids above it
// keeps its value after the frame closes and clears on reconnect.
export let boundSocialTab: SocialTab | null = null;
/** A Social open binds the tab it was asked for before the frame shows. */
export function bindSocialTab(tab: SocialTab | null): void {
  boundSocialTab = tab;
}

// The Monsters tab the last Monsters open bound: Party from the menu and V, Storage from B. Read
// by the screen's `init` at the seated open; clears on reconnect (null opens Storage).
export let boundMonstersTab: MonstersTab | null = null;
/** A Monsters open binds its tab before the frame is seated. */
export function bindMonstersTab(tab: MonstersTab): void {
  boundMonstersTab = tab;
}

// The trade session the editor was last opened on. Every open rebinds it; it keeps its value
// after the frame closes and unbinds when that session closes, on a join and on a reconnect.
export let boundTradeSessionId: bigint | null = null;
/** The trade editor binds the session it is about to open on. */
export function bindTradeSession(sessionId: bigint): void {
  boundTradeSessionId = sessionId;
}
/** The bound session closed, or the connection's trade-session facts are being forgotten. */
export function unbindTradeSession(): void {
  boundTradeSessionId = null;
}

/** A reconnect: the shop, the heal location and the two tabs unbind. The trade session is not
 *  touched here: it unbinds with the rest of its own facts, through `unbindTradeSession`. */
export function unbindForReconnect(): void {
  boundShopId = null;
  boundHealLocationId = null;
  boundSocialTab = null;
  boundMonstersTab = null;
}

/** The read-only context adapters build their view models from. The getters read live state: the
 *  identity, the binding table, what each open bound and the one `motionPreference` (never a
 *  second media-query read). */
export const screenCtx: ScreenContext = {
  store,
  get identity() {
    return identity;
  },
  get bindings() {
    return bindings;
  },
  now: () => performance.now(),
  // The wall clock, for the Monsters sheet's care readiness against the server-epoch anchor
  // (`performance.now()` is ms since navigation and would read every care as cooling).
  wallNowMs: () => Date.now(),
  get shopId() {
    return boundShopId;
  },
  get healLocationId() {
    return boundHealLocationId;
  },
  get socialTab() {
    return boundSocialTab;
  },
  get tradeSessionId() {
    return boundTradeSessionId;
  },
  get monstersTab() {
    return boundMonstersTab;
  },
  get reduceMotion() {
    return motionPreference.reduceMotion;
  },
};
