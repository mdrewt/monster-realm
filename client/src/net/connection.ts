// net/connection.ts — the live SpacetimeDB adapter (M4a; app-level reconnect M13.5b).
// Imperative shell only: connect, per-zone subscribe (ADR-0007), mirror authoritative
// rows into the AuthoritativeStore (converting at the boundary, coalescing a
// transaction's row burst via MicrotaskBatcher -> ONE flushBatch, ADR-0013), and
// surface lifecycle. It owns NO game state and never writes anything but the store
// (one-way flow, ADR-0014). Behavior is validated by the M5 two-window e2e; here it
// wires the tested cores (store / batch / rowConvert / reconnectPolicy / statusModel).
// Reducer-rejection routing lands HERE (joinGame + subscription errors) and in
// main.ts (movement + non-movement sends) per ADR-0085 — SDK 2.6 has no per-reducer
// callbacks; the reducer-promise rejection surface is the mechanism.
import { DbConnection } from '../module_bindings';
import {
  initialReconnectState,
  linkFrozen,
  onAttemptFailed,
  onConnected,
  onDisconnected,
  onReconnectAttempt,
  type ReconnectState,
  reconnectDelayMs,
} from '../prediction/reconnectPolicy';
// statusModel is a pure MODEL (no DOM, no SDK) — importing it here creates no
// net→view dependency (see the layering note in statusModel.ts).
import { subscriptionErrorMessage } from '../ui/statusModel';
import { MicrotaskBatcher } from './batch';
import {
  battleRowToStore,
  characterRowToStore,
  fusionRowToStore,
  healLocationRowToStore,
  inventoryRowToStore,
  itemRowToStore,
  monsterPubRowToStore,
  npcRowToStore,
  playerConversationRowToStore,
  playerQuestRowToStore,
  playerRowToStore,
  type SdkBattleRow,
  type SdkCharacterRow,
  type SdkFusionRow,
  type SdkInventoryRow,
  type SdkItemRowRow,
  type SdkMonsterPubRow,
  type SdkPlayerRow,
  type SdkShopItemRowRow,
  type SdkShopRowRow,
  type SdkSkillRowRow,
  type SdkSpeciesRowRow,
  shopItemRowToStore,
  shopRowToStore,
  shouldRemoveOnViewDelete,
  skillRowToStore,
  speciesRowToStore,
} from './rowConvert';
import type { AuthoritativeStore } from './store';

export interface ConnectionOptions {
  readonly uri: string;
  readonly db: string;
  readonly name: string;
  readonly store: AuthoritativeStore;
  /** Initial subscription applied — the caller starts the loop (gated on wasm + own row). */
  readonly onReady: (identity: string) => void;
  /** Re-established after a drop: the caller resets the predictor + the loop re-seeds. */
  readonly onReconnect: () => void;
  /** A non-movement failure to surface (status line). Movement-reducer rejections stay silent (M2 §3). */
  readonly onError: (where: string, message: string) => void;
  /** Called when the own entity crosses a zone boundary (M11c, ADR-0067 Option C).
   *  Receives the new zone id so the caller can reload the map and reset prediction. */
  readonly onOwnWarp?: (newZoneId: number) => void;
}

export interface Connection {
  /** The CURRENT live DbConnection (getter-backed — see the return literal below). */
  readonly conn: DbConnection;
  identity(): string;
  /** Whether input/sends must be gated off (ADR-0085 D3): true while disconnected
   *  or reconnecting. Event-driven, never promise-driven — in-flight reducer
   *  promises never settle after a drop. */
  linkFrozen(): boolean;
}

export function connect(opts: ConnectionOptions): Connection {
  const { store, name } = opts;
  // Reconcile once per transaction: each row callback schedules; the batcher fires
  // store.flushBatch() once on the next microtask (no per-transaction SDK hook in 2.6).
  // ONE batcher for ALL rebuilds (ADR-0085 C2): a per-build batcher could fire a
  // stale flush after store.reset() wiped the rows it was coalescing. wireTables
  // re-registers row handlers per build, but every handler schedules through THIS
  // single instance, so a scheduled flush always reflects the current store.
  const batcher = new MicrotaskBatcher(() => store.flushBatch());
  let identity = '';
  let hadSession = false; // distinguishes the first connect from a reconnect (survives rebuilds)
  // App-level reconnect policy (ADR-0085 D3): pure transitions live in
  // reconnectPolicy.ts; this shell owns the timers and the current state.
  let state: ReconnectState = initialReconnectState();
  // ONE timer handle = the double-schedule guard (ADR-0085 A7): onDisconnect and
  // onConnectError both route through scheduleRebuild(); while a rebuild is already
  // pending, a second schedule attempt is a no-op.
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  // Teardown guard (ADR-0085 A5): once the page is going away, never rebuild.
  let teardown = false;
  // Build generation (ADR-0085 review RT-02/RT-04/RT-07): each build() bumps this;
  // lifecycle callbacks from a SUPERSEDED build (a late onDisconnect the browser
  // buffered across a bfcache freeze, a slow onConnectError racing a successful
  // retry) compare their captured generation and no-op — a stale socket's events
  // must never reset the store, dirty the status line, or clobber identity/state
  // owned by the current build.
  let buildGen = 0;

  /** Schedule ONE rebuild after the current backoff delay (ADR-0085 D3/A7). */
  function scheduleRebuild(): void {
    if (teardown || rebuildTimer !== undefined) return;
    const delay = reconnectDelayMs(state.attempt);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      state = onReconnectAttempt(state);
      // RT-01: build() can throw synchronously (malformed URI, SDK version check).
      // An uncaught throw here would strand state at 'reconnecting' with no timer
      // and no further attempts — a permanent silent freeze. Treat it exactly like
      // a failed connect attempt: surface, climb the ladder, reschedule.
      try {
        current = build();
      } catch (err) {
        opts.onError('connect', err instanceof Error ? err.message : 'rebuild failed');
        state = onAttemptFailed(state);
        scheduleRebuild();
      }
    }, delay);
  }

  /**
   * Shared drop path (ADR-0085 D3): wipe stale rows, freeze the link, surface the
   * loss ONCE (only on the genuine connected→disconnected edge — onDisconnected is
   * idempotent, so the SDK's onerror-then-onclose double event cannot
   * double-transition, A7/A8), and schedule the rebuild.
   */
  function handleDrop(): void {
    store.reset();
    const wasConnected = state.link === 'connected';
    state = onDisconnected(state);
    if (wasConnected) opts.onError('link', 'connection lost — reconnecting…');
    scheduleRebuild();
  }

  // SINGLETON CONSTRAINT (review H1): connect() registers these window listeners
  // unbalanced (no removeEventListener) and they close over THIS call's state.
  // connect() is called exactly once per page lifetime (main()); a second call
  // would double-fire handleDrop and cross the teardown guards — do not add one
  // without extracting removable named handlers first.
  //
  // pagehide teardown (ADR-0085 A5): clear any pending reconnect timer and suppress
  // future scheduling — a dying page must not spawn a fresh WebSocket.
  window.addEventListener('pagehide', () => {
    teardown = true;
    if (rebuildTimer !== undefined) {
      clearTimeout(rebuildTimer);
      rebuildTimer = undefined;
    }
  });

  // pageshow inverse (ADR-0085 A5, RT-PH-01): a bfcache restore resumes JS with the
  // pre-pagehide state — teardown=true, no timer, and a socket the browser killed
  // while the page was frozen (the SDK's onclose may have fired into the frozen page
  // and been lost). Without this, the client is permanently frozen after Back
  // navigation. persisted=false (a fresh load) never gets here: connect() below is
  // that path. handleDrop() is safe if the drop was already processed (idempotent).
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    teardown = false;
    handleDrop();
  });

  /**
   * Register ALL table row handlers on a (re)built connection. Runs once per build:
   * a rebuilt DbConnection starts with ZERO handlers, so forgetting a table here
   * means the new connection silently ingests nothing for it (ADR-0085 — re-wire
   * everything or the reconnect looks connected but stays empty).
   */
  function wireTables(conn: DbConnection): void {
    const ingestChar = (row: SdkCharacterRow): void => {
      store.upsertCharacter(characterRowToStore(row), performance.now());
      batcher.schedule();
    };
    conn.db.character.onInsert((_ctx, row) => ingestChar(row as unknown as SdkCharacterRow));
    conn.db.character.onUpdate((_ctx, oldRow, row) => {
      const newSdkRow = row as unknown as SdkCharacterRow;
      // M11c (ADR-0067 Option C): detect own-entity zone transition via raw SDK scalars
      // (M12.5d-5: avoids characterRowToStore() double-conversion just to compare zoneId).
      // SdkCharacterRow.zoneId is a plain number (u32); entityId is bigint (u64) — both
      // strict comparisons are type-correct and require no conversion.
      if (opts.onOwnWarp !== undefined) {
        const oldSdkRow = oldRow as unknown as SdkCharacterRow;
        const ownEntityId = store.ownEntityId(identity);
        if (
          ownEntityId !== undefined &&
          newSdkRow.entityId === ownEntityId &&
          newSdkRow.zoneId !== oldSdkRow.zoneId
        ) {
          opts.onOwnWarp(newSdkRow.zoneId);
        }
      }
      ingestChar(newSdkRow);
    });
    conn.db.character.onDelete((_ctx, row) => {
      store.removeCharacter((row as unknown as SdkCharacterRow).entityId);
      batcher.schedule();
    });

    const ingestPlayer = (row: SdkPlayerRow): void => {
      store.upsertPlayer(playerRowToStore(row));
      batcher.schedule();
    };
    conn.db.player.onInsert((_ctx, row) => ingestPlayer(row as unknown as SdkPlayerRow));
    conn.db.player.onUpdate((_ctx, _old, row) => ingestPlayer(row as unknown as SdkPlayerRow));
    conn.db.player.onDelete((_ctx, row) => {
      store.removePlayer((row as unknown as SdkPlayerRow).identity.toHexString());
      batcher.schedule();
    });

    const ingestMonster = (row: SdkMonsterPubRow): void => {
      store.upsertMonster(monsterPubRowToStore(row));
      batcher.schedule();
    };
    conn.db.monster_pub.onInsert((_ctx, row) => ingestMonster(row as unknown as SdkMonsterPubRow));
    conn.db.monster_pub.onUpdate((_ctx, _old, row) =>
      ingestMonster(row as unknown as SdkMonsterPubRow),
    );
    conn.db.monster_pub.onDelete((_ctx, row) => {
      store.removeMonster((row as unknown as SdkMonsterPubRow).monsterId);
      batcher.schedule();
    });

    const ingestSpecies = (row: SdkSpeciesRowRow): void => {
      store.upsertSpecies(speciesRowToStore(row));
      batcher.schedule();
    };
    conn.db.species_row.onInsert((_ctx, row) => ingestSpecies(row as unknown as SdkSpeciesRowRow));
    conn.db.species_row.onUpdate((_ctx, _old, row) =>
      ingestSpecies(row as unknown as SdkSpeciesRowRow),
    );
    conn.db.species_row.onDelete((_ctx, row) => {
      store.removeSpecies((row as unknown as SdkSpeciesRowRow).id);
      batcher.schedule();
    });

    const ingestBattle = (row: SdkBattleRow): void => {
      store.upsertBattle(battleRowToStore(row));
      batcher.schedule();
    };
    conn.db.battle.onInsert((_ctx, row) => ingestBattle(row as unknown as SdkBattleRow));
    conn.db.battle.onUpdate((_ctx, _old, row) => ingestBattle(row as unknown as SdkBattleRow));
    conn.db.battle.onDelete((_ctx, row) => {
      store.removeBattle((row as unknown as SdkBattleRow).battleId);
      batcher.schedule();
    });

    const ingestSkill = (row: SdkSkillRowRow): void => {
      store.upsertSkill(skillRowToStore(row));
      batcher.schedule();
    };
    conn.db.skill_row.onInsert((_ctx, row) => ingestSkill(row as unknown as SdkSkillRowRow));
    conn.db.skill_row.onUpdate((_ctx, _old, row) => ingestSkill(row as unknown as SdkSkillRowRow));
    conn.db.skill_row.onDelete((_ctx, row) => {
      store.removeSkill((row as unknown as SdkSkillRowRow).id);
      batcher.schedule();
    });

    const ingestInventory = (row: SdkInventoryRow): void => {
      store.upsertInventory(inventoryRowToStore(row));
      batcher.schedule();
    };
    conn.db.inventory.onInsert((_ctx, row) => ingestInventory(row as unknown as SdkInventoryRow));
    conn.db.inventory.onUpdate((_ctx, _old, row) =>
      ingestInventory(row as unknown as SdkInventoryRow),
    );
    conn.db.inventory.onDelete((_ctx, row) => {
      store.removeInventory((row as unknown as SdkInventoryRow).invId);
      batcher.schedule();
    });

    const ingestItemDef = (row: SdkItemRowRow): void => {
      store.upsertItemDef(itemRowToStore(row));
      batcher.schedule();
    };
    conn.db.item_row.onInsert((_ctx, row) => ingestItemDef(row as unknown as SdkItemRowRow));
    conn.db.item_row.onUpdate((_ctx, _old, row) => ingestItemDef(row as unknown as SdkItemRowRow));
    conn.db.item_row.onDelete((_ctx, row) => {
      store.removeItemDef((row as unknown as SdkItemRowRow).id);
      batcher.schedule();
    });

    const ingestFusion = (row: SdkFusionRow): void => {
      store.upsertFusion(fusionRowToStore(row));
      batcher.schedule();
    };
    conn.db.fusion.onInsert((_ctx, row) => ingestFusion(row as unknown as SdkFusionRow));
    conn.db.fusion.onUpdate((_ctx, _old, row) => ingestFusion(row as unknown as SdkFusionRow));
    conn.db.fusion.onDelete((_ctx, row) => {
      store.removeFusion((row as unknown as SdkFusionRow).fusionId);
      batcher.schedule();
    });

    // M12d: conversation / player_quest / heal_location_row / npc (ADR-0071).
    // M13.5c (ADR-0087): conversations now arrive through the owner-scoped
    // `my_conversation` VIEW. Delivery shape (T0 spike finding 4): a row UPDATE
    // propagates as onInsert(new) + onDelete(old) — NO onUpdate (the view table
    // has no PK for SDK correlation), and the pair is UNORDERED. onDelete is
    // therefore gated by the pure net-effect helper shouldRemoveOnViewDelete
    // (viewDelete.test.ts): remove ONLY when the deleted row matches the
    // currently-stored one — otherwise it is the old-version half of an update
    // pair and the just-applied new row must survive.
    type SdkConversationRow = {
      ownerIdentity: { toHexString(): string };
      npcEntityId: bigint;
      currentNodeId: string;
    };
    conn.db.my_conversation.onInsert((_ctx, row) => {
      store.upsertConversation(playerConversationRowToStore(row as unknown as SdkConversationRow));
      batcher.schedule();
    });
    conn.db.my_conversation.onDelete((_ctx, row) => {
      const deleted = playerConversationRowToStore(row as unknown as SdkConversationRow);
      if (shouldRemoveOnViewDelete(store.ownConversation(deleted.ownerIdentity), deleted)) {
        store.removeConversation(deleted.ownerIdentity);
      }
      batcher.schedule();
    });

    type SdkQuestRow = {
      pqId: bigint;
      ownerIdentity: { toHexString(): string };
      questId: string;
      stepIndex: number;
    };
    const ingestQuest = (row: SdkQuestRow): void => {
      store.upsertQuest(playerQuestRowToStore(row));
      batcher.schedule();
    };
    conn.db.player_quest.onInsert((_ctx, row) => ingestQuest(row as unknown as SdkQuestRow));
    conn.db.player_quest.onUpdate((_ctx, _old, row) => ingestQuest(row as unknown as SdkQuestRow));
    conn.db.player_quest.onDelete((_ctx, row) => {
      store.removeQuest((row as unknown as SdkQuestRow).pqId);
      batcher.schedule();
    });

    type SdkHealRow = {
      locationId: number;
      zoneId: number;
      tileX: number;
      tileY: number;
      costItemId?: number;
      costQty: number;
      cooldownMs: number;
    };
    const ingestHealLocation = (row: SdkHealRow): void => {
      store.upsertHealLocation(healLocationRowToStore(row));
      batcher.schedule();
    };
    conn.db.heal_location_row.onInsert((_ctx, row) =>
      ingestHealLocation(row as unknown as SdkHealRow),
    );
    conn.db.heal_location_row.onUpdate((_ctx, _old, row) =>
      ingestHealLocation(row as unknown as SdkHealRow),
    );
    conn.db.heal_location_row.onDelete((_ctx, row) => {
      store.removeHealLocation((row as unknown as SdkHealRow).locationId);
      batcher.schedule();
    });

    type SdkNpcRow = {
      entityId: bigint;
      npcId: string;
      zoneId: number;
      homeX: number;
      homeY: number;
      wanderRadius: number;
      dialogueTreeId: string;
    };
    const ingestNpc = (row: SdkNpcRow): void => {
      store.upsertNpc(npcRowToStore(row));
      batcher.schedule();
    };
    conn.db.npc.onInsert((_ctx, row) => ingestNpc(row as unknown as SdkNpcRow));
    conn.db.npc.onUpdate((_ctx, _old, row) => ingestNpc(row as unknown as SdkNpcRow));
    conn.db.npc.onDelete((_ctx, row) => {
      store.removeNpc((row as unknown as SdkNpcRow).entityId);
      batcher.schedule();
    });

    // M13d: shop_row / shop_item_row (ADR-0084) — public content tables.
    const ingestShop = (row: SdkShopRowRow): void => {
      store.upsertShop(shopRowToStore(row));
      batcher.schedule();
    };
    conn.db.shop_row.onInsert((_ctx, row) => ingestShop(row as unknown as SdkShopRowRow));
    conn.db.shop_row.onUpdate((_ctx, _old, row) => ingestShop(row as unknown as SdkShopRowRow));
    conn.db.shop_row.onDelete((_ctx, row) => {
      store.removeShop((row as unknown as SdkShopRowRow).shopId);
      batcher.schedule();
    });

    const ingestShopItem = (row: SdkShopItemRowRow): void => {
      store.upsertShopItem(shopItemRowToStore(row));
      batcher.schedule();
    };
    conn.db.shop_item_row.onInsert((_ctx, row) =>
      ingestShopItem(row as unknown as SdkShopItemRowRow),
    );
    conn.db.shop_item_row.onUpdate((_ctx, _old, row) =>
      ingestShopItem(row as unknown as SdkShopItemRowRow),
    );
    conn.db.shop_item_row.onDelete((_ctx, row) => {
      store.removeShopItem((row as unknown as SdkShopItemRowRow).shopItemId);
      batcher.schedule();
    });
  }

  /**
   * Build a fresh DbConnection with lifecycle + table handlers wired. Called once
   * synchronously below and again by scheduleRebuild() after every drop / failed
   * attempt (the SDK has no auto-reconnect on this raw builder path — ADR-0085).
   */
  function build(): DbConnection {
    // Capture this build's generation; `stale()` is true once a newer build exists.
    // Number-token (not instance) comparison: callbacks can safely close over `gen`
    // without any TDZ/ordering dependence on the `current` assignment below.
    const gen = ++buildGen;
    const stale = (): boolean => gen !== buildGen;
    const conn = DbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.db)
      .onConnect((c, id) => {
        if (stale()) return; // superseded build: never clobber identity/subscriptions
        identity = id.toHexString();
        const reconnecting = hadSession;
        c.subscriptionBuilder()
          .onApplied(() => {
            if (stale()) return; // superseded build: never unfreeze/join on a dead link
            // The link is fully usable only once the initial snapshot is applied:
            // unfreeze + reset the backoff ladder here (the ONLY attempt reset).
            // NOTE: the link unfreezes HERE, a few statements before the caller's
            // opts.onReconnect() resets the predictor below — safe: this whole
            // callback is one synchronous JS block, so no input event or microtask
            // can interleave between the unfreeze and the predictor reset.
            state = onConnected(state);
            // joinGame stays UNCONDITIONAL: server on_disconnect DELETES the player +
            // character rows, so a reconnect MUST re-join (ADR-0085 A4).
            c.reducers.joinGame({ name }).catch((err) => {
              const msg = (err as Error)?.message ?? '';
              // "already joined" is benign: the server hasn't processed the old
              // session's drop yet — rows still live; the new subscription
              // re-hydrates them (ADR-0085 A4). EXACT match (RT-JB-01): the SDK
              // delivers the reducer's Err string verbatim (SenderError(errorString))
              // and movement.rs errs exactly this — a substring test would swallow
              // hypothetical non-benign messages that merely contain the phrase.
              if (msg !== 'already joined') opts.onError('join', msg || 'join failed');
            });
            hadSession = true;
            if (reconnecting) opts.onReconnect();
            else opts.onReady(identity);
          })
          // Forward the SDK's subscription-error payload (was discarded pre-M13.5b);
          // subscriptionErrorMessage is fallback-guarded against shape surprises.
          .onError((ctx) => opts.onError('subscribe', subscriptionErrorMessage(ctx)))
          .subscribe([
            // M11c (ADR-0067 Option C): global character subscription — no WHERE zone_id filter.
            // Warp detection uses character.onUpdate (inline scalar comparison, M12.5d-5);
            // stale-zone characters are cleared by store.resetCharacters() on zone transition.
            'SELECT * FROM character',
            'SELECT * FROM player',
            'SELECT * FROM monster_pub',
            'SELECT * FROM species_row',
            // battle: unfiltered by design. The server only inserts rows for the
            // participant identities (both sides of the battle); no private fields
            // are exposed. An owner-scoped view does not exist yet (transport RLS →
            // M16). The client further gates display to own-identity rows via
            // store.activeBattle(identity) — ADR-0015 V1 defense-in-depth pattern.
            'SELECT * FROM battle',
            'SELECT * FROM skill_row',
            // Unfiltered subscribe + client-side owner filter (store.ownInventory) is the
            // established defense-in-depth pattern (ADR-0015/0046 V1; transport RLS → M16),
            // same as monster_pub. item_row is public content (no owner).
            'SELECT * FROM inventory',
            'SELECT * FROM item_row',
            // fusion is public content (all recipes visible to all players — M10c).
            'SELECT * FROM fusion',
            // M12d: dialogue / quest / heal / npc tables (ADR-0071).
            // M13.5c (ADR-0087): player_conversation is PRIVATE — subscribe the
            // owner-scoped my_conversation view instead (subscribing the private
            // table errors the whole batch and onApplied never fires).
            'SELECT * FROM my_conversation',
            'SELECT * FROM player_quest',
            'SELECT * FROM heal_location_row',
            'SELECT * FROM npc',
            // M13d: shop catalog (public content; ADR-0084). player_wallet is PRIVATE
            // (ADR-0081/0040) and produces no client subscription — excluded.
            'SELECT * FROM shop_row',
            'SELECT * FROM shop_item_row',
          ]);
      })
      .onConnectError((_ctx, err: Error) => {
        if (stale()) return; // a superseded build's late failure must not dirty the status line
        // A failed (re)build attempt: surface, climb the backoff ladder, retry.
        opts.onError('connect', err.message);
        state = onAttemptFailed(state);
        scheduleRebuild();
      })
      // Clean re-init on a drop: drop stale rows so a reconnect never merges stale
      // state (ADR-0014). CONFIRMED (closes the M5 open question): the SDK does NOT
      // auto-reconnect on the raw builder path — the app-level rebuild via
      // handleDrop() is the reconnect mechanism (ADR-0085 D3). Stale-guarded: a
      // buffered onDisconnect from a superseded build (bfcache) must not wipe rows
      // the CURRENT build's subscription already delivered (review RT-02).
      .onDisconnect(() => {
        if (stale()) return;
        handleDrop();
      })
      .build();
    wireTables(conn);
    return conn;
  }

  // Cold-start note (ADR-0085 D3): `attempt` counts consecutive FAILED builds, so a
  // failed INITIAL build's first retry sits on the 2 s rung (the instant first
  // attempt was rung one), while a drop-triggered rebuild — no failed build yet —
  // schedules at 1 s. Same formula both ways; the asymmetry is intended.
  let current = build();

  return {
    // Getter: returns the CURRENT live connection across rebuilds — callers must not
    // cache `conn.conn` across await points; a rebuild may have replaced the
    // instance underneath them (ADR-0085 C9; name kept for call-site compatibility).
    get conn() {
      return current;
    },
    identity: () => identity,
    linkFrozen: () => linkFrozen(state),
  };
}
