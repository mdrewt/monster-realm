// net/viewReconcile.ts — the owner-view reconciles the connection's batcher runs once per
// coalesced row burst, before the hydration edge and store.flushBatch().
//
// The owner views declare no primary key, so the SDK never fires onUpdate for them: every row
// change arrives as an unordered insert+delete pair. Each reconcile therefore rebuilds its store
// collection from the view's post-burst client cache, which is ordering-immune and immune to
// multi-transaction coalescing.
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

/** Rebuilds the thirteen owner-view collections of `store` from `db`'s client cache, in the
 *  order and try groups below. Never throws: a converter or reconcile throw is logged and
 *  contained to its group. */
export function reconcileOwnerViews(store: AuthoritativeStore, db: OwnerViewCache): void {
  // 15r-sec-a hardening: the reconciles run UPSTREAM of flushBatch in the batcher's
  // shared closure, so a converter throw (bindings skew, a partially
  // decoded row) would starve EVERY batch listener — including the
  // movement reconcile that drives prediction snap. Catch and continue:
  // a stale battle map is recoverable, a starved flush is not.
  try {
    store.reconcileMonstersFromView(
      [...db.my_monster_pub.iter()].map((row) =>
        monsterPubRowToStore(row as unknown as SdkMonsterPubRow),
      ),
    );
    // same countermeasure for the `my_battle` view —
    // no PK in the view binding even on 2.11.0 codegen, so onUpdate never
    // fires and every turn arrives as an unordered insert+delete pair;
    // rebuild the battle map from the post-burst cache instead.
    store.reconcileBattlesFromView(
      [...db.myBattle.iter()].map((row) => battleRowToStore(row as unknown as SdkBattleRow)),
    );
    // the third Vec-view reconcile. AUTHORITATIVE — a chunkId absent
    // from this argument is deleted, which is how a server-side purge withdraws the client's
    // download offer. It runs BEFORE flushBatch() because main.ts's batch listener is the
    // sole assembleExportBundle() call site, and a reconcile after the flush would leave it
    // assembling the PRE-burst chunk set.
    store.reconcileExportChunksFromView(
      [...db.my_export_bundle.iter()].map((row) =>
        exportChunkRowToStore(row as unknown as SdkExportChunkRow),
      ),
    );
    // The fourth Vec-shaped reconcile, and deliberately the LAST call
    // inside this try — a throw from the newest converter can then never starve the
    // movement-driving monster/battle reconciles above it. AUTHORITATIVE: an absent row
    // CLEARS the slot, which is how the account-deletion cascade and the guest-claim rekey
    // withdraw a reveal instead of stranding it on screen. It runs BEFORE flushBatch()
    // because main.ts's batch listener is the sole banner render site.
    store.reconcileEvolutionNoticesFromView(
      [...db.myPendingEvolutionNotices.iter()].map((row) =>
        pendingEvolutionNoticeRowToStore(row as unknown as SdkPendingEvolutionNoticeRow),
      ),
    );
  } catch (err) {
    console.error('[net] view reconcile threw; flushing anyway', err);
  }
  // `my_inventory` — the owner-scoped Vec view over the private inventory table. PK-less, so
  // no onUpdate ever fires and a count change is an unordered insert+delete pair: rebuild the
  // map from the post-burst cache (AUTHORITATIVE — a consumed-to-zero stack disappears). Its
  // own try: a converter throw in either block cannot starve the other.
  try {
    store.reconcileInventoryFromView(
      [...db.my_inventory.iter()].map((row) =>
        inventoryRowToStore(row as unknown as SdkInventoryRow),
      ),
    );
  } catch (err) {
    console.error('[net] view reconcile threw; flushing anyway', err);
  }
  // bt-12 (BT12.1): the seven tactical views, each rebuilt from the post-burst cache in its OWN
  // try (a throwing converter — bindings skew, a malformed row — is contained to that view; the
  // other six and every reconcile above still land and the flush is still delivered). All seven
  // run BEFORE flushBatch(): main.ts's refreshBattle reads the phase in a batch listener, so a
  // reconcile after the flush would show the deploy panel one batch late. AUTHORITATIVE: a row
  // absent from the cache is deleted (a finished battle's rows go with the GC, a cancelled plan
  // with its row); a converter's null (an unknown payload-enum tag) drops only that row.
  const guarded = (reconcile: () => void): void => {
    try {
      reconcile();
    } catch (err) {
      console.error('[net] view reconcile threw; flushing anyway', err);
    }
  };
  const present = <T>(rows: readonly (T | null)[]): T[] =>
    rows.filter((row): row is T => row !== null);
  guarded(() =>
    store.reconcileTacticalBattlesFromView(
      present(
        [...db.myTacticalBattle.iter()].map((row) =>
          tacticalBattleRowToStore(row as unknown as SdkTacticalBattleRow),
        ),
      ),
    ),
  );
  guarded(() =>
    store.reconcileBattleUnitsFromView(
      [...db.myBattleUnits.iter()].map((row) =>
        battleUnitRowToStore(row as unknown as SdkBattleUnitRow),
      ),
    ),
  );
  guarded(() =>
    store.reconcileBattleQueuesFromView(
      present(
        [...db.myBattleQueue.iter()].map((row) =>
          battleQueueRowToStore(row as unknown as SdkBattleQueueRow),
        ),
      ),
    ),
  );
  guarded(() =>
    store.reconcileBattleDeploysFromView(
      [...db.myBattleDeploy.iter()].map((row) =>
        battleDeployRowToStore(row as unknown as SdkBattleDeployRow),
      ),
    ),
  );
  guarded(() =>
    store.reconcileBattleClocksFromView(
      [...db.myBattleClock.iter()].map((row) =>
        battleClockRowToStore(row as unknown as SdkBattleClockRow),
      ),
    ),
  );
  guarded(() =>
    store.reconcileBattleEventsFromView(
      [...db.myBattleEvents.iter()].map((row) =>
        battleEventRowToStore(row as unknown as SdkBattleEventRow),
      ),
    ),
  );
  guarded(() =>
    store.reconcileFormationFromView(
      [...db.myFormation.iter()].map((row) =>
        formationRowToStore(row as unknown as SdkFormationRow),
      ),
    ),
  );
  // `my_trade_session` — the participant-scoped Vec view over the private trade_session table.
  // PK-less, so every change is an unordered insert+delete pair: rebuild from the cache
  // (AUTHORITATIVE — a session absent from it has closed).
  guarded(() =>
    store.reconcileTradeSessionsFromView(
      [...db.myTradeSession.iter()].map((row) =>
        tradeSessionRowToStore(row as unknown as SdkTradeSessionRow),
      ),
    ),
  );
}
