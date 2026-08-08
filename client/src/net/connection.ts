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
import { createAuthTokenGate, readAuthKind } from './authToken';
import { MicrotaskBatcher } from './batch';
import { type SendLogger, wrapReducerLogging } from './devLog';
import {
  battleChallengeRowToStore,
  battleRowToStore,
  characterRowToStore,
  evolutionPathRowToStore,
  healLocationRowToStore,
  inventoryRowToStore,
  itemRowToStore,
  monsterPubRowToStore,
  npcRowToStore,
  playerConversationRowToStore,
  playerQuestRowToStore,
  playerRowToStore,
  playerWalletRowToStore,
  profileRowToStore,
  type SdkBattleChallengeRow,
  type SdkBattleRow,
  type SdkCharacterRow,
  type SdkEvolutionPathRow,
  type SdkInventoryRow,
  type SdkItemRowRow,
  type SdkMonsterPubRow,
  type SdkPlayerRow,
  type SdkPlayerWalletRow,
  type SdkProfileRow,
  type SdkShopItemRowRow,
  type SdkShopRowRow,
  type SdkSkillRowRow,
  type SdkSpeciesRowRow,
  type SdkTradeOfferRow,
  shopItemRowToStore,
  shopRowToStore,
  shouldRemoveOnViewDelete,
  skillRowToStore,
  speciesRowToStore,
  tradeOfferRowToStore,
} from './rowConvert';
import type { AuthoritativeStore } from './store';
import { isOwnZoneChange } from './warpDetect';

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
  /** dev-observability (ADR-0157): outbound reducer-call sink. `undefined` (the default
   *  production build) makes wrapReducerLogging strict identity — no Proxy is installed. */
  readonly onSend?: SendLogger;
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
  // Reconnect-credential gate (nh4, ADR-0150). Built ONCE per connect() — NEVER inside
  // build(): its consecutive-rejection counter lives in this closure and is not persisted,
  // so a per-build gate would reset the counter on every scheduleRebuild() attempt,
  // suppression could never engage, and a host reset would loop forever re-supplying a
  // permanently rejected token. Pinned by W-NH4-GATE-CONSTRUCTED.
  const auth = createAuthTokenGate(opts.uri, opts.db, globalThis);
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
      // M11c (ADR-0067 Option C): detect own-entity zone transition via isOwnZoneChange
      // (warpDetect.ts — pure predicate, unit-tested independently; M12.5d-5: raw SDK
      // scalars avoid characterRowToStore() double-conversion just to compare zoneId).
      if (opts.onOwnWarp !== undefined) {
        const oldSdkRow = oldRow as unknown as SdkCharacterRow;
        const ownEntityId = store.ownEntityId(identity);
        if (ownEntityId !== undefined && isOwnZoneChange(oldSdkRow, newSdkRow, ownEntityId)) {
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

    // EG4 (ADR-0174): the essence-graph edges. `sync_content` republishes this table as
    // N deletes + N inserts in ONE unordered transaction, RE-MINTING path_id while
    // keeping edge_id — so both the store map and this delete handler key off `pathId`.
    // Removing by edgeId would wipe the row the insert half of the same burst just
    // wrote, and the client's path map would silently empty.
    const ingestEvolutionPath = (row: SdkEvolutionPathRow): void => {
      store.upsertEvolutionPath(evolutionPathRowToStore(row));
      batcher.schedule();
    };
    conn.db.evolution_path.onInsert((_ctx, row) =>
      ingestEvolutionPath(row as unknown as SdkEvolutionPathRow),
    );
    conn.db.evolution_path.onUpdate((_ctx, _old, row) =>
      ingestEvolutionPath(row as unknown as SdkEvolutionPathRow),
    );
    conn.db.evolution_path.onDelete((_ctx, row) => {
      store.removeEvolutionPath((row as unknown as SdkEvolutionPathRow).pathId);
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
      costCurrency: bigint;
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
      // uxd2 (ADR-0161): the NpcInteraction tagged union as the SDK delivers
      // it — normalized (totally, AC-16) by npcRowToStore.
      interaction: { tag: string; value?: number };
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

    // ux2b (ADR-0169 D2): my_wallet — the owner-scoped VIEW over the PRIVATE
    // player_wallet table (ADR-0154). INSERT-ONLY, on purpose.
    // TRIPWIRE — deliberately NO onDelete and deliberately NO onUpdate handler, and
    // deliberately NO shouldRemoveOnViewDelete gate (do NOT copy the my_conversation
    // block above — it is the nearest precedent and it is both dead and wrong here):
    //   * no onDelete — no server path ever deletes a player_wallet row
    //     (economy_tests.rs::player_wallet_rows_are_never_deleted is the soundness gate),
    //     AND through a view a row UPDATE arrives as unordered onInsert(new) +
    //     onDelete(old) (ADR-0154 D4), so on a buy-then-sell round trip the coalesced
    //     `I(50) I(100) D(100) D(50)` makes ANY net-effect delete gate remove the LIVE
    //     row and the player's gold vanishes mid-session. store.reset() on disconnect is
    //     the SOLE clearing path — which is why store.ts ships upsertWallet with no
    //     removeWallet counterpart at all.
    //   * no onUpdate — a view table has no PK for SDK correlation, so it never fires
    //     (ADR-0087); wiring one implies a delivery guarantee the transport does not make.
    // If the server ever grows a wallet-delete path, this absence is the review tripwire:
    // revisit ADR-0154 D4 first, then wire removal + the store API in the same change.
    conn.db.my_wallet.onInsert((_ctx, row) => {
      store.upsertWallet(playerWalletRowToStore(row as unknown as SdkPlayerWalletRow));
      batcher.schedule();
    });

    // m15b: trade_offer (public runtime table — both parties subscribe).
    // Completed/cancelled offers are deleted server-side (D5: terminal row GC);
    // no onUpdate expected, but handle it defensively to stay fresh.
    const ingestTradeOffer = (row: SdkTradeOfferRow): void => {
      store.upsertTradeOffer(tradeOfferRowToStore(row));
      batcher.schedule();
    };
    conn.db.trade_offer.onInsert((_ctx, row) =>
      ingestTradeOffer(row as unknown as SdkTradeOfferRow),
    );
    conn.db.trade_offer.onUpdate((_ctx, _old, row) =>
      ingestTradeOffer(row as unknown as SdkTradeOfferRow),
    );
    conn.db.trade_offer.onDelete((_ctx, row) => {
      store.removeTradeOffer((row as unknown as SdkTradeOfferRow).tradeId);
      batcher.schedule();
    });

    // m16b: battle_challenge (public table — challenger + target subscribe).
    // Challenges are deleted server-side when Accepted/Declined/Cancelled
    // (pvp.rs — the delete fires onDelete here, removing the stale row).
    const ingestChallenge = (row: SdkBattleChallengeRow): void => {
      store.upsertChallenge(battleChallengeRowToStore(row));
      batcher.schedule();
    };
    conn.db.battle_challenge.onInsert((_ctx, row) =>
      ingestChallenge(row as unknown as SdkBattleChallengeRow),
    );
    conn.db.battle_challenge.onUpdate((_ctx, _old, row) =>
      ingestChallenge(row as unknown as SdkBattleChallengeRow),
    );
    conn.db.battle_challenge.onDelete((_ctx, row) => {
      store.removeChallenge((row as unknown as SdkBattleChallengeRow).challengeId);
      batcher.schedule();
    });

    // m17b: profile (PUBLIC table — world-readable ranked leaderboard, ADR-0119/0120).
    // profile is a REGULAR table (not a view), so onUpdate fires normally — the
    // my_conversation view-delete gating above does NOT apply here.
    // TRIPWIRE — deliberately NO onDelete: profile rows are never deleted
    // server-side (RL-2, ADR-0119 D1 — Elo losses update the row, never remove it).
    // If the server ever starts deleting profile rows, this missing handler is the
    // review tripwire: wire onDelete + a store removal in the same change.
    const ingestProfile = (row: SdkProfileRow): void => {
      store.upsertProfile(profileRowToStore(row));
      batcher.schedule();
    };
    conn.db.profile.onInsert((_ctx, row) => ingestProfile(row as unknown as SdkProfileRow));
    conn.db.profile.onUpdate((_ctx, _old, row) => ingestProfile(row as unknown as SdkProfileRow));
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
    // M21b (ADR-0179 D8): which credential class THIS build is supplying. Read
    // FRESH per build — the mirror image of the gate above, which is built once
    // on purpose: the gate's counter must survive rebuilds, whereas a marker
    // that flipped mid-session must be observed by the very next build. It is
    // captured HERE, not re-read inside onConnect, because onConnect fires an
    // arbitrary time later against mutable sessionStorage — a re-read there
    // could report 'anon' for a build that supplied an account credential
    // (TOCTOU), which is exactly the write this guards against.
    const buildKind = readAuthKind(globalThis, opts.uri, opts.db);
    const conn = DbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.db)
      // nh4 (ADR-0150): resume the SAME anonymous identity across a page reload. Read
      // FRESH on every build — hoisting this to connect() scope would pin one value for
      // the process lifetime, making the gate's suppression inert and a rejected-token
      // reconnect loop permanent.
      .withToken(auth.tokenForNextAttempt())
      .onConnect((c, id, token) => {
        if (stale()) return; // superseded build: never clobber identity/subscriptions
        // Persist AFTER the stale guard: a superseded build's late onConnect must not
        // overwrite the credential the live build already stored.
        //
        // M21b (ADR-0179 D8): and ONLY for an anonymous build. The SDK echoes the
        // credential we supplied back as `token` (dist/index.mjs:5765 + :6226-6231 —
        // the host's own token is adopted only when we supplied none), so on an
        // authenticated build this argument IS the short-lived account JWT. Storing it
        // here would put it in the ANONYMOUS slot, which `tokenForNextAttempt()` hands
        // straight back to `.withToken()` on the next build — replaying an account JWT
        // past its `exp`, the exact case D8 forbids. `=== 'anon'` (not `!== 'account'`)
        // is the fail-CLOSED direction ON THE VALUE: if AuthKind ever gains a third
        // member, a `!==` guard would start writing that kind's credential into the
        // anonymous slot by default.
        //
        // BEST-EFFORT, NOT STRUCTURAL — do not read more into this than it gives.
        // `readAuthKind` fails to 'anon' on every lossy path (blocked storage, quota,
        // eviction), and 'anon' is the PERMISSIVE direction here, so a lost marker
        // silently re-opens the replay. That fail direction is forced by AUTH-31 and is
        // not fixable with a marker at all; the discriminator must become the provenance
        // of the credential actually supplied, carried in memory beside the token
        // (M21b-2 — see the ⚠ block on writeAuthKind). Until then this guard is the sole
        // enforcer of "the anon slot never contains an account JWT" and no production
        // code may write an 'account' marker.
        //
        // NOTE this also gates `rejectionsSinceSuccess = 0`, which lives inside
        // onConnected — see harm 2 in that same ⚠ block.
        if (buildKind === 'anon') auth.onConnected(token);
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
            // ADR-0157 §1: the ONE outbound site that does not go through the get conn()
            // accessor, so the build()-return wrap cannot cover it — wrap it explicitly.
            wrapReducerLogging(c, opts.onSend)
              .reducers.joinGame({ name })
              .catch((err) => {
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
            // off-zone characters are excluded at RENDER time by the currentZoneId filter
            // (main.ts) — the real mechanism. (store.resetCharacters() exists but is NOT
            // wired into switchZone; correcting a stale comment, ptc5e-4.)
            'SELECT * FROM character',
            'SELECT * FROM player',
            'SELECT * FROM monster_pub',
            'SELECT * FROM species_row',
            // battle: unfiltered by design. The server only inserts rows for the
            // participant identities (both sides of the battle); no private fields
            // are exposed. An owner-scoped view does not exist yet (transport RLS →
            // M16). The client further gates display to own-identity rows via
            // store.ongoingBattle(identity) — ADR-0015 V1 defense-in-depth pattern.
            'SELECT * FROM battle',
            'SELECT * FROM skill_row',
            // Unfiltered subscribe + client-side owner filter (store.ownInventory) is the
            // established defense-in-depth pattern (ADR-0015/0046 V1; transport RLS → M16),
            // same as monster_pub. item_row is public content (no owner).
            'SELECT * FROM inventory',
            'SELECT * FROM item_row',
            // evolution_path is public content (every authored edge is visible to every
            // player — EG3/EG4). The name is EXACT: a wrong table name errors the WHOLE
            // subscription batch and onApplied never fires.
            'SELECT * FROM evolution_path',
            // M12d: dialogue / quest / heal / npc tables (ADR-0071).
            // M13.5c (ADR-0087): player_conversation is PRIVATE — subscribe the
            // owner-scoped my_conversation view instead (subscribing the private
            // table errors the whole batch and onApplied never fires).
            'SELECT * FROM my_conversation',
            'SELECT * FROM player_quest',
            'SELECT * FROM heal_location_row',
            'SELECT * FROM npc',
            // M13d: shop catalog (public content; ADR-0084).
            'SELECT * FROM shop_row',
            'SELECT * FROM shop_item_row',
            // ux2b (ADR-0169 D1): player_wallet is PRIVATE (ADR-0081/0040) — subscribe
            // the owner-scoped my_wallet view instead (ADR-0154), exactly as
            // my_conversation is subscribed above. Subscribing the private table would
            // error the whole batch and onApplied would never fire.
            'SELECT * FROM my_wallet',
            // m15b: trade_offer is a PUBLIC runtime table (ADR-0106 D3); both parties
            // subscribe. Per-row RLS is a M16 future (ADR-0106 W3 INFO); until then the
            // client sees all offers and filters by own identity in ownTradeOffer().
            'SELECT * FROM trade_offer',
            // m16b: battle_challenge is a PUBLIC runtime table (ADR-0109); challenger
            // and target subscribe. battle_action is PRIVATE (ADR-0015 must-never-leak)
            // and MUST NEVER be subscribed here.
            'SELECT * FROM battle_challenge',
            // m17b: profile is a PUBLIC regular table (world-readable leaderboard —
            // RL-13/ADR-0119); onUpdate fires normally (unlike the my_conversation view).
            'SELECT * FROM profile',
            // M21b TRIPWIRE — `my_account` is DELIBERATELY ABSENT (M21a generated its
            // bindings; this is not an oversight). Nothing in M21b consumes it, and
            // subscribing it would drag rowConvert.ts + store.ts into a slice whose
            // touches: set excludes them. It is NOT optional later, though: per
            // ADR-0179 the kind marker records INTENT, while `my_account` is the only
            // observable of the connection FACT (with the fail-closed `.invalid`
            // issuer placeholder the server leaves every connection anonymous, so a
            // client can currently believe it is authenticated when it is not).
            // M21b-2 adds it, and `my_account` is authoritative where the two disagree.
          ]);
      })
      .onConnectError((_ctx, err: Error) => {
        if (stale()) return; // a superseded build's late failure must not dirty the status line
        // nh4 (ADR-0150): classify this failure. A credential rejection advances the gate's
        // counter and, at the threshold, makes the NEXT build connect anonymously; anything
        // else resets it, so an unreachable host never costs the player their identity.
        // Reporting rides the EXISTING backoff ladder below — no second retry path.
        auth.onConnectFailed(err);
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
    // dev-observability (ADR-0157 §1): wrap AFTER wireTables so the inbound row callbacks
    // stay wired to the RAW connection. Identity when opts.onSend is undefined.
    return wrapReducerLogging(conn, opts.onSend);
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
