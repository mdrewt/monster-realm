# Client platform: one client, any desktop shell

The client runs in a browser tab and is to run unchanged inside a desktop shell, Electron or
Tauri. This file is the plan for the refactor that gets it there without adding or removing a
feature. It has three parts: the host seam (every place the client reaches something a shell may
provide differently), what happens to the extractions `docs/refactors/client-shell.md` still
lists, and the duplication found across `client/src/`. Section 4 is the one ordered list of
extractions, each one slice. The decision and what it rules out are in `docs/DECISIONS.md`
("The client reaches its host through ports cut where a second host needs one").

Everything here is measured at commit `192b8b3d`, except a row an extraction has rewritten, which
describes the code after that extraction. "Non-test file" means a `.ts` file under
`client/src` that is not a `*.test.ts`, not a `*.d.ts` and not under `module_bindings/`: 198
files, about 51,700 lines.

## 1. The host seam

### 1.1 How it was measured

A scan of the 198 non-test files, with comments and string bodies blanked, lists every identifier
that names an ambient global: `window`, `document`, `navigator`, `location`, `history`,
`localStorage`, `sessionStorage`, `globalThis`, `matchMedia`, `fetch`, `crypto`, `performance`,
the timers, `console`, `URL`, `Blob`, the observers, `Intl`, `Date` and `import.meta.env`. Each
hit is placed in the top-level symbol that holds it. Injected hosts count too: a module that
takes a `host` parameter and reads `sessionStorage` from it is a call site of storage.

`document` is named 304 times. 298 of those build or read the DOM tree: `createElement` 157,
`getElementById` 58, `activeElement` 40, `body` 21, the document handed whole to a chrome builder
(`createFrame(document, …)`) 21, `createTextNode` 1. The other six are the root element (its
`lang`, `dir` and text size) and the visibility registration. A browser tab, Electron's Chromium
and Tauri's webviews all provide the DOM, so the tree is not part of the seam. Neither are
`console` (50), `performance.now` (23, in 6 files), the four timer functions (17 mentions, type
positions included), `Date` (8), `Intl` (6), `ResizeObserver` (8, the context-sheet placement in
four views), `queueMicrotask` (1), the `URL` parser (in 2 files) and `getComputedStyle` (1, and
once more through an element's own window): each is the same web API in all three hosts and no
host is known to need a different one.

### 1.2 Call sites

One row per file and symbol that reaches a capability a shell provides, or may provide,
differently. "Reaches" names the tokens the scan found there. The concern is the row of 1.3 that
owns it.

| File | Symbol | Reaches | Concern |
|---|---|---|---|
| `client/src/shell/config.ts` | module scope (`URI`, `DB`, `TARGET_KIND`) | `globalThis` handed to `readShellDocument`; `import.meta.env` (`DEV`) | shell document |
| `client/src/net/shellDocument.ts` | `readShellDocument`, `renderShellConfigScript` | the own property `__MR_SHELL_CONFIG__` of the injected host; the script text writes `globalThis` | shell document |
| `client/src/shell/config.ts` | `DEV_LOG_LEVEL` | `import.meta.env` (`VITE_MR_DEVLOG`, `DEV`) | build configuration |
| `client/src/net/buildInfo.ts` | `BUILD_INFO` | `import.meta.env` (`DEV`); the bare globals `__MR_BUILD_SHA__` and `__MR_BUILD_TIME__` the build defines | build configuration |
| `client/src/main.ts` | `TELEMETRY_CONFIG`, `OIDC_ISSUER`, `SIGN_IN_OFFER`, `main` | `import.meta.env` (`VITE_MR_OTLP_ENDPOINT`, `VITE_MR_OTLP_INTERVAL_MS`, `VITE_MR_OIDC_ISSUER`, `VITE_MR_OIDC_PROVIDER_NAME`, `VITE_MR_OIDC_CLIENT_ID`, `VITE_MR_OIDC_REDIRECT_URI`, `DEV`) | build configuration |
| `client/src/input/bindingStore.ts` | `browserStorage` | `window.` (`window.localStorage`); its three callers in `client/src/shell/inputState.ts` (`bindings`, `padBindings`, `applyTables`) and three in `client/src/main.ts` (`textStep`, `main` twice) take the handle it returns | device storage |
| `client/src/net/authToken.ts` | `TokenStorageHost`, `storageMethod`, `createAuthTokenGate`, `readAuthKind`, `writeAuthKind` | `localStorage`, `sessionStorage` of the injected host | credential storage |
| `client/src/net/claimCode.ts` | `ClaimCodeHost`, `storageMethod`, `drawRandomBytes` | `sessionStorage`, `readonly crypto?` of the injected host | credential storage |
| `client/src/net/oidc.ts` | `OidcHost`, `storageMethod`, `drawRandomBytes`, `computeChallenge`, `createOidcClient` | `sessionStorage`, `readonly crypto?`, `readonly fetch?`, `readonly location?`, `readonly history?` of the injected host | sign-in navigation |
| `client/src/net/connection.ts` | `connect` | `globalThis` handed as the host at ten call sites (`createAuthTokenGate`, `createOidcClient`, `writeAuthKind`, `wasEverAuthenticated` twice, `claimCode.hasUnconsumed` twice, `.read`, `.mint`, `.clear`) | credential storage |
| `client/src/net/connection.ts` | `connect` (`beginOidcRedirect`) | `globalThis` read for `location.assign` | sign-in navigation |
| `client/src/main.ts` | `applyClaim`, `openProfile` | `globalThis` handed to `claimCode.clear`, `.hasSeenFirstRunNudge`, `.markFirstRunNudgeSeen` | credential storage |
| `client/src/platform/handoff.ts` | `openExternal`, `saveFile` | `window.` (`window.open`, for the Steam store entry `applyMenuStep` passes); `createObjectURL`, `Blob`, a hidden `<a download>`, `revokeObjectURL` (for the personal-data export `downloadExportBundle` passes) | hand-off |
| `client/src/main.ts` | `downloadBugBundle` | `createObjectURL`, `Blob`, a hidden `<a download>`, `revokeObjectURL` | hand-off |
| `client/src/render/resizeWiring.ts` | `installResizeHandler` | `innerWidth`, `innerHeight`, `devicePixelRatio`, the `resize` event and the root style of the injected `ResizeWindow` | window size |
| `client/src/render/world.ts` | `WorldRenderer` (`init`) | `window.` (`innerWidth`, `innerHeight`, `devicePixelRatio`) | window size |
| `client/src/main.ts` | `main` | `window.` handed to `installResizeHandler`; `innerWidth`, `innerHeight` for the request prompt | window size |
| `client/src/main.ts` | module scope | `window.` (`blur`), `visibilitychange`, `document.visibilityState`: both release held input | visibility and page life |
| `client/src/net/connection.ts` | `connect` | `window.` (`pagehide`, `pageshow`) | visibility and page life |
| `client/src/render/motionPreference.ts` | `MatchMediaHost`, `motionPreferenceFromWindow` | `matchMedia` of the injected host, `window` by default | motion preference |
| `client/src/shell/screenContext.ts` | `motionPreference` | calls `motionPreferenceFromWindow` with its default host, once at import | motion preference |
| `client/src/main.ts` | module scope | `window.` (`keydown` in the capture phase, `keydown`, `keyup`) | keyboard |
| `client/src/shell/inputState.ts` | `pad` | `navigator.` (`getGamepads`), read at each poll | gamepad |
| `client/src/input/pointerSource.ts` | `BROWSER_CLOCK` | `window.` (`setTimeout`, `clearTimeout`); pointer events on the game-screen element | pointer |
| `client/src/main.ts` | `LOCALE` | `window.` (`window.location.search`), `navigator.` (`languages`); writes `<html lang, dir>` | locale |
| `client/src/main.ts` | `main` | `navigator.` (`userAgent`, `maxTouchPoints`) handed to telemetry as hints | device hints |
| `client/src/main.ts` | module scope | `window.` (`error`, `unhandledrejection`) | error capture |
| `client/src/main.ts` | `main` | `requestAnimationFrame` | frame clock |
| `client/src/main.ts` | module scope | `window.` (`__game`, `__mrTrade`, `__mrPvp`, `__mrTactics` under `import.meta.env` `DEV`; `__mrBuild`) | debug hooks |
| `client/src/net/connection.ts` | `connect` (`build`) | the SDK's WebSocket, opened by `DbConnection.builder().withUri(…)` to the target's address | network and page policy |
| `client/src/observability/telemetry.ts` | `loadOtelSdk` | the metrics exporter's HTTP request to the build's endpoint, made only toward an `official` or `test` target | network and page policy |
| `client/src/render/world.ts` | `WorldRenderer` | Pixi's `Assets.load` of the art atlases, from the page's own origin | network and page policy |
| `client/src/shell/config.ts` | module scope (`STEP_MS`, `PROTOCOL_VERSION`) | the wasm package, compiled when the module is imported | network and page policy |
| `client/src/render/world.ts` | `WorldRenderer` (`init`) | the GPU context Pixi's `Application.init` creates on its canvas, and its `webglcontextrestored` event | rendering |

No file reads or requests fullscreen, and no file calls Steam; the store entry above is the only
Steam-related reach. The wasm module and the bundle's own chunks load from the page's origin like
the art.

### 1.3 Concerns, their ports and what each adapter provides

Every concern has one owner. The owner is a port, a module under `client/src/platform/`, only
where a second host is known to need one (1.5): "one port per concern" and "no port for a single
implementation no second host needs" are read together as one owner per concern. Every other concern keeps the owner it has: an
injected structural type the real global satisfies, or the module that registers the DOM event.
The Electron and Tauri columns say what that shell's adapter provides; "same web API" means the
shell provides nothing of its own and the browser code runs. A claim
about a shell comes from its documentation unless it says "unverified"; none was run here.

| Concern | Owner | Browser | Electron | Tauri |
|---|---|---|---|---|
| shell document | `readShellDocument` in `client/src/net/shellDocument.ts`, called once by `client/src/shell/config.ts` | the classic script `/shell-config.js` sets the page global | the preload sets it with `contextBridge.exposeInMainWorld` (measured, `docs/local-play.md` section 2) | an initialization script sets it before the document is parsed (documented, not run) |
| build configuration | the build, no port: `import.meta.env` and the two build globals are fixed when the bundle is built, and one bundle serves every host | the build's values | the same bundle, so the same values | the same bundle, so the same values |
| device storage | `StorageLike` in `client/src/input/bindingStore.ts`, resolved by `browserStorage` | `window.localStorage` | same web API; the shell registers its page scheme as standard so Web Storage is enabled | same web API; persistence across launches under `tauri://localhost` is unverified |
| credential storage | `TokenStorageHost` (`client/src/net/authToken.ts`), `ClaimCodeHost` (`client/src/net/claimCode.ts`) | `sessionStorage` and `localStorage` of `globalThis`, by target kind | same web API | same web API |
| sign-in navigation | `OidcHost` in `client/src/net/oidc.ts`; the credential port of 1.4 replaces it under a shell | `location.assign` to the issuer, the return leg read from `location` and cleaned with `history.replaceState` | nothing: the shell refuses navigation off its origin and hands a credential instead (1.4) | nothing: the same |
| hand-off | `client/src/platform/handoff.ts`: `openExternal`, `saveFile` | `window.open(url, '_blank', 'noopener')`; a blob URL on a hidden `<a download>` | the bridge's `openExternal` (the system browser or the Steam overlay's store page) and `saveFile` (a save dialog, then a write); where the shell supplies neither, `window.open` and the blob download run and its own handlers decide (`setWindowOpenHandler`, `will-download`) | the bridge's `openExternal` (the opener plugin or the overlay) and `saveFile` (a save dialog, then a write); a blob download is reported to fail under WKWebView, so `saveFile` is required there |
| window size | `ResizeWindow` in `client/src/render/resizeWiring.ts` | `window` | same web API | same web API |
| visibility and page life | `main.ts` (`blur`, `visibilitychange`) and `connect` in `client/src/net/connection.ts` (`pagehide`, `pageshow`) register the DOM events; no port | `blur`, `visibilitychange`, `pagehide`, `pageshow` | same web API, unverified; the overlay signal of 1.4 is separate | same web API, unverified |
| motion preference | `MatchMediaHost` in `client/src/render/motionPreference.ts` | `window.matchMedia` | same web API | same web API |
| keyboard | `KeyEventLike` in `client/src/input/keyboardSource.ts`; `main.ts` registers the DOM events | `keydown`, `keyup` on `window` | same web API | same web API |
| gamepad | `getPads` of `GamepadSource` in `client/src/input/gamepadSource.ts`, bound in `client/src/shell/inputState.ts` | `navigator.getGamepads` | same web API (Chromium) | same web API where the webview has it: WebKitGTK builds it only with libmanette and WKWebView is reported to return an empty list (1.4, the pad the Gamepad API does not show) |
| pointer | `PointerClock` in `client/src/input/pointerSource.ts`; the source registers its own DOM events | DOM pointer events, `window.setTimeout` | same web API | same web API |
| locale | `main.ts`, no port: it reads the `locale` query parameter first, then `navigator.languages` | the page URL and the browser's languages | the shell adds `?locale=` to the URL it loads when Steam's language differs | the same |
| device hints | `DeviceHints` in `client/src/observability/deviceClass.ts` | `navigator.userAgent`, `navigator.maxTouchPoints` | same web API | same web API |
| error capture | `main.ts` registers the DOM events; no port | `error`, `unhandledrejection` on `window` | same web API | same web API |
| frame clock | `main.ts` (`main`); no port | `requestAnimationFrame` | same web API | same web API |
| debug hooks | `main.ts`, no port: the four hooks are assigned only in a development build | properties of `window` | same web API | same web API |
| network and page policy | the SDK, the exporter, Pixi and the wasm loader, which open their own connections; no port | the page's origin and the configured addresses, with no content security policy | the app protocol serves the bundle, its art and the wasm module; the shell's content security policy must name the world's server in `connect-src` and allow wasm compilation, the `style` attributes of `index.html` and, while a download uses one, `blob:` addresses (unverified against a strict policy) | the same, through Tauri's protocol and its content security policy |
| rendering | `WorldRenderer` in `client/src/render/world.ts`, through Pixi; no port | the browser's WebGL or WebGPU | Chromium's; the Steam overlay may need GPU flags, which the overlay probe measures | the webview's: a WebKit build drew the client with WebGL2 and no `navigator.gpu` (`docs/local-play.md` section 2) |

### 1.4 Ports with no call site today

The spec names these concerns. No client code reaches them, so no port is added by this plan;
the slice that writes the first call site adds the port, under `client/src/platform/`, with the
browser adapter as its default.

| Concern | First call site comes from | Browser | Electron | Tauri |
|---|---|---|---|---|
| a credential the shell supplies | the Steam sign-in slice of M-account-service: one more `ConnectCredential` source for `connect` | none: the OIDC flow | the bridge hands an ID token; the Steam ticket stays in the main process (`auth.getAuthTicketForWebApi`) | the bridge hands an ID token (`User::authentication_session_ticket_for_webapi` in the Rust process) |
| achievements | M-steam-features | a no-op | `achievement.activate(name)` behind a bridge function | `UserStats::achievement(name)` and `store_stats` behind a bridge function |
| the overlay opened | the Steamworks slice, if the overlay probe shows held input survives the overlay | none | `steamworks.js` exposes no such callback (unverified whether `blur` fires) | `GameOverlayActivated { active }` in the Rust crate |
| a pad the Gamepad API does not show (Steam Input, or a webview without the API) | the Steamworks slice, which makes `getPads` in `client/src/shell/inputState.ts` take a read function from the bridge | none: `navigator.getGamepads` | by default Steam presents the controller as an Xbox pad, which the gamepad concern reads if the webview's Gamepad API sees it (unverified); else a read function over `input.getDigitalAction` | the same, over `Input::get_digital_action_data` |
| fullscreen | whichever slice adds a fullscreen control | `requestFullscreen` | `BrowserWindow.setFullScreen` | the window's `setFullscreen` (unverified) |

### 1.5 The shape: ports where a second host needs one, one bundle, a run-time bridge

- **A port is a module under `client/src/platform/`** that exports plain functions and holds
  today's browser code as its default. `ui/`, `net/`, `input/`, `render/`, `tactics/`, the shell
  modules and `main.ts` may import it; it imports none of them.
- **One port exists after this plan: `platform/handoff.ts`**, for what the client hands to the
  host's operating system. `openExternal(url)` opens an address outside the game; `saveFile`
  writes a file the client generated. A second host needs both: the desktop shell as specified
  refuses `window.open` (the Electron shell slice of M-local-play), and a blob download is not
  known to work in every webview.
- **Every other concern keeps its owner.** Ten structural types exist and each is satisfied by
  the real global and by a small fake: `TokenStorageHost`, `ClaimCodeHost`, `OidcHost`,
  `StorageLike`, `PadLike` with `getPads`, `KeyEventLike`, `PointerClock`, `MatchMediaHost`,
  `ResizeWindow` and `DeviceHints`. Each is the owner of its concern. `globalThis`, `window` and
  `navigator` are handed to them at the composition points.
- **A shell supplies a port's function through one page global, the shell bridge.** It is set
  before the client module runs, by the hook that sets the shell document (an Electron preload,
  a Tauri initialization script), and holds only functions, one per port verb the shell
  overrides. It is an own property of the page global that the page cannot write or
  reconfigure, as the shell document is. The client reads it once, the way `readShellDocument`
  reads the shell document; a verb the bridge does not hold runs the browser code. Both shells
  implement the same bridge, so one bundle runs in a tab, in Electron and in Tauri. Proposed name:
  `__MR_SHELL_HOST__`, read by `readShellHost` beside the ports.
- **The bridge reader is not part of this refactor.** A page global the client honours is new
  behaviour a caller can observe, so it is a feature: the first slice that has a shell to supply
  a function builds it (the Electron shell slice for `openExternal` and `saveFile`, the Steam
  sign-in slice for the credential).
  Until then `handoff.ts` holds one implementation per verb and the browser build behaves as it
  does today. The bug bundle joins `saveFile` through finding F3; until that lands it saves
  through the blob download in every host.
- **Rules for any shell's bridge.** A bridge function validates in the shell's own process and
  trusts nothing the page sends: `openExternal` takes only an address on the shell's allow-list;
  `saveFile` writes only where the player picks in a dialog. `saveFile` is given the personal-data
  export: a shell never logs it and never sends it anywhere but the chosen file. No Steamworks
  or Node object crosses the bridge, only strings and plain data.
- **What this asks of the shell's specification.** The Electron shell is specified, in
  M-local-play, with a preload that exposes the shell document "and nothing else" and with "no IPC
  channel to the page"; the Steam sign-in, in M-account-service, already hands the page a token
  through a preload hook. A bridge needs that text to allow the bridge's named functions. Whether
  a shell's page may call into the shell at all is a question of the shell's security posture,
  which is the operator's: the bridge is this plan's default, and the operator may overrule it.
  Nothing in section 4 waits on the answer. If the answer is no, the ports stand, their browser
  code runs under the shell, and the shell handles `window.open` and the download in its own
  process; the shell's refusal of `window.open` then becomes "an address on the allow-list goes to
  the system browser, every other is refused".

### 1.6 Shapes judged

A judge scored four shapes from one dossier of the facts above, 0 to 10 per criterion, on a
rubric and tie-break fixed beforehand (the tie-break, for totals within 3 points, was the first
criterion, then the second, then the unweighted total).

- **A, one host object injected at boot:** one `Host` interface with a member per concern, a
  browser implementation, and a shell laying its members over it.
- **B, a port module per concern with the adapter chosen at build time:** seven port modules, an
  implementation file per host selected by a build variable, one bundle per host.
- **C, ports only where a second host needs one, one bundle, a run-time bridge:** this section.
- **D, the web platform is the port:** no client seam; each shell makes `window.open`, the blob
  download and navigation behave inside its own process.

| Criterion | Weight | A | B | C | D |
|---|---|---|---|---|---|
| 1. What each shell must write | 3 | 7 | 2 | 9 | 6 |
| 2. How it tests with the client's existing fakes | 3 | 5 | 3 | 9 | 10 |
| 3. What leaves `main.ts` | 2 | 5 | 5 | 7 | 5 |
| 4. No abstraction without a second host | 2 | 3 | 3 | 10 | 10 |
| 5. Safety as refactor slices | 2 | 4 | 3 | 8 | 10 |
| 6. Fit with what is recorded and specced | 3 | 6 | 2 | 8 | 3 |
| Total | 150 | 78 | 43 | 128 | 107 |

C is first by 21 points, so the tie-break did not apply. What decided it: A routes six concerns
through members no second host needs and moves listener registration out of `main.ts`; B builds
one bundle per shell, which the overlay probe's "the same bundle in both shells" rules out, and
faking a port needs a module mock; D adds no port for the Steam calls and leaves a webview that
cannot download a blob with no answer.

The judge named what would reverse the result. If the shell's specified rule, "no IPC channel to
the page", stands as written, the bridge is not allowed, C scores 107, level with D, and D wins the
tie-break. That reversal does not change section 4: `handoff.ts` defaults to the web APIs, so a
shell that supplies no bridge function handles `window.open` and the download in its own
process, which is D's mechanism behind C's port. The judge also noted that a shell may choose
this per verb, for example a bridge for the file save and its own handler for links.

### 1.7 What is not measured

- Whether `blur`, `visibilitychange` and `pagehide` fire in each shell's webview, and whether the
  Steam overlay opening fires any of them.
- Whether a blob download and `window.open` behave in Electron and in each Tauri webview when the
  shell handles them; whether Web Storage persists across launches under Tauri's origin.
- How a Tauri initialization script reaches `invoke` without turning on `withGlobalTauri`, which
  exposes the whole Tauri API to the page.
- Whether a pad under Steam Input reaches a webview's Gamepad API.
- Whether the page loads under a strict content security policy: wasm compilation, the `style`
  attributes of `index.html` and `blob:` addresses each need an allowance.

The overlay probe and the shell slices measure these; none changes an extraction below.

## 2. The rest of `docs/refactors/client-shell.md`

### 2.1 The twelve extraction lines against `main.ts`

The starting point is the list `client-shell.md` holds at `192b8b3d`: twelve numbered lines,
extractions 7 to 18, each naming a module under `client/src/shell/` and the symbols it takes.
Measured against `main.ts` at that commit, which holds 257 top-level declarations: the twelve
lines name 213 symbols, and 208 of them are declared in `main.ts`.

- **Five named symbols are not declared in `main.ts`:** `openPropose` (extraction 12) and
  `TRADE_ANSWER`, `TRADE_SETTLE`, `TRADE_CANCEL`, `TRADE_PROPOSE` (extraction 16). Section 4
  leaves them out.
- **42 declarations are named by no line and are not in "What `main.ts` keeps".** Section 4
  gives 41 of them an owner: the sign-in constants (`OPERATED_BY_US`, `OIDC_ISSUER`, `SIGN_IN_MODE`,
  `SIGN_IN_OFFER`, `ACCOUNT_REQUIRED`); the trade editor (`openedTradeSessions`,
  `pendingTradeOpen`, `TRADE_OPEN_WAIT_MS`, `knownSessionIds`, `resetTradeSessionState`,
  `openTradeEditor`, `closeTradeEditor`, `tradeOpenExpired`); the sign-in gate (`signInGate`,
  `saidGateLine`, `signInGateView`, `showSignInGate`, `lowerSignInGate`, `applySignInGate`,
  `holdSignInGate`); the pad poll (`TerminalPhase`, `terminalPhase`, `padPhase`,
  `pollTerminalPad`, `pollPad`, `pressEdges`, `settleControlsCapture`); the battle playback
  (`resultsAwaitDrain`, `serverClock`, `feedTacticsShell`, `holdResultsForPlayback`); and `owed`,
  `lastRendered`, `worldRevealed`, `zoneWarpsById`, `zoneWarps`, `worldIsBare`, `ownNameModel`,
  `evolutionNoticeOk`, `MrSessionOffer`, `mrSessionOffer`. `protocolMismatchLine` stays in
  `main.ts` beside the `connect` callback that calls it.
- **`main.ts` registers 23 batch listeners.** Three have no place in that list's registration
  order: the Name section's repaint, the sign-in gate's lowering and the server-clock feed after
  `refreshBattle`; and the listener it names for the trade panel follows the trade sessions.
  `client-shell.md`'s "Registration order" lists all 23 in the order `main.ts` registers them.
- **Three call cycles cross the module map.** `applyMenuStep` calls `dispatch` and
  `showSignInGate` calls `applyStack` (both menu); `runInteract` (interact) calls `dispatch`;
  `closeTradeEditor` (screens) calls `dispatch`. `commands.ts` sits above all three in the map
  and imports them. The battle port serves `battleFrame.ts` alone.
- **One lower module writes a higher one's bindings.** `holdResultsForPlayback` (battle frame)
  assigns `outcomeShownAtMs` and `autoContinuedAtMs`, which `frames.ts` owns.

### 2.2 The command port

`dispatch` and `applyStack` are reached from four modules below `commands.ts`. They get one
port: `client/src/shell/commandPort.ts`, a module that imports no shell module and holds a typed
object with those two members, installed once by `main.ts` before its first listener registers
and throwing until then, as the hint host does. `battleFrame.ts`, `screens.ts`, `menu.ts` and
`interact.ts` call it. The battle port keeps what only the battle frame needs from the stack:
the read of `contextStack` in `popOverBattleBeforeSwitch` and `buildResultsPanel`, and a function
that clears the outcome edge for `holdResultsForPlayback`. Extraction 3 adds the command port
while every caller is still in `main.ts`, so the moves after it are moves.

### 2.3 Disposition of extractions 7 to 18

Each of the twelve is carried into section 4, which is the one list; `client-shell.md` keeps its
rules, module map, ports, pumps and owner tables and points here. The numbers in the first
column are the list's at `192b8b3d`, not the rows of the module map. "Kept" means the same
module takes the same responsibility, with the symbols section 4 lists. None is superseded and
none is dropped.

| Extraction | Module | Disposition | Section 4 |
|---|---|---|---|
| 7 | `shell/notices.ts` | kept; takes `openedTradeSessions` as well | 4 |
| 8 | `shell/battleFrame.ts` | kept; takes the battle playback symbols; its port carries the stack reads and the outcome edge, and the command port the rest | 5 |
| 9 | `shell/frames.ts` | kept; takes `worldIsBare` | 6 |
| 10 | `shell/movement.ts` | kept; takes `owed`, `lastRendered`, `worldRevealed`, `zoneWarpsById`, `zoneWarps` | 7 |
| 11 | `shell/account.ts` | kept; takes `SIGN_IN_OFFER`, `ownNameModel` and the Name repaint; its export download calls `saveFile` | 8 |
| 12 | `shell/screens.ts` | kept; takes the trade editor symbols | 9 |
| 13 | `shell/menu.ts` | kept; takes the sign-in gate; a plain move once the command port exists | 10 |
| 14 | `shell/interact.ts` | kept; `evolutionNoticeOk` goes to `shell/views.ts` as a mount in the same slice | 11 |
| 15 | `shell/bugReport.ts` | kept | 12 |
| 16 | `shell/commands.ts` | kept | 13 |
| 17 | `shell/input.ts` | kept; takes the pad poll | 14 |
| 18 | `shell/devHooks.ts` | kept; takes `MrSessionOffer`, `mrSessionOffer` | 15 |

All twelve keep their relative order. They are reordered only against the new work: extractions
2 and 3 of section 4 land first, because 2 gives `account.ts` the issuer its sign-in offer is
built from and 3 removes the cycles. The code that moves into `account.ts` and `menu.ts` calls the
hand-off port, `platform/handoff.ts`.

## 3. Duplication and structure across `client/src/`

### 3.1 How it was measured

A scan hashes every window of six consecutive normalised lines (comments, imports and bare
punctuation dropped; the catalogs excluded) across the non-test files: 51 clone pairs, 392
paired lines. Three readers then went through `ui/`, `net/` with `shell/` and `main.ts`, and
`render/` with `input/`, `tactics/` and `prediction/`, reading every copy of each candidate. Each
finding below was checked against the code again before it was written down.

### 3.2 Findings

"Extraction" names the row of section 4. "Not worth moving" gives the reason.

| # | What repeats or sits in the wrong place | Where | Outcome |
|---|---|---|---|
| D1 | `ensureElement` and `frameAnchor`, identical in four views (a fifth `ensureElement`, in `ui/evolutionNotice.ts`, is a different function) | `ui/claimView.ts`, `ui/controlsView.ts`, `ui/privacyView.ts`, `ui/sessionView.ts` | extraction 16: `ui/domParts.ts` |
| D2 | three SDK row shapes declared twice | `net/connection.ts` (`SdkConversationRow`, `SdkHealRow`, `SdkNpcRow` inside `wireTables`), `net/rowConvert.ts` (`SdkPlayerConversation`, `SdkHealLocationRow`, `SdkNpcRow`) | extraction 17: `rowConvert.ts` exports its three; `connection.ts` imports them |
| D3 | narrowing an injected host to one storage method, drawing random bytes, hex encoding, the `prefix\|uri\|db` key | `net/authToken.ts`, `net/claimCode.ts`, `net/oidc.ts` (`storageMethod` three times, `drawRandomBytes` twice, `toLowerHex` and `toHex`) | extraction 18: `net/hostAccess.ts`; each caller keeps its own failure direction |
| D4 | the keep-set reconcile loop written five times beside a generic one | `net/store.ts` (monsters, battles, trade sessions, inventory, export chunks; `#reconcileKeyed`) | extraction 19: `#reconcileKeyed` takes the equality as a parameter |
| D5 | twelve identical insert, update and delete registrations | `net/connection.ts` (`wireTables`) | extraction 20: one local helper, the registration order unchanged |
| D6 | the battle panels' element helper (four copies), root and title (three), countdown line (two) | `tactics/clock.ts`, `tactics/hud.ts`, `tactics/deployPanel.ts`, `tactics/results.ts`, `tactics/tacticsBattle.ts` | extraction 21: `tactics/panelParts.ts` |
| D7 | store-to-view-model mappers in the wasm port's file | `tactics/wasm.ts` (`shellKind`, `activeUnitOf`, `statusTagOf`, `intentKind`, `overlaySets`, `unitRowOf`) | extraction 22: `tactics/storeMap.ts` |
| D8 | the Blob, object URL and hidden anchor of a download, twice | `platform/handoff.ts` (`saveFile`, which the export calls), `main.ts` (`downloadBugBundle`) | `saveFile` in `platform/handoff.ts` holds the export's steps; the bug bundle differs in its cleanup on a failure and joins through finding F3 |
| D9 | `globalThis` handed as the host at ten call sites | `net/connection.ts` (`connect`) | not worth moving: one local alias saves ten identical words and changes no dependency; `connect` takes a host option when a shell supplies a credential |
| D10 | "if the view is open, refresh it" batch listeners with the same inner `try` | `main.ts` (quest log, heal, shop, leaderboard, challenges) | not worth moving: extraction 9 moves them whole; their guards and log tags differ, and a helper saves under thirty lines |
| D11 | SDK row and store row types mirror each other | `net/rowConvert.ts`, `net/store.ts`, `ui/exportAssembly.ts` | not worth moving: they are the two sides of the conversion boundary and differ at identity, enums and essence |
| D12 | a store row rebuilt into an SDK shape so `convert` can unwrap it | `main.ts` (`reconcileFromStore`), `convert/convert.ts` | not worth moving until `shell/movement.ts` exists: eight lines, and the fix is a store-shaped overload in `convert/` |
| D13 | frame section helpers (`sectionHeader`, the claim and privacy row sections) | `ui/claimView.ts`, `ui/privacyView.ts`, `ui/renameView.ts`, `ui/sessionView.ts` | not worth moving: two or three copies of four to thirty lines whose differences (a fallback row, a refused branch) would become parameters |
| D14 | hand-built title bars beside `createFrame` | `ui/boxView.ts`, `ui/raisingView.ts` and five smaller variants | not worth moving: five of the seven locate their bar in static markup, which `createFrame` does not do |
| D15 | the `ResizeObserver` that re-places a context sheet | `ui/boxView.ts`, `ui/raisingView.ts`, `ui/controlsView.ts`, `ui/shopView.ts` | not worth moving: four to six lines each, and the four placement bodies differ in slot and host |
| D16 | the keyed-render check | `ui/boxView.ts`, `ui/raisingView.ts` (the same private method) and five inline variants | not worth moving: sharing it hands each view's key field to a helper to save nine lines, and the variants key on different things |
| D17 | Start, Select and B handling at the top of each screen's button switch | eight files under `ui/screens/` | not worth moving: four lines per screen inside that screen's exhaustive switch; a helper returns a result each caller still branches on |
| D18 | the binding-table parsers for keys and for the pad | `input/bindingStore.ts` (`parseBindings`, `parsePadBindings`) | not worth moving: the two differ on purpose in how a duplicate claim is treated, so a generic parser carries both policies as parameters |
| D19 | the show and hide skeleton of the three battle panels | `tactics/deployPanel.ts`, `tactics/results.ts`, `tactics/tacticsBattle.ts` | not worth moving: the shared part is `ui/overlayA11y.ts` already; the rest is an order each panel states in its header |
| D20 | the window size read in two places | `render/world.ts` (`init`), `render/resizeWiring.ts` | not worth moving: three property reads; `init` applies its own scale on purpose |
| D21 | view-model shapes and the unknown-name fallback | `ui/boxModel.ts`, `ui/tradeModel.ts`, `ui/raisingModel.ts`, `ui/shopModel.ts` | not worth moving: they project different store rows, and one shape would couple the trade card to the box card |
| D22 | exhaustive event-tag switches, the protected-button subset, the empty overlay literals, the art-pack sheet rows | `tactics/presentation.ts`, `tactics/results.ts`, `input/bindings.ts`, `tactics/boardModel.ts`, `render/art/packs/` | not worth moving: each is a compile-time roster, a deliberate subset, two distinct types, or data a test checks against the files |

Single-sourced already, so nothing to do: overlay open and close (`ui/overlayA11y.ts`), the
frame feedback machine (`ui/frame.ts`), roving focus (`ui/screens/profileScreen.ts`), the context
sheet (`ui/contextSheet.ts`), the empty state (`ui/emptyState.ts`), HP percent
(`ui/boxModel.ts`), scale maths (`render/viewport.ts`), metric names (`observability/names.ts`),
interpolation constants (`shared/interpConfig.ts`) and movement marshalling
(`convert/convert.ts`).

## 4. Extractions, in order

Each row is one slice under `standards/spec-driven.md` section "Refactor slices". A **move**
relocates whole top-level symbols and is `tier: routine`; an **interface** change adds or changes
a signature, a port or an owner function and is `tier: hard`. No row does both. Every row adds no
feature and removes none: behaviour, public signatures outside the named symbols, registration
order and every asserted value stay as they are, and a defect met on the way is reported, never
fixed in the slice. The slice for a row deletes that row. The symbol lists are measured at
`192b8b3d`; the section written for a slice measures them again at its base.

| # | Module | Kind | Tier | Creates | Covering tests | Feature change |
|---|---|---|---|---|---|---|
| 2 | sign-in constants | move | routine | nothing | `client/src/shell/config.test.ts`, `client/src/main.signInGate.test.ts`, `client/src/main.targetKindGate.test.ts` | none added, none removed |
| 3 | command port | interface | hard | `client/src/shell/commandPort.ts` | `client/src/main.dispatch.test.ts`, `client/src/main.menu.test.ts`, `client/src/main.signInGate.test.ts`, `client/src/main.social.test.ts` | none added, none removed |
| 4 | notices | interface | hard | `client/src/shell/notices.ts` | `client/src/main.notices.test.ts`, `client/src/main.noticesRt.test.ts`, `client/src/main.reconnectStack.test.ts` | none added, none removed |
| 5 | battle frame | interface | hard | `client/src/shell/battleFrame.ts` | `client/src/main.dispatch.test.ts`, `client/src/main.battle-reseed.test.ts`, `client/src/tactics/tacticsBattle.test.ts`, `client/src/tactics/deployPanel.test.ts`, `client/src/tactics/results.test.ts` | none added, none removed |
| 6 | frames | interface | hard | `client/src/shell/frames.ts` | `client/src/main.dispatch.test.ts`, `client/src/main.reconnectStack.test.ts`, `client/src/main.a11yFocus.test.ts` | none added, none removed |
| 7 | movement | interface | hard | `client/src/shell/movement.ts` | `client/src/main.input.test.ts`, `client/src/main.zoneCue.test.ts`, `client/src/main.worldReveal.test.ts`, `client/src/net/switchZoneAtomicity.test.ts` | none added, none removed |
| 8 | account | interface | hard | `client/src/shell/account.ts` | `client/src/main.claimCode.test.ts`, `client/src/main.signInGate.test.ts`, `client/src/main.privacyWiring.test.ts`, `client/src/main.privacyCountdown.test.ts`, `client/src/main.exportTransport.test.ts` | none added, none removed |
| 9 | screens | interface | hard | `client/src/shell/screens.ts` | `client/src/main.social.test.ts`, `client/src/main.shopBalance.test.ts`, `client/src/main.dialogueDismiss.test.ts`, `client/src/main.controls.test.ts`, `client/src/main.help.test.ts` | none added, none removed |
| 10 | menu | move | routine | `client/src/shell/menu.ts` | `client/src/main.menu.test.ts`, `client/src/main.signInGate.test.ts` | none added, none removed |
| 11 | interact | interface | hard | `client/src/shell/interact.ts` | `client/src/main.chips.test.ts`, `client/src/main.dispatch.test.ts`, `client/src/main.input.test.ts`, `client/src/main.hintBar.test.ts` | none added, none removed |
| 12 | bug report | move | routine | `client/src/shell/bugReport.ts` | `client/src/main.help.test.ts`, `client/src/main.input.test.ts`, `client/src/ui/bugBundle.test.ts` | none added, none removed |
| 13 | commands | interface | hard | `client/src/shell/commands.ts` | `client/src/main.dispatch.test.ts`, `client/src/main.partyFull.test.ts`, `client/src/main.shopBalance.test.ts`, `client/src/main.feedbackCore.test.ts` | none added, none removed |
| 14 | input | interface | hard | `client/src/shell/input.ts` | `client/src/main.input.test.ts`, `client/src/main.remap.test.ts`, `client/src/main.accel.test.ts`, `client/src/main.controls.test.ts`, `client/src/main.hintBar.test.ts` | none added, none removed |
| 15 | dev hooks | move | routine | `client/src/shell/devHooks.ts` | `client/src/main.dispatch.test.ts`, `client/src/main.worldReveal.test.ts` | none added, none removed |
| 16 | DOM parts | move | routine | `client/src/ui/domParts.ts` | `client/src/ui/claimView.test.ts`, `client/src/ui/controlsView.test.ts`, `client/src/ui/privacyView.test.ts`, `client/src/ui/sessionView.test.ts` | none added, none removed |
| 17 | SDK row types | move | routine | nothing | `client/src/net/rowConvert.test.ts`, `client/src/net/connection.runtime.test.ts` | none added, none removed |
| 18 | host access | interface | hard | `client/src/net/hostAccess.ts` | `client/src/net/authToken.test.ts`, `client/src/net/claimCode.test.ts`, `client/src/net/oidc.test.ts` | none added, none removed |
| 19 | store reconcile | interface | hard | nothing | `client/src/net/store.test.ts`, `client/src/net/viewReconcile.test.ts` | none added, none removed |
| 20 | table registrations | interface | hard | nothing | `client/src/net/connection.runtime.test.ts`, `client/src/net/connection.test.ts`, `client/src/net/viewDelete.test.ts` | none added, none removed |
| 21 | battle panel parts | interface | hard | `client/src/tactics/panelParts.ts` | `client/src/tactics/deployPanel.test.ts`, `client/src/tactics/results.test.ts`, `client/src/tactics/tacticsBattle.test.ts`, `client/src/tactics/hud.test.ts`, `client/src/tactics/clock.test.ts`, `client/src/tactics/strings.test.ts` | none added, none removed |
| 22 | tactics store map | move | routine | `client/src/tactics/storeMap.ts` | `client/src/tactics/wasm.test.ts`, `client/src/net/rowConvert.test.ts` | none added, none removed |

What each row takes. **The shell set** is the `touches:` every row that moves code out of
`main.ts` has: `client/src/main.ts`; the destination module and its sibling test
(`client/src/shell/<module>.ts`, `client/src/shell/<module>.test.ts`); the
`client/src/main.*.test.ts` family; `client/test-util/mainBootHarness.ts`;
`client/src/ui/i18n/catalogParity.test.ts`, whose roster of files that import the catalog
resolver gains the module when it resolves a string; this file;
`docs/refactors/client-shell.md`; and `ARCHITECTURE.md`. A row names what it touches beside that
set. A row that moves boot wiring or a DEV hook (5, 14, 15) runs the full end-to-end suite as
well.

2. `client/src/shell/config.ts` takes `OPERATED_BY_US`, `OIDC_ISSUER`, `SIGN_IN_MODE` and
   `ACCOUNT_REQUIRED`. They are constants with no writer, resolved from `TARGET_KIND` and one
   build value; `config.ts` gains one type import (`SignInMode`) and nothing at run time.
   `SIGN_IN_OFFER` goes with row 8; `TELEMETRY_CONFIG` and the locale block stay in `main.ts`.
   Touches: `client/src/main.ts`, `client/src/shell/config.ts`, `client/src/shell/config.test.ts`,
   the `client/src/main.*.test.ts` family, this file, `docs/refactors/client-shell.md` and
   `ARCHITECTURE.md`.
3. `client/src/shell/commandPort.ts` is created (2.2). `main.ts` installs it beside the hint host.
   `buildDeployPanel`, `buildResultsPanel`, `tacticsShellDeps`, `runInteract`, `applyMenuStep` and
   `closeTradeEditor` call `dispatch` through it, and `popOverBattleBeforeSwitch` and
   `showSignInGate` call `applyStack` through it. Touches: `client/src/main.ts`,
   `client/src/shell/commandPort.ts`, `client/src/shell/commandPort.test.ts`, the
   `client/src/main.*.test.ts` family, `client/test-util/mainBootHarness.ts`, this file,
   `docs/refactors/client-shell.md`, `ARCHITECTURE.md` and `docs/DECISIONS.md`, whose entry "Code
   leaves `client/src/main.ts` into owner modules" names the ports and gains this one.
4. `client/src/shell/notices.ts` takes `dismissedRequests`, `announcedRequests`,
   `answeredRequests`, `noticeInput`, `livePending`, `requestLine`, `releaseAnswered` and
   `openedTradeSessions`. Interface: `dispatch`, `worldPort`, `openTradeEditor`,
   `resetTradeSessionState`, the listener that announces a new request, the listener that follows
   the trade sessions and the `connect` callbacks in `main` mutate the four sets, so each mutation
   becomes an owner function.
5. `client/src/shell/battleFrame.ts` takes `battleViews`, `battleFrameShown`,
   `hideAllBattleViews`, `activeBattleView`, `tacticalOwnsStart`, `battleHint`, `tacticsRules`,
   `tuningOf`, `refreshBattle`, `popOverBattleBeforeSwitch`, `ownMonsterName`, `tacticsMapFacts`,
   `mapFactsOf`, `mySideOf`, `buildDeployPanel`, `noteRatingBaseline`, `ratingLineFor`,
   `buildResultsPanel`, `refreshTacticsShell`, `tacticsVMEqual`, `buildTacticsVM`,
   `tacticsShellDeps`, `pumpStillThere`, `pumpClock`, `tradedIds`, `ownDeployLocked`,
   `deployPanel`, `resultsPanel`, `tacticsBattle`, `battleMount`, `tacticsRulesPort`,
   `tacticsTuning`, `tacticsShown`, `tacticsRating`, `tacticsIngested`, `lastTacticsVM`,
   `stillThereAnnouncedFor`, `dismissedBattleId`, `battleSynced`, `unrenderableReported`,
   `resultsAwaitDrain`, `serverClock`, `feedTacticsShell` and `holdResultsForPlayback`. It also
   takes the body of the listener that feeds `serverClock`. Interface: the battle port (the stack
   reads and the outcome edge), the `battleMount` mount, the lines `resetPredictionState` resets
   (`resultsAwaitDrain` and `serverClock` among them) and the latch `closeFrame` writes.
6. `client/src/shell/frames.ts` takes `overlayProbes`, `overlayHandles`, `screenViews`,
   `FrameOpen`, `frameOpens`, `frameOpenOf`, `screenHost`, `overlayVerdict`, `shownOverlays`,
   `contextStack`, `runStackCommands`, `outcomeShownAtMs`, `autoContinuedAtMs`, `syncStack`,
   `upperIds`, `shownPlayerFrames`, `panelShown`, `socialPanelView`, `hideFrame`, `topOverlay`,
   `menuPlace`, `reconcileStack`, `movementGate`, `worldBaseLive`, `openFrame`, `openSeated`,
   `topSocialFrame`, `syncedTop`, `closeLeftFocusAdrift`, `judgeCloseFocus`, `inHiddenSubtree`,
   `focusInsideHiddenSubtree`, `focusAdrift`, `lastCareTickAtMs`, `CARE_READINESS_TICK_MS` and
   `worldIsBare`. Touches beside the shell set: the two source needles of
   `client/src/main.dispatch.test.ts` that follow `movementGate` and the mirrored tables, and
   `docs/DECISIONS.md`, whose "Context stack ownership" entry names `main.ts` as their home.
   Interface: `main` sweeps `contextStack` on reconnect and writes `autoContinuedAtMs` and
   `lastCareTickAtMs` in the frame loop; the battle frame clears `outcomeShownAtMs` and
   `autoContinuedAtMs` through its port.
7. `client/src/shell/movement.ts` takes `rawMap`, `applyMove`, `predictor`, `resolver`,
   `renderer`, `telemetry`, `frameWindow`, `lastCamX`, `lastCamY`, `sawFractionalOwnMotion`,
   `resetPredictionState`, `zoneSyncFailureCount`, `switchZone`, `reconcileFromStore`,
   `lastSentSeq`, `MOVE_REJECT_POLICY`, `moveRejectLimit`, `moveSendCount`, `moveRejectCount`,
   `noteMoveRejection`, `sendIntent`, `step`, `jump`, `owed`, `lastRendered`, `worldRevealed`,
   `zoneWarpsById` and `zoneWarps`. Interface: `main` mounts `renderer` and `telemetry`, writes
   the camera hold, the motion latch, `frameWindow` and `lastRendered` in the frame loop and sets
   `worldRevealed` from the scope callback; `snapshot` sets `rawMap`. `owed` is an object used
   through its own methods, so `main` goes on calling its `clear` on reconnect.
8. `client/src/shell/account.ts` takes `claimModelState`, `sessionModelState`,
   `privacyModelState`, `lastPrivacyCountdown`, `livePrivacyCountdown`, `lastPrivacyStatusLabel`,
   `exportAssembly`, `renderSession`, `applySession`, `renderClaim`, `applyClaim`,
   `renderPrivacy`, `downloadExportBundle`, `applyPrivacy`, `sendPrivacy`, `profileOpen`,
   `showProfile`, `openProfile` and `ownNameModel` and `SIGN_IN_OFFER`. It also takes the body of
   the listener that recomputes the export assembly and of the one that repaints the Name section.
   `SIGN_IN_OFFER` is built by `signInOffer` of `client/src/ui/claimModel.ts`, a module that
   imports the catalog resolver, so it belongs here and not in `shell/config.ts`; `menu.ts` and
   `commands.ts` read it from this module. Interface: `main` writes `claimModelState`,
   `lastPrivacyCountdown`, `livePrivacyCountdown` and `exportAssembly`. Touches beside the shell
   set: `client/src/net/connection.test.ts`, whose needle for `applyClaim` follows it.
9. `client/src/shell/screens.ts` takes `shopOpen`, `questAckBaseline`, `openQuestLog`,
   `socialChrome`, `showSocialPanel`, `hidePanel`, `socialOpen`, `socialFrameView`, `openSocial`,
   `openHelp`, `openControls`, `refreshBox`, `refreshRaising`, `stepShopOpen`, `sendDismiss`,
   `openPendingShop`, `toastControls`, `pendingTradeOpen`, `TRADE_OPEN_WAIT_MS`,
   `knownSessionIds`, `resetTradeSessionState`, `openTradeEditor`, `closeTradeEditor` and
   `tradeOpenExpired`. It also takes the bodies of the listeners that refresh a screen and of the
   trade-session listener. Interface: `main` resets `questAckBaseline`; `dispatch` sets
   `pendingTradeOpen` when it sends the open and clears it when the open is refused.
10. `client/src/shell/menu.ts` takes `menuState`, `menuBadged`, `renderMenu`, `openMenu`,
    `profileSectionOf`, `socialTabOf`, `openMenuTarget`, `applyMenuStep`, `handleMenuPointer`,
    `signInGate`, `saidGateLine`, `signInGateView`, `showSignInGate`, `lowerSignInGate`,
    `applySignInGate` and `holdSignInGate`. It also takes the bodies of the listeners that follow
    the request badge and lower the gate. Move: every writer of `menuState`, `menuBadged`,
    `signInGate` and `saidGateLine` is among them. Touches beside the shell set:
    `client/src/ui/screens/mainMenuScreen.test.ts`, whose source scan follows `menuState`.
11. `client/src/shell/interact.ts` takes `interactCandidatesFn`, `lastInteractErrorMessage`,
    `reportInteractError`, `interactBatch`, `interactMemo`, `worldCandidates`, `facedChip`,
    `hintChips`, `runInteract`, `worldPort`, `interactVerb`, `sizeRowLabel`, `closeRowLabel`,
    `requestRowLabel`, `interactName`, `interactKeycap`, `interactChipText`, `ownPartyIds` and
    `eligibleChallengeIds`. It also takes the body of the listener that counts the batch.
    Interface: `evolutionNoticeOk`, which `worldPort` reads and `main()` assigns at boot, becomes
    a handle of `client/src/shell/views.ts` mounted through `mountViews`. Touches beside the shell
    set: `client/src/shell/views.ts` and `client/src/shell/views.test.ts`.
12. `client/src/shell/bugReport.ts` takes `projectKeyStore` and `downloadBugBundle`. Move: neither
    writes a binding; it follows row 7, which owns the `rawMap` it reads.
13. `client/src/shell/commands.ts` takes `DONE`, `careInFlight`, `ActionKinds`, `actionFeedback`,
    `SHOP_BUY`, `SHOP_SELL`, `RENAME`, `dispatch`, `refusedShopQty`, `refusedInBattle`,
    `applyStack`, `closeFrame` and `endedLine`. Interface: `main` clears `careInFlight`. Touches
    beside the shell set: `docs/DECISIONS.md`, whose "Four message channels" entry names `main.ts`
    for the senders this row moves.
14. `client/src/shell/input.ts` takes `routeCtx`, `applyRouterEffect`, `routeEdge`, `runAccel`,
    `openAccelPath`, `controlsCapture`, `endControlsCapture`, `captureControlsKey`,
    `cancelControlsCapture`, `pointerSource`, `paintWorldPrompt`, `pointerPress`, `pointerTop`,
    `suppressNativeMovementDefault`, `worldCanvasEl`, `gameScreenEl`, `onKeyDown`,
    `handleKeyDown`, `STOP_TYPING_TARGETS`, `stopTyping`, `settleControlsCapture`, `pressEdges`,
    `TerminalPhase`, `terminalPhase`, `padPhase`, `pollTerminalPad` and `pollPad`. It also takes
    the body of the keyup listener. Interface: `main` mounts `pointerSource`, `paintWorldPrompt`
    and `worldCanvasEl`.
15. `client/src/shell/devHooks.ts` takes `snapshot`, `mrTradeHook`, `mrPvpHook`, `mrTacticsHook`,
    `rowProbeState`, `MrSessionOffer` and `mrSessionOffer`. Move; the gated `window` assignments
    stay in `main.ts`, and it follows row 7, which gives `snapshot` its zone setter.
16. `client/src/ui/domParts.ts` is created and takes `ensureElement` and `frameAnchor` from
    `client/src/ui/claimView.ts`, `client/src/ui/controlsView.ts`, `client/src/ui/privacyView.ts`
    and `client/src/ui/sessionView.ts`, whose four copies are identical. The `ensureElement` of
    `client/src/ui/evolutionNotice.ts` is another function (a required parent, no hidden start)
    and stays. Touches: those five files, `client/src/ui/domParts.test.ts` and the four views'
    tests.
17. `client/src/net/rowConvert.ts` exports `SdkPlayerConversation`, `SdkHealLocationRow` and
    `SdkNpcRow`; `client/src/net/connection.ts` imports them and its three declarations of the
    same fields inside `wireTables` are deleted. Types only: nothing changes at run time. Touches:
    those two files.
18. `client/src/net/hostAccess.ts` is created with the storage narrowing, the random-byte draw,
    the hex encoder and the target key; `client/src/net/authToken.ts`,
    `client/src/net/claimCode.ts` and `client/src/net/oidc.ts` call it. The header of
    `claimCode.ts` gives a reason for keeping its own copy: a shared helper would be a seam
    between modules that fail in different directions. The helper here holds no state and returns
    a bound method or nothing, and each caller keeps its own `try` and its own answer on failure
    (anonymous, no code, a transient error), so that reason does not apply to it; the three
    headers are rewritten to say so. Touches: those four files and
    `client/src/net/hostAccess.test.ts`. The three existing tests fake the host and run unedited.
19. `client/src/net/store.ts`: `#reconcileKeyed` takes the equality function; the five
    hand-written loops call it with the equality each uses (shallow for monsters, inventory and
    export chunks, deep for battles and trade sessions). Touches: that file.
20. `client/src/net/connection.ts`: the twelve tables `wireTables` registers with one insert, one
    update and one delete go through one local helper, in the same order. The conversation, wallet
    and account views keep their own handlers. Touches: that file. `client/vite.config.ts` names
    it in its coverage list by path, and the file does not move.
21. `client/src/tactics/panelParts.ts` is created with one element helper, the battle root and
    title, and the countdown line; `client/src/tactics/clock.ts`, `client/src/tactics/hud.ts`,
    `client/src/tactics/deployPanel.ts`, `client/src/tactics/results.ts` and
    `client/src/tactics/tacticsBattle.ts` use it. The root's class list, the title's `data-testid`
    and its `tabindex` are the ones the end-to-end selectors and
    `client/src/ui/overlayRegistry.ts` name. Touches: those six files and
    `client/src/tactics/panelParts.test.ts`. Pin: `client/src/tactics/strings.test.ts` reads every
    tactics file and must pass over the new one unedited.
22. `client/src/tactics/storeMap.ts` is created and takes `shellKind`, `activeUnitOf`,
    `statusTagOf`, `intentKind`, `overlaySets` and `unitRowOf` from `client/src/tactics/wasm.ts`,
    with `copyTiles`, the private helper only `overlaySets` calls. Their importers are re-pointed:
    `client/src/main.ts` (`shellKind`, `activeUnitOf`, `statusTagOf`; after rows 5 and 15 those
    imports sit in `client/src/shell/battleFrame.ts` and `client/src/shell/devHooks.ts`),
    `client/src/net/rowConvert.ts` (`unitRowOf`), `client/src/tactics/tacticsBattle.ts`
    (`overlaySets`), `client/src/tactics/wasm.test.ts` and `client/src/net/rowConvert.test.ts`.
    Touches: those files and the two it moves between.

## 5. Findings for follow-up

Defects and stale statements met while measuring. None is fixed by an extraction; each has a
tracked row.

| # | Finding | Where | Follow-up |
|---|---|---|---|
| F1 | Comments name a check, a file or a line that is not there: a "G30 source scan" of files no test reads as text; `authToken.ts:104-120` and `:70-77` for functions at other lines; `main.ts` as the owner of the OIDC navigation and of reducer-rejection routing, which `net/connection.ts` and `shell/session.ts` hold; a source-scan gate on `WorldRenderer.init`; `battleModel.ts` as an importer of `hpPercent`; `ui/frame.ts` as unwired | `client/src/net/claimCode.ts`, `client/src/net/oidc.ts`, `client/src/net/connection.ts`, `client/src/render/world.ts`, `client/src/ui/boxModel.ts`, `client/src/ui/frame.ts` | `R-st-21-NOTEA408CD` |
| F2 | Three exports have no production caller, only tests: `SIGN_IN_REASONS`, `characterFieldsFromWasm`, `EMPTY_OVERLAYS` | `client/src/net/oidc.ts`, `client/src/convert/convert.ts`, `client/src/tactics/boardModel.ts` | `R-st-21-NOTECB143D` |
| F3 | The bug bundle's download removes its anchor and revokes its object URL inside the `try`, so a throw after the URL is made leaves both behind; the export does this in a `finally`. The fix is for it to call `saveFile` | `client/src/main.ts` (`downloadBugBundle`) | `R-st-21-NOTED582FF` |
| F4 | The challenges listener builds its view model on every batch before it checks whether the panel shows | `client/src/main.ts` (the PvP batch listener) | `R-st-21-NOTEAD375C` |
