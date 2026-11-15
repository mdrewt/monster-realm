// net/viewReconcile.ts — the owner-view reconciles the connection's batcher runs once per
// coalesced row burst, before the hydration edge and store.flushBatch(), and the dirty set that
// limits each burst to the views whose rows changed.
//
// The owner views declare no primary key, so the SDK never fires onUpdate for them: every row
// change arrives as an unordered insert+delete pair. Each reconcile therefore rebuilds its store
// collection from the view's post-burst client cache, which is ordering-immune and immune to
// multi-transaction coalescing. A view's row handlers mark it dirty; a view that is not dirty is
// not read, so a burst of `character` or `player` rows reconciles nothing here.
import {
  battleClockRowToStore,
  battleDeployRowToStore,
  battleEventRowToStore,
  battleQueueRowToStore,
  battleRowToStore,
  battleUnitRowToStore,
  exportChunkRowToStore,
  formationRowToStore,
  inventoryRowToStore,
  monsterPubRowToStore,
  pendingEvolutionNoticeRowToStore,
  type SdkBattleClockRow,
  type SdkBattleDeployRow,
  type SdkBattleEventRow,
  type SdkBattleQueueRow,
  type SdkBattleRow,
  type SdkBattleUnitRow,
  type SdkExportChunkRow,
  type SdkFormationRow,
  type SdkInventoryRow,
  type SdkMonsterPubRow,
  type SdkPendingEvolutionNoticeRow,
  type SdkTacticalBattleRow,
  type SdkTradeSessionRow,
  tacticalBattleRowToStore,
  tradeSessionRowToStore,
} from './rowConvert';
import type { AuthoritativeStore } from './store';

/** One SDK view handle: only iteration over its client-cache rows is read. */
interface ViewHandle {
  iter(): Iterable<unknown>;
}

/** The owner views of the connection's `db` that `reconcileOwnerViews` reads. */
export interface OwnerViewCache {
  readonly my_monster_pub: ViewHandle;
  readonly myBattle: ViewHandle;
  readonly my_export_bundle: ViewHandle;
  readonly myPendingEvolutionNotices: ViewHandle;
  readonly my_inventory: ViewHandle;
  readonly myTacticalBattle: ViewHandle;
  readonly myBattleUnits: ViewHandle;
  readonly myBattleQueue: ViewHandle;
  readonly myBattleDeploy: ViewHandle;
  readonly myBattleClock: ViewHandle;
  readonly myBattleEvents: ViewHandle;
  readonly myFormation: ViewHandle;
  readonly myTradeSession: ViewHandle;
}

/** One owner view: its handle name on the connection's `db`. */
export type OwnerView = keyof OwnerViewCache;

/** Rebuilds one view's store collection from its cache rows. AUTHORITATIVE, as every reconcile
 *  here is: a row absent from the cache leaves the store. */
type Reconcile = (store: AuthoritativeStore, db: OwnerViewCache) => void;

/** Drops the rows a converter returned null for (an unknown payload-enum tag): only that row. */
const present = <T>(rows: readonly (T | null)[]): T[] =>
  rows.filter((row): row is T => row !== null);

const RECONCILE: Record<OwnerView, Reconcile> = {
  my_monster_pub: (store, db) =>
    store.reconcileMonstersFromView(
      [...db.my_monster_pub.iter()].map((row) =>
        monsterPubRowToStore(row as unknown as SdkMonsterPubRow),
      ),
    ),
  myBattle: (store, db) =>
    store.reconcileBattlesFromView(
      [...db.myBattle.iter()].map((row) => battleRowToStore(row as unknown as SdkBattleRow)),
    ),
  // AUTHORITATIVE — a chunkId absent from the cache is deleted, which is how a server-side purge
  // withdraws the client's download offer. It runs BEFORE flushBatch() because main.ts's batch
  // listener is the sole assembleExportBundle() call site, and a reconcile after the flush would
  // leave it assembling the PRE-burst chunk set.
  my_export_bundle: (store, db) =>
    store.reconcileExportChunksFromView(
      [...db.my_export_bundle.iter()].map((row) =>
        exportChunkRowToStore(row as unknown as SdkExportChunkRow),
      ),
    ),
  // AUTHORITATIVE: an absent row CLEARS the slot, which is how the account-deletion cascade and
  // the guest-claim rekey withdraw a reveal instead of stranding it on screen. It runs BEFORE
  // flushBatch() because main.ts's batch listener is the sole banner render site.
  myPendingEvolutionNotices: (store, db) =>
    store.reconcileEvolutionNoticesFromView(
      [...db.myPendingEvolutionNotices.iter()].map((row) =>
        pendingEvolutionNoticeRowToStore(row as unknown as SdkPendingEvolutionNoticeRow),
      ),
    ),
  // The owner-scoped view over the private inventory table: a consumed-to-zero stack disappears.
  my_inventory: (store, db) =>
    store.reconcileInventoryFromView(
      [...db.my_inventory.iter()].map((row) =>
        inventoryRowToStore(row as unknown as SdkInventoryRow),
      ),
    ),
  // The seven tactical views run BEFORE flushBatch(): main.ts's refreshBattle reads the phase in a
  // batch listener, so a reconcile after the flush would show the deploy panel one batch late. A
  // finished battle's rows go with the GC, a cancelled plan with its row.
  myTacticalBattle: (store, db) =>
    store.reconcileTacticalBattlesFromView(
      present(
        [...db.myTacticalBattle.iter()].map((row) =>
          tacticalBattleRowToStore(row as unknown as SdkTacticalBattleRow),
        ),
      ),
    ),
  myBattleUnits: (store, db) =>
    store.reconcileBattleUnitsFromView(
      [...db.myBattleUnits.iter()].map((row) =>
        battleUnitRowToStore(row as unknown as SdkBattleUnitRow),
      ),
    ),
  myBattleQueue: (store, db) =>
    store.reconcileBattleQueuesFromView(
      present(
        [...db.myBattleQueue.iter()].map((row) =>
          battleQueueRowToStore(row as unknown as SdkBattleQueueRow),
        ),
      ),
    ),
  myBattleDeploy: (store, db) =>
    store.reconcileBattleDeploysFromView(
      [...db.myBattleDeploy.iter()].map((row) =>
        battleDeployRowToStore(row as unknown as SdkBattleDeployRow),
      ),
    ),
  myBattleClock: (store, db) =>
    store.reconcileBattleClocksFromView(
      [...db.myBattleClock.iter()].map((row) =>
        battleClockRowToStore(row as unknown as SdkBattleClockRow),
      ),
    ),
  myBattleEvents: (store, db) =>
    store.reconcileBattleEventsFromView(
      [...db.myBattleEvents.iter()].map((row) =>
        battleEventRowToStore(row as unknown as SdkBattleEventRow),
      ),
    ),
  myFormation: (store, db) =>
    store.reconcileFormationFromView(
      [...db.myFormation.iter()].map((row) =>
        formationRowToStore(row as unknown as SdkFormationRow),
      ),
    ),
  // The participant-scoped view over the private trade_session table: a session absent from the
  // cache has closed.
  myTradeSession: (store, db) =>
    store.reconcileTradeSessionsFromView(
      [...db.myTradeSession.iter()].map((row) =>
        tradeSessionRowToStore(row as unknown as SdkTradeSessionRow),
      ),
    ),
};

// The try groups, in run order. The reconciles run UPSTREAM of flushBatch in the batcher's shared
// closure, so a throw (bindings skew, a partially decoded row) must never escape: it would starve
// EVERY batch listener, including the movement reconcile that drives prediction snap. A throw is
// logged and ends only its own group. The monster, battle, export and evolution-notice reconciles
// share one try (the evolution notices last, so the newest converter can never starve the
// movement-driving monster and battle reconciles); the inventory has its own; each tactical view
// and the trade session view is alone.
const TRY_GROUPS: readonly (readonly OwnerView[])[] = [
  ['my_monster_pub', 'myBattle', 'my_export_bundle', 'myPendingEvolutionNotices'],
  ['my_inventory'],
  ['myTacticalBattle'],
  ['myBattleUnits'],
  ['myBattleQueue'],
  ['myBattleDeploy'],
  ['myBattleClock'],
  ['myBattleEvents'],
  ['myFormation'],
  ['myTradeSession'],
];

/** Every owner view, in reconcile order. */
export const OWNER_VIEWS: readonly OwnerView[] = TRY_GROUPS.flat();

/** The owner views of one connection: which need a rebuild, and the rebuild itself. */
export interface OwnerViewReconciler {
  /** `view`'s rows changed: the next reconcile rebuilds it. */
  markDirty(view: OwnerView): void;
  /** Every view needs a rebuild: the next reconcile rebuilds them all. */
  markAllDirty(): void;
  /** Rebuilds each dirty view's store collection from `db`, in the order and try groups above,
   *  and clears a view once its reconcile returns. A clean view is not read. Never throws: a throw
   *  is logged, and the view that threw and every later dirty view of its group stay dirty for the
   *  next call. */
  reconcileOwnerViews(store: AuthoritativeStore, db: OwnerViewCache): void;
}

/** A reconciler whose views all start dirty, so its first reconcile rebuilds every view. */
export function createOwnerViewReconciler(): OwnerViewReconciler {
  const dirty = new Set<OwnerView>(OWNER_VIEWS);
  return {
    markDirty(view) {
      dirty.add(view);
    },
    markAllDirty() {
      for (const view of OWNER_VIEWS) dirty.add(view);
    },
    reconcileOwnerViews(store, db) {
      for (const group of TRY_GROUPS) {
        try {
          for (const view of group) {
            if (!dirty.has(view)) continue;
            RECONCILE[view](store, db);
            dirty.delete(view);
          }
        } catch (err) {
          console.error('[net] view reconcile threw; flushing anyway', err);
        }
      }
    },
  };
}
