// net/connection.ts — the live SpacetimeDB adapter (M4a; app-level reconnect M13.5b).
// Imperative shell only: connect, check the server's protocol numbers (`module_info` alone,
// protocolCheck.ts), subscribe (the base set, then the own character row and each
// wanted zone's characters as worldScope.ts directs), mirror authoritative
// rows into the AuthoritativeStore (converting at the boundary, coalescing a
// transaction's row burst via MicrotaskBatcher -> ONE flushBatch), and
// surface lifecycle. It owns NO game state and never writes anything but the store
// (one-way flow). Behavior is validated by the M5 two-window e2e; here it
// wires the tested cores (store / batch / rowConvert / viewReconcile / reconnectPolicy /
// statusModel).
// Reducer-rejection routing lands HERE (joinGame + subscription errors) and in
// main.ts (movement + non-movement sends) — SDK 2.6 has no per-reducer
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
import {
  createAuthTokenGate,
  tokenPersistenceFor,
  wasEverAuthenticated,
  writeAuthKind,
} from './authToken';
import { MicrotaskBatcher } from './batch';
import { claimCode } from './claimCode';
import {
  type ConnectCredential,
  decideConnectCredential,
  mayReachOidc,
  type SignInMode,
} from './credentialDecision';
import { type SendLogger, wrapReducerLogging } from './devLog';
import { createOidcClient, type OidcClient } from './oidc';
import {
  checkProtocol,
  type ProtocolMismatch,
  type ServerProtocol,
  serverProtocolFrom,
} from './protocolCheck';
import {
  accountRowToStore,
  battleChallengeRowToStore,
  characterRowToStore,
  evolutionPathRowToStore,
  healLocationRowToStore,
  itemRowToStore,
  npcRowToStore,
  playerConversationRowToStore,
  playerRowToStore,
  playerWalletRowToStore,
  profileRowToStore,
  type SdkAccountRow,
  type SdkBattleChallengeRow,
  type SdkCharacterRow,
  type SdkEvolutionPathRow,
  type SdkItemRowRow,
  type SdkPlayerRow,
  type SdkPlayerWalletRow,
  type SdkProfileRow,
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
import type { TargetKind } from './shellDocument';
import type { AuthoritativeStore } from './store';
import type { TicketSource, WorldGateEvent } from './worldTicket';
import { createOwnerViewReconciler, OWNER_VIEWS } from './viewReconcile';
import { isOwnZoneChange } from './warpDetect';
import {
  describeScope,
  INITIAL_SCOPE,
  onScopeEvent,
  PREFETCH_TILES,
  type ScopeEffect,
  type ScopeKey,
  type ScopeState,
  type ScopeSummary,
  type ScopeWarp,
  syncScope,
  wantedZones,
} from './worldScope';

/** How often the world scope is re-evaluated with nothing else happening: it is what ends a
 *  linger, retries a rejected set and notices one that never applied. */
const SCOPE_TICK_MS = 500;

export interface ConnectionOptions {
  readonly uri: string;
  readonly db: string;
  readonly name: string;
  readonly store: AuthoritativeStore;
  /** Initial subscription applied — the caller starts the loop (gated on wasm + own row). */
  readonly onReady: (identity: string) => void;
  /** Re-established after a drop: the caller resets the predictor + the loop re-seeds. Carries
   *  THIS connection's identity: a rebuild can mint a NEW anon
   *  identity (continueAnonymously / the nh4 token-rejection path), and a caller that keeps the
   *  old one deafens every identity-gated listener. Test-carried, not type-carried: TS parameter
   *  bivariance still accepts a zero-arg handler, so RSD17B-CARRIES / IDROT pin it. */
  readonly onReconnect: (identity: string) => void;
  /** hydration-complete edge. Fired from the batcher flush closure
   *  on the first flush after each applied snapshot — AFTER the view reconciles ran against the
   *  cache the SDK had fully populated before it emitted `applied` (2.6.0, unchanged at 2.11.0: apply → 'applied' →
   *  row callbacks, all synchronous) and BEFORE store.flushBatch(), so every listener that flush
   *  notifies observes it as already delivered. Once per applied snapshot (guaranteed today by
   *  the always-non-empty content subscriptions, which schedule that flush). MUST be total (never
   *  throw): it runs outside the reconcile try/catch, so a throw here would starve the flush. */
  readonly onHydrated: () => void;
  /** A non-movement failure to surface (status line). Movement-reducer rejections stay silent (M2 §3). */
  readonly onError: (where: string, message: string) => void;
  /** Called when the own entity crosses a zone boundary.
   *  Receives the new zone id so the caller can reload the map and reset prediction. */
  readonly onOwnWarp?: (newZoneId: number) => void;
  /** The world scope settled (true: the own character row's set and its zone's set are both
   *  applied, so the store holds the own zone's characters) or is not settled (false: a
   *  connection's scope has just opened, a warp into a zone not yet applied, a lost own row, a
   *  dropped or superseded connection). */
  readonly onScopeSettled?: (settled: boolean) => void;
  /** The warps of a zone, by the content's zone map. The world scope also holds the destination
   *  of each warp within `PREFETCH_TILES` of the own character. Absent: the own zone alone. MUST
   *  be total and cheap: it is read on every scope run, inside row callbacks. */
  readonly zoneWarps?: (zoneId: number) => readonly ScopeWarp[];
  /** dev-observability: outbound reducer-call sink. `undefined` (the default
   *  production build) makes wrapReducerLogging strict identity — no Proxy is installed. */
  readonly onSend?: SendLogger;
  /** A previously-authenticated session was definitively rejected. */
  readonly onSessionExpired?: () => void;
  /** The auth service stayed unreachable past the transient threshold. */
  readonly onAuthServiceUnreachable?: () => void;
  /** a FIRST sign-in exchange failed — routes to claimModel.
   *  `reason` is a static classifier-mapped string (AUTH-57), never raw provider text. */
  readonly onSignInFailed?: (reason: string) => void;
  /** A guest-claim reissue fired on the first applied snapshot. */
  readonly onClaimPending?: (code: string) => void;
  /** A claim code is outstanding but no account row has arrived yet. */
  readonly onClaimAwaitingAccount?: () => void;
  /** The guest-claim reducer settled. */
  readonly onClaimResult?: (result: { readonly ok: boolean; readonly message: string }) => void;
  /** Whether this connection may sign in to an account. `'off'` builds no OIDC client: every
   *  build is anonymous, no OIDC request is made, and startSignIn reports `'sign-in-off'`. */
  readonly signIn: SignInMode;
  /** The OIDC issuer / client-id / redirect for this target, read only when `signIn` is
   *  `'oidc'`. */
  readonly authIssuer?: string;
  readonly authClientId?: string;
  readonly authRedirectUri?: string;
  /** What the shell document says the server is. It decides where the anonymous reconnect token
   *  is kept (`tokenPersistenceFor`): on the device for `local` and `private`, per tab for
   *  `official` and `test`. */
  readonly targetKind: TargetKind;
  /** Whether the page runs in the desktop shell. Absent or false: a browser. */
  readonly desktop?: boolean;
  /** The world's name and where its ticket comes from. Present only when a ticket can be had. */
  readonly world?: { readonly name: string; readonly tickets: TicketSource };
  /** What the world's account gate should show next. */
  readonly onWorldGate?: (event: WorldGateEvent) => void;
  /** The protocol this client speaks (client-wasm's `protocol_version()`). Each connection checks
   *  it against the server's `module_info` row before it subscribes anything else. */
  readonly clientProtocol: number;
  /** The server cannot be spoken to; `side` says who must update. That connection has ended and
   *  the page builds no other one. */
  readonly onProtocolMismatch: (side: ProtocolMismatch) => void;
  /** The server admits no player without an account (the official server). An anonymous build
   *  then sends no joinGame. Absent or false, the connection learns the same from the first join
   *  the server refuses for ownership, and withholds every anonymous join after it. */
  readonly accountRequired?: boolean;
  /** An anonymous build's join was withheld because the server needs an account. Called on each
   *  such applied snapshot, just before `onReady` / `onReconnect`. */
  readonly onAccountRequired?: () => void;
  /** joinGame was refused with the server's ownership error. Reported here and never through
   *  `onError`, whose text is shown as it is. */
  readonly onOwnershipRefused?: () => void;
}

export interface Connection {
  /** The CURRENT live DbConnection, or undefined while no connection is built (cold start,
   *  mid-attempt, a parked terminal state, or a server the protocol check refused). Getter-backed. */
  readonly conn: DbConnection | undefined;
  /** The current live DbConnection, or undefined — the same slot the getter reads, exposed as
   *  a method so callers `const live = conn?.live()` and guard once (G26). */
  live(): DbConnection | undefined;
  identity(): string;
  /** Whether input/sends must be gated off: true while disconnected
   *  or reconnecting. Event-driven, never promise-driven — in-flight reducer
   *  promises never settle after a drop. */
  linkFrozen(): boolean;
  /** sticky decline — connect anonymously and stop retrying. */
  continueAnonymously(): void;
  /** The session terminal state driving the registry-external overlay. */
  sessionState(): SessionState;
  /** mint a claim code, then begin the OIDC sign-in redirect; with sign-in off, only report
   *  `'sign-in-off'` through onSignInFailed. While the server needs an account the redirect begins
   *  with no claim code: a connection it never admitted has no progress to claim. */
  startSignIn(): void;
  /** Fire a fresh connect attempt for the session 'retry' affordance. */
  reconnectNow(): void;
  /** joinGame on the live link, failures surfaced through onError('join', …) and an ownership
   *  refusal through onOwnershipRefused. A no-op while frozen or unbuilt: a call on a dead conn
   *  never settles, and the next onApplied joins (the claim flow only asks once it has cleared the
   *  code that vetoes that join). A no-op too for an anonymous build while the server needs an
   *  account. */
  join(): void;
  /** The `character` query sets the live connection holds (worldScope.ts). */
  worldScope(): ScopeSummary;
  /** The player asked for the world's account check to run now. */
  checkIn(): void;
}

/** The one error `join_game` answers a caller the server does not admit as an owner of the game
 *  (`ERR_OWNERSHIP_REQUIRED`, server-module/src/accounts.rs). Matched exactly. */
const ERR_OWNERSHIP_REQUIRED = 'ownership required';

/** R-rb-128-E1: re-join only on the PendingDeletion -> Active edge. An undefined `prev` (initial
 *  snapshot, post-reset) is onApplied's join. The claim-code veto is onApplied's; it scopes it to
 *  account builds, and only account builds ever carry an account row. */
export function shouldRejoinAfterAccountChange(
  prevStatus: string | undefined,
  nextStatus: string,
  claimCodeUnconsumed: boolean,
): boolean {
  return prevStatus === 'PendingDeletion' && nextStatus === 'Active' && !claimCodeUnconsumed;
}

export function connect(opts: ConnectionOptions): Connection {
  const { store, name } = opts;
  // Armed by each applied snapshot (stale-guarded), consumed by the FIRST flush after it.
  let snapshotApplied = false;
  // Which owner views changed since their last rebuild. ONE for ALL rebuilds, like the batcher:
  // every build's view handlers mark it, and each build, applied snapshot, store reset and
  // throwing row handler marks every view.
  const ownerViews = createOwnerViewReconciler();
  // Reconcile once per transaction: each row callback schedules; the batcher fires
  // store.flushBatch() once on the next microtask (no per-transaction SDK hook in 2.6).
  // ONE batcher for ALL rebuilds: a per-build batcher could fire a
  // stale flush after store.reset() wiped the rows it was coalescing. wireTables
  // re-registers row handlers per build, but every handler schedules through THIS
  // single instance, so a scheduled flush always reflects the current store.
  const batcher = new MicrotaskBatcher(() => {
    // Rebuild the changed owner-view collections from the SDK's post-burst cache BEFORE
    // notifying listeners (viewReconcile.ts). Stale-build guarded: `live !== undefined` is the
    // sanctioned spelling; while no build is live the marks wait for the next one.
    const live = current;
    if (live !== undefined) {
      ownerViews.reconcileOwnerViews(store, live.db);
    }
    // hydration-complete — AFTER the reconciles (the store now holds the applied snapshot)
    // and BEFORE flushBatch (listeners observe it delivered). Outside the live-guard on purpose:
    // a parked build (current = undefined) must not leave the flag armed for a later bogus edge.
    if (snapshotApplied) {
      snapshotApplied = false;
      opts.onHydrated();
    }
    store.flushBatch();
  });
  // Reconnect-credential gate. Built ONCE per connect() — NEVER inside
  // build(): its consecutive-rejection counter lives in this closure and is not persisted,
  // so a per-build gate would reset the counter on every scheduleRebuild() attempt,
  // suppression could never engage, and a host reset would loop forever re-supplying a
  // permanently rejected token.
  const auth = createAuthTokenGate(
    opts.uri,
    opts.db,
    globalThis,
    tokenPersistenceFor(opts.targetKind, opts.desktop === true),
  );
  let identity = '';
  let hadSession = false; // distinguishes the first connect from a reconnect (survives rebuilds)
  // App-level reconnect policy: pure transitions live in
  // reconnectPolicy.ts; this shell owns the timers and the current state.
  let state: ReconnectState = initialReconnectState();
  // ONE timer handle = the double-schedule guard: onDisconnect and
  // onConnectError both route through scheduleRebuild(); while a rebuild is already
  // pending, a second schedule attempt is a no-op.
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  // Teardown guard: once the page is going away, never rebuild.
  let teardown = false;
  // Set when the protocol check refuses the server: that connection is the page's last.
  let refused = false;
  // Ends the current build's world scope: its timer stops and its state is discarded. No handle
  // is unsubscribed, because every caller is leaving that connection behind.
  let stopScope: (() => void) | undefined;
  let scopeSummary: () => ScopeSummary = () => describeScope(INITIAL_SCOPE);
  // Build generation: each build() bumps this;
  // lifecycle callbacks from a SUPERSEDED build (a late onDisconnect the browser
  // buffered across a bfcache freeze, a slow onConnectError racing a successful
  // retry) compare their captured generation and no-op — a stale socket's events
  // must never reset the store, dirty the status line, or clobber identity/state
  // owned by the current build.
  let buildGen = 0;
  // The OIDC client for this target, built only in `'oidc'` mode. INJECTED host (globalThis) —
  // storage/crypto/fetch all go through it, never an ambient reach from this shell. With sign-in
  // off there is no client: the URL's return leg and any stored flow are left unread, and no
  // OIDC request is ever made.
  const oidc =
    opts.signIn === 'oidc'
      ? createOidcClient(globalThis, {
          issuer: opts.authIssuer ?? '',
          clientId: opts.authClientId ?? '',
          redirectUri: opts.authRedirectUri ?? '',
          uri: opts.uri,
          db: opts.db,
        })
      : undefined;
  // The three cross-rebuild ladder facts, declared at connect() scope
  // (NOT per build/attempt): a per-attempt copy resets on every reconnect and defeats each one.
  let isReturnLegAttempt = false; // set once from the OIDC return leg below; SINGLE-USE (D12)
  let consecutiveTransientErrors = 0; // AUTH_SERVICE_TRANSIENT_THRESHOLD's counter (D17)
  let forcedAnon = false; // set ONLY by continueAnonymously(); sticky for the tab's page life
  // The session terminal state the registry-external overlay reads through sessionState().
  let sessionMode: SessionState = 'hidden';
  // Whether the server admits no player without an account: what the caller said, or what the
  // first ownership refusal of this page taught. It only ever turns on. While it is on an
  // anonymous build sends no joinGame, and a sign-in starts with no claim code.
  let accountRequired = opts.accountRequired === true;
  // Whether `current` connected with an account token.
  let currentIsAccount = false;
  // In `'oidc'` mode, consume the OIDC return leg exactly once on cold start (D12): a matched state
  // records the authorization code and arms this attempt's gate so the first sign-in exchanges its
  // verifier.
  if (oidc?.consumeReturnLeg() === true) isReturnLegAttempt = true;

  /** Schedule ONE rebuild after the current backoff delay. */
  function scheduleRebuild(): void {
    if (teardown || rebuildTimer !== undefined) return;
    const delay = reconnectDelayMs(state.attempt);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      // attemptBuild owns the whole resolve→build cycle and is defensively total
      // (RT-01's synchronous-throw protection and C1's async-throw protection both live inside
      // it), so the timer body is a bare fire-and-forget of the one reconnect entry point.
      void attemptBuild();
    }, delay);
  }

  /**
   * Shared drop path: wipe stale rows, freeze the link, surface the loss ONCE (only on the
   * genuine connected→disconnected edge), and schedule the rebuild. onDisconnected counts the
   * drop of an attempt that never applied as that attempt's failure (one rung) and leaves an
   * already-down link as it is, so the SDK's onerror-then-onclose double event cannot transition
   * or climb twice (A7/A8). On a refused page it wipes and freezes only: nothing is reconnecting,
   * so nothing says so, and the rebuild it schedules builds nothing (attemptBuild).
   */
  function handleDrop(): void {
    stopScope?.();
    store.reset();
    ownerViews.markAllDirty();
    const wasConnected = state.link === 'connected';
    state = onDisconnected(state);
    if (wasConnected && !refused) opts.onError('link', 'connection lost — reconnecting…');
    scheduleRebuild();
  }

  /**
   * The protocol check refused the server `c` reached: this is the page's last connection. It
   * ends the way a drop does (scope stopped, rows wiped, link frozen) and nothing is built after
   * it; `current` is dropped so no reducer can be sent; a session terminal is cleared, since on a
   * refused page its actions cannot do anything. The socket is closed so the server sees this
   * connection end, and the caller is told last. Rows the SDK still delivers from the message being
   * dispatched land in the wiped store, as after the world scope's `drop`; its close event runs
   * the drop path once more and wipes them.
   */
  function refuse(c: DbConnection, side: ProtocolMismatch): void {
    refused = true;
    handleDrop();
    sessionMode = 'hidden';
    current = undefined;
    c.disconnect();
    opts.onProtocolMismatch(side);
  }

  // SINGLETON CONSTRAINT (review H1): connect() registers these window listeners
  // unbalanced (no removeEventListener) and they close over THIS call's state.
  // connect() is called exactly once per page lifetime (main()); a second call
  // would double-fire handleDrop and cross the teardown guards — do not add one
  // without extracting removable named handlers first.
  //
  // pagehide teardown: clear any pending reconnect timer and suppress
  // future scheduling — a dying page must not spawn a fresh WebSocket.
  window.addEventListener('pagehide', () => {
    teardown = true;
    stopScope?.();
    if (rebuildTimer !== undefined) {
      clearTimeout(rebuildTimer);
      rebuildTimer = undefined;
    }
  });

  // pageshow inverse: a bfcache restore resumes JS with the
  // pre-pagehide state — teardown=true, no timer, and a socket the browser killed
  // while the page was frozen (the SDK's onclose may have fired into the frozen page
  // and been lost). Without this, the client is permanently frozen after Back
  // navigation. persisted=false (a fresh load) never gets here: connect() below is
  // that path. handleDrop() is safe if the drop was already processed (a down link keeps its
  // rung); an attempt that was in flight when the page froze counts as failed.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    teardown = false;
    handleDrop();
  });

  /**
   * Register ALL table row handlers on a (re)built connection. Runs once per build:
   * a rebuilt DbConnection starts with ZERO handlers, so forgetting a table here
   * means the new connection silently ingests nothing for it (re-wire
   * everything or the reconnect looks connected but stays empty).
   */
  function wireTables(conn: DbConnection, runScope: () => void, onOwnAccount: () => void): void {
    // A row handler that throws stops the SDK dispatching the rest of that message, whose rows are
    // already in the SDK cache: a view whose own handler never ran would stay clean and stale. So
    // a throw from any other table's handler marks every owner view and schedules the flush, then
    // propagates unchanged.
    const recoverViewsOnThrow =
      <A extends unknown[]>(handler: (...args: A) => void) =>
      (...args: A): void => {
        try {
          handler(...args);
        } catch (err) {
          ownerViews.markAllDirty();
          batcher.schedule();
          throw err;
        }
      };
    const ingestChar = (row: SdkCharacterRow): void => {
      store.upsertCharacter(characterRowToStore(row), performance.now());
      batcher.schedule();
    };
    // The own rows decide the world scope (the entity id names the own-row set, the own
    // character's zone names the zone set), so each change to one re-evaluates it, after the
    // store holds the change.
    const scopeIfOwn = (row: SdkCharacterRow): void => {
      if (row.entityId === store.ownEntityId(identity)) runScope();
    };
    conn.db.character.onInsert(
      recoverViewsOnThrow((_ctx, row) => {
        ingestChar(row as unknown as SdkCharacterRow);
        scopeIfOwn(row as unknown as SdkCharacterRow);
      }),
    );
    conn.db.character.onUpdate(
      recoverViewsOnThrow((_ctx, oldRow, row) => {
        const newSdkRow = row as unknown as SdkCharacterRow;
        // detect own-entity zone transition via isOwnZoneChange
        // (warpDetect.ts — pure predicate, unit-tested independently; the raw SDK scalars
        // avoid a characterRowToStore() double-conversion just to compare zoneId).
        if (opts.onOwnWarp !== undefined) {
          const oldSdkRow = oldRow as unknown as SdkCharacterRow;
          const ownEntityId = store.ownEntityId(identity);
          if (ownEntityId !== undefined && isOwnZoneChange(oldSdkRow, newSdkRow, ownEntityId)) {
            opts.onOwnWarp(newSdkRow.zoneId);
          }
        }
        ingestChar(newSdkRow);
        scopeIfOwn(newSdkRow);
      }),
    );
    conn.db.character.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        const own = (row as unknown as SdkCharacterRow).entityId === store.ownEntityId(identity);
        store.removeCharacter((row as unknown as SdkCharacterRow).entityId);
        batcher.schedule();
        if (own) runScope();
      }),
    );

    const ingestPlayer = (row: SdkPlayerRow): void => {
      const player = playerRowToStore(row);
      store.upsertPlayer(player);
      batcher.schedule();
      if (player.identity === identity) runScope();
    };
    conn.db.player.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestPlayer(row as unknown as SdkPlayerRow)),
    );
    conn.db.player.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestPlayer(row as unknown as SdkPlayerRow)),
    );
    conn.db.player.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        const hex = (row as unknown as SdkPlayerRow).identity.toHexString();
        store.removePlayer(hex);
        batcher.schedule();
        if (hex === identity) runScope();
      }),
    );

    const ingestSpecies = (row: SdkSpeciesRowRow): void => {
      store.upsertSpecies(speciesRowToStore(row));
      batcher.schedule();
    };
    conn.db.species_row.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestSpecies(row as unknown as SdkSpeciesRowRow)),
    );
    conn.db.species_row.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestSpecies(row as unknown as SdkSpeciesRowRow)),
    );
    conn.db.species_row.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeSpecies((row as unknown as SdkSpeciesRowRow).id);
        batcher.schedule();
      }),
    );

    const ingestSkill = (row: SdkSkillRowRow): void => {
      store.upsertSkill(skillRowToStore(row));
      batcher.schedule();
    };
    conn.db.skill_row.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestSkill(row as unknown as SdkSkillRowRow)),
    );
    conn.db.skill_row.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestSkill(row as unknown as SdkSkillRowRow)),
    );
    conn.db.skill_row.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeSkill((row as unknown as SdkSkillRowRow).id);
        batcher.schedule();
      }),
    );

    const ingestItemDef = (row: SdkItemRowRow): void => {
      store.upsertItemDef(itemRowToStore(row));
      batcher.schedule();
    };
    conn.db.item_row.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestItemDef(row as unknown as SdkItemRowRow)),
    );
    conn.db.item_row.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestItemDef(row as unknown as SdkItemRowRow)),
    );
    conn.db.item_row.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeItemDef((row as unknown as SdkItemRowRow).id);
        batcher.schedule();
      }),
    );

    // The essence-graph edges. `sync_content` republishes this table as
    // N deletes + N inserts in ONE unordered transaction, RE-MINTING path_id while
    // keeping edge_id — so both the store map and this delete handler key off `pathId`.
    // Removing by edgeId would wipe the row the insert half of the same burst just
    // wrote, and the client's path map would silently empty.
    const ingestEvolutionPath = (row: SdkEvolutionPathRow): void => {
      store.upsertEvolutionPath(evolutionPathRowToStore(row));
      batcher.schedule();
    };
    conn.db.evolution_path.onInsert(
      recoverViewsOnThrow((_ctx, row) =>
        ingestEvolutionPath(row as unknown as SdkEvolutionPathRow),
      ),
    );
    conn.db.evolution_path.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) =>
        ingestEvolutionPath(row as unknown as SdkEvolutionPathRow),
      ),
    );
    conn.db.evolution_path.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeEvolutionPath((row as unknown as SdkEvolutionPathRow).pathId);
        batcher.schedule();
      }),
    );

    // conversation / heal_location_row / npc (quests are an owner view, viewReconcile.ts).
    // conversations arrive through the owner-scoped
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
    conn.db.my_conversation.onInsert(
      recoverViewsOnThrow((_ctx, row) => {
        store.upsertConversation(
          playerConversationRowToStore(row as unknown as SdkConversationRow),
        );
        batcher.schedule();
      }),
    );
    conn.db.my_conversation.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        const deleted = playerConversationRowToStore(row as unknown as SdkConversationRow);
        if (shouldRemoveOnViewDelete(store.ownConversation(deleted.ownerIdentity), deleted)) {
          store.removeConversation(deleted.ownerIdentity);
        }
        batcher.schedule();
      }),
    );

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
    conn.db.heal_location_row.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestHealLocation(row as unknown as SdkHealRow)),
    );
    conn.db.heal_location_row.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestHealLocation(row as unknown as SdkHealRow)),
    );
    conn.db.heal_location_row.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeHealLocation((row as unknown as SdkHealRow).locationId);
        batcher.schedule();
      }),
    );

    // zone_def (public content, PK zone_id): the client's only zone-name source, read by main.ts's
    // zone cue (qf-15). A regular table, so onUpdate fires — the heal_location_row per-row idiom,
    // not the PK-less view rebuild.
    const ingestZoneName = (row: { zoneId: number; name: string }): void => {
      store.upsertZoneName(row.zoneId, row.name);
      batcher.schedule();
    };
    conn.db.zoneDef.onInsert(recoverViewsOnThrow((_ctx, row) => ingestZoneName(row)));
    conn.db.zoneDef.onUpdate(recoverViewsOnThrow((_ctx, _old, row) => ingestZoneName(row)));
    conn.db.zoneDef.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeZoneName(row.zoneId);
        batcher.schedule();
      }),
    );

    type SdkNpcRow = {
      entityId: bigint;
      npcId: string;
      zoneId: number;
      homeX: number;
      homeY: number;
      wanderRadius: number;
      dialogueTreeId: string;
      // The NpcInteraction tagged union as the SDK delivers
      // it — normalized (totally, AC-16) by npcRowToStore.
      interaction: { tag: string; value?: number };
    };
    const ingestNpc = (row: SdkNpcRow): void => {
      store.upsertNpc(npcRowToStore(row));
      batcher.schedule();
    };
    conn.db.npc.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestNpc(row as unknown as SdkNpcRow)),
    );
    conn.db.npc.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestNpc(row as unknown as SdkNpcRow)),
    );
    conn.db.npc.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeNpc((row as unknown as SdkNpcRow).entityId);
        batcher.schedule();
      }),
    );

    // shop_row / shop_item_row — public content tables.
    const ingestShop = (row: SdkShopRowRow): void => {
      store.upsertShop(shopRowToStore(row));
      batcher.schedule();
    };
    conn.db.shop_row.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestShop(row as unknown as SdkShopRowRow)),
    );
    conn.db.shop_row.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestShop(row as unknown as SdkShopRowRow)),
    );
    conn.db.shop_row.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeShop((row as unknown as SdkShopRowRow).shopId);
        batcher.schedule();
      }),
    );

    const ingestShopItem = (row: SdkShopItemRowRow): void => {
      store.upsertShopItem(shopItemRowToStore(row));
      batcher.schedule();
    };
    conn.db.shop_item_row.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestShopItem(row as unknown as SdkShopItemRowRow)),
    );
    conn.db.shop_item_row.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestShopItem(row as unknown as SdkShopItemRowRow)),
    );
    conn.db.shop_item_row.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeShopItem((row as unknown as SdkShopItemRowRow).shopItemId);
        batcher.schedule();
      }),
    );

    // ux2b: my_wallet — the owner-scoped VIEW over the PRIVATE
    // player_wallet table. INSERT-ONLY, on purpose.
    // TRIPWIRE — deliberately NO onDelete and deliberately NO onUpdate handler, and
    // deliberately NO shouldRemoveOnViewDelete gate (do NOT copy the my_conversation
    // block above — it is the nearest precedent and it is both dead and wrong here):
    //   * no onDelete — no server path ever deletes a player_wallet row
    //     (economy_tests.rs::player_wallet_rows_are_never_deleted is the soundness gate),
    //     AND through a view a row UPDATE arrives as unordered onInsert(new) +
    //     onDelete(old), so on a buy-then-sell round trip the coalesced
    //     `I(50) I(100) D(100) D(50)` makes ANY net-effect delete gate remove the LIVE
    //     row and the player's gold vanishes mid-session. store.reset() on disconnect is
    //     the SOLE clearing path — which is why store.ts ships upsertWallet with no
    //     removeWallet counterpart at all.
    //   * no onUpdate — a view table has no PK for SDK correlation, so it never fires;
    //     wiring one implies a delivery guarantee the transport does not make.
    // If the server ever grows a wallet-delete path, this absence is the review tripwire:
    // revisit the no-delete wallet decision first, then wire removal + the store API in the same change.
    conn.db.my_wallet.onInsert(
      recoverViewsOnThrow((_ctx, row) => {
        store.upsertWallet(playerWalletRowToStore(row as unknown as SdkPlayerWalletRow));
        batcher.schedule();
      }),
    );

    // battle_challenge (public table — challenger + target subscribe).
    // Challenges are deleted server-side when Accepted/Declined/Cancelled
    // (pvp.rs — the delete fires onDelete here, removing the stale row).
    const ingestChallenge = (row: SdkBattleChallengeRow): void => {
      store.upsertChallenge(battleChallengeRowToStore(row));
      batcher.schedule();
    };
    conn.db.battle_challenge.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestChallenge(row as unknown as SdkBattleChallengeRow)),
    );
    conn.db.battle_challenge.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) =>
        ingestChallenge(row as unknown as SdkBattleChallengeRow),
      ),
    );
    conn.db.battle_challenge.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeChallenge((row as unknown as SdkBattleChallengeRow).challengeId);
        batcher.schedule();
      }),
    );

    // Profile (PUBLIC table — the ranked leaderboard). The client holds the leaderboard_top
    // members' rows and its own row (the two profile queries in the subscription below).
    // profile is a REGULAR table with a primary key, so onUpdate fires normally — the
    // my_conversation view-delete gating above does NOT apply here. The server never deletes a
    // profile row; a delete is a member leaving the top 100. The own row is held by its own query
    // too, and the SDK counts rows per primary key across queries, so it never sees that delete.
    const ingestProfile = (row: SdkProfileRow): void => {
      store.upsertProfile(profileRowToStore(row));
      batcher.schedule();
    };
    conn.db.profile.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestProfile(row as unknown as SdkProfileRow)),
    );
    conn.db.profile.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestProfile(row as unknown as SdkProfileRow)),
    );
    conn.db.profile.onDelete(
      recoverViewsOnThrow((_ctx, row) => {
        store.removeProfile((row as unknown as SdkProfileRow).identity.toHexString());
        batcher.schedule();
      }),
    );

    // my_account is the owner-scoped VIEW over the PRIVATE account table
    // (subscribed above) and is the sole reconciliation authority for "am I signed in" (AUTH-51).
    // It needs BOTH onInsert AND onUpdate — status/claimed_from MUTATE after provisioning (a guest
    // claim re-keys the row mid-session; delete_account flips status to PendingDeletion). But
    // deliberately there is no conn.db.my_account.onDelete handler: through a view an UPDATE
    // arrives as unordered onInsert(new) + onDelete(old), so any delete delivered is the STALE
    // half of an update pair and would wipe the live account slot — and no server path ever truly
    // deletes an account row. store.reset() on disconnect is the SOLE clearing path (mirrors the
    // my_wallet TRIPWIRE above), which is why store.ts ships upsertAccount with no removeAccount.
    // R-rb-128-E1: a mid-grace drop deleted the player row and join_game refused while
    // PendingDeletion, so the PendingDeletion -> Active edge (cancel_account_deletion) re-joins.
    // `prev` is read BEFORE the upsert; a still-connected player gets the benign "already joined".
    // A superseded socket neither writes the account slot nor joins: its write would consume the
    // edge the current build still has to see. Joins go out on the current, already-wrapped handle.
    // Every own row then goes to `onOwnAccount`, which sends a guest claim the join gate left
    // waiting for this row.
    const ingestAccount = (row: SdkAccountRow): void => {
      const live = current;
      if (live === undefined || rawConnectionOf.get(live) !== conn) return;
      const prev = store.ownAccount(identity)?.status;
      const next = accountRowToStore(row);
      store.upsertAccount(next);
      batcher.schedule();
      if (next.identity !== identity) return;
      const codeUnconsumed = claimCode.hasUnconsumed(globalThis, opts.uri, opts.db);
      if (shouldRejoinAfterAccountChange(prev, next.status, codeUnconsumed)) {
        attemptJoin(live, name, opts.onError);
      }
      onOwnAccount();
    };
    conn.db.my_account.onInsert(
      recoverViewsOnThrow((_ctx, row) => ingestAccount(row as unknown as SdkAccountRow)),
    );
    conn.db.my_account.onUpdate(
      recoverViewsOnThrow((_ctx, _old, row) => ingestAccount(row as unknown as SdkAccountRow)),
    );

    // The owner views (viewReconcile.ts) are PK-less, so the SDK never fires onUpdate for them
    // (none is wired) and every change is an unordered insert+delete pair: a handler writes
    // nothing to the store, it marks its view and schedules the flush, which rebuilds that view
    // from the cache. onDelete is wired for every view: a row leaving one (the export TTL reaper,
    // the deletion cascade, the guest-claim rekey, a finished battle's GC, a completed quest) must
    // rebuild it too.
    for (const view of OWNER_VIEWS) {
      const viewChanged = (): void => {
        ownerViews.markDirty(view);
        batcher.schedule();
      };
      conn.db[view].onInsert(viewChanged);
      conn.db[view].onDelete(viewChanged);
    }
  }

  /** Issue joinGame through a WRAPPED connection — the ONE join path (onApplied, the
   *  cancel-deletion re-join, and join() for the claim flow). Extracted ONCE:
   *  devLog builds a fresh Proxy per call, so an inline re-wrap double-logs every reducer call.
   *  The server's ownership refusal turns `accountRequired` on and goes to onOwnershipRefused,
   *  whichever of the three asked. */
  function attemptJoin(
    conn: DbConnection,
    name: string,
    onError: ConnectionOptions['onError'],
  ): void {
    const gen = buildGen;
    conn.reducers.joinGame({ name }).catch((err) => {
      const msg = (err as Error)?.message ?? '';
      if (msg === ERR_OWNERSHIP_REQUIRED) {
        // The server admits only a player who owns the game. A refusal that settles after a newer
        // build was started reports nothing: that build's own join decides.
        if (gen !== buildGen) return;
        accountRequired = true;
        opts.onOwnershipRefused?.();
        return;
      }
      // "already joined" is benign: either the server has not processed the old session's drop
      // yet, or it processed it and kept the rows because this rebuilt
      // connection was still live — either way the rows live and the new subscription
      // re-hydrates them. EXACT match.
      if (msg !== 'already joined') onError('join', msg || 'join failed');
    });
  }

  /**
   * Build a fresh DbConnection for `credential`, lifecycle + table handlers wired. Called ONLY
   * from attemptBuild(), which owns the generation bump and the resolve→build sequencing.
   * Stays SYNCHRONOUS; widens its return to `DbConnection | undefined` only so a
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

    // This connection's guest claim: 'awaiting' once the join gate found a claim code but no own
    // account row, 'sent' once complete_guest_claim went out. Whichever path sends sets 'sent', so
    // the claim goes out at most once per connection.
    let claim: 'idle' | 'awaiting' | 'sent' = 'idle';
    // Sends complete_guest_claim for the stored code and reports the reducer's answer through
    // onClaimResult. Answers the code it sent, or undefined when there is none or the call threw
    // (the latch is then unchanged).
    const sendClaim = (c: DbConnection): string | undefined => {
      const code = claimCode.read(globalThis, opts.uri, opts.db);
      if (code === undefined) return undefined;
      let pendingClaim: Promise<void>;
      try {
        // Call on the RAW connection, NOT wrapReducerLogging(c): the dev-observability
        // Proxy JSON-stringifies reducer args to the onSend sink, and `code` is a bearer
        // secret (whoever holds it can steal this guest's progress). joinGame's `{name}` is
        // sanctioned free text; a claim code categorically is not (AUTH-57 spirit; the G21
        // scanner can't see this indirect sink — its own residual R4). Assigned first so the
        // `.reducers.completeGuestClaim({ code })` call stays contiguous (biome breaks a short
        // receiver's method chain otherwise) — G18 pins that exact needle.
        pendingClaim = c.reducers.completeGuestClaim({ code });
      } catch (err) {
        console.error('[claim] complete_guest_claim threw', err);
        return undefined;
      }
      claim = 'sent';
      // Two-argument `then`: the reject arm sees only the reducer's rejection, so a throw
      // inside the success handler is logged and never reported as a refused claim.
      pendingClaim
        .then(
          () => opts.onClaimResult?.({ ok: true, message: '' }),
          (err) => opts.onClaimResult?.({ ok: false, message: (err as Error)?.message ?? '' }),
        )
        .catch((err) => console.error('[claim] result handler error', err));
      return code;
    };
    // The own account row reached the store. A claim the gate left waiting goes out now, alone:
    // onClaimPending is the gate's (the caller re-opens its claim prompt from it on a reconnect),
    // so this path reports only through onClaimResult. ingestAccount calls it only for the current
    // build, and sendClaim sends nothing once the code is gone.
    const sendAwaitedClaim = (): void => {
      if (claim === 'awaiting') sendClaim(conn);
    };

    // The world scope of THIS build: which `character` query sets it holds beyond the base set.
    // Per build, so a rebuilt connection starts with none. worldScope.ts decides; this block only
    // reads the own rows, executes the effects and reports each handle's outcome back.
    type ScopeHandle = { isActive(): boolean; unsubscribe(): void };
    // One record per live set. A callback acts only while its own record is still the key's, so
    // a set that was unsubscribed or replaced by a retry cannot report into its successor.
    const scopeHandles = new Map<ScopeKey, { handle?: ScopeHandle }>();
    let scope: ScopeState = INITIAL_SCOPE;
    let scopeConn: DbConnection | undefined;
    let scopeTimer: ReturnType<typeof setInterval> | undefined;
    const endScope = (): void => {
      if (scopeTimer !== undefined) clearInterval(scopeTimer);
      scopeTimer = undefined;
      scopeConn = undefined;
      scopeHandles.clear();
      const wasSettled = scope.settled;
      scope = INITIAL_SCOPE;
      if (wasSettled) opts.onScopeSettled?.(false);
    };
    const scopeEvent = (kind: 'applied' | 'rejected', key: ScopeKey): void => {
      scope = onScopeEvent(scope, { kind, key, now: performance.now() });
      runScope();
    };
    const runScopeEffect = (c: DbConnection, effect: ScopeEffect): void => {
      switch (effect.kind) {
        case 'subscribe': {
          const { key } = effect;
          const rec: { handle?: ScopeHandle } = {};
          const mine = (): boolean => !stale() && scopeHandles.get(key) === rec;
          scopeHandles.set(key, rec);
          rec.handle = c
            .subscriptionBuilder()
            .onApplied(() => {
              if (mine()) scopeEvent('applied', key);
            })
            .onError((ctx) => {
              if (!mine()) return;
              opts.onError('subscribe', subscriptionErrorMessage(ctx));
              scopeHandles.delete(key);
              scopeEvent('rejected', key);
            })
            .subscribe(effect.query);
          return;
        }
        case 'unsubscribe': {
          const rec = scopeHandles.get(effect.key);
          scopeHandles.delete(effect.key);
          if (rec?.handle?.isActive()) rec.handle.unsubscribe();
          return;
        }
        case 'settled':
          opts.onScopeSettled?.(effect.settled);
          return;
        case 'drop':
          // The sets this client needs cannot be had on this connection (rejected past the
          // retries, or never applied): take the drop path, then close the socket the SDK
          // still holds open so the server sees this connection end.
          handleDrop();
          c.disconnect();
          return;
      }
    };
    // TOTAL: it runs inside row callbacks and a timer, where a throw would break the SDK's
    // dispatch of the rest of the message.
    const runScope = (): void => {
      const c = scopeConn;
      if (c === undefined || stale()) return;
      try {
        const own = store.ownCharacter(identity)?.row;
        // The own zone, plus the destination of each warp the own row stands near: that zone's
        // rows are then in the store before the warp, so the arrival draws them on its first
        // frame. Read from the authoritative row, never the predicted tile or the drawn map.
        const warps = own === undefined ? [] : (opts.zoneWarps?.(own.zoneId) ?? []);
        const step = syncScope(scope, {
          wantEntity: store.ownEntityId(identity),
          ownZone: own?.zoneId,
          wantZones: wantedZones(own, warps, PREFETCH_TILES),
          now: performance.now(),
        });
        scope = step.state;
        for (const effect of step.effects) {
          try {
            runScopeEffect(c, effect);
          } catch (err) {
            console.error('[net] world scope effect threw (continuing)', effect.kind, err);
          }
        }
      } catch (err) {
        opts.onError('subscribe', err instanceof Error ? err.message : 'world scope failed');
      }
    };

    const conn = DbConnection.builder()
      .withUri(opts.uri)
      .withDatabaseName(opts.db)
      // The token is decided by THIS build's `credential` ALONE, computed in memory
      // on this same attempt — never re-derived from mutable storage. `=== 'account'` is
      // fail-closed on the permissive value, so a future variant can never leak an account token.
      .withToken(credential.kind === 'account' ? credential.token : auth.tokenForNextAttempt())
      .onConnect((c, id, token) => {
        if (stale()) return; // superseded build: never clobber identity/subscriptions
        // Save the anon reconnect token ONLY for an anon build: the SDK echoes the supplied JWT
        // back as `token`, so on an account build this argument is the short-lived account JWT and
        // must never enter the anonymous slot (`=== 'anon'` is the fail-closed side).
        if (credential.kind === 'anon') auth.onConnected(token);
        // D13/D14: a first-paint HINT for account builds, superseded by my_account's first snapshot
        // (D15) and never a security input — provenance is `credential`, never this marker.
        if (credential.kind === 'account') writeAuthKind(globalThis, opts.uri, opts.db, 'account');
        identity = id.toHexString();
        const reconnecting = hadSession;
        // The base set, opened only once the protocol check below admits this client.
        const openBaseSet = (): void => {
          c.subscriptionBuilder()
            .onApplied(() => {
              if (stale()) return; // superseded build: never unfreeze/join on a dead link
              // The snapshot is in the cache: every owner view is rebuilt on the next batch. First,
              // so a throwing callback below cannot skip it.
              ownerViews.markAllDirty();
              // The link is fully usable only once the initial snapshot applies: unfreeze + reset
              // the backoff ladder here (the ONLY attempt reset), and clear any session terminal.
              state = onConnected(state);
              sessionMode = 'hidden';
              // Join gate, re-evaluated FRESH every applied snapshot. An anonymous build joins
              // unless the server needs an account (`accountRequired`): then it sends nothing and
              // says so, and the caller offers sign-in. Otherwise it always joins: the idempotent
              // A4 re-join (server on_disconnect deletes the player + character rows when the
              // identity's LAST live connection ends, so a reconnect must still attempt the join).
              // An account build has ONE veto, the claim code; my_account presence is NEVER
              // consulted in it (AUTH-52).
              const codeUnconsumed = claimCode.hasUnconsumed(globalThis, opts.uri, opts.db);
              const isAccount = credential.kind === 'account';
              if (accountRequired && !isAccount) {
                opts.onAccountRequired?.();
              } else if (!isAccount || !codeUnconsumed) {
                attemptJoin(wrapReducerLogging(c, opts.onSend), name, opts.onError);
              } else {
                // AUTH-53: re-issue complete_guest_claim on THIS connection's first applied snapshot
                // once the own account row is there — a pre-drop promise never settles. onClaimPending
                // is a UX notification fired ALONGSIDE the reducer call, never a substitute for it.
                // The SDK calls this before it dispatches the snapshot's row callbacks, so an own
                // account row of this snapshot is in the cache of `conn` (the connection `c` is) and
                // not yet in the store.
                const code =
                  store.ownAccount(identity) !== undefined || ownAccountCached(conn)
                    ? sendClaim(c)
                    : undefined;
                if (code !== undefined) {
                  opts.onClaimPending?.(code);
                } else {
                  // The own row's arrival sends it (sendAwaitedClaim).
                  claim = 'awaiting';
                  opts.onClaimAwaitingAccount?.(); // UX polish only — the veto above is what makes F2 safe
                }
              }
              // The link is live: open the world scope. The first run usually finds no own rows
              // yet (they arrive as row callbacks after this one); each own-row callback runs it
              // again, and the timer runs it while nothing else does.
              scopeConn = c;
              stopScope = endScope;
              scopeSummary = () => describeScope(scope);
              scopeTimer = setInterval(runScope, SCOPE_TICK_MS);
              opts.onScopeSettled?.(false);
              runScope();
              // Arm the hydration edge BEFORE notifying, so a throwing callback cannot lose it.
              snapshotApplied = true;
              hadSession = true;
              if (reconnecting) opts.onReconnect(identity);
              else opts.onReady(identity);
            })
            // Forward the SDK's subscription-error payload; subscriptionErrorMessage is
            // fallback-guarded against shape surprises.
            .onError((ctx) => opts.onError('subscribe', subscriptionErrorMessage(ctx)))
            .subscribe([
              // `character` is NOT in this set: it is the one table written on every step, so it
              // is subscribed by the world scope above as the own row plus one set per wanted
              // zone. `player` is world-wide: nothing writes it per step, and it is the directory
              // the Players tab, names and trade / challenge targeting read.
              'SELECT * FROM player',
              // monster_pub is PRIVATE — subscribe
              // the owner-scoped my_monster_pub view instead (the my_conversation /
              // my_wallet pattern). Other players' monster rows are need-to-know
              // and are not delivered at all (no client consumer exists).
              'SELECT * FROM my_monster_pub',
              'SELECT * FROM species_row',
              // battle is PRIVATE — subscribe the
              // participant-scoped my_battle view instead (the my_monster_pub /
              // my_wallet pattern). Each client receives only rows where it is
              // player_identity or opponent_identity; store.ongoingBattle's
              // own-identity filter remains as defense-in-depth.
              'SELECT * FROM my_battle',
              'SELECT * FROM skill_row',
              // inventory is PRIVATE — subscribe the owner-scoped my_inventory view instead
              // (the my_monster_pub pattern; subscribing the private table errors the whole
              // batch). store.ownInventory's owner filter stays as defense in depth. item_row
              // is public content (no owner).
              'SELECT * FROM my_inventory',
              'SELECT * FROM item_row',
              // evolution_path is public content (every authored edge is visible to every
              // player — EG3/EG4). The name is EXACT: a wrong table name errors the WHOLE
              // subscription batch and onApplied never fires.
              'SELECT * FROM evolution_path',
              // dialogue / quest / heal / npc tables.
              // player_conversation is PRIVATE — subscribe the
              // owner-scoped my_conversation view instead (subscribing the private
              // table errors the whole batch and onApplied never fires).
              'SELECT * FROM my_conversation',
              // player_quest is PRIVATE — subscribe the owner-scoped my_player_quest view instead
              // (the my_inventory pattern; subscribing the private table errors the whole batch).
              // store.ownQuests's owner filter stays as defense in depth.
              'SELECT * FROM my_player_quest',
              'SELECT * FROM heal_location_row',
              'SELECT * FROM npc',
              'SELECT * FROM zone_def',
              // shop catalog (public content).
              'SELECT * FROM shop_row',
              'SELECT * FROM shop_item_row',
              // ux2b: player_wallet is PRIVATE — subscribe the owner-scoped my_wallet
              // view instead, exactly as my_conversation is subscribed above.
              // Subscribing the private table would error the whole batch and onApplied
              // would never fire.
              'SELECT * FROM my_wallet',
              // battle_challenge is a PUBLIC runtime table; challenger
              // and target subscribe. battle_action is PRIVATE (must-never-leak)
              // and MUST NEVER be subscribed here.
              'SELECT * FROM battle_challenge',
              // The leaderboard (RL-13): the profile rows of the leaderboard_top members (the top
              // 100, kept by the server) and the caller's own row, never the whole profile table,
              // which grows with every account that ever rated.
              'SELECT profile.* FROM profile JOIN leaderboard_top ON profile.identity = leaderboard_top.identity',
              `SELECT * FROM profile WHERE identity = 0x${identity}`,
              // my_account is the owner-scoped VIEW over the PRIVATE account
              // table — the sole reconciliation authority for "am I signed in" (AUTH-51). Ingested
              // with onInsert + onUpdate (and NO onDelete) in wireTables above. Subscribing the
              // private `account` table itself would error the whole batch and onApplied never fires.
              'SELECT * FROM my_account',
              // my_export_bundle is the owner-scoped VIEW over the PRIVATE
              // export_bundle table — the ONLY client read path for a completed data export.
              // Subscribing `export_bundle` itself would error the whole batch.
              'SELECT * FROM my_export_bundle',
              // my_pending_evolution_notices is the owner-scoped VIEW over
              // the PRIVATE pending_evolution_notice table — subscribing the table itself would
              // error the whole batch and onApplied would never fire.
              'SELECT * FROM my_pending_evolution_notices',
              // The seven owner- / participant-scoped tactical VIEWS (schema.rs
              // my_tactical_battle … my_formation). Every table behind them is PRIVATE — subscribing
              // `battle_unit` or `player_formation` itself would error the whole batch and
              // onApplied would never fire. Names are EXACT.
              'SELECT * FROM my_tactical_battle',
              'SELECT * FROM my_battle_units',
              'SELECT * FROM my_battle_queue',
              'SELECT * FROM my_battle_deploy',
              'SELECT * FROM my_battle_clock',
              'SELECT * FROM my_battle_events',
              'SELECT * FROM my_formation',
              // my_trade_session is the participant-scoped VIEW over the PRIVATE trade_session
              // table: each client receives only the sessions it is in. Subscribing `trade_session`
              // itself would error the whole batch.
              'SELECT * FROM my_trade_session',
            ]);
        };
        // The protocol check (protocolCheck.ts): `module_info` alone first. Until its verdict
        // nothing else is subscribed and no reducer is called. An admitted build is judged again
        // whenever the row changes, from the cache, and only toward refusal: a server whose
        // numbers move past this client mid-session is left, and a refused page is never admitted.
        let admitted = false;
        // TOTAL: a read that throws would leave the client with no verdict, so it is a refusal.
        const readServerProtocol = (): ServerProtocol => {
          try {
            return serverProtocolFrom(c.db.moduleInfo.iter());
          } catch (err) {
            console.error('[net] module_info could not be read', err);
            return 'refused';
          }
        };
        const judge = (server: ServerProtocol): void => {
          if (stale() || refused) return;
          const verdict = checkProtocol(server, opts.clientProtocol);
          if (verdict !== 'ok') {
            refuse(c, verdict);
            return;
          }
          if (admitted) return;
          admitted = true;
          const rejudge = (): void => judge(readServerProtocol());
          c.db.moduleInfo.onInsert(rejudge);
          c.db.moduleInfo.onUpdate(rejudge);
          c.db.moduleInfo.onDelete(rejudge);
          openBaseSet();
        };
        c.subscriptionBuilder()
          .onApplied(() => judge(readServerProtocol()))
          // A refused query is what a module that predates `module_info` answers. Once admitted,
          // an error of this set decides nothing.
          .onError((ctx) => {
            if (stale() || admitted) return;
            console.error('[net] module_info subscription refused', subscriptionErrorMessage(ctx));
            judge('refused');
          })
          .subscribe('SELECT * FROM module_info');
      })
      .onConnectError((_ctx, err: Error) => {
        if (stale()) return; // a superseded build's late failure must not dirty the status line
        // Classify this failure. A credential rejection advances the gate's
        // counter and, at the threshold, makes the NEXT build connect anonymously; anything
        // else leaves it as it is, so an unreachable host never costs the player their identity.
        // Reporting rides the EXISTING backoff ladder below — no second retry path.
        auth.onConnectFailed(err);
        // A failed (re)build attempt: surface, climb the backoff ladder, retry.
        opts.onError('connect', err.message);
        state = onAttemptFailed(state);
        scheduleRebuild();
      })
      // Clean re-init on a drop: drop stale rows so a reconnect never merges stale
      // state. CONFIRMED (closes the M5 open question): the SDK does NOT
      // auto-reconnect on the raw builder path — the app-level rebuild via
      // handleDrop() is the reconnect mechanism. Stale-guarded: a
      // buffered onDisconnect from a superseded build (bfcache) must not wipe rows
      // the CURRENT build's subscription already delivered (review RT-02).
      .onDisconnect(() => {
        if (stale()) return;
        handleDrop();
      })
      .build();
    wireTables(conn, runScope, sendAwaitedClaim);
    // A new connection is a new cache: every owner view is rebuilt from it on the next batch,
    // whether or not this rebuild reset the store (reconnectNow and continueAnonymously do not).
    ownerViews.markAllDirty();
    // dev-observability: wrap AFTER wireTables so the inbound row callbacks
    // stay wired to the RAW connection. Identity when opts.onSend is undefined.
    const wrapped = wrapReducerLogging(conn, opts.onSend);
    rawConnectionOf.set(wrapped, conn);
    return wrapped;
  }

  /** Whether `c`'s cache holds the own `my_account` row. */
  function ownAccountCached(c: DbConnection): boolean {
    for (const row of c.db.my_account.iter()) {
      if (accountRowToStore(row as unknown as SdkAccountRow).identity === identity) return true;
    }
    return false;
  }

  // Wrapped (logging) connection -> the RAW connection it wraps. startSignIn sends the claim
  // code, a bearer secret, and must bypass the dev reducer-arg logger exactly as the
  // completeGuestClaim reissue does.
  const rawConnectionOf = new WeakMap<DbConnection, DbConnection>();

  // The current live connection, undefined until an attempt builds one (and reset
  // to undefined by the parked session terminals). Declared immediately after build().
  let current: DbConnection | undefined;

  /**
   * The ONE real I/O boundary. Decides which credential build() should act on,
   * consulting Better Auth ONLY when the attempt gate is open — a never-authenticated, declined or
   * sign-in-off tab makes ZERO network calls (AUTH-43/44/49). TOTAL by contract
   * (oidc.renewOrExchange maps every internal error to 'transient-error'); attemptBuild's
   * try/catch is the belt.
   */
  async function resolveCredential(): Promise<ConnectCredential> {
    if (forcedAnon) return { kind: 'anon', token: auth.tokenForNextAttempt() };
    const attemptGateOpen = mayReachOidc({
      signIn: opts.signIn,
      everAuthenticated: wasEverAuthenticated(globalThis, opts.uri, opts.db),
      returnLeg: isReturnLegAttempt,
    });
    // SINGLE-USE (D12): consumed on this read regardless of outcome, so a later ordinary reconnect
    // never re-drives the exchange with no stored verifier left to act on.
    isReturnLegAttempt = false;
    // `oidc` is undefined exactly when the gate is shut by sign-in off; the check narrows its type.
    if (!attemptGateOpen || oidc === undefined) {
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
   * The ONE caller of build(), and so the entry of every build path: the rebuild timer, the cold
   * start, reconnectNow and continueAnonymously. Starts the reconnect attempt and bumps the
   * generation before the async gap, resolves the credential inside an exception boundary (C1:
   * an ordinary Better Auth hiccup must never stop the ladder), re-checks staleness after the
   * await, and routes each terminal kind. On a page the protocol check refused it builds nothing.
   */
  async function attemptBuild(): Promise<void> {
    if (refused) return;
    // Started here, before the async gap, so every failure of this attempt — an arm below, or
    // the build's own onConnectError / onDisconnect — finds an attempt in flight and climbs the
    // ladder once for it.
    state = onReconnectAttempt(state);
    // The build this attempt supersedes stops driving its world scope.
    stopScope?.();
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
      // biome-ignore format: kept as one line on purpose.
      current = build(credential.kind === 'sign-in-failed' ? { kind: 'anon', token: auth.tokenForNextAttempt() } : credential);
      currentIsAccount = credential.kind === 'account';
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

  /** AUTH-48: mint the claim code, register it with `start_guest_claim` while still connected as
   *  the GUEST (the code is written to storage BEFORE the reducer call, and only that
   *  reducer inserts the row `complete_guest_claim` later resolves), and only once the registration
   *  has SETTLED hand off to the OIDC redirect (the redirect leaves the page). A registration that
   *  cannot happen — no live link, no CSPRNG, or a refused reducer — BLOCKS sign-in: the code is
   *  cleared and the claim UI shows the transient-error copy, because signing in without a
   *  registered code would silently strand the guest's progress. beginSignIn is TOTAL (never
   *  rejects, oidc.ts C1) — its .catch is a belt only. On a 'ready' result the tab leaves the page;
   *  any other kind degrades to the claim UI's failure copy (the intended behaviour against the
   *  `.invalid` placeholder issuer until a real issuer is deployed) and KEEPS the registered code.
   *  With sign-in off it reports `'sign-in-off'` first and does nothing else: no claim code, no
   *  reducer call, no request.
   *  While the server needs an account (`accountRequired`) there is no guest to claim from: the
   *  connection never joined, and `start_guest_claim` refuses a caller with no player row. The
   *  redirect then begins at once, link or no link, with no code minted and a code already in
   *  storage left as it is (it is an earlier guest's only way to move its progress). */
  function startSignIn(): void {
    if (oidc === undefined) {
      opts.onSignInFailed?.('sign-in-off');
      return;
    }
    if (accountRequired) {
      beginOidcRedirect(oidc);
      return;
    }
    const live = current === undefined ? undefined : rawConnectionOf.get(current);
    if (live === undefined || linkFrozen(state)) {
      opts.onSignInFailed?.('transient-error');
      return;
    }
    const code = claimCode.mint(globalThis, opts.uri, opts.db);
    if (code === undefined) {
      opts.onSignInFailed?.('transient-error');
      return;
    }
    // On the RAW connection (never the logging wrapper): `code` is a bearer secret.
    const registration = live.reducers.startGuestClaim({ code });
    registration.then(
      () => beginOidcRedirect(oidc),
      () => {
        claimCode.clear(globalThis, opts.uri, opts.db);
        opts.onSignInFailed?.('transient-error');
      },
    );
  }

  function beginOidcRedirect(client: OidcClient): void {
    client
      .beginSignIn()
      .then((result) => {
        if (result.kind === 'ready') {
          // `location?` guards a non-browser host; the navigation target is textually the URL
          // beginSignIn produced. A missing `assign` (never in a real browser) throws into the
          // `.catch` belt below.
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

  // Cold start: resolve → build through the same total entry point every reconnect
  // uses. Even the zero-I/O anon fast path defers `current` by one microtask (accepted residual).
  void attemptBuild();

  return {
    // Getter: returns the CURRENT live connection across rebuilds — callers must not cache
    // `conn.conn` across await points; a rebuild may have replaced the instance.
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
    join: () => {
      if (current === undefined || linkFrozen(state)) return;
      if (accountRequired && !currentIsAccount) return;
      attemptJoin(current, name, opts.onError);
    },
    worldScope: () => scopeSummary(),
    checkIn: () => {},
  };
}
