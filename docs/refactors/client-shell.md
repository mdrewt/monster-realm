# Client shell: module map and state ownership

`client/src/main.ts` is the client shell: the entry module, with no exports, that wires the
store, prediction, input, the context stack and every view. This file is the plan its
extractions follow. It names the modules the shell splits into, the owner of every
module-level `let` that `main.ts` declares, how a non-owner reaches that state, and the
extractions still to make. The decision and what it rules out are in `docs/DECISIONS.md`
("The client shell is owner modules under `client/src/shell/`").

## Rules

1. **One owner per binding.** A mutable binding is a module-level `export let` in exactly one
   module under `client/src/shell/`. Another module reads it through its import, which is live:
   every read sees the owner's current value, and the identifier in a moved body stays as it is.
   TypeScript rejects an assignment to an import, so only the owner assigns. A write that sits
   outside the owner becomes a call to a function the owner exports, named for the event.
2. **Shared collections follow the same rule.** A `Set` or `Map` that more than one module
   mutates is exported as `ReadonlySet` or `ReadonlyMap`, and each mutation is an owner function.
3. **A live binding is never copied at module scope.** `const id = identity` outside a function
   freezes the value.
4. **`main.ts` is the composition root.** Of `main.ts` and the shell modules, only `main.ts`
   registers a listener on `store`, `window` or `document`, installs the DEV hooks, writes the
   DOM at import or constructs a boot-built view. It registers the listeners in one ordered block
   ("Registration order" below). An inline listener body moves to its owner as a named export;
   `main.ts` registers it by name.
5. **Shell module scope is inert.** A shell module may construct its own state at import (wasm
   constants, a storage read, a media query, a clock read). It registers nothing on `store`,
   `window` or `document`, writes no DOM and resolves no catalog string. The one listener a shell
   module's scope creates is the media-query listener inside the motion preference, which still
   registers before the first batch listener.
6. **The locale block stays in `main.ts`.** Negotiating the locale, `setLocale` and the two
   `<html>` attributes are the only import-time statements that write state other modules read,
   and they run after every import. No module-scope code under `client/src` reads the active
   locale or `<html lang|dir>`. `shell/config.ts` holds only the pure resolves: it imports nothing
   with an import-time effect, writes nothing and registers nothing, and its throw on a
   misconfigured production build happens at import, before `connect()` is reachable.
7. **Imports point down.** A shell module imports only shell modules listed above it in the map.
   The two places a lower module calls upward are ports ("Ports" below). The existing modules
   (`ui/`, `net/`, `input/`, `prediction/`, `render/`, `tactics/`, `convert/`, `observability/`
   and the wasm package) are importable by every shell module and import neither `shell/` nor
   `main.ts`.
8. **Views get their handlers from the composition root.** `main()` constructs each boot-built
   view with its handler closures and hands the instance to `shell/views.ts`. The three battle
   views are built lazily inside `shell/battleFrame.ts` with the handlers its port carries.

## Module map

All paths are under `client/src/shell/`. The table is in import order.

| # | Module | One responsibility | Shell modules it imports |
|---|---|---|---|
| 1 | `config.ts` | The values fixed for the session: the connection target, the dev-log sinks, the game-core constants | none |
| 2 | `views.ts` | The handles of the view instances built at boot | none |
| 3 | `inputState.ts` | The live input devices: the binding table, the keyboard source, the router, the held directions | none |
| 4 | `feedback.ts` | Where a message goes: the toast, the world hint, the announcer, the error ring and overlay | `views` |
| 5 | `session.ts` | The link to the server: the store, the identity, the connection, hydration, the guarded send, the session-event latches | `config`, `feedback` |
| 6 | `screenContext.ts` | What a screen adapter reads: `screenCtx`, the id each open bound, the motion preference | `inputState`, `session` |
| 7 | `notices.ts` | The trade and challenge requests waiting on this client | `views`, `session` |
| 8 | `battleFrame.ts` | The battle frame: its three views, which one shows, the outcome latch, the tactics memos | `feedback`, `session`, `screenContext` |
| 9 | `frames.ts` | The context stack and what sits on it: opens, syncs, the mirrored tables, the gates | `views`, `inputState`, `feedback`, `session`, `screenContext`, `battleFrame` |
| 10 | `movement.ts` | The own character in its zone: the map, the predictor, intents, reconcile, the zone switch, the renderer handle | `config`, `inputState`, `feedback`, `session`, `battleFrame`, `frames` |
| 11 | `account.ts` | The session terminal, the claim prompt and Profile's three sections | `config`, `views`, `feedback`, `session`, `frames` |
| 12 | `screens.ts` | The other player screens: how each opens and how each follows the store | `config`, `views`, `feedback`, `session`, `screenContext`, `frames` |
| 13 | `menu.ts` | The main menu: its state, its paint, the frame each entry opens | `views`, `feedback`, `session`, `screenContext`, `notices`, `frames`, `account`, `screens` |
| 14 | `interact.ts` | What A does at the world base: candidates, the run, the world port, chips and row words | `config`, `views`, `inputState`, `feedback`, `session`, `screenContext`, `notices`, `battleFrame`, `frames`, `movement`, `screens` |
| 15 | `bugReport.ts` | The bug bundle download | `feedback`, `session`, `movement` |
| 16 | `commands.ts` | Running one command: `dispatch`, its refusals, the stack moves it applies | `config`, `views`, `feedback`, `session`, `notices`, `battleFrame`, `frames`, `account`, `screens`, `menu`, `interact`, `bugReport` |
| 17 | `input.ts` | Keys and pointer presses into router edges, accelerators and the remap capture | `views`, `inputState`, `feedback`, `session`, `screenContext`, `battleFrame`, `frames`, `movement`, `account`, `screens`, `menu`, `interact`, `bugReport`, `commands` |
| 18 | `devHooks.ts` | The DEV hook objects the end-to-end specs read | `config`, `views`, `session`, `battleFrame`, `frames`, `movement`, `menu` |

`main.ts` imports any of them and nothing imports `main.ts`.

`applyStack`, `closeFrame` and `dispatch` call each other, so they share `commands.ts`;
`reconcileFromStore` and `sendIntent` share `movement.ts`; `sendDismiss` and `stepShopOpen`
share `screens.ts`; `applyPrivacy` and `sendPrivacy` share `account.ts`. No other call cycle
exists among the shell's functions.

## Ports

A port is a typed object `main.ts` hands to a lower module once, before it registers any
listener. A port member called before the install throws.

| Lower module | Reaches up for | Today's upward references |
|---|---|---|
| `feedback.ts` | whether the main menu is the top frame, and a repaint of the menu | `hintOnMenu` reads `menuPlace`; `paintWorldHint` calls `renderMenu` |
| `battleFrame.ts` | the handlers of the three battle views, the pop of the player frames over a battle, and whether the outcome is the top frame | `buildDeployPanel`, `buildResultsPanel` and `tacticsShellDeps` call `dispatch`; `popOverBattleBeforeSwitch` calls `applyStack` and reads `contextStack`; `buildResultsPanel` reads `contextStack` |

The battle port has the shape of the handler objects `main()` passes to every boot-built view,
and it also carries the mount element.

## Owners

One row per module-level `let`. "Readers" are the modules outside the owner that read the
binding. "Outside writers" are the places outside the owner that assign it in `main.ts` as it
stands, and the kind of owner function that takes each over: a **mount** (a value `main()`
builds at boot), a **pump** (a part of the frame loop that moves into the owner), a **reset**
(the reconnect or zone-switch fan-out) or an **event** (a named change of state). A reader
listed beside a pump or a reset is that same piece of code: it stops reading when the write moves.

### Context stack and overlays

| Binding | Owner | Readers | Outside writers |
|---|---|---|---|
| `contextStack` | `frames.ts` | `screens`, `menu`, `commands`, `input`, `devHooks`, `main`; `battleFrame` through its port | the `onReconnect` sweep: reset |
| `outcomeShownAtMs` | `frames.ts` | `input`, `main` | none |
| `autoContinuedAtMs` | `frames.ts` | `main` | the frame loop's results auto-advance: pump |
| `syncedTop` | `frames.ts` | none | none |
| `closeLeftFocusAdrift` | `frames.ts` | `main` | none |
| `lastCareTickAtMs` | `frames.ts` | `main` | the frame loop's care-readiness tick: pump |
| `statusEl` | `feedback.ts` | none | `main()` boot: mount |
| `toastChrome` | `feedback.ts` | none | `main()` boot: mount |
| `toastState` | `feedback.ts` | none | none |
| `worldHints` | `feedback.ts` | none | none |
| `saidHint` | `feedback.ts` | none | none |
| `menuHint` | `feedback.ts` | none | none |
| `statusNotice` | `feedback.ts` | `main` | `onReconnect`: reset; the frame loop's notice step: pump |
| `announcedSinceFrame` | `feedback.ts` | `main` | the frame loop's notice step: pump |
| `lastA11ySnapshot` | `feedback.ts` | `main` | the frame loop's announcement edge: pump |
| `toastDismissedSeq` | `feedback.ts` | none | none |
| `handlingError` | `feedback.ts` | none | none |
| `lastPaintErrorMessage` | `feedback.ts` | none | none |
| `lastFrameErrorMessage` | `main.ts` | none | none: the frame loop's own latch |

### Session and claim

| Binding | Owner | Readers | Outside writers |
|---|---|---|---|
| `identity` | `session.ts` | every module from `screenContext` to `devHooks` in the map; `main` | `onReady`, `onReconnect`: event |
| `conn` | `session.ts` | `movement`, `account`, `screens`, `interact`, `commands`, `devHooks`, `main` | `main()` boot: mount |
| `hydratedSinceReconnect` | `session.ts` | `screens` | `onHydrated`, `onReconnect`: event |
| `resolveReady` | `session.ts` | `main` | none; `onReady` calls it: event |
| `battleEmit` | `session.ts` | `movement`, `main` | `resetPredictionState`: reset; `onReconnect` arming the reseed: event |
| `lastOwnRating` | `session.ts` | none | `resetPredictionState`: reset |
| `claimModelState` | `account.ts` | `main` | the claim view's dismissed handler in `main()` boot: event |
| `sessionModelState` | `account.ts` | none | none |
| `privacyModelState` | `account.ts` | `main` | none |
| `lastPrivacyCountdown` | `account.ts` | `main` | `onReconnect`: reset; the frame loop's privacy step: pump |
| `livePrivacyCountdown` | `account.ts` | none | the frame loop's privacy step: pump |
| `lastPrivacyStatusLabel` | `account.ts` | `main` | none |
| `exportAssembly` | `account.ts` | none | `onReconnect`: reset |
| `claimRaised` | `main.ts` | none | none: every writer is a `connect` callback |

### Prediction and input

| Binding | Owner | Readers | Outside writers |
|---|---|---|---|
| `rawMap` | `movement.ts` | `bugReport`, `devHooks`, `main` | the test-only zone setter in `snapshot`: event |
| `predictor` | `movement.ts` | `interact`, `devHooks`, `main` | none |
| `renderer` | `movement.ts` | `devHooks`, `main` | `main()` boot: mount |
| `telemetry` | `movement.ts` | `main` | `main()` boot: mount |
| `frameWindow` | `movement.ts` | `main` | the frame loop's world step: pump |
| `lastCamX` | `movement.ts` | `main` | the frame loop's world step: pump |
| `lastCamY` | `movement.ts` | `main` | the frame loop's world step: pump |
| `zoneSyncFailureCount` | `movement.ts` | none | none |
| `lastSentSeq` | `movement.ts` | none | none |
| `moveRejectLimit` | `movement.ts` | none | none |
| `bindings` | `inputState.ts` | `screenContext`, `interact`, `input`, `main` | none |
| `keyboard` | `inputState.ts` | `input`, `main` | none |
| `pointerSource` | `input.ts` | none | `main()` boot: mount |
| `paintWorldPrompt` | `input.ts` | none | `main()` boot: mount |
| `worldCanvasEl` | `input.ts` | `main` | `main()` boot: mount |
| `textStep` | `main.ts` | none | none: read and written by the Controls handlers `main()` builds |

### Per-feature view state

| Binding | Owner | Readers | Outside writers |
|---|---|---|---|
| `boxView` | `views.ts` | `screens`, `menu`, `input` | `main()` boot: mount |
| `raisingView` | `views.ts` | `screens`, `menu`, `main` | `main()` boot: mount |
| `evolutionView` | `views.ts` | `main` | `main()` boot: mount |
| `dialogueView` | `views.ts` | `frames`, `screens` | `main()` boot: mount |
| `questLogView` | `views.ts` | `screens` | `main()` boot: mount |
| `healView` | `views.ts` | `screens`, `interact` | `main()` boot: mount |
| `shopView` | `views.ts` | `screens`, `main` | `main()` boot: mount |
| `tradeView` | `views.ts` | `frames`, `screens`, `main` | `main()` boot: mount |
| `pvpView` | `views.ts` | `frames`, `screens`, `main` | `main()` boot: mount |
| `leaderboardView` | `views.ts` | `frames`, `screens`, `main` | `main()` boot: mount |
| `profileView` | `views.ts` | `account`, `input`, `main` | `main()` boot: mount |
| `renameView` | `views.ts` | `account`, `main` | `main()` boot: mount |
| `tradeProposeView` | `views.ts` | `screens`, `main` | `main()` boot: mount |
| `helpView` | `views.ts` | `screens`, `commands` | `main()` boot: mount |
| `menuView` | `views.ts` | `frames`, `menu`, `devHooks` | `main()` boot: mount |
| `claimView` | `views.ts` | `account`, `main` | `main()` boot: mount |
| `privacyView` | `views.ts` | `account`, `main` | `main()` boot: mount |
| `controlsView` | `views.ts` | `screens`, `input` | `main()` boot: mount |
| `controlsSavedLine` | `views.ts` | `screens` | `main()` boot: mount |
| `sessionView` | `views.ts` | `account` | `main()` boot: mount |
| `evolutionNoticeBanner` | `views.ts` | `screens`, `main` | `main()` boot: mount |
| `errorOverlayView` | `views.ts` | `feedback`, `notices`, `input` | `main()` boot: mount |
| `hintBarView` | `views.ts` | `main` | `main()` boot: mount |
| `deployPanel` | `battleFrame.ts` | `devHooks`, `main` | none |
| `resultsPanel` | `battleFrame.ts` | `devHooks`, `main` | none |
| `tacticsBattle` | `battleFrame.ts` | `movement`, `commands`, `devHooks`, `main` | none |
| `battleMount` | `battleFrame.ts` | none | `main()` boot: mount |
| `tacticsRulesPort` | `battleFrame.ts` | none | none |
| `tacticsTuning` | `battleFrame.ts` | none | none |
| `tacticsShown` | `battleFrame.ts` | none | `resetPredictionState`: reset |
| `tacticsRating` | `battleFrame.ts` | none | none |
| `tacticsIngested` | `battleFrame.ts` | none | `resetPredictionState`: reset |
| `lastTacticsVM` | `battleFrame.ts` | none | `resetPredictionState`: reset |
| `stillThereAnnouncedFor` | `battleFrame.ts` | none | `resetPredictionState`: reset |
| `dismissedBattleId` | `battleFrame.ts` | `frames`, `commands` | `closeFrame` continuing the outcome: event; `resetPredictionState`: reset |
| `battleSynced` | `battleFrame.ts` | `frames` | `resetPredictionState`: reset |
| `unrenderableReported` | `battleFrame.ts` | none | none |
| `boundShopId` | `screenContext.ts` | `screens` | `openPendingShop`: event; `onReconnect`: reset |
| `boundHealLocationId` | `screenContext.ts` | `screens` | `runInteract`: event; `onReconnect`: reset |
| `boundSocialTab` | `screenContext.ts` | none | `openSocial`: event; `onReconnect`: reset |
| `boundMonstersTab` | `screenContext.ts` | none | `openMenuTarget`: event; `onReconnect`: reset |
| `boundProposeTarget` | `screenContext.ts` | none | `openPropose`: event; `onReconnect`: reset |
| `shopOpen` | `screens.ts` | `commands` | none |
| `questAckBaseline` | `screens.ts` | none | `onReconnect`: reset |
| `menuState` | `menu.ts` | `input`, `devHooks` | none |
| `menuBadged` | `menu.ts` | none | none |
| `lastInteractErrorMessage` | `interact.ts` | none | none |
| `interactBatch` | `interact.ts` | none | none |
| `interactMemo` | `interact.ts` | none | none |

### DEV hooks

| Binding | Owner | Readers | Outside writers |
|---|---|---|---|
| `rowProbeState` | `devHooks.ts` | none | none |
| `sawFractionalOwnMotion` | `movement.ts` | `devHooks` | the frame loop's world step: pump |
| `moveSendCount` | `movement.ts` | `devHooks` | none |
| `moveRejectCount` | `movement.ts` | `devHooks` | none |

The three movement latches are written where the event happens and read only by `snapshot`.

### Shared collections

| Collection | Owner | Mutated from outside the owner by |
|---|---|---|
| `navHeldCodes` | `inputState.ts` | `onKeyDown`, `captureControlsKey`, the keyup listener |
| `dismissedRequests` | `notices.ts` | `worldPort`, `onReady`, `onReconnect` |
| `announcedRequests` | `notices.ts` | the batch listener that announces a new request, `onReady`, `onReconnect` |
| `answeredRequests` | `notices.ts` | `dispatch`, `onReady`, `onReconnect` |
| `careInFlight` | `commands.ts` | `onReconnect` |
| `frameOpens` | `frames.ts` | nothing: `openFrame` is its one writer |
| `tacticsMapFacts` | `battleFrame.ts` | nothing: `mapFactsOf` is its one writer |

### Owner functions the extractions add

These names are proposals. None exists until its extraction lands, and that extraction may
choose another name; what is fixed is the owner and what the function takes over.

| Owner | Proposed function | Takes over |
|---|---|---|
| `views.ts` | `mountViews` | each view assignment in `main()`, called after each construction in the same statement order |
| `inputState.ts` | `noteNavHeld`, `releaseNavHeld` | the adds and the delete on `navHeldCodes` |
| `feedback.ts` | `installHintHost` | the hint-host port |
| `feedback.ts` | `mountFeedback` | the `statusEl` and `toastChrome` assignments |
| `feedback.ts` | `pumpAnnouncements` | the frame loop's announcement edge and notice step |
| `feedback.ts` | `resetStatusNotice` | the `statusNotice` reset in `onReconnect` |
| `session.ts` | `adoptIdentity`, `adoptConnection` | the `identity` and `conn` assignments |
| `session.ts` | `noteHydrated`, `clearHydration`, `markReady` | the hydration flag's two writes and the `resolveReady` call |
| `session.ts` | `armEmitReseed`, `resetEmitLatches` | the reseed arming in `onReconnect` and the two latch resets in `resetPredictionState` |
| `screenContext.ts` | `bindShop`, `bindHealLocation`, `bindSocialTab`, `bindMonstersTab`, `bindProposeTarget`, `unbindScreens` | each opener's bind and the five clears in `onReconnect` |
| `notices.ts` | `markAnswered`, `dismissRequest`, `markAnnounced`, `clearNoticeSets` | every mutation of the three request sets |
| `battleFrame.ts` | `mountBattleFrame` | the battle port and the `battleMount` assignment |
| `battleFrame.ts` | `resetBattleFrame` | the battle and tactics lines of `resetPredictionState`, in their position |
| `battleFrame.ts` | `continueOutcome` | the latch and the hide in `closeFrame`'s battle arm |
| `frames.ts` | `sweepForReconnect` | the `reconnectSweep` block of `onReconnect` |
| `frames.ts` | `takeResultsAutoContinue`, `pumpCareReadiness` | the two frame-loop parts that write `autoContinuedAtMs` and `lastCareTickAtMs` |
| `movement.ts` | `adoptRenderer`, `adoptTelemetry` | the `renderer` and `telemetry` assignments |
| `movement.ts` | `stepWorldFrame` | the frame loop's drain, re-issue, resolve, latch, camera, render and frame sample |
| `movement.ts` | `setRawMapZoneForTest` | the test-only zone setter `snapshot` exposes |
| `account.ts` | `cancelArmedDecline` | the claim view's dismissed handler |
| `account.ts` | `pumpPrivacyCountdown`, `forgetPrivacyCountdown`, `dropExportAssembly` | the frame loop's privacy step and the two resets in `onReconnect` |
| `screens.ts` | `resetQuestAck` | the baseline reset in `onReconnect` |
| `commands.ts` | `clearCareInFlight` | the clear in `onReconnect` |
| `input.ts` | `mountInput` | the `pointerSource`, `paintWorldPrompt` and `worldCanvasEl` assignments |

## What `main.ts` keeps

- The boot prelude that writes shared state: the locale block, the text-step apply, the
  wasm-ready mark and the telemetry config.
- Three bindings: `textStep`, `claimRaised`, `lastFrameErrorMessage`.
- `RECONNECT_RESETS`, whose rows read the view handles through their imports.
- `main()`: the view constructions and their mounts, the status, toast, prompt and banner
  elements, the `connect` call with its callbacks, the world prompt painter and the frame loop.
  The frame loop stays one function whose body is the ordered list of the owners' pumps.
- The registration block and the DEV hook assignments inside `if (import.meta.env.DEV)`.

### Registration order

`main.ts` registers in this order. A batch listener is named by its owner and what it does.

1. batch: `interact` counts the batch for the candidate memo.
2. batch: `account` recomputes the export assembly and repaints an open Privacy section.
3. `window` `error`, then `window` `unhandledrejection`: `pushError`.
4. batch: `frames` runs `reconcileStack`. It is the first of the listeners that show or hide a view.
5. batch: `movement` runs `reconcileFromStore`.
6. `window` `keydown` in the capture phase for Escape, `window` `keydown` in the bubble phase
   for every other key, `window` `keyup`, `window` `blur`, `document` `visibilitychange`.
7. batch: `screens` runs `refreshBox`, then `refreshRaising`.
8. batch: `battleFrame` runs `refreshBattle`.
9. batch: `screens` paints the dialogue and steps the deferred shop open; refreshes the quest
   log; acknowledges a completed quest; refreshes the heal frame; refreshes the shop; refreshes
   the trade panel; refreshes the challenge panel.
10. batch: `menu` announces a new request and follows the request badge.
11. batch: `screens` refreshes the leaderboard.
12. batch: `session` steps the battle emit latch, then the ranked emit latch.
13. batch: `screens` paints the evolution notice banner.
14. batch: `frames` syncs the stack and lets every open frame's adapter observe the batch. It
    is the last batch listener.
15. The DEV hook assignments, the build stamp, then `void main()`.

## Tests and docs that follow the code

No `client/src/main.*.test.ts` suite changes how it boots: each resets the module registry and
imports `./main`, a mock is keyed on the module it replaces, and module-level state in a shell
module resets with the registry. The wasm stubs in `client/test-util/mainBootHarness.ts` and
the inline ones serve a shell module that imports a name they already carry; an extraction that
imports a wasm export `main.ts` did not import by name adds it to those stubs.

These read `main.ts` as text or name it by path, and move with the code they read. Each edit
is the tester's.

| What reads `main.ts` | Follows | The edit |
|---|---|---|
| `client/src/main.dispatch.test.ts`: `movementGate` and `worldBaseLive` push, pop, show and hide nothing | `frames.ts` | the path; the two header needles gain `export` |
| `client/src/main.dispatch.test.ts`: `overlayProbes`, `overlayHandles` and `screenViews` are three separate records with exactly the mirrored rows | `frames.ts` | the path only; the row text is unchanged |
| `client/src/net/connection.test.ts`: `applyClaim` joins through `conn?.join()`, and the source never names `joinGame` or indexes `reducers` by bracket | `account.ts` | the path for `applyClaim`; the two absence checks read `main.ts` and every `shell/` module together |
| `client/src/ui/screens/mainMenuScreen.test.ts`: the source holds `menuState` and reads no level off it | `menu.ts` | the scan reads `main.ts` and every `shell/` module together, so the absence checks widen and the length floor holds |
| `client/src/ui/i18n/catalogParity.test.ts`: the roster of files that import the resolver, and the literal keys `main.ts` resolves | every module that resolves a catalog key | the roster gains the module; the key set splits between `main.ts` and the module, with the union unchanged |
| `client/vite.config.ts`: `src/main.ts` is excluded from coverage by path | nothing | shell modules are measured; coverage is a report with no threshold |
| `client/e2e/trade-full.spec.ts`, `client/e2e/pvp-full.spec.ts`: the hook shapes they re-declare | `devHooks.ts` | none while the shapes hold |

The whole-tree scans (`client/src/ui/i18n/hardcodedStrings.test.ts`,
`client/src/ui/i18n-no-html-sink.test.ts`, the dynamic-key scan in `catalogParity.test.ts`) walk
every non-test file under `client/src`, exempt nothing, and cover a shell module without an edit.
`scripts/verify-build-hooks.mjs` reads the built bundle, so it gates `devHooks.ts` whatever file
holds the hooks.

Two sentences of the `docs/DECISIONS.md` entry "Context stack ownership" name `main.ts` as the
home of `openFrame` and of the three mirrored tables. The `frames.ts` extraction rewrites them in
place to name `client/src/shell/frames.ts`; the tables stay three separate total records.
`ARCHITECTURE.md` names `main.ts` for `switchZone`, the frame loop, `dispatch`, `applyStack` and
`downloadBugBundle`; each extraction updates the sentence for what it moves.

## Extractions, in order

Each is one slice. The order is the map's: a moved function reads only modules already
extracted, or a port. A **plain move** relocates whole top-level symbols with every binding
they write; bodies change only by imports, and an inline listener body gains a name. An
**ownership change** leaves a writer outside the destination, so it adds an owner function, or
it installs a port. The slice for a line deletes that line.

1. `client/src/shell/config.ts` takes `URI`, `DB`, `DEV_LOG_LEVEL`, `sendLogger`, `fateLogger`, `ZONE_ID`, `STEP_MS`, `QUEUE_CAP`, `PARTY_SIZE`, `PARTY_SLOT_NONE`, `MAX_TRADE_MONSTERS_PER_SIDE` and `DELETION_GRACE_MS_DEFAULT`. Plain move.
2. `client/src/shell/views.ts` takes the 23 view handles from `boxView` to `hintBarView`. Ownership change: `main` keeps every construction and mounts each instance.
3. `client/src/shell/inputState.ts` takes `bindings`, `keyboard`, `held`, `inputRouter`, `navHeldCodes`, `releaseAllInput` and `applyBindings`. Ownership change: `navHeldCodes` is mutated by `onKeyDown` and `captureControlsKey`.
4. `client/src/shell/feedback.ts` takes `route`, `reportError`, `showToast`, `paintToast`, `tickToast`, `setWorldHint`, `topHint`, `hintOnMenu`, `paintWorldHint`, `resetFeedbackSinks`, `announceNow`, `dismissErrorToast`, `pushError`, `reportPaintError`, `eventRing`, `errorRing`, `liveRegion`, `MOVE_REJECT_PREFIX` and the twelve bindings they write. Ownership change: the hint-host port, the two boot mounts, and the parts of `main` that write `statusNotice`, `announcedSinceFrame` and `lastA11ySnapshot`.
5. `client/src/shell/session.ts` takes `store`, `identity`, `conn`, `hydratedSinceReconnect`, `resolveReady`, `ready`, `sessionGateBlocks`, `liveReducers`, `privacyLinkLive`, `sendGuarded`, `SEND_REJECT_KIND`, `battleEmit`, `lastOwnRating` and the two batch listeners that step the emit latches. Ownership change: `main` assigns `identity`, `conn` and `hydratedSinceReconnect`, and `resetPredictionState` resets the latches.
6. `client/src/shell/screenContext.ts` takes `screenCtx`, `motionPreference`, `boundShopId`, `boundHealLocationId`, `boundSocialTab`, `boundMonstersTab` and `boundProposeTarget`. Ownership change: `openPendingShop`, `runInteract`, `openSocial`, `openMenuTarget` and `openPropose` bind them and `main` clears them.
7. `client/src/shell/notices.ts` takes `dismissedRequests`, `announcedRequests`, `answeredRequests`, `noticeInput`, `livePending`, `requestLine` and `releaseAnswered`. Ownership change: `dispatch`, `worldPort` and `main` mutate the three sets.
8. `client/src/shell/battleFrame.ts` takes `battleViews`, `battleFrameShown`, `hideAllBattleViews`, `activeBattleView`, `tacticalOwnsStart`, `battleHint`, `tacticsRules`, `tuningOf`, `refreshBattle`, `popOverBattleBeforeSwitch`, `ownMonsterName`, `tacticsMapFacts`, `mapFactsOf`, `mySideOf`, `buildDeployPanel`, `noteRatingBaseline`, `ratingLineFor`, `buildResultsPanel`, `refreshTacticsShell`, `tacticsVMEqual`, `buildTacticsVM`, `tacticsShellDeps`, `pumpStillThere`, `pumpClock`, `tradedIds`, `ownDeployLocked` and the fourteen bindings from `deployPanel` to `unrenderableReported`. Ownership change: the battle port, the `battleMount` mount, the lines `resetPredictionState` resets and the latch `closeFrame` writes.
9. `client/src/shell/frames.ts` takes `overlayProbes`, `overlayHandles`, `screenViews`, `frameOpens`, `frameOpenOf`, `screenHost`, `overlayVerdict`, `shownOverlays`, `contextStack`, `runStackCommands`, `outcomeShownAtMs`, `autoContinuedAtMs`, `syncStack`, `upperIds`, `shownPlayerFrames`, `panelShown`, `socialPanelView`, `hideFrame`, `topOverlay`, `menuPlace`, `reconcileStack`, `movementGate`, `worldBaseLive`, `openFrame`, `openSeated`, `topSocialFrame`, `syncedTop`, `closeLeftFocusAdrift`, `judgeCloseFocus`, `inHiddenSubtree`, `focusInsideHiddenSubtree`, `focusAdrift`, `lastCareTickAtMs` and `CARE_READINESS_TICK_MS`. Ownership change: `main` sweeps `contextStack` on reconnect and writes `autoContinuedAtMs` and `lastCareTickAtMs` in the frame loop.
10. `client/src/shell/movement.ts` takes `rawMap`, `applyMove`, `predictor`, `resolver`, `renderer`, `telemetry`, `frameWindow`, `lastCamX`, `lastCamY`, `sawFractionalOwnMotion`, `resetPredictionState`, `zoneSyncFailureCount`, `switchZone`, `reconcileFromStore`, `lastSentSeq`, `MOVE_REJECT_POLICY`, `moveRejectLimit`, `moveSendCount`, `moveRejectCount`, `noteMoveRejection`, `sendIntent`, `step` and `jump`. Ownership change: `main` mounts `renderer` and `telemetry` and writes the camera hold, the motion latch and `frameWindow` in the frame loop; `snapshot` sets `rawMap`.
11. `client/src/shell/account.ts` takes `claimModelState`, `sessionModelState`, `privacyModelState`, `lastPrivacyCountdown`, `livePrivacyCountdown`, `lastPrivacyStatusLabel`, `exportAssembly`, `renderSession`, `applySession`, `renderClaim`, `applyClaim`, `renderPrivacy`, `downloadExportBundle`, `applyPrivacy`, `sendPrivacy`, `profileOpen`, `showProfile`, `openProfile` and the batch listener that recomputes the export assembly. Ownership change: `main` writes `claimModelState`, `lastPrivacyCountdown`, `livePrivacyCountdown` and `exportAssembly`.
12. `client/src/shell/screens.ts` takes `shopOpen`, `questAckBaseline`, `openQuestLog`, `socialChrome`, `showSocialPanel`, `hidePanel`, `socialOpen`, `socialFrameView`, `openSocial`, `openPropose`, `openHelp`, `openControls`, `refreshBox`, `refreshRaising`, `stepShopOpen`, `sendDismiss`, `openPendingShop`, `toastControls` and the batch listeners that refresh a screen. Ownership change: `main` resets `questAckBaseline`.
13. `client/src/shell/menu.ts` takes `menuState`, `menuBadged`, `renderMenu`, `openMenu`, `profileSectionOf`, `socialTabOf`, `openMenuTarget`, `applyMenuStep`, `handleMenuPointer` and the batch listener that follows the request badge. Plain move.
14. `client/src/shell/interact.ts` takes `interactCandidatesFn`, `lastInteractErrorMessage`, `reportInteractError`, `interactBatch`, `interactMemo`, `worldCandidates`, `facedChip`, `hintChips`, `runInteract`, `worldPort`, `interactVerb`, `sizeRowLabel`, `closeRowLabel`, `requestRowLabel`, `interactName`, `interactKeycap`, `interactChipText`, `ownPartyIds`, `eligibleChallengeIds` and the batch listener that counts the batch. Plain move.
15. `client/src/shell/bugReport.ts` takes `projectKeyStore` and `downloadBugBundle`. Plain move.
16. `client/src/shell/commands.ts` takes `DONE`, `careInFlight`, `actionFeedback`, `SHOP_BUY`, `SHOP_SELL`, `TRADE_ANSWER`, `TRADE_SETTLE`, `TRADE_CANCEL`, `TRADE_PROPOSE`, `RENAME`, `dispatch`, `refusedShopQty`, `refusedInBattle`, `applyStack`, `closeFrame` and `endedLine`. Ownership change: `main` clears `careInFlight`.
17. `client/src/shell/input.ts` takes `routeCtx`, `applyRouterEffect`, `routeEdge`, `runAccel`, `openAccelPath`, `controlsCapture`, `endControlsCapture`, `captureControlsKey`, `cancelControlsCapture`, `pointerSource`, `paintWorldPrompt`, `pointerPress`, `pointerTop`, `suppressNativeMovementDefault`, `worldCanvasEl`, `gameScreenEl`, `onKeyDown`, `handleKeyDown`, `STOP_TYPING_TARGETS`, `stopTyping` and the body of the keyup listener. Ownership change: `main` mounts `pointerSource`, `paintWorldPrompt` and `worldCanvasEl`.
18. `client/src/shell/devHooks.ts` takes `snapshot`, `mrTradeHook`, `mrPvpHook`, `mrTacticsHook` and `rowProbeState`. Plain move; the gated `window` assignments stay in `main`.

An extraction that moves boot wiring or a DEV hook runs the full end-to-end suite as well as
the unit suites, because only the end-to-end specs read the hooks.
