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
import type { SessionState } from '../ui/sessionModel';
import { subscriptionErrorMessage } from '../ui/statusModel';
import { createAuthTokenGate, wasEverAuthenticated, writeAuthKind } from './authToken';
import { MicrotaskBatcher } from './batch';
import { claimCode } from './claimCode';
import { type ConnectCredential, decideConnectCredential } from './credentialDecision';
import { type SendLogger, wrapReducerLogging } from './devLog';
import { createOidcClient } from './oidc';
import {
  accountRowToStore,
  battleChallengeRowToStore,
  battleRowToStore,
  characterRowToStore,
  evolutionPathRowToStore,
  exportChunkRowToStore,
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
  type SdkAccountRow,
  type SdkBattleChallengeRow,
  type SdkBattleRow,
  type SdkCharacterRow,
  type SdkEvolutionPathRow,
  type SdkExportChunkRow,
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
  /** Re-established after a drop: the caller resets the predictor + the loop re-seeds. Carries
   *  THIS connection's identity (17r-b, ADR-0130 residual e): a rebuild can mint a NEW anon
   *  identity (continueAnonymously / the nh4 token-rejection path), and a caller that keeps the
   *  old one deafens every identity-gated listener. Test-carried, not type-carried: TS parameter
   *  bivariance still accepts a zero-arg handler, so RSD17B-CARRIES / IDROT pin it. */
  readonly onReconnect: (identity: string) => void;
  /** 17r-b (ADR-0130 residual d): hydration-complete edge. Fired from the batcher flush closure
   *  on the first flush after each applied snapshot — AFTER the view reconciles ran against the
   *  cache the SDK had fully populated before it emitted `applied` (2.6.0: apply → 'applied' →
   *  row callbacks, all synchronous) and BEFORE store.flushBatch(), so every listener that flush
   *  notifies observes it as already delivered. Once per applied snapshot (guaranteed today by
   *  the always-non-empty content subscriptions, which schedule that flush). MUST be total (never
   *  throw): it runs outside the reconcile try/catch, so a throw here would starve the flush. */
  readonly onHydrated: () => void;
  /** A non-movement failure to surface (status line). Movement-reducer rejections stay silent (M2 §3). */
  readonly onError: (where: string, message: string) => void;
  /** Called when the own entity crosses a zone boundary (M11c, ADR-0067 Option C).
   *  Receives the new zone id so the caller can reload the map and reset prediction. */
  readonly onOwnWarp?: (newZoneId: number) => void;
  /** dev-observability (ADR-0157): outbound reducer-call sink. `undefined` (the default
   *  production build) makes wrapReducerLogging strict identity — no Proxy is installed. */
  readonly onSend?: SendLogger;
  /** M21b-2 (ADR-0182 D17): a previously-authenticated session was definitively rejected. */
  readonly onSessionExpired?: () => void;
  /** M21b-2 (ADR-0182 D17): the auth service stayed unreachable past the transient threshold. */
  readonly onAuthServiceUnreachable?: () => void;
  /** M21b-2 (ADR-0182 D17/AUTH-48): a FIRST sign-in exchange failed — routes to claimModel.
   *  `reason` is a static classifier-mapped string (AUTH-57), never raw provider text. */
  readonly onSignInFailed?: (reason: string) => void;
  /** M21b-2 (ADR-0182 D16): a guest-claim reissue fired on the first applied snapshot. */
  readonly onClaimPending?: (code: string) => void;
  /** M21b-2 (ADR-0182 D16): a claim code is outstanding but no account row has arrived yet. */
  readonly onClaimAwaitingAccount?: () => void;
  /** M21b-2 (ADR-0182 D16): the guest-claim reducer settled. */
  readonly onClaimResult?: (result: { readonly ok: boolean; readonly message: string }) => void;
  /** M21b-2 (ADR-0182 D11/D12): the OIDC issuer / client-id / redirect for this target. Absent
   *  in anonymous-only builds — with no issuer the flow contacts no network (AUTH-44). */
  readonly authIssuer?: string;
  readonly authClientId?: string;
  readonly authRedirectUri?: string;
}

export interface Connection {
  /** The CURRENT live DbConnection, or undefined while no connection is built (cold start,
   *  mid-attempt, or a parked terminal state — ADR-0182 D13). Getter-backed. */
  readonly conn: DbConnection | undefined;
  /** The current live DbConnection, or undefined — the same slot the getter reads, exposed as
   *  a method so callers `const live = conn?.live()` and guard once (ADR-0182 D13, G26). */
  live(): DbConnection | undefined;
  identity(): string;
  /** Whether input/sends must be gated off (ADR-0085 D3): true while disconnected
   *  or reconnecting. Event-driven, never promise-driven — in-flight reducer
   *  promises never settle after a drop. */
  linkFrozen(): boolean;
  /** M21b-2 (ADR-0182 D17/AUTH-49): sticky decline — connect anonymously and stop retrying. */
  continueAnonymously(): void;
  /** M21b-2 (ADR-0182 D17): the session terminal state driving the registry-external overlay. */
  sessionState(): SessionState;
  /** M21b-2 (ADR-0182 D16/AUTH-48): mint a claim code, then begin the OIDC sign-in redirect. */
  startSignIn(): void;
  /** M21b-2 (ADR-0182 D17): fire a fresh connect attempt for the session 'retry' affordance. */
  reconnectNow(): void;
}

export function connect(opts: ConnectionOptions): Connection {
  const { store, name } = opts;
  // 17r-b: armed by each applied snapshot (stale-guarded), consumed by the FIRST flush after it.
  let snapshotApplied = false;
  // Reconcile once per transaction: each row callback schedules; the batcher fires
  // store.flushBatch() once on the next microtask (no per-transaction SDK hook in 2.6).
  // ONE batcher for ALL rebuilds (ADR-0085 C2): a per-build batcher could fire a
  // stale flush after store.reset() wiped the rows it was coalescing. wireTables
  // re-registers row handlers per build, but every handler schedules through THIS
  // single instance, so a scheduled flush always reflects the current store.
  const batcher = new MicrotaskBatcher(() => {
    // 13r-e (ADR-0194 D4): reconcile the monster map from the SDK's post-burst
    // `my_monster_pub` cache BEFORE notifying listeners. The view has no PK in
    // 1.12.0 bindings, so the SDK never fires onUpdate — every row change is an
    // unordered insert+delete pair; rebuilding membership from the cache is
    // ordering-immune and immune to multi-transaction coalescing. Stale-build
    // guarded (ADR-0085 C2): `live !== undefined` is the sanctioned spelling —
    // `current === undefined` would collide with the M21b-2 assignment-count pin.
    const live = current;
    if (live !== undefined) {
      // 15r-sec-a hardening: the reconciles run UPSTREAM of flushBatch in this
      // shared closure, so a converter throw (bindings skew, a partially
      // decoded row) would starve EVERY batch listener — including the
      // movement reconcile that drives prediction snap. Catch and continue:
      // a stale battle map is recoverable, a starved flush is not.
      try {
        store.reconcileMonstersFromView(
          [...live.db.my_monster_pub.iter()].map((row) =>
            monsterPubRowToStore(row as unknown as SdkMonsterPubRow),
          ),
        );
        // 15r-sec-a (ADR-0198 D4): same countermeasure for the `my_battle` view —
        // no PK in the view binding even on 2.8.1 codegen, so onUpdate never
        // fires and every turn arrives as an unordered insert+delete pair;
        // rebuild the battle map from the post-burst cache instead.
        store.reconcileBattlesFromView(
          [...live.db.myBattle.iter()].map((row) =>
            battleRowToStore(row as unknown as SdkBattleRow),
          ),
        );
        // rb-53 (ADR-0231 A3-D1): the third Vec-view reconcile. AUTHORITATIVE — a chunkId absent
        // from this argument is deleted, which is how a server-side purge withdraws the client's
        // download offer. It runs BEFORE flushBatch() because main.ts's batch listener is the
        // sole assembleExportBundle() call site, and a reconcile after the flush would leave it
        // assembling the PRE-burst chunk set.
        store.reconcileExportChunksFromView(
          [...live.db.my_export_bundle.iter()].map((row) =>
            exportChunkRowToStore(row as unknown as SdkExportChunkRow),
          ),
        );
      } catch (err) {
        console.error('[net] view reconcile threw; flushing anyway', err);
      }
    }
    // 17r-b: hydration-complete — AFTER the reconciles (the store now holds the applied snapshot)
    // and BEFORE flushBatch (listeners observe it delivered). Outside the live-guard on purpose:
    // a parked build (current = undefined) must not leave the flag armed for a later bogus edge.
    if (snapshotApplied) {
      snapshotApplied = false;
      opts.onHydrated();
    }
    store.flushBatch();
  });
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
  // M21b-2 (ADR-0182 D11/D12): the OIDC client for this target. INJECTED host (globalThis) —
  // storage/crypto/fetch all go through it, never an ambient reach from this shell. With no
  // issuer (an anonymous-only build) renewOrExchange returns no session and contacts no network.
  const oidc = createOidcClient(globalThis, {
    issuer: opts.authIssuer ?? '',
    clientId: opts.authClientId ?? '',
    redirectUri: opts.authRedirectUri ?? '',
    uri: opts.uri,
    db: opts.db,
  });
  // M21b-2 (ADR-0182 D13) — the three cross-rebuild ladder facts, declared at connect() scope
  // (NOT per build/attempt): a per-attempt copy resets on every reconnect and defeats each one.
  let isReturnLegAttempt = false; // set once from the OIDC return leg below; SINGLE-USE (D12)
  let consecutiveTransientErrors = 0; // AUTH_SERVICE_TRANSIENT_THRESHOLD's counter (D17)
  let forcedAnon = false; // set ONLY by continueAnonymously(); sticky for the tab's page life
  // The session terminal state the registry-external overlay reads through sessionState().
  let sessionMode: SessionState = 'hidden';
  // Consume the OIDC return leg exactly once on cold start (D12): a matched state records the
  // authorization code and arms this attempt's gate so the first sign-in exchanges its verifier.
  if (oidc.consumeReturnLeg()) isReturnLegAttempt = true;

  /** Schedule ONE rebuild after the current backoff delay (ADR-0085 D3/A7). */
  function scheduleRebuild(): void {
    if (teardown || rebuildTimer !== undefined) return;
    const delay = reconnectDelayMs(state.attempt);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      state = onReconnectAttempt(state);
      // ADR-0182 D13: attemptBuild owns the whole resolve→build cycle and is defensively total
      // (RT-01's synchronous-throw protection and C1's async-throw protection both live inside
      // it), so the timer body is a bare fire-and-forget of the one reconnect entry point.
      void attemptBuild();
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

    // 13r-e (ADR-0194 D4): `my_monster_pub` is a PK-less VIEW — the SDK never
    // fires onUpdate for it, so do NOT wire one (W-13RE-INGEST tripwire), and
    // per-row store writes are banned here: the batcher's flush closure
    // reconciles the whole monster map from the SDK cache, so these handlers
    // only schedule that flush.
    conn.db.my_monster_pub.onInsert(() => batcher.schedule());
    conn.db.my_monster_pub.onDelete(() => batcher.schedule());

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

    // 15r-sec-a (ADR-0198 D4): `my_battle` is a PK-less VIEW — the SDK never
    // fires onUpdate for it, so do NOT wire one (W-15RSECA-INGEST tripwire),
    // and per-row store writes are banned here: the batcher's flush closure
    // reconciles the whole battle map from the SDK cache, so these handlers
    // only schedule that flush (the my_monster_pub pattern above).
    conn.db.myBattle.onInsert(() => batcher.schedule());
    conn.db.myBattle.onDelete(() => batcher.schedule());

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

    // M21b-2 (ADR-0182 D15): my_account is the owner-scoped VIEW over the PRIVATE account table
    // (subscribed above) and is the sole reconciliation authority for "am I signed in" (AUTH-51).
    // It needs BOTH onInsert AND onUpdate — status/claimed_from MUTATE after provisioning (a guest
    // claim re-keys the row mid-session; delete_account flips status to PendingDeletion). But
    // deliberately there is no conn.db.my_account.onDelete handler: through a view an UPDATE
    // arrives as unordered onInsert(new) + onDelete(old), so any delete delivered is the STALE
    // half of an update pair and would wipe the live account slot — and no server path ever truly
    // deletes an account row. store.reset() on disconnect is the SOLE clearing path (mirrors the
    // my_wallet TRIPWIRE above), which is why store.ts ships upsertAccount with no removeAccount.
    conn.db.my_account.onInsert((_ctx, row) => {
      store.upsertAccount(accountRowToStore(row as unknown as SdkAccountRow));
      batcher.schedule();
    });
    conn.db.my_account.onUpdate((_ctx, _old, row) => {
      store.upsertAccount(accountRowToStore(row as unknown as SdkAccountRow));
      batcher.schedule();
    });

    // rb-53 (ADR-0231 A3-D1): `my_export_bundle` is a PK-less Vec-VIEW — the my_monster_pub /
    // my_battle shape, NOT the my_account/my_wallet one. The SDK never fires onUpdate for it, so
    // do NOT wire one, and per-row store writes are banned here: the batcher's flush closure
    // reconciles the whole chunk map from the SDK cache, so these handlers only schedule that
    // flush. onDelete IS wired (unlike my_account/my_wallet, whose rows are never deleted
    // server-side): export chunks leave this view via the 7-day TTL reaper and the deletion
    // cascade, and with no delete handler the batcher is never scheduled for that burst — the
    // client would keep offering a download of data the server has already purged.
    conn.db.my_export_bundle.onInsert(() => batcher.schedule());
    conn.db.my_export_bundle.onDelete(() => batcher.schedule());
  }

  /** Issue the connection-internal joinGame through the WRAPPED connection (ADR-0157 §1) — the
   *  ONE outbound call that bypasses the get conn() accessor. Extracted ONCE (ADR-0182 D16):
   *  devLog builds a fresh Proxy per call, so an inline re-wrap double-logs every reducer call. */
  function attemptJoin(
    conn: DbConnection,
    name: string,
    onError: ConnectionOptions['onError'],
  ): void {
    conn.reducers.joinGame({ name }).catch((err) => {
      const msg = (err as Error)?.message ?? '';
      // "already joined" is benign: the server has not processed the old session's drop yet — the
      // rows still live and the new subscription re-hydrates them (ADR-0085 A4). EXACT match.
      if (msg !== 'already joined') onError('join', msg || 'join failed');
    });
  }

  /**
   * Build a fresh DbConnection for `credential`, lifecycle + table handlers wired. Called ONLY
   * from attemptBuild(), which owns the generation bump and the resolve→build sequencing
   * (ADR-0182 D13). Stays SYNCHRONOUS; widens its return to `DbConnection | undefined` only so a
   * future non-anon/account variant fails closed rather than leaking an unintended token.
   */
  function build(credential: ConnectCredential): DbConnection | undefined {
    // Defensive belt (D13): attemptBuild never calls build() with a terminal kind, but a future
    // variant must DECLINE rather than leak an unintended token to the builder.
    if (credential.kind !== 'anon' && credential.kind !== 'account') return undefined;
    // Capture this build's generation (bumped by attemptBuild BEFORE the async gap); `stale()` is
    // true once a newer attempt exists. Number-token comparison, no TDZ dependence on `current`.
    const gen = buildGen;
    const stale = (): boolean => gen !== buildGen;
    const conn = DbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.db)
      // ADR-0182 D14: the token is decided by THIS build's `credential` ALONE, computed in memory
      // on this same attempt — never re-derived from mutable storage. `=== 'account'` is
      // fail-closed on the permissive value, so a future variant can never leak an account token.
      .withToken(credential.kind === 'account' ? credential.token : auth.tokenForNextAttempt())
      .onConnect((c, id, token) => {
        if (stale()) return; // superseded build: never clobber identity/subscriptions
        // Save the anon reconnect token ONLY for an anon build: the SDK echoes the supplied JWT
        // back as `token`, so on an account build this argument is the short-lived account JWT and
        // must never enter the anonymous slot (ADR-0182 D14; `=== 'anon'` is the fail-closed side).
        if (credential.kind === 'anon') auth.onConnected(token);
        // D13/D14: a first-paint HINT for account builds, superseded by my_account's first snapshot
        // (D15) and never a security input — provenance is `credential`, never this marker.
        if (credential.kind === 'account') writeAuthKind(globalThis, opts.uri, opts.db, 'account');
        identity = id.toHexString();
        const reconnecting = hadSession;
        c.subscriptionBuilder()
          .onApplied(() => {
            if (stale()) return; // superseded build: never unfreeze/join on a dead link
            // The link is fully usable only once the initial snapshot applies: unfreeze + reset
            // the backoff ladder here (the ONLY attempt reset), and clear any session terminal.
            state = onConnected(state);
            sessionMode = 'hidden';
            // ADR-0182 D16 join gate, re-evaluated FRESH every applied snapshot. The claim-code
            // veto is the SOLE veto and is scoped to account-kind builds; my_account presence is
            // NEVER consulted in it (AUTH-52). Anon builds always join — the idempotent A4 re-join
            // (server on_disconnect deletes the player + character rows, so a reconnect must join).
            const codeUnconsumed = claimCode.hasUnconsumed(globalThis, opts.uri, opts.db);
            const shouldJoin = credential.kind !== 'account' || !codeUnconsumed;
            if (shouldJoin) {
              attemptJoin(wrapReducerLogging(c, opts.onSend), name, opts.onError);
            } else if (store.ownAccount(identity) !== undefined) {
              // AUTH-53: re-issue complete_guest_claim on THIS connection's first applied snapshot,
              // unconditionally — a pre-drop promise never settles (ADR-0085 D3). onClaimPending is
              // a UX notification fired ALONGSIDE the reducer call, never a substitute for it.
              const code = claimCode.read(globalThis, opts.uri, opts.db)!;
              // Call on the RAW connection, NOT wrapReducerLogging(c): the dev-observability
              // Proxy JSON-stringifies reducer args to the onSend sink, and `code` is a bearer
              // secret (whoever holds it can steal this guest's progress). joinGame's `{name}` is
              // sanctioned free text; a claim code categorically is not (AUTH-57 spirit; the G21
              // scanner can't see this indirect sink — its own residual R4). Assigned first so the
              // `.reducers.completeGuestClaim({ code })` call stays contiguous (biome breaks a short
              // receiver's method chain otherwise) — G18 pins that exact needle.
              const pendingClaim = c.reducers.completeGuestClaim({ code });
              pendingClaim
                .then(() => opts.onClaimResult?.({ ok: true, message: '' }))
                .catch((err) =>
                  opts.onClaimResult?.({ ok: false, message: (err as Error)?.message ?? '' }),
                );
              opts.onClaimPending?.(code);
            } else {
              opts.onClaimAwaitingAccount?.(); // UX polish only — the veto above is what makes F2 safe
            }
            // 17r-b: arm the hydration edge BEFORE notifying, so a throwing callback cannot lose it.
            snapshotApplied = true;
            hadSession = true;
            if (reconnecting) opts.onReconnect(identity);
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
            // 13r-e (ADR-0194, issue #284): monster_pub is PRIVATE — subscribe
            // the owner-scoped my_monster_pub view instead (the my_conversation /
            // my_wallet pattern). Other players' monster rows are need-to-know
            // and are not delivered at all (no client consumer exists).
            'SELECT * FROM my_monster_pub',
            'SELECT * FROM species_row',
            // 15r-sec-a (ADR-0198): battle is PRIVATE — subscribe the
            // participant-scoped my_battle view instead (the my_monster_pub /
            // my_wallet pattern). Each client receives only rows where it is
            // player_identity or opponent_identity; store.ongoingBattle's
            // own-identity filter remains as defense-in-depth.
            'SELECT * FROM my_battle',
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
            // M21b-2 (ADR-0182 D15): my_account is the owner-scoped VIEW over the PRIVATE account
            // table — the sole reconciliation authority for "am I signed in" (AUTH-51). Ingested
            // with onInsert + onUpdate (and NO onDelete) in wireTables above. Subscribing the
            // private `account` table itself would error the whole batch and onApplied never fires.
            'SELECT * FROM my_account',
            // rb-53 (ADR-0231 A3-D1): my_export_bundle is the owner-scoped VIEW over the PRIVATE
            // export_bundle table — the ONLY client read path for a completed data export
            // (schema.rs:916). Subscribing `export_bundle` itself would error the whole batch.
            // The same literal is mirrored in evals/monster-privacy.eval.mjs's
            // EXPECTED_SUBSCRIPTIONS, which pins this array as an exact SET.
            'SELECT * FROM my_export_bundle',
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

  // ADR-0182 D13: the current live connection, undefined until an attempt builds one (and reset
  // to undefined by the parked session terminals). Declared immediately after build().
  let current: DbConnection | undefined;

  /**
   * The ONE real I/O boundary (ADR-0182 D13). Decides which credential build() should act on,
   * consulting Better Auth ONLY when the attempt gate is open — a never-authenticated or
   * declined tab makes ZERO network calls (AUTH-43/44/49). TOTAL by contract (oidc.renewOrExchange
   * maps every internal error to 'transient-error'); attemptBuild's try/catch is the belt.
   */
  async function resolveCredential(): Promise<ConnectCredential> {
    if (forcedAnon) return { kind: 'anon', token: auth.tokenForNextAttempt() };
    const attemptGateOpen =
      wasEverAuthenticated(globalThis, opts.uri, opts.db) || isReturnLegAttempt;
    // SINGLE-USE (D12): consumed on this read regardless of outcome, so a later ordinary reconnect
    // never re-drives the exchange with no stored verifier left to act on.
    isReturnLegAttempt = false;
    if (!attemptGateOpen) {
      return { kind: 'anon', token: auth.tokenForNextAttempt() };
    }
    const outcome = await oidc.renewOrExchange();
    consecutiveTransientErrors =
      outcome.kind === 'transient-error' ? consecutiveTransientErrors + 1 : 0;
    return decideConnectCredential(
      outcome,
      wasEverAuthenticated(globalThis, opts.uri, opts.db),
      consecutiveTransientErrors,
      auth.tokenForNextAttempt(),
    );
  }

  /**
   * The ONE caller of build() (ADR-0182 D13). Bumps the generation before the async gap, resolves
   * the credential inside an exception boundary (C1: an ordinary Better Auth hiccup must never
   * stop the ladder), re-checks staleness after the await, and routes each terminal kind.
   */
  async function attemptBuild(): Promise<void> {
    buildGen += 1; // opens the generation BEFORE the async gap
    const gen = buildGen;
    let credential: ConnectCredential;
    try {
      credential = await resolveCredential();
    } catch {
      if (gen !== buildGen || teardown) return;
      state = onAttemptFailed(state);
      scheduleRebuild();
      return;
    }
    if (gen !== buildGen || teardown) return; // re-checked AFTER the await
    if (credential.kind === 'retry') {
      // AUTH-45: an ambiguous transient outcome climbs the SAME backoff ladder a socket-level
      // failure uses and builds nothing — it must never reach build().
      state = onAttemptFailed(state);
      scheduleRebuild();
      return;
    }
    if (credential.kind === 'session-expired' || credential.kind === 'auth-service-unreachable') {
      sessionMode = credential.kind === 'session-expired' ? 'expired' : 'unreachable';
    }
    if (credential.kind === 'session-expired') {
      opts.onSessionExpired?.();
      current = undefined;
      return;
    }
    if (credential.kind === 'auth-service-unreachable') {
      opts.onAuthServiceUnreachable?.();
      current = undefined;
      return;
    }
    if (credential.kind === 'sign-in-failed') {
      opts.onSignInFailed?.(credential.reason); // routes to claimModel (AUTH-48); falls through to anon
    }
    try {
      // RT-01 preserved: build() can still throw synchronously (malformed URI, SDK version check).
      // A first-time sign-in-failed still gets an ANON connection — never `credential` (whose token
      // field is a reason string) and never no connection at all, which would strand the claimant.
      // biome-ignore format: ADR-0182 D13 line 220 — pinned single-line literal (W-M21B2-LIVE-IS-CURRENT).
      current = build(credential.kind === 'sign-in-failed' ? { kind: 'anon', token: auth.tokenForNextAttempt() } : credential);
    } catch (err) {
      opts.onError('connect', err instanceof Error ? err.message : 'rebuild failed');
      state = onAttemptFailed(state);
      scheduleRebuild();
    }
  }

  /** AUTH-49: the sticky decline — connect anonymously and stop asking Better Auth. */
  function continueAnonymously(): void {
    forcedAnon = true;
    void attemptBuild();
  }

  /** AUTH-48: mint the claim code (so the return-leg reissue has one), then hand off to the OIDC
   *  redirect. beginSignIn is TOTAL (never rejects, oidc.ts C1) — the .catch is a belt only. On a
   *  'ready' result the tab leaves the page; any other kind degrades to the claim UI's failure copy
   *  (the intended behaviour against the `.invalid` placeholder issuer until 13r-c-2 deploys). */
  function startSignIn(): void {
    claimCode.mint(globalThis, opts.uri, opts.db);
    // Bound to a short local so biome keeps `oidc.beginSignIn(` on one line (G-teeth pin it
    // contiguous — a broken chain squashes to `oidc .beginSignIn(` and reads as a missing call).
    const flow = oidc.beginSignIn();
    flow
      .then((result) => {
        if (result.kind === 'ready') {
          // `location?` guards a non-browser host; the navigation target is textually the URL
          // beginSignIn produced (G-teeth pin `.assign(result.authorizationUrl` contiguous, hence
          // the short-bound `nav` so biome does not break the call). A missing `assign` (never in a
          // real browser) throws into the `.catch` belt below.
          const nav = (globalThis as { location?: { assign(u: string): void } }).location;
          nav?.assign(result.authorizationUrl);
        } else {
          opts.onSignInFailed?.(result.kind);
        }
      })
      .catch(() => opts.onSignInFailed?.('transient-error'));
  }

  /** AUTH-45: the session 'retry' affordance — fire a fresh connect attempt through the one total
   *  entry point (attemptBuild owns the resolve→build cycle and every exception boundary). */
  function reconnectNow(): void {
    void attemptBuild();
  }

  // Cold start (ADR-0182 D13): resolve → build through the same total entry point every reconnect
  // uses. Even the zero-I/O anon fast path defers `current` by one microtask (accepted residual).
  void attemptBuild();

  return {
    // Getter: returns the CURRENT live connection across rebuilds — callers must not cache
    // `conn.conn` across await points; a rebuild may have replaced the instance (ADR-0085 C9).
    get conn() {
      return current;
    },
    live: () => current,
    identity: () => identity,
    linkFrozen: () => linkFrozen(state),
    continueAnonymously,
    sessionState: () => sessionMode,
    startSignIn,
    reconnectNow,
  };
}
