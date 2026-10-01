// The dialogue-dismiss / deferred shop-open step (ctl-3, CTL3.5/CTL3.6). Pure — no DOM, SDK,
// module state or clock. main.ts feeds it the events and performs the one effect it returns.
//
// "Greet then shop": the NPC's Shop button ends the conversation (dismissDialogue) and records
// the shop to open; the open itself waits for the first batch with no conversation, so the
// shop never opens over the dialogue it replaces.

/** Which send a rejection or a no-send belongs to: rollback is per path. */
export type DismissPath = 'escape' | 'shop';

export interface ShopOpenState {
  /** A dismissDialogue reducer call is in flight: never send a second one. */
  readonly dismissPending: boolean;
  /** The shop the player picked, opened on the first no-conversation batch. */
  readonly pendingShopId: number | null;
}

export const SHOP_OPEN_INITIAL: ShopOpenState = { dismissPending: false, pendingShopId: null };

export type ShopOpenEvent =
  /** Escape in the dialogue: end the conversation and cancel a pending shop open. */
  | { readonly kind: 'dismissRequested' }
  /** The Shop button: end the conversation, then open this shop (the last pick wins). */
  | { readonly kind: 'shopPicked'; readonly shopId: number }
  | { readonly kind: 'dismissRejected'; readonly path: DismissPath }
  /** The send produced no reducer call (a frozen link, or no live connection) (B8). */
  | { readonly kind: 'dismissNotSent'; readonly path: DismissPath }
  | { readonly kind: 'batch'; readonly conversationPresent: boolean }
  | { readonly kind: 'reconnect' };

export type ShopOpenEffect =
  | { readonly kind: 'sendDismiss'; readonly path: DismissPath }
  | { readonly kind: 'openShop'; readonly shopId: number };

export interface ShopOpenResult {
  readonly state: ShopOpenState;
  readonly effect?: ShopOpenEffect;
}

/** Send a dismiss unless one is already in flight. */
function requestDismiss(state: ShopOpenState, path: DismissPath): ShopOpenResult {
  if (state.dismissPending) return { state };
  return { state: { ...state, dismissPending: true }, effect: { kind: 'sendDismiss', path } };
}

export function shopOpenStep(state: ShopOpenState, event: ShopOpenEvent): ShopOpenResult {
  switch (event.kind) {
    case 'dismissRequested':
      return requestDismiss({ ...state, pendingShopId: null }, 'escape');
    case 'shopPicked':
      return requestDismiss({ ...state, pendingShopId: event.shopId }, 'shop');
    case 'dismissRejected':
      // A rejected Shop click drops its own intent; a rejected Escape leaves a Shop click
      // made while it was in flight standing.
      return {
        state: {
          dismissPending: false,
          pendingShopId: event.path === 'shop' ? null : state.pendingShopId,
        },
      };
    case 'dismissNotSent':
      return { state: { ...state, dismissPending: false } };
    case 'batch':
      if (event.conversationPresent) return { state };
      if (state.pendingShopId === null) return { state: { ...state, dismissPending: false } };
      return {
        state: SHOP_OPEN_INITIAL,
        effect: { kind: 'openShop', shopId: state.pendingShopId },
      };
    case 'reconnect':
      return { state: SHOP_OPEN_INITIAL };
  }
}
