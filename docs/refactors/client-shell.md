# Client shell: module map and state ownership

`client/src/main.ts` is the client shell: the entry module, with no exports, that wires the
store, prediction, input, the context stack and every view. This file is the plan its
extractions follow. It names the modules the shell splits into, the owner of every
module-level `let` that `main.ts` declares and how a non-owner reaches that state. The
extractions still to make, with the symbols each takes, are section 4 of
`docs/refactors/client-platform.md`, in order. The decision and what it rules out are in
`docs/DECISIONS.md` ("Code leaves `client/src/main.ts` into owner modules under
`client/src/shell/`").

## Rules

1. **One owner per binding.** A mutable binding is a module-level `export let` in exactly one
   module under `client/src/shell/`. Another module reads it through its import, which is live:
   every read sees the owner's current value, and the identifier in a moved body stays as it is.
   TypeScript rejects an assignment to an import, so only the owner assigns. A write that sits
   outside the owner becomes a call to a function the owner exports, named for the event.
2. **Shared collections follow the same rule.** A `Set` or `Map` that more than one module
   mutates is exported as `ReadonlySet` or `ReadonlyMap`, and each mutation is an owner function.
   An object with methods of its own (`held`, `inputRouter`, `screenHost`, the two rings, the
   live region, the predictor, `owed`, `serverClock`) is used through those methods by any module
   that imports it.
3. **A live binding is never copied at module scope.** `const id = identity` outside a function
   freezes the value. Inside a function, an import does not narrow after its mount the way a
   local `let` narrows after an assignment, so `main()` builds into a local any instance it uses
   again in the same function (the three Profile sections the Profile frame takes, the renderer it
   initialises) and mounts that local.
4. **`main.ts` is the composition root.** Of `main.ts` and the shell modules, only `main.ts`
   registers a listener on `store`, `window` or `document`, installs the DEV hooks, writes the
   DOM at import or constructs a boot-built view. Its registrations keep the order "Registration
   order" lists. An inline listener body that does more than forward moves to its owner as a
   named export, and `main.ts` registers it by name; an arrow that only calls one or two exports
   stays as written.
5. **Shell module scope is inert.** A shell module may construct its own state at import (wasm
   constants, a storage read, a media query, a clock read, an element it does not attach). It
   registers nothing on `store`, `window` or `document`, writes nothing to the document and
   resolves no catalog string. The one listener a shell module's scope creates is the media-query
   listener inside the motion preference, which still registers before the first batch listener.
6. **The locale block stays in `main.ts`.** Negotiating the locale, `setLocale` and the two
   `<html>` attributes are the only import-time statements that write state other modules read,
   and they run after every import. No module-scope code under `client/src` reads the active
   locale or `<html lang|dir>`. `shell/config.ts` holds only resolves and constants: it imports
   the wasm package and the pure resolvers, writes nothing to the document, registers nothing and
   reads no locale. Its throw on a misconfigured production build happens at import, before
   `connect()` is reachable.
7. **Imports point down.** A shell module imports only shell modules listed above it in the map.
   A lower module reaches upward in two ways only: a port ("Ports" below), or the parameter
   object of a pump ("Pumps" below). The existing modules (`ui/`, `net/`, `input/`,
   `prediction/`, `render/`, `tactics/`, `convert/`, `observability/`, the host ports under
   `platform/` and the wasm package) are importable by every shell module and import neither
   `shell/` nor `main.ts`.
8. **Views get their handlers from the composition root.** `main()` constructs each boot-built
   view with its handler closures and hands the instance to `shell/views.ts`. The three battle
   views are built lazily inside `shell/battleFrame.ts`; their handlers run commands through the
   command port.

## Module map

All paths are under `client/src/shell/`. The table is in import order.

| # | Module | One responsibility | Shell modules it imports |
|---|---|---|---|
| 1 | `config.ts` | The values fixed for the session: the connection target, the dev-log sinks, the sign-in constants, the game-core constants, the wasm-ready mark | none |
| 2 | `views.ts` | The handles of the view instances built at boot | none |
| 3 | `inputState.ts` | The live input devices: the binding table, the keyboard source, the router, the held directions, the key codes whose repeats are cancelled | none |
| 4 | `feedback.ts` | Where a message goes: the toast, the world hint, the announcer, the error ring and overlay | `views` |
| 5 | `session.ts` | The link to the server: the store, the identity, the connection, hydration, the guarded send, the session-event latches | `config`, `feedback` |
| 6 | `screenContext.ts` | What a screen adapter reads: `screenCtx`, what each open bound, the motion preference | `inputState`, `session` |
| 7 | `commandPort.ts` | The port a lower module runs a command or a stack move through | none |
| 8 | `notices.ts` | The trade and challenge requests waiting on this client | `views`, `session` |
| 9 | `battleFrame.ts` | The battle frame: its three views, which one shows, the outcome latch, the tactics memos | `inputState`, `feedback`, `session`, `screenContext`, `commandPort` |
| 10 | `frames.ts` | The context stack and what sits on it: opens, syncs, the mirrored tables, the gates | `views`, `inputState`, `feedback`, `session`, `screenContext`, `battleFrame` |
| 11 | `movement.ts` | The own character in its zone: the map, the predictor, intents, reconcile, the zone switch, the renderer handle | `config`, `inputState`, `feedback`, `session`, `screenContext`, `battleFrame`, `frames` |
| 12 | `account.ts` | The session terminal, the claim prompt and Profile's three sections | `config`, `views`, `feedback`, `session`, `frames` |
| 13 | `screens.ts` | The other player screens: how each opens and how each follows the store | `config`, `views`, `inputState`, `feedback`, `session`, `screenContext`, `commandPort`, `notices`, `frames` |
| 14 | `menu.ts` | The main menu: its state, its paint, the frame each entry opens, the sign-in gate | `config`, `views`, `feedback`, `session`, `screenContext`, `commandPort`, `notices`, `frames`, `account`, `screens` |
| 15 | `interact.ts` | What A does at the world base: candidates, the run, the world port, chips and row words | `config`, `views`, `inputState`, `feedback`, `session`, `screenContext`, `commandPort`, `notices`, `battleFrame`, `frames`, `movement`, `screens` |
| 16 | `bugReport.ts` | The bug bundle download | `feedback`, `session`, `movement` |
| 17 | `commands.ts` | Running one command: `dispatch`, its refusals, the stack moves it applies | `config`, `views`, `feedback`, `session`, `notices`, `battleFrame`, `frames`, `account`, `screens`, `menu`, `interact`, `bugReport` |
| 18 | `input.ts` | Keys, pad and pointer presses into router edges, accelerators and the remap capture | `views`, `inputState`, `feedback`, `session`, `screenContext`, `battleFrame`, `frames`, `movement`, `account`, `screens`, `menu`, `interact`, `bugReport`, `commands` |
| 19 | `devHooks.ts` | The DEV hook objects the end-to-end specs read | `config`, `views`, `session`, `battleFrame`, `frames`, `movement`, `menu` |

`main.ts` imports any of them and nothing imports `main.ts`.

`applyStack`, `closeFrame` and `dispatch` call each other, so they share `commands.ts`;
`reconcileFromStore` and `sendIntent` share `movement.ts`; `sendDismiss` and `stepShopOpen`
share `screens.ts`; `applyPrivacy` and `sendPrivacy` share `account.ts`. Four modules below
`commands.ts` call `dispatch` or `applyStack` (the battle views' handlers and
`popOverBattleBeforeSwitch`, `closeTradeEditor`, `applyMenuStep` and `showSignInGate`,
`runInteract`): they reach both through the command port. The import columns are the ones each
extraction confirms at its own base.

## Ports

A port is a typed object `main.ts` hands to a lower module once, at module scope, before it
registers its first listener. A port member called before the install throws.

| Lower module | Reaches up for | Today's upward references |
|---|---|---|
| `feedback.ts` | whether the main menu is the top frame, and a repaint of the menu | none: `hintOnMenu` asks the host `installHintHost` took (`menuOnTop`), and `paintWorldHint` calls its `repaintMenu` |
| `commandPort.ts`, for `battleFrame.ts`, `screens.ts`, `menu.ts` and `interact.ts` | `dispatch` and `applyStack` | none: `installCommandPort` took both. From `battleFrame.ts`, `buildDeployPanel`, `buildResultsPanel` and `tacticsShellDeps` call the port's `dispatch` and `popOverBattleBeforeSwitch` its `applyStack`; from `main.ts`, `runInteract`, `applyMenuStep` and `closeTradeEditor` call its `dispatch` and `showSignInGate` its `applyStack` |
| `battleFrame.ts` | the stack as the battle frame reads it, and the outcome edge | none: `installBattlePort` took both. `popOverBattleBeforeSwitch` and `buildResultsPanel` read the stack through the port's `stack`, and `holdResultsForPlayback` clears `outcomeShownAtMs` and `autoContinuedAtMs` through its `clearOutcomeEdge` |

The command port is one typed object with two members, declared in a module that imports no
shell module. The battle port carries what only the battle frame needs. The mount element is
part of neither: `main()` mounts it at boot (`mountBattleFrame`), and until then `battleMount` is
`undefined` and the battle functions return early.

## Pumps

A pump is a part of the frame loop that writes its owner's bindings, moved into the owner as one
function. The frame loop in `main()` stays the ordered list of pump calls. A pump is not a port:
what it needs from a module it may not import, or from a local of `main()`, arrives as one
parameter object, whose members it calls in the position the frame loop calls them in; what the
frame loop must act on, it returns.

| Pump | Owner | Its parameter object carries | It returns |
|---|---|---|---|
| the announcement edge and the notice step (`pumpAnnouncements`) | `feedback.ts` | the frame's clock reading, the top overlay (`topOverlay`), the line `pumpStillThere` returned, and the focus return on a world edge (`closeLeftFocusAdrift`, `focusAdrift`, `worldCanvasEl`) | nothing |
| the results auto-advance | `frames.ts` | nothing | whether to continue; `main()` then calls `dispatch` |
| the care-readiness tick | `frames.ts` | nothing | nothing |
| the privacy step | `account.ts` | the paint of the countdown banner, a local of `main()` | nothing |
| the world step: drain, re-issue, resolve, latch, camera, render, frame sample | `movement.ts` | nothing | nothing |

## Owners

One row per module-level `let`. "Readers" are the modules outside the owner that read the
binding. "Outside writers" are the places outside the owner that assign it in `main.ts` as it
stands, and the kind of owner function that takes each over: a **mount** (a value `main()`
builds at boot), a **pump** (a part of the frame loop that moves into the owner), a **reset**
(the reconnect or zone-switch fan-out) or an **event** (a named change of state). Readers are
counted by where the reading code lives in the map: a pump's own reads move with it and are not
listed, and a read a pump receives through its parameter object is a read by `main`.

### Context stack and overlays

| Binding | Owner | Readers | Outside writers |
|---|---|---|---|
| `contextStack` | `frames.ts` | `screens`, `menu`, `commands`, `input`, `devHooks`, `main`; `battleFrame` through its port | the `onReconnect` sweep: reset |
| `outcomeShownAtMs` | `frames.ts` | `input` | none |
| `autoContinuedAtMs` | `frames.ts` | none | the frame loop's results auto-advance: pump |
| `syncedTop` | `frames.ts` | none | none |
| `closeLeftFocusAdrift` | `frames.ts` | `main` | none |
| `lastCareTickAtMs` | `frames.ts` | none | the frame loop's care-readiness tick: pump |
| `statusEl` | `feedback.ts` | none | `main()` boot: mount |
| `toastChrome` | `feedback.ts` | none | `main()` boot: mount |
| `toastState` | `feedback.ts` | none | none |
| `worldHints` | `feedback.ts` | none | none |
| `saidHint` | `feedback.ts` | none | none |
| `menuHint` | `feedback.ts` | none | none |
| `statusNotice` | `feedback.ts` | `battleFrame` | `onReconnect`: reset; the frame loop's notice step: pump |
| `announcedSinceFrame` | `feedback.ts` | none | the frame loop's notice step: pump |
| `lastA11ySnapshot` | `feedback.ts` | none | the frame loop's announcement edge: pump |
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
| `resolveReady` | `session.ts` | none | none; `onReady` resolves `ready` through `markReady`: event |
| `battleEmit` | `session.ts` | none | `resetPredictionState`: reset; `onReconnect` arming the reseed: event |
| `lastOwnRating` | `session.ts` | none | `resetPredictionState`: reset |
| `claimModelState` | `account.ts` | `main` | the claim view's dismissed handler in `main()` boot: event |
| `sessionModelState` | `account.ts` | none | none |
| `privacyModelState` | `account.ts` | none | none |
| `lastPrivacyCountdown` | `account.ts` | none | `onReconnect`: reset; the frame loop's privacy step: pump |
| `livePrivacyCountdown` | `account.ts` | none | the frame loop's privacy step: pump |
| `lastPrivacyStatusLabel` | `account.ts` | none | none |
| `exportAssembly` | `account.ts` | none | `onReconnect`: reset |
| `claimRaised` | `main.ts` | none | none: every writer is a `connect` callback |
| `signInGate` | `menu.ts` | none | none: `applySignInGate` is its one writer, and `main` calls it from the `connect` callbacks |
| `saidGateLine` | `menu.ts` | none | none |

### Prediction and input

| Binding | Owner | Readers | Outside writers |
|---|---|---|---|
| `rawMap` | `movement.ts` | `bugReport`, `devHooks`, `main` | the test-only zone setter in `snapshot`: event |
| `predictor` | `movement.ts` | `interact`, `devHooks` | none |
| `renderer` | `movement.ts` | `devHooks`, `main` | `main()` boot: mount |
| `telemetry` | `movement.ts` | `main` | `main()` boot: mount |
| `frameWindow` | `movement.ts` | none | the frame loop's world step: pump |
| `lastCamX` | `movement.ts` | none | the frame loop's world step: pump |
| `lastCamY` | `movement.ts` | none | the frame loop's world step: pump |
| `zoneSyncFailureCount` | `movement.ts` | none | none |
| `lastSentSeq` | `movement.ts` | none | none |
| `moveRejectLimit` | `movement.ts` | none | none |
| `bindings` | `inputState.ts` | `screenContext`, `interact`, `input`, `main` | none |
| `keyboard` | `inputState.ts` | `input` | none |
| `pointerSource` | `input.ts` | none | `main()` boot: mount |
| `paintWorldPrompt` | `input.ts` | none | `main()` boot: mount |
| `worldCanvasEl` | `input.ts` | `main` | `main()` boot: mount |
| `textStep` | `main.ts` | none | none: read and written by the Controls handlers `main()` builds |
| `worldRevealed` | `movement.ts` | none | the scope callback of `connect`: event |
| `padPhase` | `input.ts` | none | none |

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
| `tradeSessionView` | `views.ts` | `screens`, `main` | `main()` boot: mount |
| `helpView` | `views.ts` | `screens`, `commands` | `main()` boot: mount |
| `menuView` | `views.ts` | `frames`, `menu`, `devHooks` | `main()` boot: mount |
| `claimView` | `views.ts` | `account`, `main` | `main()` boot: mount |
| `privacyView` | `views.ts` | `account`, `main` | `main()` boot: mount |
| `controlsView` | `views.ts` | `screens`, `input` | `main()` boot: mount |
| `controlsSavedLine` | `views.ts` | `screens` | `main()` boot: mount |
| `sessionView` | `views.ts` | `account` | `main()` boot: mount |
| `evolutionNoticeBanner` | `views.ts` | `notices`, `screens`, `main` | `main()` boot: mount |
| `errorOverlayView` | `views.ts` | `feedback`, `notices`, `input` | `main()` boot: mount |
| `hintBarView` | `views.ts` | `main` | `main()` boot: mount |
| `evolutionNoticeOk` | `views.ts` | `interact` | `main()` boot: mount |
| `deployPanel` | `battleFrame.ts` | `devHooks`, `main` | none |
| `resultsPanel` | `battleFrame.ts` | `frames`, `devHooks`, `main` | none |
| `tacticsBattle` | `battleFrame.ts` | `commands`, `input`, `devHooks`, `main` | none |
| `battleMount` | `battleFrame.ts` | none | `main()` boot: mount |
| `tacticsRulesPort` | `battleFrame.ts` | none | none |
| `tacticsTuning` | `battleFrame.ts` | none | none |
| `tacticsShown` | `battleFrame.ts` | none | `resetPredictionState`: reset |
| `tacticsRating` | `battleFrame.ts` | none | none |
| `tacticsIngested` | `battleFrame.ts` | none | `resetPredictionState`: reset |
| `lastTacticsVM` | `battleFrame.ts` | none | `resetPredictionState`: reset |
| `stillThereAnnouncedFor` | `battleFrame.ts` | none | `resetPredictionState`: reset |
| `dismissedBattleId` | `battleFrame.ts` | `frames` | `closeFrame` continuing the outcome: event; `resetPredictionState`: reset |
| `battleSynced` | `battleFrame.ts` | `frames` | `resetPredictionState`: reset |
| `unrenderableReported` | `battleFrame.ts` | none | none |
| `resultsAwaitDrain` | `battleFrame.ts` | `frames`, `input`, `main` | `resetPredictionState`: reset |
| `boundShopId` | `screenContext.ts` | `screens` | `openPendingShop`: event; `onReconnect`: reset |
| `boundHealLocationId` | `screenContext.ts` | `screens` | `runInteract`: event; `onReconnect`: reset |
| `boundSocialTab` | `screenContext.ts` | none | `openSocial`: event; `onReconnect`: reset |
| `boundMonstersTab` | `screenContext.ts` | none | `openMenuTarget`: event; `onReconnect`: reset |
| `boundTradeSessionId` | `screenContext.ts` | `screens` | `openTradeEditor`: event; `resetTradeSessionState`, on a join and on a reconnect: reset; the batch listener that drops a closed session: event |
| `shopOpen` | `screens.ts` | `commands` | none |
| `pendingTradeOpen` | `screens.ts` | `interact`, `commands` | `dispatch` sending the open, and the open refused: event |
| `knownSessionIds` | `screens.ts` | none | none |
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
| `lastRendered` | `movement.ts` | `devHooks` | the frame loop's world step: pump |

The movement latches are written where the event happens and read only by `snapshot`.

### Shared collections

| Collection | Owner | Mutated from outside the owner by |
|---|---|---|
| `navHeldCodes` | `inputState.ts` | nothing: `noteNavHeld`, `releaseNavHeld` and `releaseAllInput` are its writers |
| `dismissedRequests` | `notices.ts` | nothing: `dismissRequest`, `forgetClosedSession` and `forgetRequests` are its writers |
| `announcedRequests` | `notices.ts` | nothing: `markAnnounced`, `forgetClosedSession` and `forgetRequests` are its writers |
| `answeredRequests` | `notices.ts` | nothing: `markAnswered`, `releaseAnswered`, `forgetClosedSession` and `forgetRequests` are its writers |
| `careInFlight` | `commands.ts` | `onReconnect` |
| `openedTradeSessions` | `notices.ts` | nothing: `markSessionOpened`, `forgetOpenedSessions` and `forgetClosedSession` are its writers |
| `zoneWarpsById` | `movement.ts` | nothing: `zoneWarps` is its one writer |
| `frameOpens` | `frames.ts` | nothing: `openFrame` is its one writer |
| `tacticsMapFacts` | `battleFrame.ts` | nothing: `mapFactsOf` is its one writer |

### Owner functions the extractions add

These names are proposals. No top-level function of these names exists until its extraction
lands, and that extraction may choose another name; what is fixed is the owner and what the
function takes over.

| Owner | Proposed function | Takes over |
|---|---|---|
| `frames.ts` | `sweepForReconnect` | the `reconnectSweep` block of `onReconnect` |
| `frames.ts` | `takeResultsAutoContinue`, `pumpCareReadiness` | the two frame-loop parts that write `autoContinuedAtMs` and `lastCareTickAtMs` |
| `movement.ts` | `adoptRenderer`, `adoptTelemetry` | the `renderer` and `telemetry` assignments |
| `movement.ts` | `stepWorldFrame` | the frame loop's world step |
| `movement.ts` | `setRawMapZoneForTest` | the body of the test-only zone setter of that name, which `snapshot` goes on exposing |
| `movement.ts` | `revealWorldAfterScopeEdge` | the `worldRevealed` assignment in the scope callback |
| `screens.ts` | `notePendingTradeOpen`, `dropPendingTradeOpen` | the two `pendingTradeOpen` assignments in `dispatch`: set when the open is sent, cleared when it is refused |
| `account.ts` | `cancelArmedDecline` | the claim view's dismissed handler |
| `account.ts` | `pumpPrivacyCountdown`, `forgetPrivacyCountdown`, `dropExportAssembly` | the frame loop's privacy step and the two resets in `onReconnect` |
| `screens.ts` | `resetQuestAck` | the baseline reset in `onReconnect` |
| `commands.ts` | `clearCareInFlight` | the clear in `onReconnect` |
| `input.ts` | `mountInput` | the `pointerSource`, `paintWorldPrompt` and `worldCanvasEl` assignments |

## What `main.ts` keeps

- The boot prelude that writes shared state: the locale block and the text-step apply; and the
  telemetry config.
- Three bindings: `textStep`, `claimRaised`, `lastFrameErrorMessage`; and
  `protocolMismatchLine`, beside the `connect` callback that calls it.
- `RECONNECT_RESETS`, whose rows read the view handles through their imports.
- `main()`: the view constructions and their mounts, the status, toast, prompt and banner
  elements, the `connect` call with its callbacks, the world prompt painter and the frame loop.
  The frame loop stays one function whose body is the ordered list of the owners' pumps.
- Every registration, the port installs ahead of them, and the DEV hook assignments inside
  `if (import.meta.env.DEV)`.

### Registration order

`main.ts` registers in this order. A batch listener is named by its owner and what it does.
The listeners that only forward stay inline: the ones that run `reconcileStack`,
`reconcileFromStore`, `refreshBox`, `refreshRaising` and `refreshBattle`, the last batch listener,
the `error` pair, the two key-phase filters, `blur` and `visibilitychange`. The pad has no
listener: the frame loop polls it.

1. batch: `interact` counts the batch for the candidate memo.
2. batch: `account` recomputes the export assembly and repaints an open Privacy section.
3. batch: `account` repaints the Name section's current name while Profile is open.
4. batch: `menu` lowers the sign-in gate once the own player row is in the store.
5. `window` `error`, then `window` `unhandledrejection`: `pushError`.
6. batch: `frames` runs `reconcileStack`. It is the first of the listeners that show or hide a view.
7. batch: `movement` runs `reconcileFromStore`.
8. `window` `keydown` in the capture phase for Escape, `window` `keydown` in the bubble phase
   for every other key, `window` `keyup`, `window` `blur`, `document` `visibilitychange`.
9. batch: `screens` runs `refreshBox`, then `refreshRaising`.
10. batch: `battleFrame` runs `refreshBattle`, then feeds the shown battle's clock rows to the
    server-time estimate.
11. batch: `screens` paints the dialogue and steps the deferred shop open; refreshes the quest
    log; acknowledges a completed quest; refreshes the heal frame; refreshes the shop; follows the
    trade sessions (a face-to-face editor opens when its row arrives, a closed session closes its
    editor); refreshes the challenge panel.
12. batch: `menu` announces a new request and follows the request badge.
13. batch: `screens` refreshes the leaderboard.
14. batch: `session` steps the battle emit latch, then the ranked emit latch.
15. batch: `screens` paints the evolution notice banner.
16. batch: `frames` syncs the stack and lets every open frame's adapter observe the batch. It
    is the last batch listener.
17. The DEV hook assignments, the build stamp, then `void main()`.

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
| `client/src/net/connection.test.ts`: `applyClaim` joins through `conn?.join()`, and the source never calls or names `joinGame` and never indexes `reducers` by bracket | `account.ts` | the path for `applyClaim`; the three absence checks read `main.ts` and every `shell/` module together |
| `client/src/ui/screens/mainMenuScreen.test.ts`: the source holds `menuState` and reads no level off it | `menu.ts` | the scan reads `main.ts` and every `shell/` module together, so the absence checks widen and the length floor holds |
| `client/src/ui/i18n/catalogParity.test.ts`: the roster of files that import the resolver, and the literal keys `main.ts` resolves | every module that imports the resolver | the roster gains the module; the key set splits between `main.ts` and the module, with the union unchanged |
| `client/vite.config.ts`: `src/main.ts` is excluded from coverage by path | nothing | shell modules are measured; coverage is a report with no threshold |
| the `client/e2e` specs that re-declare the shape of a hook they read | `devHooks.ts` | none while the shapes hold |
| the `client/e2e` specs that abort the request for `src/main.ts` to hold the shell unbooted | nothing | none: a shell module loads only through `main.ts` |

The whole-tree scans (`client/src/ui/i18n/hardcodedStrings.test.ts`,
`client/src/ui/i18n-no-html-sink.test.ts`, the dynamic-key scan in `catalogParity.test.ts`) walk
every non-test file under `client/src`, exempt nothing, and cover a shell module without an edit.
`scripts/verify-build-hooks.mjs` reads the built bundle, so it gates `devHooks.ts` whatever file
holds the hooks.

Prose that names `main.ts` as the home of a symbol follows the symbol, in the slice that moves it:

- `docs/DECISIONS.md`, "Context stack ownership", in three places: the home of `openFrame`, and
  "the three main.ts tables" in the decision and again under what it rules out. The `frames.ts`
  extraction rewrites them in place to name `client/src/shell/frames.ts`; the tables stay three
  separate total records.
- `docs/DECISIONS.md`, "Four message channels, chosen by one policy table", which names
  `main.ts` for the senders it still holds (the battle refusal, the care, shop and rename
  outcomes): the `commands.ts` extraction.
- `ARCHITECTURE.md`, which names `main.ts` for `switchZone`, the frame loop, `dispatch`,
  `applyStack` and `downloadBugBundle`.
- Comments under `client/src` that name `main.ts` as the caller or home of a symbol. An
  extraction lists the files whose comments name what it moves.

## Extractions, in order

The list is section 4 of `docs/refactors/client-platform.md`: one row per slice, with the
symbols each module takes, whether the slice is a move or an interface change, and the tests that
cover it. A **move** relocates whole top-level symbols with every binding they write; bodies
change only by imports, and an inline listener body gains a name. An **interface** change leaves a
writer outside the destination, so it adds an owner function, or it installs a port or adds a
pump. The slice for a row deletes that row and brings this file's tables in line with what it
moved.

An extraction that moves boot wiring or a DEV hook runs the full end-to-end suite as well as
the unit suites, because only the end-to-end specs read the hooks.
