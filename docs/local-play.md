# Local play: licence, shell, sign-in and footprint

What is known and measured about running Monster Realm as a single-player world on the player's
machine and as a server a player hosts for friends: the SpacetimeDB licence state, the desktop
shell, the sign-in design's questions, what one host costs, what it sends off the machine, and the
budgets work on local play holds. It was read and measured on 2026-11-14 against SpacetimeDB 2.11.0
(the version this repository pins) and the module and client built from commit `0e7a089d`; the
in-module signature check of section 3 was measured on 2026-11-21 with the module at commit
`5ceb483e`, and the access measurements of section 3 the same day with the module at commit
`d6d80547`; the browser measurements of section 3 were made on 2026-11-22. The decisions drawn
from it are in [`DECISIONS.md`](DECISIONS.md): "The desktop shell
is Electron", "Local-play budgets", "The attestation is signed with Ed25519 and checked by
`ed25519-dalek` compiled into the module", the four access decisions: "A world that is not
open refuses an unadmitted identity at connect and in every reducer; the owner relays the door",
"The official build holds no attestation key and a world build trusts no login issuer", "An
attestation names the server as the player's own software authenticated it" and "Ownership is
enforced unless a dev feature switches it off", and "A browser binds a friends server by a sign-in
on the account service's own origin; the attestation names the address the browser is sent back
to".

The local-play plan's milestones are named here by their plan labels: LP2 (desktop shell with the
bundled server), LP3 (worlds), LP4 (sign in once, then offline), LP5 (open to friends), LP6
(private-server access) and LP7 (standalone server package).

## 1. Licence state

This section quotes the licence files and lists what is open. It adopts no reading of what the
licence permits; that is the operator's negotiation with the licensor.

| | Default-branch text | Host this repository pins |
|---|---|---|
| Source | `LICENSE.txt` on the SpacetimeDB repository's default branch, read 2026-11-12 and again 2026-11-14 | `LICENSE.txt` at tag `v2.11.0`, read 2026-11-14 |
| Licence | Business Source License 1.1 | Business Source License 1.1 |
| Licensor | Clockwork Laboratories, Inc. | Clockwork Laboratories, Inc. |
| Licensed Work | SpacetimeDB 2.16.0 | SpacetimeDB 2.11.0 |
| Change Date | 2031-11-10 | 2031-09-15 |
| Change License | GNU Affero General Public License v3.0 with a linking exception | the same |

- **The two files differ only in the version and the Change Date** (compared byte for byte).
  2.16.0 is the default branch's version and has no release tag; the newest release, v2.15.0 of
  2026-11-10, carries the Change Date 2031-11-05. The Change Date is a parameter of each version's
  file.
- **The Additional Use Grant** reads, in both: "You may make use of the Licensed Work provided your
  application or service uses the Licensed Work with
  no more than one SpacetimeDB instance in production and provided that you do not use the
  Licensed Work for a Database Service."
- **The "Database Service" clause** reads: "A “Database Service” is a commercial offering that
  allows third parties (other than your employees and contractors) to access the functionality of
  the Licensed Work by
  creating tables whose schemas are controlled by such third parties."
  Modding is planned after early access, and tables a mod adds would be tables whose schema a third
  party wrote. Whether that meets the clause is a question for the licensor, not answered here.
- **"Instance" and "production" are not defined** in the text. A single-player world started on
  each player's machine, and a server each host runs for friends, are many running copies; how the
  grant counts them is a question for the licensor too.
- **The conversion** reads: "Effective on the Change Date, or the fourth anniversary of the first
  publicly available distribution of a specific version of the Licensed Work under this License,
  whichever comes first, the Licensor hereby grants you rights under the terms of the Change
  License, and the rights granted in the paragraph above terminate." The Change License is the GNU
  Affero General Public License v3.0 with a linking exception. The exception is two additional
  permissions printed in the same file before the AGPL text. The first: "If you modify this
  Program, or any covered work, by linking or combining it with SpacetimeDB (or a modified version
  of that library), containing parts covered by the terms of the AGPL v3.0, the licensors of this
  Program grant you additional permission to convey the resulting work." The second grants, under
  the same condition, that "you need not prominently offer all users interacting with your modified
  version remotely through a computer network an opportunity to receive the Corresponding Source of
  your version from a network server at no charge, if your version supports such interaction. This
  permission does not waive or modify any other obligations or terms of the AGPL v3.0, except for
  the specific requirement set forth in section 13."
- **Subdirectories.** The file says: "If a subdirectory contains its own LICENSE or LICENSE.txt
  file, the terms in that file apply exclusively to all files and subfolders within that
  subdirectory." and "In the event of any conflict between this base license and a subdirectory’s
  license, the base license will govern for that subdirectory’s contents." At `v2.11.0` the host's
  crates (`crates/standalone`, `crates/core`, `crates/client-api`) and the command-line tool point
  their `LICENSE` at `licenses/BSL.txt`. The module bindings crate (`crates/bindings`, published as
  `spacetimedb`) and the libraries under it (`crates/lib`, `crates/sats`) point theirs at
  `licenses/apache2.txt`, while crates.io lists the published crate's licence as "non-standard".
  The TypeScript SDK's `package.json` says `ISC`.
- **Negotiation.** The operator has been negotiating terms with the licensor since 2026-11-12. No
  terms are recorded yet.
- **What waits on it.** LP2 (a desktop build that ships the host inside the game) and LP7 (a
  standalone server package) wait on the negotiated terms.
  Nothing else in the local-play plan distributes the host. If the terms do not cover bundling,
  the desktop shell connects to a server the player installs separately; that changes LP2's scope
  and nothing below.

## 2. Desktop shell

Chosen shell: Electron. The decision and what it rules out are in `DECISIONS.md`; this section is
the evidence.

A judge scored three candidates from one evidence dossier, 1 (poor) to 5 (excellent) per criterion.
The weights (in brackets) were fixed before scoring: the engine the client renders in and the Steam
integration count three times, the two contracts the shell must provide count twice.

| Candidate | Hosts the unchanged web build (3) | Page global before module scripts (2) | Starts and stops a child server (2) | Installer and memory size (1) | Steamworks and overlay (3) | Licence (1) | Signing and update (1) | Unweighted, of 35 | Weighted, of 65 |
|---|---|---|---|---|---|---|---|---|---|
| Tauri 2 | 3 | 4 | 3 | 5 | 2 | 5 | 4 | 26 | 43 |
| Electron | 5 | 5 | 3 | 2 | 3 | 4 | 4 | 26 | 50 |
| Native launcher that opens the system browser | 4 | 5 | 2 | 5 | 1 | 5 | 5 | 27 | 44 |

Unweighted, the launcher leads by a point; the weights reverse that. Electron leads on the two
heaviest criteria and loses on size.

**What decided each criterion.**

- *Hosts the unchanged web build.* Electron ships its own Chromium (156 in Electron 45.3.2), the
  engine family the e2e suite runs (Chromium 149). Tauri renders in the operating system's webview:
  WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux and the Steam Deck, the last two
  engines no test here runs. The launcher renders in whatever browser the player has. Measured: the
  client bundle of section 7, with no change for the shell, joined a live server and drew the
  player's own character inside Electron from a custom protocol, and over loopback HTTP in a WebKit
  build (WebGL2, no `navigator.gpu`) and in
  Firefox 151 (no WebGL2 context in headless mode). That is one boot and join per engine with
  software rendering, not the e2e suite, and the WebKit build is Playwright's, not WebKitGTK as a
  distribution ships it.
- *Page global before module scripts.* Electron: measured (below). Tauri: documented, not run
  (`WebviewBuilder::initialization_script` adds a script "run after the global object has been
  created, but before the HTML document has been parsed and before any other script included by
  the HTML document is run", on every top-level navigation). Launcher: it serves
  `/shell-config.js` itself, the browser build's own delivery.
- *Starts and stops a child server.* Electron and Tauri both spawn a native child and must kill it
  on quit; neither documents what happens to the child when the shell is killed. The launcher
  controls the child fully but cannot tell that the player closed the browser tab.
- *Installer and memory size.* Electron 45.3.2 adds a 151 MiB archive on Windows (118 MiB Linux,
  115 MiB macOS arm64) and unpacks to 274 MiB on Linux; Tauri adds nothing on a Windows that has
  WebView2. The server binary is 127 MiB whichever shell carries it. Neither shell's idle memory was
  measured.
- *Steamworks and overlay.* Nothing was measured: the measuring machine has no Steam client.
  Electron has a documented route (`steamworks.js`, whose README has the main process call
  `electronEnableSteamOverlay()`) with mixed community reports that it needs GPU flags. Tauri's
  issue about making the Steam overlay work (tauri-apps/tauri issue 6196) is closed as not
  planned. The launcher has no window for the overlay or Steam Input to attach to.
- *Licence, signing and update.* Electron and Tauri are permissively licensed; platform signing
  rules are the same for all three; Steam delivers updates.

**The hook that sets `__MR_SHELL_CONFIG__`.** A preload script calls
`contextBridge.exposeInMainWorld('__MR_SHELL_CONFIG__', document)` in a window created with
`contextIsolation: true` and `sandbox: true`. Measured on Electron 45.3.2 with a probe page (a
classic script in `<head>`, then a module script), under `file://` and under a custom protocol
registered with `protocol.handle`, on first load and after a reload:

- the global is an own data property of the page's global object (enumerable, not writable, not
  configurable) when the first classic script runs and when the module script runs;
- its value is a frozen plain object whose `connection`, and `connection.uri`, are own properties.

The client reads the document as an own property of the global, synchronously at module scope
(`readShellDocument` in `client/src/net/shellDocument.ts`, called from
`client/src/shell/config.ts`);
this hook meets that contract. The page also loads `/shell-config.js` itself, the browser build's
delivery. Measured in the same probe: a page script that assigns the global again changes nothing,
because the property is not writable, and a missing script does not stop the module script. So
under this shell the preload is the only source of the document, whatever answers that request.
With `contextIsolation: false` a preload that assigns the global directly has the same timing and
an ordinary writable property; the isolated form is the one to use.

**What the choice rests on that is not measured.** The Steam overlay drawing over an Electron
window on Windows. That is to be proved, or shown impossible, before anything else is built on the
shell. The judge named it as the one unknown that turns the result: without an overlay Electron
scores 44, level with the launcher and one above Tauri.

## 3. Sign-in

The proposed design: a world's server is its own issuer; the account issuer attests "this account
is valid" to one server, once, and the player's identity in that world comes from the world, never
from the account issuer. The fallback: audience-scoped tokens from the account issuer. The
questions below are answered at SpacetimeDB 2.11.0. Source paths are in the SpacetimeDB repository
at tag `v2.11.0` unless they start with `server-module/`, `client/` or `evals/` (this repository);
"measured" means observed on a 2.11.0 standalone host, on 2026-11-14 unless a subsection names
another date.

### Which token claims a module can read at connect

**Answer.** All of them. `ctx.sender_auth().jwt()` gives the connection's claims: `subject()`,
`issuer()`, `audience()`, `identity()` and `raw_payload()`, the whole JSON payload, so a custom
claim (a nonce, an expiry, anything an issuer adds) is read by parsing it. It is available in the
connect lifecycle reducer and in every reducer a client calls, and absent in scheduled and `init`
calls. The host has already verified the signature and the expiry (a missing `exp` means no
expiry); it requires only `sub` and `iss` and does not check `aud`, so audience and any other claim
are the module's to check.

**Rests on.** `crates/bindings/src/lib.rs` lines 1937 to 2066 (`JwtClaims`, `AuthCtx::jwt`);
`crates/core/src/auth/token_validation.rs` lines 141 to 186 (`REQUIRED_CLAIMS`,
`validate_aud = false`, the expiry rule). This module reads issuer and audience at connect
(`provision_or_touch_account` in `server-module/src/accounts.rs`), and
`evals/account-e2e.eval.mjs` runs that path against a live host with real signed tokens.

### Whether a standalone server can sign with its own key per world

**Answer.** Yes, when each world runs in its own host process. A standalone host holds one ES256
key pair for the whole process (`--jwt-key-dir`, or `--jwt-pub-key-path` and `--jwt-priv-key-path`,
or `[certificate-authority]` in its `config.toml`) and creates one on first start in an empty key
directory (measured). It signs the tokens it mints at `POST /v1/identity`: a random UUID subject,
`iss` "localhost", `aud` ["spacetimedb"], no expiry (measured). There is no key per database: every
database one host serves shares its key. Every standalone host calls itself the same issuer,
"localhost", so two worlds' tokens differ by signature alone: a token minted by one host was refused
by another with `401 Invalid token: InvalidSignature`, over HTTP and on the WebSocket upgrade
(measured). A player's identity in a world is derived from "localhost" and that random subject, so
it is unrelated to any identity elsewhere.

Two limits shape the design. A host mints only anonymous tokens: `routes/identity.rs` defines no
route that issues a token for a chosen subject (`POST /v1/identity/websocket-token` re-signs the
caller's own claims for 60 seconds), and the bindings crate gives a module nothing to sign with.
And a host tries its own key first, then, for any other issuer named in the token, fetches that
issuer's keys (below).

**Rests on.** `crates/standalone/src/subcommands/start.rs` lines 56 to 182 (the key flags);
`crates/client-api/src/auth.rs` line 34 (`LOCALHOST`) and lines 184 to 197 (`SpacetimeAuth::alloc`);
`crates/standalone/src/lib.rs` line 101; `crates/client-api/src/routes/identity.rs` lines 102 to
179;
`crates/core/src/auth/token_validation.rs` lines 98 to 117 (own key first, then the issuer).

### Whether an account issuer can mint an attestation as a second token type

**Decided and built in part.** The issuer is our own account service, and the attestation is signed
by a route beside it, with its own issuer name and signing key, neither trusted by the official
server (DECISIONS.md, "A private world verifies an account by a per-world attestation our account
service signs"). The route exists (`account-service/src/attest.ts`), and the module's half is built
(`server-module/src/world_binding.rs`). No issuer is deployed (`PRODUCTION_LOGIN_ISSUERS` in
`server-module/src/accounts.rs` is a placeholder; a test or dev build trusts the dev issuers) and no
production attestation key is published (`PRODUCTION_ATTESTATION_KEYS` is empty). SpacetimeDB puts nothing in the way: a host verifies a
token from any issuer whose discovery document it can fetch, and a module reads every claim. The
attestation is a signed token with an audience naming one world, a nonce the world chose, and a
lifetime of minutes; what the audience is, is fork (c) of "The access and attestation design"
below.

### How a world server verifies an attestation

**Answer.** As a reducer argument. Both routes exist at 2.11.0, and only one fits.

- *As the connection token.* The host verifies it: on first sight of the issuer it fetches
  `<iss>/.well-known/openid-configuration` and the issuer's keys (cached, refreshed after 300 s,
  dropped after 7200 s). The module then reads the claims at connect. This needs the network from
  the host's machine whenever the keys are not cached, so it fails the offline requirement; it
  makes the player's identity in that world a function of the attestation issuer and subject, the
  same in every world; and a host cannot exchange a short-lived attestation for a token of its own
  (the limit above), so every session would need a fresh one.
- *As a reducer argument.* The client connects under the world's own anonymous token, the only
  kind a host mints, and calls a reducer with the attestation. The module verifies the signature
  and checks what the attestation names (audience, nonce, expiry) itself, then records the binding.
  No network is
  needed afterwards, and the identity is the world's own. SpacetimeDB gives a module no signature
  or token API, so the verifier is a pure-Rust one compiled into the module with the accepted
  attestation keys as module data. A reducer cannot fetch keys; a procedure can make HTTP requests
  (`crates/bindings/src/http.rs`), which a world that must work offline cannot depend on. Key
  rotation is therefore a module or content update.

The verifier is Ed25519, the `ed25519-dalek` crate; the next subsection is the measurement behind
that choice.

**Rests on.** `crates/core/src/auth/token_validation.rs` lines 211 to 240 (the key cache and fetch);
`crates/bindings/src/http.rs` (procedure HTTP); measured: a token naming an unreachable issuer made
the host look the issuer up and answer 401 about ten seconds later (section 5).

### What a signature check costs inside a reducer

**Answer.** A pure-Rust ES256 verifier and a pure-Rust Ed25519 verifier both build for the module's
`wasm32-unknown-unknown` target with no clock and no source of randomness, and one check costs well
under 5 ms with either. Five milliseconds is the budget for one check: a bind runs once per world,
so the cost matters as a lever for flooding the reducer, not for play. Neither condition for the
audience-scoped fallback holds (a candidate builds, and its median is under the budget), so the
fallback is not the route. The verifier chosen is Ed25519: `ed25519-dalek`, called through
`verify_strict`.

| Verifier | Builds for the module target | Module size change (one codegen unit, over a reducer with no check) | Median of 101 checks inside one reducer | Against the 5 ms budget, on the machine of section 7 |
|---|---|---|---|---|
| ES256: `p256` 0.14.0, `ecdsa` feature only | yes | +70,435 bytes | 593.3 µs | 8.4 times under |
| Ed25519: `ed25519-dalek` 3.0.0, no default features | yes | +58,156 bytes | 108.4 µs | 46 times under |

Measured on 2026-11-21 on a 2.11.0 standalone host, with each verifier added to this repository's
module at commit `5ceb483e`; section 7 has the method, the per-call numbers and the follow-up runs.
Each median is the median of ten calls' medians, every call one reducer running 101 checks; across
the ten calls the per-call median ranged from 585.7 to 606.1 µs (ES256) and from 106.6 to 125.1 µs
(Ed25519). These are medians on one fast desktop processor: the slowest single ES256 check took
3,354.8 µs, and nothing was measured on a slow machine. In the profile the module ships in (16
codegen units) the size change is within build-to-build variation: a reducer with no check alone
adds 110,197 bytes to the 3,204,399-byte module, the ES256 build 84,261 and the Ed25519 build
119,454, because adding any code to the module crate changes how unrelated functions are inlined.

- *Builds with no clock or randomness.* Each built module imports the 18 host functions the
  unmodified module imports and nothing else but the two timer functions the measurement itself
  calls, no function in either build is named for `std::time` or `getrandom`, and both published
  and ran. The 2.11.0 host exports no clock and no entropy function for a reducer to import. A
  reducer's time is `ctx.timestamp` and its randomness is `ctx.rng()`, a generator seeded from that
  timestamp; a verifier needs neither. The compiler does not refuse every randomness dependency:
  `p256`'s `precomputed-tables` feature needs `std` or `critical-section`, and with `std` it
  enables `getrandom` 0.4.3, which refuses the target at compile time, but `spacetimedb` turns on
  `getrandom` 0.2's `custom` feature, under which that version compiles (the unmodified module
  already builds with it). The import list of the built module is the check.
- *What one check is.* What a bind does to a compact JWT of 531 bytes carrying the attestation
  route's claims, signed by Node's `crypto`: split off the signature, base64url-decode it, parse the
  public key, and verify the signature over the header and payload. The token and the key are
  reducer arguments. Reading the header, choosing a key by `kid` and parsing the claims are not in
  it.
- *A token that fails costs what a valid one costs.* One changed payload character: 590.0 µs
  (ES256) and 108.2 µs (Ed25519). Another key of the same type: 593.4 and 109.4 µs. Every such call
  accepted none of its 101 tokens, and every valid call all 101. A signature cut to 40 bytes is
  refused in 1.2 µs (ES256) and 5.3 µs (Ed25519).
- *One check per call.* A bind is one check in its own reducer call, which costs a little more
  than a check in a loop: 621.8 µs (ES256) and 138.5 µs (Ed25519), and up to 690.3 and 190.8 µs for
  the first call after a publish.
- *The cost grows with the token's length*, because both verifiers hash the whole token. At 4 KiB a
  check costs 640.6 µs (ES256) and 133.1 µs (Ed25519); it passes 5 ms at about 430 KiB and 688 KiB.
  The host's HTTP call route took a reducer argument of 1.5 MiB and refused one of 2 MiB. So the
  budget holds only if the bind refuses an over-long token before it decodes anything.
- *Faster configurations.* `ed25519-dalek`'s `fast` feature (precomputed tables) builds and saves 4
  percent for 10,909 bytes more (104.2 µs, +69,065 bytes). `p256`'s `precomputed-tables`, built
  through `critical-section`, is no faster (603.0 µs against 585.2 µs without it, in one run).

**The choice.** A judge scored the two candidates from one evidence dossier, 1 (poor) to 5
(excellent) per criterion, with the weights (in brackets) fixed before scoring. Both passed the two
gates: it builds for the module target, and its median is at most 5 ms.

| Candidate | Build and feature fragility (2) | Headroom under the budget (3) | Size (1) | Dependencies (2) | Fit with the signer (3) | Verification semantics (2) | Unweighted, of 30 | Weighted, of 65 |
|---|---|---|---|---|---|---|---|---|
| ES256, `p256` | 4 | 3 | 4 | 3 | 4 | 3 | 21 | 45 |
| Ed25519, `ed25519-dalek` | 5 | 5 | 5 | 4 | 3 | 4 | 26 | 55 |

- *Build and feature fragility.* `p256` has a feature that drags `getrandom` in and stops the
  build; no `ed25519-dalek` feature tried did.
- *Headroom.* A check costs a fifth as much with Ed25519. That is the margin a slower host and a
  flood of failing tokens use up.
- *Dependencies.* ES256 adds 27 crates to the module's 74, Ed25519 adds 10. OSV listed no advisory
  for any of them on 2026-11-21. Both sets are permissively licensed (MIT or Apache-2.0, with
  BSD-3-Clause for `subtle`, `curve25519-dalek` and `ed25519-dalek`). Both crates are major versions
  published in July 2026; whether those versions have been audited was not checked.
- *Fit with the signer.* The account service's login keys are ES256, so ES256 would keep one
  algorithm in the service and in its key service. Ed25519 is a second key type there. In return a
  P-256 login key cannot be loaded as an attestation key or the reverse, so the rule that neither
  key set verifies the other's tokens holds by key type as well as by key list. The `alg` name the
  signer writes in the token's header (`EdDSA`, RFC 8037, or `Ed25519`, which RFC 9864 adds while
  deprecating `EdDSA`) is the signer's choice.
- *Verification semantics.* ECDSA accepts two forms of every signature, `(r, s)` and `(r, n − s)`,
  and a signer that repeats a nonce reveals its key. `verify_strict` refuses a non-canonical
  signature and a small-order key, and Ed25519 signing draws no random nonce. `ed25519-dalek`'s
  plain `verify` is the weaker check.

The judge's result does not turn on any one score: with Ed25519 at 1 for signer fit it still leads.
It turns on one fact this record does not hold: signing keys live in the production host's key
service, and that host is not chosen. AWS KMS and Google Cloud KMS document Ed25519 signing (read
on 2026-11-21, not tried); Azure Key Vault's support was not confirmed. If the host chosen cannot
hold an Ed25519 key, ES256 is the verifier, and it fits the budget.

**What the bind adds to the check.** The measurement is a signature check, not the bind. The bind
(`server-module/src/world_binding.rs`) refuses a token longer than 4096 bytes before decoding it,
requires exactly three non-empty segments, decodes base64url strictly, calls `verify_strict`, takes
the key from the build's own key list by `kid` (the header's `alg` is never read), checks `aud`,
`exp` (against the host clock) and the nonce, and keys replay on a claim (the world's spent nonce),
never on the token's text, since a lenient decoder, and ECDSA itself, let two texts verify as one
token. The payload is parsed only after the signature verifies.

### Can a token a private host receives be replayed to the official server

**Own-issuer design.** Not as the account. A private host holds two things.

The world's own token is signed by the private host's key: the official host refuses it
(`InvalidSignature`, measured between two hosts).

The attestation, presented as a connection token, names an issuer the official server does not
list. With no discovery document published for that issuer (the reducer-argument route needs none)
the official host cannot verify it and answers 401. If one is published, the host accepts the
connection and the module treats an unlisted issuer as an anonymous guest whose identity is
unrelated to the account's (`provision_or_touch_account`). Either way it does not reach the
account.

The attestation, presented as a reducer argument, is as narrow as what it names, and the same
module source runs on every server, the official one included. The rule that keeps it off the
official server is fork (b) of "The access and attestation design" below: the official build holds
no attestation key, so it takes accounts only as connection tokens from the account issuer. With
that rule nothing a private host holds reaches an account on the official server. The module's half
is built: the official build holds no attestation key (`server-module/src/accounts.rs`).

Replay to another private world is a separate question, and the design has to close it before a
private server sees a real attestation. An audience and a nonce do not close it: a hostile host can
have its player's client fetch an attestation addressed to another world, carrying that world's
nonce, and present it there as its own. Naming the player's identity in the attestation does not
close it either: every standalone host calls itself "localhost", and a hostile operator holds its
host's signing key and can sign any subject with it, so its player can be given the identity the
operator holds on the other world. The attestation has to name something a hostile host cannot
make true of its own server. Fork (c) below names it: the server as the player's own software
authenticated it. The key that verifies the client's own world token does not serve: a module
cannot read its own host's verifying key (a reducer cannot call `GET /v1/identity/public-key`),
and a hostile host that proxies the other world hands the client a genuine token from it.

**Audience-scoped fallback.** Refused at the WebSocket connection, by one check, and only for a
token whose audience list holds no official audience. The private host holds a token from the
account issuer whose audience names the private server. The official host accepts it (it does not
check `aud`), and the official module disconnects it at connect because the issuer is listed and
the audience is not (`provision_or_touch_account`; the wrong-audience control in
`evals/account-e2e.eval.mjs` runs this live over a WebSocket). Three weaknesses:

- `audience_allowed` passes a token if any entry of its audience list is listed, so the issuer must
  never mint one token for both a private server and the official audience.
- The check runs in the connect reducer, and it is the only check: the host does not read `aud`.
  It does hold on the host's HTTP routes (`/v1/database/<db>/call/<reducer>`,
  `/v1/database/<db>/sql`): both answered a wrong-audience token with 403 (measured, next
  subsection).
- The token carries the account's official identity, so the host learns which official player
  joined.

The account token the client is built to send is this fallback's dangerous case: its audience is
the build-wide client id, which the official server accepts. That is why the local-play plan
offers no account token to a single-player or friends world.

### What the host's HTTP routes do with a token the connect reducer refuses

**Answer.** They refuse it. At 2.11.0 every route that reads a row or calls a reducer runs the
module's connect reducer first, and a refusal there ends the request: no reducer runs and no row is
read. One wrong-audience account token, sent to `/v1/database/<db>/call/<reducer>` and to
`/v1/database/<db>/sql`, was answered 403 with the module's own reason on both.

| Token | `POST /v1/database/<db>/call/join_game` | `POST /v1/database/<db>/sql` | MCP tools `sql` and `call` (`POST …/mcp`) | WebSocket `…/subscribe` | `GET …/schema` |
|---|---|---|---|---|---|
| Account token, wrong audience | 403, body `unrecognized audience` | 403, body `unrecognized audience` | a result marked as an error, text `unrecognized audience` | the upgrade completes, then the socket closes with no message | 200 |
| Account token, right audience | 200 | 200, with rows | a result | open, identity message | 200 |
| Token from an issuer the module does not list | 200 | 200, with rows | a result | open, identity message | 200 |
| The host's own anonymous token | 200 | 200, with rows | a result | open, identity message | 200 |

Measured on 2026-11-21 on a 2.11.0 standalone host with the issuer rig
`evals/account-e2e.eval.mjs` builds (its stub issuer, its token minting, its two patches to the
module's issuer and audience lists) and the module at commit `d6d80547`; section 7 has the method
and the count of sends. The wrong-audience token named the listed issuer, was signed by its key,
and carried the audience `mr-acct-e2e-wrong-aud`, where the module lists `mr-acct-e2e-client`.
Afterwards the owner read one `account` row, the right-audience account's, and none for the
wrong-audience identity.

- *What does not run the connect reducer.* `GET /schema` answers anyone with the module's table
  and reducer definitions and no row. Module-defined HTTP handlers (`/v1/database/<db>/route/…`)
  are served outside the host's authentication on purpose; this module defines none.
- *A refused request still names an identity.* The 403 carries the caller's identity and token in
  its headers, and a request with no token is given a new identity even when it is refused
  (measured on the probe module of fork (a) below). An identity costs nothing to obtain.
- *The unlisted issuer.* The host fetched that issuer's discovery document and keys before the
  module saw the token (section 5), and the module then treated the caller as an anonymous guest.
  The module's issuer list is the only thing that decides whose tokens are accounts.

**Rests on.** `crates/client-api/src/routes/database.rs`: `call` and `sql_direct` both end in
`with_connection`, which calls the connect reducer and maps its refusal to 403
(`client_connected_error_to_response`); the handler routes are merged outside the authenticated
router (the comment at line 1798). `crates/client-api/src/routes/mcp.rs` runs the same call for its
`sql` and `call` tools, and `crates/client-api/src/routes/subscribe.rs` runs it before a WebSocket
connection is spawned.

### What identifies a player between launches

The world's own anonymous token, kept on the device. Toward a `local` or `private` target the
client keeps the reconnect token in the origin's `localStorage`, keyed on the target's `uri` and
`db`, so a new page in the same browser profile resumes the player; toward an `official` or `test`
target it keeps the token per tab (`tokenPersistenceFor` in `client/src/net/authToken.ts`;
DECISIONS.md, "A single-player or friends world keeps its anonymous reconnect token on the device;
a server we operate keeps it per tab"). Measured on 2026-11-14, with the token then kept per tab for
every target: three launches against one world, each with a fresh browser context, made three
players; with the first launch's stored entry written back before the page's scripts ran, three
more launches each resumed the first identity. Two things a desktop launch still rests on are not
built: the shell keeping one browser profile across launches, and a world's address staying the
same from one launch to the next.

### The access and attestation design

Four questions the sections above leave open are decided here: (a) how a connection the host's
access rule has not admitted is kept from every world row and reducer; (b) how the official server
refuses attestation binding when the same module source runs everywhere; (c) what the attestation
names, so that a hostile host cannot relay one world's attestation to another; and (e) how a build
enforces ownership, and how a connection reaches the admission and binding calls before
`join_game`. Question (d), plaintext `ws:` to a friends server, is decided in DECISIONS.md ("Private
servers carry their own encryption…"). Fork (a)'s module half is built (`server-module/src/access.rs`);
its gate half is not. The module halves of forks (b) and (c) are built (`server-module/src/world_binding.rs`);
the client's bind flow, the shell and gate halves and the run over two real hosts are not. Fork (e)'s features, constants, check, artefact
section and recipe are built (`server-module/Cargo.toml`, `server-module/src/accounts.rs`,
`justfile`); its default is not, since the default feature list holds `open_join`. Work is named by its id in the
harness specs `M-local-play.spec.md` (lpw-9: the open or password rule; lpw-11 to lpw-14: the
desktop shell, its host gate and opening a world to friends; lpw-15: binding, ownership and the
allowlist; lpw-18: the certificate and the pin) and `M-account-service.spec.md` (acs-3: the
attestation route; acs-6: trusted issuers by build, and entitlement), and a test by the criterion
it proves.

| Fork | Chosen | Rejected | Proved by |
|---|---|---|---|
| (a) An unadmitted connection | A1: the connect reducer refuses an identity the rule has not admitted, every reducer a player can call makes the same check, connections open when the rule changes are admitted, and the owner relays the door | A2: row filters on every public table. A3: every table private behind a view. A1 at connect only | lpw-9.2 and lpw-20.1 to lpw-20.3 in `server-module/src/access_tests.rs`; `mod admission_roster` and `mod reducer_arguments` in `server-module/src/privacy_enforcement_tests.rs` |
| (b) The official server's refusal | B1: the official build holds no attestation key, and a world build trusts no login issuer | B2: a row or flag in the database. B3: the world-name check and the route alone. B4: a database identity compiled in | lpw-15.3 in `server-module/src/world_binding_tests.rs` (`mod official_build`, run under the `official` build; `mod binding_build` on every build) |
| (c) What the attestation names | C2: the server as the player's own software authenticated it, `spki:<fingerprint>/<db>` or `dns:<host>:<port>/<db>`, bound from the desktop shell; a browser's way in, and `ip:<address>:<port>/<db>`, are "A browser binds a friends server it reached by address" below | C1: the key that verifies the client's world token. C3: the server's address or database identity. C2 with a browser flow built now | lpw-15.4 in `server-module/src/world_binding_tests.rs` (`mod bind_refuses`, `mod relay_rig`); the client's half is not built |
| (e) The build input | E2: a build enforces ownership unless the feature `open_join` is named; `official` and `world` are the two release builds | E1: a feature that switches enforcement on. E3: an environment variable at build time. E4: a row at run time | lpw-15.7 in `server-module/src/world_binding_tests.rs`; acs-6.1 to acs-6.5 in `server-module/src/accounts_tests.rs`, `server-module/src/movement_tests.rs` and `evals/account-e2e.eval.mjs` |

Each fork was scored by a judge from one evidence dossier, 1 (poor) to 5 (excellent) per criterion,
with the weights (in brackets) fixed before scoring. An alternative that fails its gate is scored
and cannot be chosen; a gate cell that says more than "pass" carries the judge's qualification. The
attacker throughout is a hostile host: it runs its own world
and controls that world's host process, signing key, rows, gate and the page its gate serves; it
can relay or proxy anything a player's client sends it and can connect to any other world as a
client. It does not hold another world's TLS private key, cannot get a browser-trusted certificate
for a domain it does not control, and does not hold the player's account sign-in. The desktop shell
and the browser are honest; a page a hostile gate serves is not. Two things are accepted elsewhere
and are outside every fork: a host that patches the module it runs, and a player who lends their
own account.

#### (a) Keeping an unadmitted connection off every row and reducer

Measured on 2026-11-21 on a 2.11.0 standalone host, with a probe module that is not in this
repository: a locked world, a private admission table, one public table of three rows, a private
table behind a view that returns nothing to an unadmitted sender, a door reducer the caller runs
for itself, and an owner-only admit and remove.

| What was tried | Result |
|---|---|
| The connect reducer refuses an identity with no admission row; that identity then calls any reducer, the door included | 403 `not admitted` |
| The same identity reads a public table, the view and a private table over `/sql` | 403 `not admitted` |
| The same identity opens a WebSocket and subscribes | the upgrade completes, then the socket closes with no message |
| A request with no token at all | 403, with a new identity and token in the response headers |
| The owner admits the identity; it calls, reads and subscribes | all three work |
| The owner removes the admission while the identity's WebSocket is open | on that socket a reducer call commits, a one-off query returns the rows and a new subscription delivers them; a new call, read or socket is refused |
| The connect reducer accepts everyone, and a row filter on the public table joins the private admission table | every query of the filtered table fails for every caller but the owner: `no such table`; a query of the view still works |
| The filter joins a public admission table that has its own filter, `identity = :sender` | over `/sql` an unadmitted caller reads no row and an admitted one all three; every subscription to the filtered table fails, admitted or not: `Subscriptions require indexes on join columns` (both join columns are indexed) |
| The filter joins a public admission table with no filter of its own | reads and subscriptions both work, and an open subscription gains the rows when the admission row is inserted and loses them when it is deleted; any connection, admitted or not, can read the admission table |

The connect reducer runs once, when a connection opens. A refusal there is complete for an
identity that is not yet connected, and does nothing to a connection that is already open. A module
has no call that closes a connection. Row filters (`client_visibility_filter`) sit behind the
bindings crate's `unstable` feature, whose own source comment says they are not enforced; they are
enforced at 2.11.0, as the last three rows show.

**The design (A1).**

- *At connect.* While the world's rule is not `Open`, the connect reducer refuses, as its first
  statement, an identity that is neither the owner (`config.owner_identity`) nor in the admission
  table. That holds the identity off every row and every reducer on the WebSocket, `call` and
  `sql` routes (measured on the probe) and through the MCP tools (measured for the audience
  refusal, which is the same reducer).
- *In every reducer.* Every reducer of the generated client roster except the owner-only ones
  (`sync_content`, `set_world_access`, `set_world_names`, `set_world_allowlist` and the two
  relayed binding reducers) and `unbind_world_account`, which makes no admission check, makes the
  same check (`access::require_admitted`) before anything else, because a connection opened while its identity
  was admitted, or while the rule was `Open`, is not checked again by the host. The test
  `mod admission_roster` in `server-module/src/privacy_enforcement_tests.rs` holds it: it takes the
  roster from the file names of `client/src/module_bindings/*_reducer.ts` and executes each shipped
  reducer as an unadmitted caller on a `Password` world, requiring the admission refusal from each
  player reducer and the owner refusal from the owner-only ones; a reducer with no probe fails
  it. Reducers that exist only in a dev build (`dev_reducers`, `load_test_zones`) make no check.
- *When the rule changes or an identity is removed.* When the rule leaves `Open`, the reducer that
  sets it admits every identity that has a connection open at that moment (the `player_session`
  table), so no unadmitted connection is left open, with or without a gate. A removed identity's
  reducer calls are refused at once. Its reads end when its socket closes: the host gate records
  the identity behind each socket it forwards and closes the sockets of an identity the owner
  removes. On a host with no gate the removed identity keeps reading what it subscribed to until
  it disconnects, and is refused when it returns.
- *What the module never declares.* An HTTP handler, which the host serves without the connect
  reducer and without authentication, or a row filter. Both sit behind the `spacetimedb` crate's
  `unstable` feature, which the workspace does not enable (`Cargo.toml`: `spacetimedb = "=2.12.0"`,
  no features), so neither can be declared; the deletion-gate census in the same test file refuses a
  `procedure` attribute.
- *The door.* An unadmitted identity can call nothing but its own unbind, so admission is granted
  by reducers only the owner can call, each taking the joiner's identity as an argument: the admit
  list of `set_world_access`, and under `Allowlist` the relayed bind. No reducer takes a password, a
  hash of one or a value derived from one (operator ruling monster-realm#840), because the
  host's commit log keeps every committed call's arguments in the clear (the last row of the table
  below); `world_access` holds the `Password` rule with an empty salt and hash, and the module reads
  neither. The host gate checks the password itself: it keeps the Argon2id salt and hash
  in the world's directory with the owner credential's permissions, never in a backup copy's
  readable part or a log, and serves one door endpoint of its own, which it never forwards; for a
  joiner with no token it creates an identity on the host's internal port, checks the password,
  admits the identity through the owner's `set_world_access` naming the rule in force, and returns
  the token only then. The owner identity the gate calls as never joins the game, so the connect
  and disconnect that each call brings touch no player's state. A host with no gate has no password
  door: its owner admits identities from the command line, and until the gate is built that is the
  only way into a `Password` world.
- *Attempts.* The gate counts wrong passwords by source address and by identity, five in ten
  minutes, and refuses both after that; the module keeps no count and never sees a source address.
- *The shell's own player.* On a world whose rule is not `Open` a new identity cannot connect to
  become known, so the shell admits its own player before the rule leaves `Open`: connected, it is
  admitted by the rule change; otherwise the shell creates that identity on the internal port and
  admits it.

A world with no access rule is `Open` (an operator default), so a database recreated without its
rows is open until the rule is written again. The gate therefore listens beyond loopback only
after it has read back the rule the host chose.

**Rejected.** A2, row filters: the one shape that works needs a public admission table with no
filter of its own, so who is admitted is delivered to every connection; each of the 18 public
tables needs a filter and an indexed column to join on; the filter puts the sender in every
subscription query, on the official server too, where the zone subscriptions rest on the host
sharing one query among subscribers (DECISIONS.md, "World rows are subscribed by zone"); and the
feature is `unstable`. A3, every table private behind a view: it holds rows back correctly (the
probe's view did), and it is what "World rows are subscribed by zone" rules out for `character`, a
view evaluated on the reducer thread for every subscriber on every write, and it replaces the
client's whole subscription set. Under both, the door is a reducer anyone who reaches the server
can call without limit, each wrong attempt one password hash on the one reducer thread. A1 at
connect only: it fails for any identity whose connection is open when its admission is taken away
or the rule changes.

| Alternative | Gate: an unadmitted identity gets no row by any route and runs no reducer but an admission step | Complete against every route, measured (3) | Stays complete when a table, view or reducer is added (3) | Cost on the reducer thread and to subscriptions (2) | Rests on stable host behaviour (2) | Fit with lpw-9 as specified (2) | The door (2) | Removal (1) | Unweighted, of 35 | Weighted, of 75 |
|---|---|---|---|---|---|---|---|---|---|---|
| A1, refuse at connect and in every reducer | pass | 4 | 5 | 5 | 4 | 3 | 4 | 3 | 28 | 62 |
| A1 at connect only | fail | 2 | 3 | 5 | 4 | 2 | 4 | 1 | 21 | 46 |
| A2, row filters | fail | 1 | 2 | 2 | 1 | 2 | 2 | 5 | 15 | 28 |
| A3, views | pass | 3 | 3 | 1 | 5 | 1 | 2 | 5 | 20 | 41 |

A1 loses its points on fit: lpw-9's criteria read as if the joiner's own connection called the door, and
admission by password waits for the gate. The result reverses if a route that reads a row is found
that does not run the connect reducer, at 2.11.0 or at a later host version (the table in "What the
host's HTTP routes do…" is measured again at every host upgrade), or if a connection already open
must stop reading at removal on a host with no gate, which only A3 gives.

**Proved by.** `server-module/src/access_tests.rs` covers the rule default (no row is `Open`), the
connect refusal under `Password` (an unadmitted identity is refused before its session or account is
written; the owner and an admitted identity connect), the `Password` rule stored with no salt and no
hash, a salt and hash an earlier module stored cleared at the owner's next `set_world_access` and
admitting nobody meanwhile, an identity admitted outright connecting, and the owner guard on
`set_world_access`. `mod admission_roster`
in `server-module/src/privacy_enforcement_tests.rs` takes the reducer roster from the file names of
the generated bindings and executes each shipped reducer as an unadmitted caller on a `Password`
world: an executing test, not a parse of source. `mod reducer_arguments` in the same file describes
every reducer the build declares (client-callable, scheduled, lifecycle and the dev builds') through
the reducer macro's own describer, checks the client-callable and scheduled ones against the
generated bindings and the scheduled tables (the dev builds' are listed by hand), and holds that no argument is named for a password and that the arguments which
carry text are a reviewed roster. It is a tripwire, not a proof: a value derived from a password
could ride in an argument of another type, and review is the defence there. The tests do not assert that an open connection
stops reading: it does not. No in-repo test shows an unadmitted connection receiving no row: that
rests on the host running the connect reducer before every route, which is the measurement above,
on a live host, repeated at every host upgrade. The wrong-audience control of
`evals/account-e2e.eval.mjs` exercises the same refusal over a WebSocket on every run, for the
audience check and not for admission.

Measured on 2026-11-21 on a 2.11.0 standalone host (a scratch data directory) with the module of
commit `d6d80547` published, which had a door reducer, `admit(who, password)`, and took a password
in `set_world_access`; the current module has neither. The script is not in the repository.

| What was tried | Result |
|---|---|
| A stranger joins and reads an `Open` world | works |
| After the owner set `Password`: seven reducers (`join_game`, `buy`, `clear_queue`, `delete_account`, `request_data_export`, `sync_content`, `admit`) called by an identity never admitted | each 403 `not admitted` |
| The same identity runs `sql` on each of the 68 tables the schema lists | refused for every one; the owner reads all 68 |
| The same identity opens a WebSocket | the upgrade completes, then the socket closes with no message |
| Five wrong `admit` calls for one identity | each exits 0 and leaves one attempt record |
| The right password for that identity | refused, `too many wrong passwords for this identity`; no admission row (the count survives across transactions) |
| One wrong password, then the right one, for another identity | admitted; it then joins, reads and keeps its socket |
| An identity admitted through `set_world_access` with no password | joins |
| A door call that hashes against one that does not, over HTTP | median 23.4 ms against 1.0 ms (about 22 ms for one Argon2id hash inside the reducer, on this machine) |
| The host's commit log (`replicas/1/clog/…stdb.log`) after these calls | holds the arguments of every committed reducer call in the clear: the password given to `set_world_access` and each password given to `admit`, wrong ones included |

The table's last row means a salted hash in a table protects the row, not the world's data
directory, and a password stretched before the call would still leave a password-equivalent in the
log. So no reducer takes one, and the gate checks it (the door, above). A commit log a module with
the door wrote keeps every password given to it; the module cannot erase that log, so a host who set
a password through such a module chooses a new one for the gate.

#### (b) How the official server refuses attestation binding

**The design (B1).** The module's two trust lists are constants of the build (fork (e)): the login
issuers whose tokens are accounts, and the attestation keys a bind accepts. The `official` build
holds the production login issuer and no attestation key. The `world` build, which the shell and
the standalone server ship, holds the production attestation keys and no login issuer. So each
release build has one way to be entitled: a login token on the official server, a binding in a
world.

- On the `official` build `bind_world_account`, the reducer that issues bind nonces, the
  owner-relayed form of each (see "The order of calls") and `unbind_world_account` return one fixed
  error of their own before they decode, read or write anything. An empty key list would
  fail every signature anyway; the fixed error is what lets a test tell the guard from that
  failure.
- On the `official` build `entitled(ctx)` never reads a binding. A binding row that reached an
  official database, by a wrong publish or a restored copy, admits nobody.
- On the `world` build no issuer is listed, so every token is an anonymous guest's and no account
  is provisioned from a login token (the path the unlisted-issuer row above took).
- The builds differ in these constants and nothing else: the tables, reducers, views and client
  bindings are the same.

A binding is checked once and kept. If the official server accepted one, an account would outlive a
refund or a ban there, where a login token is reissued, and re-checked, within the hour.

**Rejected.** B2, a row or flag that marks the database official: a row its owner controls, unset
on a fresh, restored or republished database. B3, nothing in the module, because by fork (c) no
attestation names the official server: the refusal then rests on the official world's own name
rows and on a rule in the account service. B4 (the judge's addition), a database identity compiled
in: a build constant, but a recreated database has a new identity, and it writes one deployment's
name into the module.

| Alternative | What the refusal derives from | Can a host set or unset it |
|---|---|---|
| B1 | the build of the module: its list of attestation keys is empty | no |
| B2 | a row or flag in the database | yes: the database's owner writes it |
| B3 | rows, the world's own names, and a rule in the account service | yes: the database's owner writes the rows |
| B4 | the build of the module: a database identity compiled in | no |

| Alternative | Gate: derived from a build of the module or a key the official deployment alone holds, never a row or flag | Fails closed when the deployment is fresh or misconfigured (3) | Cannot be changed at run time, by the owner either (3) | One schema and one set of bindings (2) | Fits the lists acs-3 and acs-6 specify (2) | Testable as lpw-15.3 (2) | Fewest new parts (1) | Unweighted, of 30 | Weighted, of 65 |
|---|---|---|---|---|---|---|---|---|---|
| B1, no attestation key in the official build | pass | 4 | 5 | 5 | 3 | 5 | 2 | 24 | 55 |
| B2, a row or flag | fail | 1 | 1 | 5 | 5 | 3 | 4 | 19 | 36 |
| B3, the name check and the route | fail | 2 | 2 | 5 | 5 | 2 | 4 | 20 | 40 |
| B4, a compiled-in database identity | pass, weakly | 1 | 4 | 5 | 5 | 2 | 4 | 21 | 43 |

B1's one loss on failing closed is a `world` artefact published to the official database: it would
accept bindings, so the official deploy checks the artefact it publishes (fork (e)) and writes no
world name (fork (c)), which leaves a wrong artefact nothing to accept. The result reverses if the
host comes to offer a module a deploy-time value signed by a key only the official deployment
holds, or if only one release artefact may exist, which leaves B4.

**Proved by.** lpw-15.3, under the `official` build: given this identity's outstanding nonce and an
attestation that the dev-enforcing build accepts byte for byte, `bind_world_account` returns the
official build's fixed error and no table changes, the nonce row included, and the owner-relayed
forms return the same error; then, with a binding row
that carries the entitlement put in place for the caller, `join_game` returns the ownership
refusal and writes no player row (`mod official_build`, which also has the build refuse before any
other check). `mod binding_build`, on every build, shows that a build binds nothing exactly when it
holds no attestation key, that a binding counts only under a profile holding its key, and holds the
key lists to the generated `account-service/attestation-public-keys.json`. No run of `just ci` includes `official_build`; it runs with `cargo nextest
run --workspace --no-default-features --features monster-realm-module/official -E
'package(monster-realm-module) & test(/official_build/)'`. acs-6.5 repeats the join half on the
built `official` artefact, on a live host.

#### (c) What the attestation names

The relay it must stop: a hostile host H connects to a victim world V as its own identity, takes
V's nonce for that identity, tells its player's client to bind with that nonce while claiming V's
name as its own, and presents the attestation the client fetched to V. V sees a valid signature,
its own name and that identity's outstanding nonce, and binds H's identity to the player's account.
The nonce is not secret and the design does not rest on it: it ties an attestation to one identity
and one use.

**The design (C2).** The attestation's `aud` is one string, the name of the server as the player's
own software authenticated it:

| The target | Its name | What authenticated it |
|---|---|---|
| Pinned: the invite and the shell document carry the certificate fingerprint | `spki:<fingerprint>/<db>` | the shell completes the connection only to that key |
| A domain server the client did not pin | `dns:<host>:<port>/<db>` | the platform's certificate checks for that name; the shell refuses every certificate error and offers no way past one |
| A `local` target: the shell's own world, on loopback | `spki:<fingerprint>/<db>` | whoever started the host wrote the fingerprint into the shell document: the shell, which confirms the process answering is the child it started, or in development the recipe that started the world |
| Anything else, such as a `private` target over plaintext loopback | none | nothing: the client asks for no attestation |

- *The spelling.* `<fingerprint>` is the SHA-256 of the world's own certificate key, in the form
  the invite prints. `<host>` is lower-cased, in its ASCII form, with no trailing dot; the port is
  always written. The function that produces a name is not the one that keys the reconnect token,
  which never normalizes a `uri`.
- *Who supplies it.* The party that authenticated the server, never the world and never a page we
  did not serve. For a browser joiner that party is the browser, and the account service derives
  the name from the address it sends the browser back to ("A browser binds a friends server it
  reached by address"). One function computes a name from a target (its kind, `uri`, `db` and
  fingerprint), for the client, the shell and whatever writes a world's names; it lives in the
  client, and the shell imports it as it imports the connection resolver. In the desktop shell the main process calls it with the pin it enforced or the address
  it dialled, and calls the attestation route; toward a `local` or `private` target the page calls
  one function that takes the nonce and returns the attestation, and is given no login token.
- *What the world holds.* Its own names, in a private table only its owner writes, and
  `bind_world_account` accepts an attestation only when its `aud` equals one of them, byte for
  byte. The shell and the standalone server write `spki:` for the world's own key; a certificate
  for a domain from a certificate authority, or one the host supplies, is named only as `dns:`, so
  a renewal that changes its key changes no name. A `dns:` name is written only while the server
  holds an unexpired, publicly trusted certificate for it, and never for an address literal, a
  single-label name or a name with no registrable domain. An address is named `ip:`, under a
  certificate issued for the world's own key (fork (g) of the browser design below). A server behind the host's own reverse proxy is told its public name
  and port by the host.
- *What the route is given.* At `POST /attest`, the name as an opaque string of bounded length, in
  the request body. The route does not log it and does not keep it. The bind route a browser uses
  derives the name itself and never takes one.
- *A browser.* A page served from an origin the account service registers as a sign-in redirect
  is our page: it may sign in and bind, computing the name itself. No origin is registered yet;
  the first is the development origin, and no page we serve in production targets a private
  world. A page that a world's own gate serves may be the hostile host's own code, and an
  account's login token, which the official server accepts, must never reach it. It never signs
  in and never names the server: it sends the browser to the account service, which returns an
  attestation for the address it sends the browser back to ("A browser binds a friends server it
  reached by address"). That flow is designed and not built; until it is, such a page tells the
  player to bind from the desktop app.
- *Before the shell exists.* The only target a build can bind is a `local` one whose shell document
  carries a fingerprint. That optional field is therefore needed by the first slice that binds
  (lpw-15), ahead of the pin that enforces it for a `private` target (lpw-18). A development
  world's fingerprint is whatever value its recipe writes into both the document and the world's
  names.
- *Stored tokens.* An invite, a shell document or the address form carries a `uri`, a `db` and a
  fingerprint and nothing else. A reconnect token planted for a world would let a genuine
  connection to that world bind the planter's identity to the player's account.

Against the relay: the player's shell pinned H's certificate, so it names H's key, and V compares
the name with its own and refuses. H cannot present V's certificate without V's private key,
whether it relays or proxies; an invite that mixes V's fingerprint with H's address opens no
connection.

**Rejected.** C1, the key that verifies the client's own world token: a world token is a bearer
token, so a host that proxies the client to the victim world hands it a genuine token under the
victim's key, the client names that key, and the host in the middle holds the token of the
identity that was just bound; in a browser the check runs in the page the host served. C3, the
server's address or the database's identity: private addresses repeat on every network, and a
database's identity is whatever its host says. C2 with a browser flow built now: a page on the
account service's own origin that signs in the player and returns an attestation naming the origin
it returns to. It passes the gate and scores below the shell alone: it puts a redirect in front of
the route, and the names it needs exist already. The operator's ruling requires a browser's way
in all the same (<https://github.com/mdrewt/monster-realm/issues/833>), and "A browser binds a
friends server it reached by address" designs it, for a domain and for a bare address.

| Alternative | Gate: a hostile host cannot obtain, by relay or proxy, a binding on another world for an identity it controls | Unforgeable by a hostile host, proxying included (3) | Covers a pinned target, a domain target, the shell's own world and a browser page (3) | What the world must know about itself, and who writes it (2) | Stable across an address change and a certificate renewal (2) | Burden beyond what the specs already hold (2) | What the account service learns (1) | Unweighted, of 30 | Weighted, of 65 |
|---|---|---|---|---|---|---|---|---|---|
| C2, bound from the desktop shell | pass | 5 | 3 | 3 | 4 | 3 | 4 | 22 | 48 |
| C2, with a browser flow built now | pass | 4 | 4 | 3 | 4 | 2 | 3 | 20 | 45 |
| C1, the world token's key | fail | 2 | 5 | 4 | 5 | 3 | 4 | 23 | 49 |
| C3, the address or database identity | fail | 1 | 5 | 2 | 1 | 5 | 2 | 16 | 36 |

C1 scores highest and fails the gate. The result reverses if browser players of domain servers
must be able to join an enforcing build at launch (then the browser flow is built, with the same
names), or if a relay or proxy through the shell is shown to succeed with the rules above in
place. The first condition holds under the operator's ruling on a browser joiner: the shell binds as
this fork has it, and a browser as the browser design below has it.

**Proved by.** lpw-15.4: given this identity's outstanding nonce and an attestation, valid in
every other way, whose `aud` is another world's name, `bind_world_account` refuses with no write
to the binding or the nonce, and passing that check unconditionally turns the test red
(`mod bind_refuses`, in `server-module/src/world_binding_tests.rs`); `mod relay_rig` there runs the
relay against two worlds' module state: the attestation fetched for the hostile host's own world is
refused on the victim, and binds on a world that holds that name. That is the module's half. The
client's half, that the name the client asks for is a function of the authenticated target alone,
is not built: `client/src/net/attestation.ts`, the name function, the bind flow and the not-owned
message for a bind do not exist. The run over two real hosts and their certificates (a relay, a
proxy, invites that mix one world's fingerprint with the other's address) needs the gate and the
pin, which lpw-12, lpw-14 and lpw-18 build and no criterion of theirs asks for; until it has run,
the relay is closed by design and proved in halves, and no `world` build is given the production
attestation keys (`PRODUCTION_ATTESTATION_KEYS` is empty).

#### (e) The build input, and the order of calls

**The design (E2).** The input is the set of cargo features of `monster-realm-module`. Enforcement
is not switched on: a build enforces ownership unless it names `open_join`.

| Feature | What it does |
|---|---|
| `official` | a release build: the production login issuer |
| `world` | a release build: the production attestation keys |
| `dev_issuers` | the dev login issuers and the dev attestation keys; ownership is still enforced |
| `open_join` | switches enforcement off; implies `dev_issuers` |
| `dev_reducers`, `load_test_zones` | as today; `dev_reducers` implies `open_join` |

The constants are computed in code from the features (`cfg!()`, so every branch is compiled and
linted in every build), and a release feature wins over a dev feature: a build is a release when
it names `official` or `world`; it enforces when it is a release or does not name `open_join`; it
trusts the dev issuers and keys when it names `dev_issuers` and is not a release; it trusts the
production login issuer when it names `official` and not `world`, and holds the production
attestation keys when it names `world` and not `official`.

| Features named | Enforces ownership | Login issuers trusted | Attestation keys held | What the build is |
|---|---|---|---|---|
| none | yes | none | none | the default build: nobody can join it |
| `dev_issuers` | yes | dev | dev | dev-enforcing |
| `open_join` | no | dev | dev | test |
| `dev_reducers` | no | dev | dev | test, with the dev reducers |
| `load_test_zones` | no | dev | dev | load-test |
| `official` | yes | production | none | official |
| `world` | yes | none | production | world |
| `official`, `world` | yes | none | none | trusts nothing |
| `official`, `open_join` | yes | production | none | official: the dev feature has no effect |
| `world`, `dev_issuers` | yes | none | production | world: the dev feature has no effect |
| `official`, `world`, `dev_issuers`, `open_join` | yes | none | none | trusts nothing |

No row has production trust with enforcement off, and none has production and dev trust together.
A release feature with `dev_reducers` is a compile error, since the constants cannot remove a
reducer; the error is skipped under clippy, whose `--all-features` run (`just lint`) names every
feature at once. The ownership features add or remove no table, reducer, view or type.

**The recipe that produces a shipped module cannot omit it.** The target is that there is nothing to omit:
leaving every feature out gives a module that enforces ownership and admits nobody, and enforcement
comes off only by naming a dev feature. Today `default = ["open_join"]` in
`server-module/Cargo.toml`, so a build that names no feature is the test build, which admits
anonymous players and trusts the dev issuers. `spacetime publish --module-path` and
`spacetime generate` build with the default features unless `--build-options` passes others to the
build, so a module published without saying so is the default build. One
recipe makes a module to ship, `just release-module <official|world>`: it refuses any other
argument; it builds the module alone, with exactly that feature, `--locked` and
`--no-default-features`, into a target directory of its
own (the e2e and CI builds write a dev module to the shared one) and with the compiler-flag
variables unset; it reads the build's profile back from the artefact, which carries it in a
section of its own (`mr_build_profile`) built from the same constants, and refuses an artefact
whose profile is not the argument; it refuses one that exports a dev reducer; and it writes the
artefact with its SHA-256. The shell, the standalone server and the official deploy embed or
publish that artefact by its hash. The artefact is the thing checked, because
`spacetime describe --json` reads the same for every profile.

What changes when `open_join` leaves `default`: every site that builds or publishes for anonymous
play names `open_join`: in `justfile` (the first line of `just test`, `ci-fast` and the mutation
recipes included, since the module's own tests join), `scripts/smoke-republish.sh`,
`client/e2e/global-setup.ts` and the load smoke in `.github/workflows/nightly.yml`; a site that
publishes with `--module-path` passes it through `--build-options`, which was tried here for
argument parsing only. Until then those sites get `open_join` from the default. The recipe and the
reader of the artefact's profile (`just module-profile`) are built. Ranked play reads the
production list (`PRODUCTION_LOGIN_ISSUERS`, in `ranked_enforcement_active` in
`server-module/src/pvp.rs`), not the build's own, so it is inert in every build while that list is
the placeholder, and a test build's guests still play PvP.

**Rejected.** E1, a feature that switches enforcement on: the build cargo produces when nobody says
anything is then the one that admits anyone and trusts the dev keys, and only a test stands
between it and a package. E3, an environment variable at build time: an unset variable is E1's
omission, and the input is in no manifest. E4, a row at run time: fork (b)'s B2.

| Alternative | Gate: names a build input, and each side of the switch has a test | A build nobody configured fails closed (3) | Production trust without enforcement cannot be built (3) | Blast radius on existing recipes and tests (2) | Consistent with "Dev-only reducers never ship" (2) | Both sides provable in CI, on the artefact (2) | Simplicity (1) | Unweighted, of 30 | Weighted, of 65 |
|---|---|---|---|---|---|---|---|---|---|
| E2, enforced unless `open_join` | pass | 5 | 5 | 2 | 4 | 5 | 2 | 23 | 54 |
| E1, a feature switches it on | pass, narrowly | 1 | 4 | 4 | 2 | 4 | 4 | 19 | 39 |
| E3, an environment variable | pass, narrowly | 1 | 2 | 3 | 1 | 3 | 3 | 13 | 26 |
| E4, a row at run time | fail | 1 | 1 | 2 | 1 | 3 | 3 | 11 | 21 |

Because the precedence is computed in code, a feature given to the compiler from outside cargo
cannot split a release feature from enforcement. The design is reopened if the ownership features
turn out to change the schema or the generated bindings, which is measured when they are built.

**Proved by.** Both sides, for each consumer:

| Side of the switch | acs-6 | lpw-15 |
|---|---|---|
| Enforcing | acs-6.1 to acs-6.3 in `server-module/src/accounts_tests.rs` and `server-module/src/movement_tests.rs`, run under `dev_issuers`; acs-6.5 in `evals/account-e2e.eval.mjs`, which builds through `just release-module` and, on a live host, requires an anonymous `join_game` refused, no account for a dev-issuer token, and the artefact's profile | lpw-15.7 in `server-module/src/world_binding_tests.rs`, run under `dev_issuers`: an unbound caller, and one whose binding carried no entitlement, are refused by `join_game` under `Open`, `Password` and `Allowlist`; lpw-15.3 under `official` |
| Not enforcing | acs-6.4: the e2e suite's anonymous joins on the `dev_reducers` module (`client/e2e/global-setup.ts`), and the module's own joins in `server-module/src/movement_tests.rs` under `open_join` | the same joins by an unbound caller, accepted under `open_join`, in `server-module/src/world_binding_tests.rs` |

The rule itself is one function over the build's profile, the caller's claims and its binding, with
the profile an argument, so one test table in `server-module/src/accounts_tests.rs` covers every
row of the table above in a single build; one more test per profile holds the constants to that
table.

**The order of calls.** `join_game` is the only reducer that asks whether the caller is entitled,
and a player row exists only through it.

- *The official server.* Connect with a login token from the production issuer, then `join_game`.
  The bind is refused.
- *A world whose rule is `Open`,* a single-player world included. Connect; when the build enforces
  and the identity has no binding, ask the world for a nonce, fetch the attestation, call
  `bind_world_account`; then `join_game`.
- *`Password`.* The gate's door first: it checks the password and admits the identity through the
  owner's `set_world_access`; then as for `Open`.
- *`Allowlist`.* The bind is the admission, so it comes before the connection: the nonce and the
  bind are relayed by the owner (`request_bind_nonce_for` and `bind_world_account_for`, owner-only
  forms that take the joiner's identity). `access::is_admitted` admits an identity with a trusted
  binding exactly while its bound account is a row of `world_allowlist`, so delisting refuses at the
  next check, and an identity with no trusted binding only when it holds a `world_admission` row
  (admitted before, which connects without a bind). The joiner then connects and calls `join_game`.
  The list is read at every check and nothing is stored from it.

An admitted connection that has not bound can read what any connection reads, on every build, as
an unentitled connection can on the official server: the ownership rule gates `join_game`, and
with it every reducer that acts in the world, not reading. A connection that is refused the bind
plays nothing and can watch.

#### What this changes in the slices as specified

| Slice | What the design changes |
|---|---|
| lpw-9 | Admission is the owner's: an unadmitted identity is refused every reducer, where lpw-9.2 reads as if its own connection called one. The module takes no password (lpw-20): lpw-9.3's door and count are the gate's (lpw-14.6). The reducer that sets the rule admits the identities then connected. The executing roster test covers the reducer check, and a handler or a filter cannot be declared with the `unstable` feature off. The connect refusal's log line is rate-limited, as the unlisted-issuer one is |
| lpw-11 | The preload exposes one more function, which takes a nonce and returns an attestation; lpw-11.1 and lpw-11.3 allow the shell document and no channel. No typed or imported entry carries a reconnect token |
| lpw-12, lpw-14 | The gate gains the door endpoint, which it serves itself and never forwards; the password check, with the Argon2id salt and hash in the world's directory and a count of wrong passwords by source address and by identity; the identity behind each socket, and the closing of a removed identity's sockets; and reading the world's rule back before it listens beyond loopback. On the right password it admits the joiner through the owner's `set_world_access`, which also writes the rule, so the call names the rule in force. The two-host relay run of fork (c) has no owner yet |
| lpw-13 | The shell admits its own player before the rule leaves `Open`; the password the host chooses goes to the gate, never to the module; it writes the world's names at each start, and embeds the artefact `just release-module` wrote, by its hash |
| lpw-15 | It builds the world's private table of names and the owner-only reducer that writes it, and a development recipe that writes one fingerprint into both the shell document and that table; it needs the shell document's fingerprint field, which lpw-18 specifies. The bind and the nonce reducer each gain an owner-only form that takes the joiner's identity, for `Allowlist`. A page a gate serves does not sign in, where the slice has every browser sign in. Its run under the `official` build needs a line in `justfile`, which acs-6 holds. It proves the relay closed in halves, where the slice has it close the relay with a hostile-host rig: that stays open until the two-host run |
| lpw-17 | The standalone command writes the world's names: `spki:` for the world's own key, `dns:` for a domain it holds a certificate for. A host behind its own proxy states its public name and port. The browser design below adds a certificate and a name for a bare address |
| lpw-18 | The shell document's fingerprint field arrives earlier, with lpw-15. lpw-18.7's browser joiner plays only on a build that does not enforce ownership, until the browser design below is built |
| acs-3 | The `world` it is given is the name above: opaque, bounded in length, in the request body, logged by neither the route nor the proxy in front of it. Only the `world` and dev builds embed attestation keys, where the slice has every release build embed the production keys |
| acs-6 | Two release builds, not one: `official` trusts the production issuer and `world` trusts none, where the slice has release builds trust the production issuer. The features, the recipe, the artefact's profile, the build and publish sites and the ranked gate of fork (e) are its to build, several outside the files it lists (`scripts/smoke-republish.sh`, `client/e2e/global-setup.ts`, `.github/workflows/nightly.yml`, `server-module/src/pvp.rs` and its tests). DECISIONS.md's "Dev-only reducers never ship" says the playtest recipes publish the default build, which changes with it |
| acs-11 | acs-11.3's release module is the `official` build |
| acs-12 | Toward a `local` or `private` target the preload hands the page an attestation, never the ID token |

### A browser binds a friends server it reached by address

The operator's ruling (<https://github.com/mdrewt/monster-realm/issues/833>, 2026-11-22): a player
at a public computer with no desktop build joins a friend's cloud server from a browser by
navigating to its address, a static IP address included, with security kept. It overrules the
default fork (c) recorded, under which a page a world's gate serves told the player to bind from
the desktop app. Two questions are decided here: (f) how a page a gate serves obtains an
attestation, when that page may be a hostile host's own code and must never hold a login token; and
(g) what names a server a browser reached by a bare IP address. Nothing here is built: the account
service has no bind route, the client no bind flow, and the gate and the standalone server do not
exist. A bind asks nothing new of the module: a world's names are strings its owner writes, and
`bind_world_account` compares an attestation's `aud` with them byte for byte
(`server-module/src/world_binding.rs`). The one rule the design wants from it, refusing a second
account for a bound identity, is the lpw-23 row of the last table.

| Fork | Chosen | Rejected | Proved by |
|---|---|---|---|
| (f) A page a gate serves | F6: the page sends the browser to the account service's own origin; the player signs in and consents there; the service redirects back with a one-use code, and the page redeems it for an attestation whose `aud` the service derived from the address it redirected to | F1: the redirect carries the attestation itself. F5: a window on the account service's origin posts it back. F3: the page signs in with a token scoped to its origin. F2: the page signs in and calls `/attest`. F4: approval on a second device | `account-service/src/bind.test.ts`, `account-service/src/bindName.test.ts`, `client/src/net/attestation.test.ts` and `client/e2e/browser-bind.spec.ts`, none of them built; `mod bind_refuses` in `server-module/src/world_binding_tests.rs`, which is |
| (g) A server reached by a bare IP address | G1: a publicly trusted certificate for the address, issued for the world's own key; the name is `ip:<address>:<port>/<db>` | G4b: a public address named under the world's self-signed certificate. G2: a DNS name we issue for the server's key. G5: desktop only. G4: any address under any certificate. G3: the account service connects and names the key it saw | `desktop/src/acme.test.ts` and `desktop/e2e/acme.spec.ts` (lpw-17) and the name vectors of `account-service/src/bindName.test.ts`, none of them built; `mod relay_rig` in `server-module/src/world_binding_tests.rs`, which is |

| The server | How the joiner obtains an attestation | The attestation's `aud` | What authenticated it |
|---|---|---|---|
| A domain name, with a certificate a browser trusts | The page the gate serves posts the world's nonce to the account service's bind route; the player signs in and consents on the account service's own origin; the page redeems the code the redirect brings back | `dns:<host>:<port>/<db>` | The browser's certificate checks for that name. The code exists only in a redirect to `https://<host>:<port>/bind-return`, which a browser completes only to a server showing a certificate it trusts for that host, and is redeemed only with a value the page that started the bind kept |
| A bare IP address, with a publicly trusted certificate for it | The same flow | `ip:<address>:<port>/<db>` | The browser's certificate checks for that address, in the same way. Let's Encrypt issues such a certificate only to whoever answers at the address on port 80 or 443, and for 160 hours at a time |
| An address with no publicly trusted certificate: the world's self-signed certificate, at a public or a private address | None from a browser. The desktop shell binds it by its pin | none from a browser; `spki:<fingerprint>/<db>` from the shell | Nothing a browser can use: a certificate accepted through a warning authenticates nobody |

Each fork was scored by a judge from one evidence dossier, as the forks above were: 1 (poor) to 5
(excellent) per criterion, the weights fixed before scoring, an alternative that fails its gate
scored and not chosen. A red-team attacked the dossier before the judges read it, and what it broke
is in the design below. The attacker is fork (c)'s hostile host, with two things written out that
the access design leaves unsaid: it cannot get a browser-trusted certificate for an address it
does not control, any more than for a domain, and it is not on the network path between a player
and another server. One thing is added to it: a player's browser may have loaded the hostile
host's page before.

#### (f) How a page a gate serves obtains an attestation

**The design (F6).** The account service gains a bind route beside `POST /attest`. A gate serves
one world.

1. *The nonce.* The page connects to its own gate under the world's anonymous token and takes the
   world's nonce for that identity (`request_bind_nonce`, read through `my_bind_nonce`). Under
   `Password` the gate's door comes first; under `Allowlist` the gate's door relays the owner's
   `request_bind_nonce_for` for the identity whose token the caller presents.
2. *The start.* When the player presses a button, the page makes a random verifier, keeps it in
   the tab's `sessionStorage` with the identity it is binding, and posts a form to the account
   service as a top-level navigation: `POST <issuer>/bind` with `return` (the page's own origin),
   `db`, `nonce` and `challenge` (the SHA-256 of the verifier). Waiting for the press is the
   honest page's rule: a hostile page can post without one, and gains a sign-in the player sees.
3. *The checks.* The service refuses a request that fails any row of the table below, on a page of
   its own, and redirects nowhere.
4. *The sign-in.* The service keeps the four values in a signed, `HttpOnly`, host-only,
   `SameSite=Lax` cookie named for this one bind, so two binds in one browser do not overwrite
   each other, and runs its profile's sign-in step on its own origin: email and password on the
   dev profiles, which is built, and Steam's OpenID in production, which acs-10 builds. It issues
   no ID token, authorization code or refresh token to anyone, and starts no session: the cookie
   admits to nothing but this bind. Starting a bind counts against a cap of its own, so a flood of
   binds does not stop sign-ins to the official server. Like the sign-in cap it is not per network
   address, so a flood does stop every browser bind for as long as it lasts.
5. *The consent.* After every sign-in, for an account that owns the game and for one that does
   not, the service shows the server's address exactly as the name will carry it (the host in its
   ASCII form, the port) and the database, says that the server's host will learn the account's id
   and whether it owns the game, and offers Continue and Cancel. Nothing is sent to the server
   before one of the two is pressed.
6. *The answer.* On Continue the service marks the bind spent, so a second Continue signs nothing,
   applies the account's attestation limit (shared with `/attest`), reads the account again, and
   signs the eight claims `/attest` signs, with `aud` derived from `return`:
   `dns:<host>:<port>/<db>` or `ip:<address>:<port>/<db>`, the port always written and the host as
   the URL parser serialized it. It logs the account and the time, as `/attest` does. It holds the
   attestation in memory, with the challenge and the return address, under a random one-use code
   for at most a minute, and answers `303` to `<return>/bind-return#code=<code>`. `/bind-return`
   is one fixed path, the same for every server. On Cancel the fragment is `error=access_denied`
   and says nothing about the account. For an account that does not own the game, Continue carries
   what `/attest` answers for it: the error `not_entitled` as built, and an attestation that says
   so once lpw-23 has the route issue one.
7. *The redemption.* The page at `/bind-return`, where the gate serves the client page and never a
   redirect, reads the fragment, removes it from the address bar before anything else, and treats
   every field as untrusted text of bounded length. It posts the code and the verifier to
   `<issuer>/bind/redeem`. The service answers with the attestation once, only when the verifier's
   SHA-256 is the challenge the bind started with and the request's `Origin` is the bind's
   `return`. Its cross-origin answer names that origin alone, carries no credentials and is sent
   with `Cache-Control: no-store`; the route reads no cookie. A redemption that fails either check
   leaves the code unspent: the verifier cannot be guessed, and a code that anyone who saw it could
   burn would let them stop a bind.
8. *The bind.* The page calls `bind_world_account` with the attestation on its own connection
   (under `Allowlist` it hands it to the gate's door, which relays `bind_world_account_for` for the
   identity whose token the caller presents), then `join_game`.

Every page of the route sends what the sign-in pages send (`frame-ancestors 'none'`,
`X-Frame-Options: DENY`, `Cache-Control: no-store`) and `Cross-Origin-Opener-Policy: same-origin`.

| What the bind route requires | What it stops |
|---|---|
| `POST` with a form body; a `GET` is refused | The server's address in a URL, and so in a proxy's log, the history or a `Referer` |
| `return` is `https:` and is already the URL parser's own serialization of its origin | User-info, a path, a query, a fragment, upper case, a written default port and every second spelling of an address (the measurement below) |
| The `Origin` header the browser put on the post equals `return`; `null` is refused | A page starting a bind that returns anywhere but to itself: in a browser, the address on the consent page is the address of the page the player just left |
| A domain has no trailing dot, labels of letters, digits and inner hyphens, and at least one label below a suffix of the public suffix list's ICANN section; the list's default rule is not applied | A single-label name, a made-up suffix (`server.lan`), a special-use name (`.local`, `.internal`, `.test`, `.onion`, `home.arpa`): names that repeat on every network and that no certificate authority certifies |
| An IP address is IPv4 outside the special-purpose blocks, or IPv6 inside `2000::/3` and outside them, and is not IPv4-mapped; the port is not 0 | A private, loopback, link-local or shared address, and a second name for an IPv4 address |
| `db` matches `[A-Za-z0-9_-]+` and the name is at most 512 characters; `nonce` is 1 to 128 visible ASCII characters; `challenge` is 43 characters of `[A-Za-z0-9_-]` | A name the module's own bound refuses; anything but opaque, bounded text in the attestation |
| No redirect before Continue or Cancel | The service as a redirector to addresses nobody approved, and a site learning, without the player's consent, that a visitor has an account or whether it owns the game |
| The four values ride in the bind's cookie until the consent. From the consent to the redemption, a minute at most, the attestation waits in memory with its challenge and return address; the id of a spent bind stays in memory until its cookie expires. None of it reaches the database, a log or a backup | A record of which server an account joined |

The `local-dev` profile alone also takes a loopback `return`, the three spellings the `set-client`
command takes for a redirect address: `http://localhost:<port>` is signed as
`dns:localhost:<port>/<db>`, and `http://127.0.0.1:<port>` and `http://[::1]:<port>` as `ip:`
names. So the flow runs on one machine; that profile's attestation key is public and signs nothing
a release build accepts.

**What the page is left holding.**

| What the flow hands the page | A login token the official server accepts | Why |
|---|---|---|
| The code in the redirect's fragment | no | Random; spent by its first redemption and dead after a minute; worth nothing without the verifier; no token of any issuer |
| The attestation the redemption returns, which carries the account's id and whether it owns the game | no | Signed with the attestation key under the issuer name `<issuer>/attest`. The official build holds no attestation key and refuses every bind (fork (b)), and as a connection token it names an issuer no build lists |
| An error word (`access_denied`, `not_entitled`) | no | One of a fixed list, which says nothing the page could present anywhere |
| The verifier and the challenge | no | The page made them itself; they are good for one redemption of one bind |
| Nothing else | no | No ID token, authorization code or refresh token is issued in a bind, and the bind's cookie is `HttpOnly` on the account service's origin, where the page's script cannot read it |

The rest of the account service gives such a page nothing either. `POST /attest` answers only a
bearer ID token, which the page does not hold. The token endpoint answers across origins only from
a registered client's redirect address and needs that client's code and its verifier; a client has
one redirect address, written by an admin command, and it is not a gate's. The attestation carries
the account's id, as every attestation does, and the consent page says so.

**Against the relay, the proxy and an address that changes hands.**

| The attack | What the hostile host does | Where it stops | Outcome |
|---|---|---|---|
| Relay | H takes V's nonce for its own identity and has its page start a bind that carries it | A page can start only a bind that returns to its own origin, so the name signed is H's; V refuses it with `attestation names another world`, lpw-15.4's check | closed |
| Relay, with the request made outside a browser | H posts to the bind route itself, with `return` and `Origin` set to V's origin and V's nonce for its identity | No player is signed in to that request. If H signs in as itself, it reads the code out of the redirect and redeems an attestation for its own account, which `/attest` gives H anyway | closed |
| Proxy | H serves the page from its own origin and forwards the connection to V, at the application layer or as untouched TCP | Through an application proxy the browser's origin is H's, so the name is H's. Forwarded untouched, the browser is shown V's certificate for an address it did not dial; past that warning the page is V's own and the origin still H's, so the name is still H's | closed |
| Proxy, from another port of V's address | H is another tenant of the same address | The port is part of the browser's origin and of the name, so H's port is another name | closed |
| An address that changes hands: what was issued before | H keeps a code or an attestation from the time it held the address | A code lives a minute and an attestation five; each is spent by one use, and the attestation carries one identity's nonce | closed |
| An address that changes hands: the past holder, in a browser that never loaded its page there | H held V's address before V and still has a certificate for it | The code goes to whoever answers at the address when the player binds; H's certificate is of no use off the network path, and expires: within 160 hours for an address, and for a domain name with the certificate's life (90 days by Let's Encrypt's default) | closed |
| An address that changes hands: the past holder, in a browser that did load its page at that address and port | H's page left a service worker, cached pages or a stored token in that browser. The first two run as V's origin: they start a bind for H's identity on V and redeem it, or read the world token the browser keeps for V. A planted token of an identity H already bound has the player play H's character | Nowhere, in that browser. A service worker answers the navigation before V is asked (measured), so no header V sends reaches that load. The world's port is drawn at random when the world is made, which makes the same origin unlikely; a host who names its port, 443 included, has no such margin. What H binds this way stays bound until the world's owner removes it | open, in a browser that visited the past holder at the same origin; tracked as R-lpw-19-CHANGEDHANDS |
| An address that changes hands: the new holder | V moved and still runs, configured for its old address and holding an unexpired certificate for it. H answers at that address, obtains attestations that name it and presents them on V, which it reaches at V's new address | V lists an `ip:` or `dns:` name only while it holds an unexpired, publicly trusted certificate for it, rewrites its names at every start and renewal, and removes a name at a refused renewal or an expiry: within 160 hours for an address, unless H forwards the certificate authority's validation to V. For that time H is also the server every browser reaches at the address, and reads each browser joiner's world token outright | open: V accepts the name for at most 160 hours after it leaves an address (a domain name: its certificate's life), longer while the new holder keeps V's certificate renewed, and what is bound in that time stays bound until the owner removes it; tracked as R-lpw-19-CHANGEDHANDS |

The last two rows are what it means to know a server by its address. To a browser the server is
whoever answers there with a certificate it trusts, and an origin keeps what was put in it. Neither
is particular to the bind: both give the same party the page and the stored world token, and the
second is as true of a domain name that changes hands, for the certificate's whole life. The
desktop shell has neither limit, because it knows a server by its key. Two rules on the moved
world's side would cut the new holder's time and are not part of this design, since each has the
server calling a service: asking a party outside its network which address its connections come
from, which answers in minutes, and watching the certificate-transparency logs for a certificate
for its address that it did not order, which answers in the hours a log search takes and not at
all while the search cannot be reached. No design in which the joiner navigates to the server's
address closes these two rows. The one that does, a name that follows the key (G2 below), has the
joiner navigate to a name we issue and has us operate the service that issues it; leaving them
open is this design's default, which the operator may overrule.

Three more rules keep an honest page from binding what it should not:

- *A first bind is for an identity the world issued in this tab.* When a stored token's identity
  has no binding (no row in `my_world_binding`), the page sets the token aside and takes a new
  identity before the bind starts, unless the player says the stored player is theirs: it tells
  them this browser holds a player for this server that no account is linked to, and a new player
  is the choice it offers first. In a browser whatever held the origin before can write its
  storage, and a planted token would bind the planter's identity to the player's account (fork
  (c), "Stored tokens").
- *A later bind never changes the account.* The page presents a new attestation for a bound
  identity only when its `sub` is the binding's account; otherwise it says the stored player
  belongs to another account and offers a new one. The module as built replaces a binding with
  whatever attestation an identity presents (`bind_identity`), so whoever holds an identity's
  token can move it to an account of their own; until the module refuses that, this rule guards
  the honest page and nothing else.
- *The gate's door ties an identity to the caller.* Under `Allowlist` the door relays a nonce
  request or a bind only for the identity whose token the caller presents, so nobody binds
  another joiner's identity.

*How often.* The operator's ruling on account checks
(<https://github.com/mdrewt/monster-realm/issues/848>) has the client bind before every
`join_game`. Through this route each bind is a sign-in and a consent, the page unloads for it, and
an account gets 20 attestations an hour. So a page a gate serves asks for a bind when the world
says it needs one (no binding, or the ownership refusal) and otherwise once the binding is more
than a day old, the interval that ruling gives the host's own account. A player who comes back
without an attestation joins on the stored status, as the client does when the issuer cannot be
reached. The ruling leaves the workflow of each kind of world to judgement; this is that judgement
for a browser joiner, a default the operator may overrule.

*What stays on a shared computer.* The history keeps the address of the return, which holds a
spent code. The world's token stays in the origin's `localStorage`, as it does for every `private`
target, so the next person at that browser resumes the player until the site's data is cleared;
and a player who joins from another browser is a new identity there, with a new character.

*What a hostile page can still do.* Choose when to send a player to a sign-in, and send them to a
look-alike of it on another origin instead. Every web sign-in has that exposure, the official
site's included. The address the browser shows and Steam's own second factor stand against it; the
route hands the look-alike nothing.

**Measured** on 2026-11-22; the scripts are not in the repository (section 7).

| What was tried | Result |
|---|---|
| A prototype of the name rule over 74 return addresses, under Node 24.22.0 | 11 are signed, among them `https://friends.example.com` as `dns:friends.example.com:443/world-1`, the same with `:8443`, `https://8.8.8.8:8443` as `ip:8.8.8.8:8443/world-1`, `https://[2606:4700:4700::1111]:8443` as `ip:[2606:4700:4700::1111]:8443/world-1` |
| The same host spelled `:443`, in upper case, with a trailing `/`, a path, a query, a fragment, `user@`, `%`-escapes or a trailing dot | each parses to an origin that is not the string sent, or keeps its dot, and is refused |
| `8.8.8.8` spelled `0x8.0x8.0x8.0x8`, `010.010.010.010`, `134744072`, `8.8.2056`, `8.8.8.8.` or in full-width digits | all parse to `8.8.8.8` and are refused as a second spelling |
| `[::ffff:8.8.8.8]` | parses to `[::ffff:808:808]` and is refused as a second spelling; `[::ffff:808:808]` itself is refused as IPv4-mapped |
| `192.168.1.10`, `10.0.0.5`, `127.0.0.1`, `100.64.0.1`, `169.254.1.1`, `[::1]`, `[fe80::1]`, `[fd00::1]`, `[2002:808:808::1]`, `[64:ff9b::808:808]` | refused as not globally reachable |
| `[::808:808]`, `[4000::1]`, `[8000::1]`, `[1::1]` | a rule written as a list of blocks to refuse signs all four; the rule `2000::/3` less the special blocks refuses them |
| `*.example.com`, `a$b.example.com`, `_x.example.com` | the parser accepts each as a host; refused by the label rule |
| `co.uk`, `server.lan`, `x.local`, `x.internal`, `x.onion`, `x.home.arpa`, `localhost` | refused; `x.co.uk` is signed |
| `net.BlockList` with a rule for `::ffff:0:0/96`, asked about `8.8.8.8` | it matches, so that rule refused every IPv4 address; the mapped form is refused by its prefix instead |
| A page posts a form across origins, in Chromium 149.0.7827.55 | the request line is `POST /bind`, the values are in the body only, and `Origin` is the posting page's origin |
| The same post from a page whose `Referrer-Policy` is `no-referrer` or `same-origin` | `Origin: null`; under `strict-origin-when-cross-origin` and `origin` it is the page's origin |
| A 303 to `<gate>/bind-return#…` | the gate receives `GET /bind-return` with the fragment in neither its request line nor a header; the page reads it |
| The page replaces its history entry with the bare path | the address bar and the Back button hold no fragment; the profile's `History` database keeps the address with its fragment, whole |
| The return path answers 302 to another site | that site's page reads the fragment |
| A page opens the account service's page in a new window, then sets that window's location | without `Cross-Origin-Opener-Policy` the window goes where the opener sends it; with `same-origin` its `opener` is null, the opener's handle reports closed and the window stays |
| A server registers a service worker and writes `localStorage`; another server then takes the same origin | the service worker answers the navigation to `/bind-return` and reads the fragment, with no request reaching the new server; with the worker gone, the new server's page reads the value the first one stored |
| A server serves a page cacheable for a year; another server then takes the same origin | the cached copy is served, with no request reaching the new server |

**Rejected.** F1, the attestation itself in the redirect's fragment: one endpoint fewer and no
request from the page by script, and the attestation, with the account's id and the server's
address, stays in the browser's history on the shared computer the ruling is about (the measured
row above). F5, a window on the account service's origin that posts the attestation back: the
game page stays loaded, but the sign-in page must keep its opener and so cannot send
`Cross-Origin-Opener-Policy`, and the page that opened it can then send it to another address in
the middle of the sign-in (measured); browsers block a window nobody clicked for, and whether
Steam's pages keep the opener is not ours to decide. F3, the page signs in as a client registered
for its own origin: the name is bound to the origin as in F6, but the page holds a login token,
refused by the official server through the one audience check that passes a token when any entry
of its audience list is allowed (`audience_allowed`), and a refresh token good for 30 days, with
which a hostile page mints attestations for its own name with no player present. F2, the page
signs in and calls `/attest`, lpw-15's contract as written: the page holds an ID token the
official server accepts and names the world itself. F4, approval on a second device: nothing
delivers the answer through the player's browser, so the name is whatever the asking page claims;
it is the remote phishing of RFC 8628 section 5.4.

| Alternative | Gate: no login token reaches a page a gate serves; no binding on another world by relay or proxy; done in a browser with nothing installed | Unforgeable by a hostile page, relay and proxy included (3) | What a hostile page is left holding, and for how long (3) | Holds against a page that imitates the sign-in or keeps hold of its window (2) | Works in every current browser, across the Steam step, and when the game page reloads (2) | Burden on the account service and on the slices as specified (2) | What the account service learns and keeps, and what is left on a shared computer (1) | Unweighted, of 30 | Weighted, of 65 |
|---|---|---|---|---|---|---|---|---|---|
| F6, the redirect carries a one-use code | pass, narrowly: the relay rests on the browser's origin check, and state left at a reused origin is fork (g)'s | 4 | 5 | 4 | 4 | 2 | 4 | 23 | 51 |
| F1, the redirect carries the attestation | pass, narrowly: as F6 | 4 | 5 | 4 | 4 | 3 | 2 | 22 | 51 |
| F5, a window that posts the result back | pass, narrowly: across Steam's pages it is unverified | 4 | 5 | 2 | 2 | 3 | 4 | 20 | 45 |
| F3, a token scoped to the page's origin | fail | 3 | 2 | 2 | 4 | 2 | 1 | 14 | 32 |
| F2, the page signs in and calls `/attest` | fail | 1 | 1 | 2 | 4 | 3 | 2 | 13 | 26 |
| F4, approval on a second device | fail | 1 | 2 | 1 | 2 | 2 | 4 | 12 | 23 |

F6 and F1 tie on the weighted total: F1 scores 52 without the history measurement and 51 with
it. The judge chose F6 on the unweighted total and on the one difference between them that is
measured; the rubric sets no tie-break. The result reverses if the rule that a gate's page makes
no request to the account service is held to forbid the page's redemption request (F1's form post
is a navigation); if the attestation can be kept out of every address the history records without
such a request (F1 then wins on burden); or if Steam's pages are shown to keep an opener and a
bind before every connection is required (F5's kept page then counts for more, though it still
cannot send `Cross-Origin-Opener-Policy`).

**Proved by.** None of these tests exists; each is named for the work that builds it.
`account-service/src/bindName.test.ts`: the name for every row of a table of return addresses,
held in the repository once and read by the client's tests too, the 74 measured here among them
(the one whose label is not valid Punycode included, signed as measured).
`account-service/src/bind.test.ts`: each refusal of the table above alone; a whole bind, in which
no response, header, cookie or redirect holds a token that verifies under a login key; the
attestation's claims are `/attest`'s with the derived `aud`; a code redeems once, only with its
verifier and from its origin; nothing reaches the server before Continue or Cancel; no log line
and no stored record holds a return address, a database, a nonce or a challenge.
`client/src/net/attestation.test.ts`: the page starts a bind only from a press, toward its own
origin, with a fresh identity when the stored one is unbound; it presents no attestation whose
`sub` differs from its binding's; it makes no request to the account service but the redemption.
`client/e2e/browser-bind.spec.ts`: in a real browser, against the `local-dev` account service and
a world that lists the derived name, the round trip binds and joins; an attestation obtained for
one origin is refused by a world that lists another (`mod bind_refuses` holds the module's half
of that); a code delivered to a page that did not start the bind is not redeemed. No test
above runs over TLS: a `dns:` and an `ip:` bind in a browser, under certificates from a test
certificate authority the browser is made to trust, and the relay and proxy rows of the table
above, belong to the run over two real hosts that fork (c) still lacks, and that run has no slice.

#### (g) What names a server a browser reached by a bare IP address

A browser shows a page nothing about the certificate it accepted and cannot pin one. All it
authenticates is the origin in the address bar, through the public certificate authorities. A host
who takes a domain name, a free dynamic one included, is served by fork (f) with a `dns:` name and
the standalone server's ACME. This fork is for the host who has an address and no name.

**The design (G1).**

- *The certificate.* Given its public IP address, the standalone server obtains a certificate for
  it over ACME, for the world's own key, and renews it. Let's Encrypt issues one for an address
  only on its `shortlived` profile, valid 160 hours, validated by http-01 on port 80 or by
  tls-alpn-01 on port 443 and never by DNS. A browser then reaches `https://<address>:<port>/`
  with no warning. Because the key is the world's own, a desktop shell still completes its pin
  against that certificate: the invite, the fingerprint and the name `spki:` are unchanged for the
  shell.
- *The name.* The account service derives `ip:<address>:<port>/<db>` for a browser joiner: the
  address as the URL parser writes it, an IPv6 address in its brackets, the port always written.
- *When the world lists it.* The standalone server writes an `ip:` or a `dns:` name only while it
  holds an unexpired, publicly trusted certificate for it, never for an address outside the
  globally reachable ranges or a name the bind route would refuse. It rewrites the names at every
  start and at every renewal, and removes a name when the certificate authority refuses a renewal
  or the certificate expires.
- *The port.* A world's public port is drawn at random when the world is made and kept, unless the
  host names one, so the origin is one no earlier server at that address is likely to have used.
- *One world, one origin.* The database in a name is the page's word: every page of one origin is
  one host's. A gate serves one world, so the word is never another host's.

What an `ip:` name does and does not prove:

- It proves who answers at the address when the player binds, and nothing about who answered
  before or will after. The two open rows of the table in fork (f) are its limits.
- A past holder of an address can spend its allowance of certificates (at Let's Encrypt, 5 for the
  same address in 7 days, with no override) and leave the next server there without one for up to
  a week.
- The host keeps port 80 or 443 reachable at the address for a validation every few days, and the
  server keeps its certificate across restarts so that a restart costs no issuance. Every
  certificate, with its address and key, is published in the certificate-transparency logs.
- An IP address cannot be an HSTS host (RFC 6797, Appendix A), so a browser always offers a way
  past a certificate error there. A player who accepts a warning for an attacker on the network
  path has authenticated the attacker. That attacker is outside this design's model, and a public
  computer is where it is likeliest.
- A LAN or other private address is never certified (CA/Browser Forum Baseline Requirements
  section 4.2.2), never signed and never listed. A browser joiner there cannot bind.
- Typed with no `https://`, an address depends on the browser trying `https:` first; the address a
  host hands out is the whole one.

**Rejected.** G4b, the judge's addition: a public address named under the world's self-signed
certificate, with no certificate authority. It passes only because the model takes the attacker
off the network path; no certificate ever expires, so nothing removes a stale name; and every
join, at a public computer too, begins with the player accepting a certificate warning that looks
the same when the certificate is an attacker's. G2, a name we issue for the server's key: we
operate a DNS zone and a certificate broker, give each server `k-<hash of its key>.<zone>` and
answer its DNS-01 challenge, as Tailscale does for its users' machines; Plex gives its users'
servers names and certificates under a domain of its own. The name follows
the key, so it closes both open rows and, with the zone preloaded for HSTS, the warning as well.
It costs a service that is always on in front of every friends server a browser can join, whose
one compromise is every browser joiner's page; an allowance of 50 certificates a week per
registered domain until the certificate authority grants more; names under our domain pointing at
servers strangers run; and the joiner navigates to a name we made, not to the server's IP address.
G5, an address server stays desktop-only: what the ruling overrules. G4, any address under any
certificate: private addresses repeat on every network (fork (c)'s C3). G3, the account service
connects to the address and names the key it saw: a host that forwards the account service's
connection untouched to the victim, and answers browsers itself, has the victim's name signed and
delivered to its own page.

| Alternative | Gate: a browser with nothing installed joins a server that has an address and no name; a host that never controlled the address gets no binding there by relay or proxy | Closed against relay and proxy by a hostile host that never held the address (3) | What an address that changes hands allows, in both directions, and for how long (3) | What we must operate, what one compromise of it reaches, and what stops when it is down (3) | The ruling as worded: the joiner navigates to the server's IP address (2) | Burden on the host (2) | Burden on the slices as specified (2) | What we and the public learn about servers and players (1) | Unweighted, of 35 | Weighted, of 80 |
|---|---|---|---|---|---|---|---|---|---|---|
| G1, a certificate for the address | pass, as worded: an address that changes hands is scored, not gated | 5 | 2 | 5 | 4 | 3 | 4 | 3 | 26 | 61 |
| G4b, a public address under the self-signed certificate | pass, only because the model takes the attacker off the path | 4 | 1 | 5 | 3 | 5 | 5 | 4 | 27 | 60 |
| G2, a name we issue for the key | pass, on its letter: the joiner navigates to a name | 5 | 5 | 2 | 2 | 5 | 1 | 2 | 22 | 54 |
| G5, desktop only | fail | 5 | 5 | 5 | 1 | 5 | 5 | 5 | 31 | 72 |
| G4, any address under any certificate | fail | 1 | 1 | 5 | 3 | 5 | 5 | 4 | 24 | 51 |
| G3, the account service names the key it saw | fail | 1 | 3 | 3 | 3 | 5 | 3 | 3 | 21 | 46 |

G5 scores highest and fails the gate: it does nothing. G1 leads G4b by one point, and what
separates them is not in the rubric: a join under G1 shows no warning. The result reverses if we
come to operate a DNS zone and a certificate broker for another reason, or get such a zone onto
the public suffix list cheaply (G2 then wins), if the
ACME code cannot obtain a `shortlived` certificate for an address in practice (only Certbot's
support was confirmed), or if an address that changes hands proves to be a targeted attack and
not a matter of chance, which makes the second criterion a gate that G1 fails.

**Proved by.** None of the standalone server's tests exists. `desktop/src/acme.test.ts` and
`desktop/e2e/acme.spec.ts` (lpw-17), against Pebble: an order with an `ip` identifier and the
`shortlived` profile, for the world's own key, validated on each of the two ports; the names
written are exactly those the server holds an unexpired certificate for; a refused renewal and an
expiry each remove the name; a restart issues nothing. `account-service/src/bindName.test.ts`
holds the spelling of an address name and the refusal of every address outside the globally
reachable ranges. In the module nothing is new: `mod bind_refuses` and `mod relay_rig` in
`server-module/src/world_binding_tests.rs` already refuse an attestation whose `aud` is not one of
the world's names, whatever its form.

#### What a joiner is shown at a server whose address has no publicly trusted certificate

| The server | The build | What the joiner is shown |
|---|---|---|
| Serves the world's own self-signed certificate, at a public or a private address | enforces ownership | The browser's certificate warning, which the joiner accepts to load the page. Then, where the sign-in button would be, the page says that this server cannot check an account from a browser, and that the way in is the desktop app with the server's invite, or the host giving the server a domain name or a certificate for its address. The page makes no request to the account service. It knows from the shell document the gate serves to a browser, which carries the world's fingerprint exactly when the certificate the gate serves is the self-signed one |
| The same server | does not enforce ownership | The browser's certificate warning, then the game: no bind is asked for, as lpw-18.7 specifies |
| A private address, a single-label name or a name under no public suffix, from a page that starts a bind all the same | enforces ownership | The account service's own page, before any sign-in: this address cannot be checked from a browser. It offers no way on and redirects nowhere |
| A public address under a self-signed certificate, from a page that starts a bind all the same | enforces ownership | The sign-in and the consent, then the world's refusal, `attestation names another world`, since the world lists no `ip:` name; the page shows the first row's message |

#### What the browser bind changes in the slices as specified

| Slice | What the design changes |
|---|---|
| lpw-15 (the client's bind flow, which lpw-24 builds) | The attestation has three sources behind its one interface: the shell's function; a sign-in with `/attest` from an origin registered as a sign-in redirect (the development page, toward a `local` target whose document carries a fingerprint); and, for a `private` target on the page's own origin, the bind route. For that third source the page computes no name and never signs in. It starts a bind only from a press; it handles `/bind-return`; it binds a fresh identity when the stored one is unbound and never another account over a binding; it shows the cannot-bind message when a `private` target's document carries a fingerprint. It asks for a bind when the world needs one and once a day otherwise, where lpw-24.1 has every connection, and a return without an attestation is lpw-24.2's case. The one name function gains the `ip:` form for the standalone server that writes it; no client asks for an attestation under it. lpw-1.1's rule counts one navigation to the bind route and one request to redeem, during a bind and at no other time. The bind address is a build value, kept for `local` and `private` targets alone and never given to `connect`; lpw-24 amends the two DECISIONS.md entries that say a `private` target makes no request to the issuer and shows no sign-in ("A target's kind gates telemetry and account sign-in: only servers we operate get either" and "The client learns that a server needs an account from its kind or from the first refusal; the menu frame is the sign-in screen") |
| lpw-17 | Given a public IP address the command certifies it over ACME (an `ip` identifier, the `shortlived` profile, the world's own key) where lpw-17.5 has it serve the self-signed certificate, and prints the `https:` address for browser joiners beside the invite. It writes `ip:` and `dns:` names by the rule of fork (g) and removes one at a refused renewal or an expiry, while lpw-17.6 keeps it serving the last valid certificate. It draws the world's public port at random unless told one. Its guide, `docs/hosting.md`, is to say which servers a browser can bind, that port 80 or 443 must stay reachable, and that a host behind its own proxy routes `/bind-return` to the gate and never redirects it. If no ACME library it can use orders a certificate for an address, an address server stays shell-only and fork (g) is reopened |
| lpw-18 | lpw-18.7's browser joiner plays on an enforcing build where the gate serves a publicly trusted certificate, and "without any other origin" excepts the account service, reached by one navigation and one request during a bind. The gate serves the client page at `/bind-return`. The shell document it serves to a browser carries the fingerprint exactly when the certificate it serves is the self-signed one; the shell takes its fingerprint from the invite, whatever certificate the gate serves. Its page sends a `Referrer-Policy` that discloses its origin, and a content security policy whose `form-action` and `connect-src` name the account service and itself |
| acs-3 | A second way to an attestation beside `POST /attest`, which is unchanged and merged; a new slice of the account service builds it: `POST /bind`, the consent page and `POST /bind/redeem`, with the checks, the cap and the headers of fork (f). It signs the same eight claims under the same key and log line and one limiter shared by both routes, with `aud` derived and never taken from the caller. The public suffix list and the special-purpose address blocks are snapshots held in the repository and refreshed with a release; a suffix or a block the snapshot lacks is refused. acs-3.5's rule covers the return address, the database, the nonce and the challenge, in logs and in the database. The sign-in step is reached from the bind route as well as from an authorization request, which adds the bind's cookie to the four the request handler passes on (acs-2) and a second address Steam returns to (acs-10) |
| The world's names | One more form, `ip:<address>:<port>/<db>`, beside `spki:` and `dns:`. A `dns:` or an `ip:` name is what a browser or an unpinned shell authenticated through a certificate authority, and the account service derives it for a browser; `spki:` is the world's own key, which an address certificate also carries. A name is listed only under an unexpired, publicly trusted certificate, rewritten at every start and renewal and removed at a refused renewal or an expiry. The name the account service derives and the name the one name function computes, for the shell and for whatever writes a world's names, are held equal by one table of vectors |
| lpw-14 | A world the shell opens to friends serves its self-signed certificate, so on an enforcing build a browser cannot bind it; the standalone server is what certifies an address. The gate's door serves a browser joiner under `Allowlist`: it gives a new identity its token and nonce before the bind, since an unadmitted identity's token connects to nothing, and relays the nonce request and the bind only for the identity whose token the caller presents |
| lpw-23 | `bind_world_account` for an identity that already has a binding refuses an attestation for another account; `unbind_world_account` (lpw-22) is the way to change it |
| lpw-2 | A world's token in a browser's `localStorage` outlives the visit, at a public computer too, and a player in another browser is another identity. Both stand as specified and are named in R-lpw-19-SHAREDCOMPUTER |

### The design later work elaborates against

The own-issuer design, with the attestation verified as a reducer argument under the world's own
anonymous token, and the access design above. LP4 (sign in once, then offline) and LP6
(private-server access) elaborate against it. The in-module verifier is measured: Ed25519,
108.4 µs a check against a budget of 5 ms. Of the three conditions the design holds on, one is
decided, an attestation route beside our own account service (DECISIONS.md, "A private world
verifies an account by a per-world attestation our account service signs"), which exists
(`account-service/src/attest.ts`), and two are built in the module and proved in its tests: the
official server refusing attestation binding (fork (b)) and the relay between private worlds
closed (fork (c)), the latter in halves. What is not built: the client's bind flow (asking for an
attestation, the name function `spki:`/`dns:`/`ip:` in `client/src/net/attestation.ts`, the
not-owned message for a bind), the shell and gate halves, the development recipe that writes a world's names,
the run over two real hosts, and everything of a browser's bind (the account service's bind route,
the page's half and a certificate for a bare address). On a `world` build no account exists, so `delete_account` and
`request_data_export` cannot be reached by a bound player there; the host owns that data and
deletes rows over SQL, and a player erases their own binding with `unbind_world_account`. The audience-scoped fallback
(tokens from the account issuer addressed to one server, with the official module's audience
check as the single defence and a private host that learns official identities) is not the route:
a verifier builds and fits the budget. Its one untested question is answered: the audience check
holds on the host's HTTP routes.

## 4. Footprint

Modest-machine profile: the host process is confined to the two sibling hardware threads of one
core (as the virtual machine reports the topology) and to 2 GiB of memory with no swap. The machine
under it is a 16-core workstation, so this bounds parallelism and memory only. Clock speed and disk
speed are not modelled: a laptop core is slower than these and its disk slower than this one. One
run on real low-end hardware replaces the profile when one is available. Method, commands and
per-run numbers are in section 7.

Each cell is the median of three runs, with the range of the three in brackets.

| Condition | Runs | Window, min | Peak resident memory, MiB | Resident memory at window end, MiB | CPU, % of one thread | Commit log growth, MiB per hour | Data directory growth, MiB per hour |
|---|---|---|---|---|---|---|---|
| Nobody connected | 3 | 60 | 220.4 (212.9 to 221.4) | 156.2 (153.7 to 164.0) | 0.65 (0.63 to 0.65) | 0.00 (0.00 to 0.00) | 0.01 (0.01 to 0.01) |
| One idle player | 3 | 30 | 220.8 (203.5 to 221.9) | 192.1 (177.7 to 198.7) | 0.89 (0.89 to 0.89) | 1.24 (1.24 to 1.24) | 1.26 (1.26 to 1.26) |
| One walking player | 3 | 30 | 207.5 (198.7 to 210.7) | 173.0 (162.5 to 176.0) | 1.46 (1.43 to 1.47) | 8.21 (8.21 to 8.21) | 8.23 (8.23 to 8.23) |
| Eight walking players | 3 | 30 | 216.4 (214.8 to 219.1) | 184.9 (167.0 to 190.9) | 3.92 (3.92 to 3.92) | 44.99 (44.99 to 44.99) | 45.01 (45.01 to 45.01) |

- *Peak resident memory* is the process's high-water mark since it started. In every run it was
  set while the module was being published, so it does not vary with the condition; *resident
  memory at window end* is what the host held in play. *CPU* is processor time used over the window
  divided by the window: 100 % is one hardware thread busy.
- *Nobody connected*: a world with the module published and no client, ever.
- *One idle player*: the real client in a headless browser, joined, sending no input (0
  move intents sent across the three runs).
- *One walking player* and *Eight walking players*: `mr_load_driver` clients sending one move
  intent every 200 ms, the fastest a character walks; every level report was valid, with all
  clients connected and no intent rejected. The eight-player row is a walking-only floor: the
  driver sends movement and nothing else, and its clients hold only the character subscriptions, so
  a friends server with battles and trades costs more than this.
- A cross-check, one run: the real client walking at the same rate (9,450 intents, none
  rejected) cost 1.34 % of one thread and 8.47 MiB of commit log per hour, against
  1.46 % and 8.21 for the driver.

**What the numbers say.**

- With nobody connected the host wrote no commit log in any run; its data directory grew only by
  log files. The only reducer that ran was the heartbeat, once a minute (61 calls
  per host by the end, from each host's own counters).
- A connected player who stands still is not free: the movement tick runs five times a second
  while anyone is in a zone, and each tick commits a transaction, about 72
  bytes of commit log each, 1.24 MiB an hour.
- Walking writes 8.21 MiB an hour for one player and 44.99 for eight. No run
  saw the commit log shrink, and the host wrote one snapshot when the world was created and none
  in the window after it, so within the time measured a world's disk use grows by this much for
  every hour played. What a later snapshot changes was not observed.
- Resident memory at the end of a window was never more than 2 % above its value at the start, and
  no host's scope peaked above 202 MiB of the 2048 allowed.
- The three runs of a condition agree within 4 % on CPU and on commit-log growth.

Start-up, from the host process starting to the client's first frame with its own character drawn:

| Path | Runs | Host answers, ms | Module published, ms | Page navigation to that frame, ms | Process start to that frame, ms |
|---|---|---|---|---|---|
| Open an existing world, returning player | 3 | 95 (90 to 101) | none | 422 (418 to 425) | 538 (536 to 551) |
| Open an existing world, new player | 3 | 98 (96 to 98) | none | 353 (349 to 366) | 472 (470 to 487) |
| Create a world | 3 | 115 (104 to 120) | 1179 (1174 to 1186) | 331 (315 to 397) | 1651 (1628 to 1718) |

- *Open an existing world, returning player*: the data directory already holds the world and the
  page starts with the player's reconnect token in session storage, so the same identity resumes
  (each run checked that it did). This is the launch a player repeats once a shell carries the
  token (section 3).
- *Open an existing world, new player*: the same world, a fresh browser context, so a new player
  joins.
- *Create a world* starts from an empty data directory and publishes the module before the client
  loads; the publish is most of it.
- The browser process was already running, the page was served from loopback by `vite preview`,
  and the files were in the page cache. A desktop shell adds its own start to these. The
  one-minute load average during these runs was between 0.2 and 0.6.

## 5. What the host sends off the machine

**Result.** In this run the standalone host attempted no connection off the machine. From before
its process started, through start-up and 65 minutes, the capture recorded no name lookup and no
packet addressed off the machine.

Observed window: 65 minutes, from before the host process started.

**Method.** A packet capture in a network namespace built for the purpose. The namespace has a
loopback interface and one dummy interface that holds the IPv4 and IPv6 default routes, so any
packet addressed off the machine is sent to the dummy interface, and the resolver named in
`/etc/resolv.conf` is itself off the machine, so a name lookup is such a packet. A capture on a raw
packet socket recorded every frame on every interface for the whole run; only loopback TCP to and
from the host's own port was counted without being logged. It wrote a count line every 60 seconds:
65 of them across the window, never more than 61 seconds apart.

Inside the namespace ran the capture, the host, `curl` (the module publish over the HTTP API, and
the controls below) and one `mr_load_driver` client. A capture cannot say which process sent a
frame, so the result rests on there being no frame to attribute. The host ran across its start-up
on an empty data directory, two minutes with nothing published, the publish, ten minutes of the
driver walking, and then with nobody connected. The capture saw 14,868 loopback packets on the
host's own port and no other frame.

A positive control closed the window, to show the capture sees an attempt: a TCP connection to a
public IPv4 address, a name lookup, and a TCP connection to a public IPv6 address, each made on
purpose and each recorded on the dummy interface (3, 4 and 3 frames).

What the method does not see: an attempt that fails before a packet is built (a socket bound to a
device that does not exist); what a host would send after a first contact succeeded, since here
none could; and frames the capture socket dropped, whose counter was not read (the run carried
about 4 packets a second).

**What makes a host call out.** Three things, none of which happened in the window above:

- *A token naming another issuer.* Presented, after the window, with a token whose `iss` was
  `https://lpg0-issuer.example.org`, the host looked that name up (4 lookup packets captured; the
  request was answered 401) and its
  log names the URL it tried, `/.well-known/openid-configuration` under that issuer. The host has
  no list of allowed issuers: any `http` or `https` issuer named in a token is fetched
  (`crates/core/src/auth/token_validation.rs`, lines 233 to 240 and 420). So a client decides
  where a host connects. A host's own tokens name "localhost" and the local-play plan offers these
  worlds no account token, so a client built to that plan does not cause it; anyone who can reach
  a friends server's port can.
- *A module that asks.* Procedures may make outbound HTTP requests unless the host's `config.toml`
  sets `[module-http] enabled = false`. This module defines no procedure.
- *The command-line tool*, which is a different program from the host and was kept out of the
  namespace. It was not observed.

The host listens on every interface unless told otherwise (`--listen-addr` defaults to
`0.0.0.0:3000`); a single-player world passes a loopback address.

## 6. Budgets

Absolute numbers for the modest-machine profile of section 4, measured with the method of
section 7. Each derives from a median reported above and is at most twice it. A budget is compared
only with a run on the same profile, by the same method, in the condition its row names; work that
changes what the host does per tick, per connection or at start-up re-measures and holds these.

| Budget | Median it derives from | Budget | Unit | Headroom |
|---|---|---|---|---|
| Single-player world: memory, peak since the server started | 220.8 | 330 | MiB | 1.49 times the median |
| Single-player world: idle CPU, the player standing still | 0.89 | 1.4 | % of one thread | 1.57 times the median |
| Single-player world: start-up to playable, opening an existing world | 538 | 800 | ms | 1.49 times the median |
| Single-player world: disk growth, the player walking without pause | 8.23 | 12 | MiB per hour | 1.46 times the median |
| Friends server: memory, peak since the server started | 216.4 | 330 | MiB | 1.52 times the median |
| Friends server: idle CPU, nobody connected | 0.65 | 1.0 | % of one thread | 1.54 times the median |
| Friends server: start-up to playable, opening an existing world | 538 | 800 | ms | 1.49 times the median |
| Friends server: disk growth, eight players walking | 45.01 | 68 | MiB per hour | 1.51 times the median |

- *Memory* is peak resident memory since the host started, world creation included. Creation sets
  the peak today in both rows, so this budget bounds what the host ever holds and does not bound
  growth in play: resident memory at window end (section 4) is the number that shows that.
- *Idle CPU* for a single-player world is the player standing still, the idle such a world has;
  for a friends server it is the host with nobody connected, an always-on server's idle.
- *Start-up to playable* is the same host and module for both, so both rows derive from "Open an
  existing world, returning player". It excludes the shell's own start.
- *Disk growth* is the whole data directory. The friends-server row, like its memory row, comes
  from the walking-only floor: it is the least a friends server needs, to be set again when
  battles and trades are measured.

## 7. Method

**Machine.** AMD Ryzen 9 9950X (16 cores, 32 hardware threads), 45 GiB visible, Ubuntu 24.04.4
under WSL2 (kernel 6.18.33.2), data on ext4 over a virtual disk. Other work ran on the machine
during the runs; the one-minute load average over the windows was 5.8 (median) and
23.0 (highest), on 32 threads.

**Software.** `spacetimedb-standalone` 2.11.0 (sha256 `71b5cff7…a72729`), started directly, not
through the `spacetime` command-line tool. The module is `monster_realm_module.wasm` from
`spacetime build --module-path server-module` at commit `0e7a089d` (2.9 MiB, not run through
`wasm-opt`). The load driver is `cargo build --release -p sim-harness --bin mr_load_driver`. The
browser client is `vite build` of `client/` with the development hooks kept (`NODE_ENV=development`,
`--mode development`) so `window.__game()` reports what was drawn, served by `vite preview`, in
Playwright's Chromium 149, headless.

**Constraints.** Each host ran in its own systemd scope with a memory limit, pinned to one core's
two threads; every driver, browser and web server was pinned to six other threads:

```sh
systemd-run --user --scope --unit=<run> -p MemoryMax=2G -p MemorySwapMax=0 \
  taskset -c <a>,<a+1> spacetimedb-standalone start --data-dir <run>/data \
  --jwt-key-dir <run>/keys --listen-addr 127.0.0.1:<port> --non-interactive
curl -X POST http://127.0.0.1:<port>/v1/identity            # the owner's token
curl -X PUT http://127.0.0.1:<port>/v1/database/lpg0 -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/wasm" --data-binary @monster_realm_module.wasm
mr_load_driver --run-id <run> --server http://127.0.0.1:<port> --db lpg0 --clients-start <n> \
  --clients-step 1 --clients-max <n> --hold-scrapes 64 --scrape-interval-ms 30000 --move-rate 5
```

**Runs.** Thirteen hosts ran at once, each on its own core with its own fresh data directory:
three per condition and the one cross-check. A run is: start the host, publish, start the load,
wait 60 seconds, then the window. The three runs of a condition are therefore concurrent, not
consecutive. The eight-client driver ran more threads than the six it was pinned to and says so in
its report; its level was valid and its send count matched its rate.

**Sampling.** Every 5 seconds: resident memory and its high-water mark from `/proc/<pid>/status`,
processor time from the scope's `cpu.stat`, and the apparent size of each part of the data
directory (`replicas/1/clog` is the commit log). The window is a span of samples: from the first
sample after the 60-second wait to the first sample a full 60 minutes (nobody connected) or
30 minutes (every other condition) later. The driver also reads the host's `/v1/metrics` every
30 seconds, which the walking rows therefore include.

**Start-up.** One script per run: start the host as above and note the time; poll `/v1/ping` every
5 ms until it answers; open the page in a new browser context; wait, checking every animation
frame, until `window.__game().rendered` contains the player's own entity. "Create a world" publishes
before opening the page. Both "Open an existing world" paths reuse the first created world's data
directory; the returning-player path writes that run's session-storage entries into the new
context before any page script runs and checks that the identity is the first run's.

**Off-machine capture.** `unshare -Urn`, then inside it: `ip link add dummy0 type dummy`, IPv4 and
IPv6 addresses and default routes on it, router solicitations off, the capture (a Python
`AF_PACKET` socket over all interfaces), then the host, started directly and not pinned. The
capture's log holds a line per frame that is not loopback traffic on the host's port, and a count
line per minute.

**Per-run numbers.**

| Run | Condition | Window, s | Memory at window start, MiB | Memory at window end, MiB | Highest in window, MiB | Peak since start, MiB | Scope memory peak, MiB | CPU, % of one thread | Highest CPU over any 60 s, % | Commit log, MiB per hour | Log files, MiB per hour | Data directory, MiB per hour | Data directory at end, MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 | Nobody connected | 3600 | 153.8 | 153.7 | 153.9 | 221.4 | 201.3 | 0.63 | 1.01 | 0.00 | 0.015 | 0.01 | 19.4 |
| E2 | Nobody connected | 3600 | 169.9 | 164.0 | 170.0 | 212.9 | 193.0 | 0.65 | 0.96 | 0.00 | 0.015 | 0.01 | 19.4 |
| E3 | Nobody connected | 3600 | 156.2 | 156.2 | 156.3 | 220.4 | 195.7 | 0.65 | 1.14 | 0.00 | 0.015 | 0.01 | 19.4 |
| I1 | One idle player | 1800 | 218.1 | 198.7 | 218.1 | 221.9 | 197.7 | 0.89 | 1.36 | 1.24 | 0.015 | 1.26 | 20.0 |
| I2 | One idle player | 1800 | 210.9 | 177.7 | 211.0 | 220.8 | 198.3 | 0.89 | 1.34 | 1.24 | 0.015 | 1.26 | 20.0 |
| I3 | One idle player | 1800 | 199.9 | 192.1 | 200.0 | 203.5 | 180.0 | 0.89 | 1.32 | 1.24 | 0.015 | 1.26 | 20.0 |
| W1 | One walking player | 1800 | 175.6 | 176.0 | 177.4 | 198.7 | 178.1 | 1.47 | 2.08 | 8.21 | 0.015 | 8.23 | 23.6 |
| W2 | One walking player | 1805 | 196.1 | 173.0 | 196.5 | 210.7 | 185.8 | 1.43 | 1.94 | 8.21 | 0.015 | 8.23 | 23.6 |
| W3 | One walking player | 1800 | 181.7 | 162.5 | 181.7 | 207.5 | 185.4 | 1.46 | 2.04 | 8.21 | 0.015 | 8.23 | 23.6 |
| F1 | Eight walking players | 1800 | 196.9 | 190.9 | 197.8 | 214.8 | 192.9 | 3.92 | 4.79 | 44.99 | 0.015 | 45.01 | 42.6 |
| F2 | Eight walking players | 1800 | 187.0 | 167.0 | 188.1 | 219.1 | 197.7 | 3.92 | 5.12 | 44.99 | 0.015 | 45.01 | 42.6 |
| F3 | Eight walking players | 1800 | 196.2 | 184.9 | 197.1 | 216.4 | 194.4 | 3.92 | 4.86 | 44.99 | 0.015 | 45.01 | 42.6 |
| WR | One walking player, real client | 1805 | 201.9 | 172.0 | 202.0 | 212.2 | 192.6 | 1.34 | 1.85 | 8.47 | 0.015 | 8.49 | 23.7 |

Start-up, per run, in milliseconds:

| Path | Run | Host answers | Module published | Page navigation to frame | Process start to frame |
|---|---|---|---|---|---|
| Open an existing world, returning player | 1 | 101 | none | 425 | 551 |
| Open an existing world, returning player | 2 | 90 | none | 422 | 536 |
| Open an existing world, returning player | 3 | 95 | none | 418 | 538 |
| Open an existing world, new player | 1 | 96 | none | 353 | 472 |
| Open an existing world, new player | 2 | 98 | none | 349 | 470 |
| Open an existing world, new player | 3 | 98 | none | 366 | 487 |
| Create a world | 1 | 115 | 1174 | 397 | 1718 |
| Create a world | 2 | 104 | 1186 | 315 | 1628 |
| Create a world | 3 | 120 | 1179 | 331 | 1651 |

**In-module signature check (section 3).** Measured on 2026-11-21 on the same machine, host binary
and confinement: one systemd scope of 2 GiB per host, the host on the two threads of one core, the
driver on six others. The module is this repository's at commit `5ceb483e` with one more reducer,
built with `cargo build --release --target wasm32-unknown-unknown` under rustc 1.99.0 and not run
through `wasm-opt`. Four variants: `p256` 0.14.0 (`default-features = false`, feature `ecdsa`);
`ed25519-dalek` 3.0.0 (`default-features = false`), and again with `fast`; and a control whose
reducer decodes the token and makes no signature check. The reducer takes a count, a token and a
public key, runs the check that many times, wraps each check in a `LogStopwatch` span (the host
times it and writes it to the module log), and logs how many checks accepted. The driver calls it
through `POST /v1/database/<db>/call/<reducer>` with a count of 101 and reads that call's 101 spans
from `GET /v1/database/<db>/logs`. The tokens are compact JWTs of 531 bytes carrying the
attestation route's claims (`iss`, `sub`, `aud`, `nonce`, `mr_ent`, `iat`, `exp`, `jti`), signed by
Node 24's `crypto`. Two passes ran the variants in opposite orders, each variant on a fresh host and
data directory, five calls per token per pass; the one-minute load average was 0.41 to 0.78. The
one-check-per-call, token-length and `precomputed-tables` runs used the same driver, with five
calls of 101 checks per length, at a load average of 0.95 to 1.58. Sizes are the size of
`monster_realm_module.wasm`; the one-codegen-unit builds set
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1`. The reducer and the driver are not in this repository.

Per call, the median of its 101 checks of the valid token, in microseconds; calls 1 to 5 are the
first pass. The host's own figures follow: its duration for the whole call (median of the ten), and
its energy counter for a call divided by 101, which was the same in every call.

| Variant | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | Whole call, µs | Energy per check, millions |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| No signature check | 0.2 | 0.2 | 0.2 | 0.3 | 0.2 | 0.2 | 0.3 | 0.2 | 0.3 | 0.3 | 119.5 | 0.006 |
| ES256 | 594.8 | 601.9 | 585.7 | 598.7 | 587.9 | 600.4 | 606.1 | 588.4 | 591.7 | 587.1 | 63,950.5 | 12.30 |
| Ed25519 | 109.2 | 125.1 | 111.3 | 110.3 | 114.7 | 106.6 | 107.4 | 107.6 | 107.5 | 107.4 | 13,597 | 4.02 |
| Ed25519 with `fast` | 104.1 | 104.9 | 104.6 | 104.2 | 104.6 | 103.8 | 104.3 | 104.0 | 103.8 | 104.8 | 13,019.5 | 3.72 |

The slowest single check of the 1,010 per variant took 3,354.8 µs (ES256) and 546.4 µs (Ed25519).

One check per reducer call, over three fresh hosts and eleven calls each: 621.8 µs (579.9 to 820.4)
with ES256 and 138.5 µs (118.2 to 190.8) with Ed25519. The first call after a publish took 610.5 to
690.3 µs and 141.8 to 190.8 µs. The host reported 657 µs and 177 µs for the whole call, against 37
µs for a call that checks nothing.

Against token length, the longer tokens signed over an added padding claim and every one accepted,
the median of five calls' medians in microseconds:

| Token length, bytes | ES256 | Ed25519 |
|---|---|---|
| 531 | 609.9 | 110.4 |
| 4,098 | 640.6 | 133.1 |
| 65,538 | 1,271.4 | 557.7 |
| 262,146 | 3,195.8 | 1,922.8 |
| 1,048,578 | 11,137.7 | 7,393.9 |

The 5 ms crossings (about 430 KiB and 688 KiB) are a straight line between the last two rows. The
largest argument was probed with one call per size to the reducer with no check, on a host that was
not confined: a token of 1,572,863 bytes was taken, and one of 2,097,151 bytes was refused with
HTTP 413.

**Access measurements (section 3).** Measured on 2026-11-21 on the same machine and host binary,
each host started directly on a loopback port with a data directory and a key directory of its own,
not confined. Every request is plain HTTP from Node 24
(`fetch`, and its WebSocket client with the `v1.json.spacetimedb` protocol). None of the drivers or
the probe module is in this repository.

*The wrong-audience token.* The rig is a copy of `evals/account-e2e.eval.mjs` with one import path
made absolute and its rig functions exported: its stub issuer (two ES256 issuers on one loopback port), its
token minting, and its patches to a copy of this repository at commit `d6d80547`, which set
`ALLOWED_ISSUERS` to the stub's first issuer and `ALLOWED_AUDIENCE` to `mr-acct-e2e-client`. The
patched module was built with `cargo build --release --target wasm32-unknown-unknown` and published
over the HTTP API to a fresh host. Four tokens: the listed issuer with the listed audience; the
listed issuer and key with the audience `mr-acct-e2e-wrong-aud`; the stub's second issuer; and a
token the host minted at `POST /v1/identity`. Each token was sent in three rounds, in each of two
runs on two fresh hosts: one `call` of `join_game`, two `sql` statements (`SELECT * FROM
module_info`, `SELECT * FROM player`), one `GET /schema`, one MCP `tools/list` request, and one
WebSocket in the first round; the second run added one call of the MCP `sql` tool and one of its
`call` tool per round. For the wrong-audience token:

| Route | Requests in run 1 | Requests in run 2 | Every answer |
|---|---|---|---|
| `call` | 3 | 3 | 403 |
| `sql` | 6 | 6 | 403 |
| MCP `sql` tool | 0 | 3 | an error result |
| MCP `call` tool | 0 | 3 | an error result |
| WebSocket | 1 | 1 | closed with no message |

That is 10 refusals in run 1 and 16 in run 2, and the module's log held 10 and 16 `unrecognized
audience` rejections (each written twice, once by the module and once by the host). The three other
tokens were answered 200 on every `call` and `sql` request, and their WebSockets stayed open. The
twelve `GET /schema` requests and the twelve `tools/list` requests of each run were answered 200
for every token: neither runs the connect reducer.

*The admission probe.* A module of one file built against `spacetimedb` 2.11.0, in five variants
chosen by cargo features: the connect reducer refusing an unadmitted identity, and four with a row
filter (`unstable`): on the private admission table; on a public admission table with its own
filter; the same with no `WHERE` in the outer filter; and on a public admission table with no
filter. One driver per variant, on a fresh host: publish, create a joiner identity at
`POST /v1/identity`, then the steps of the table in section 3, with a WebSocket held open across
the admission and the removal. The step that calls a reducer, runs a one-off query and subscribes
again on a socket after the removal of its admission ran in a second pass, with the same module
and a copy of the driver.

*Two smaller checks.* `spacetime publish` and `spacetime generate` refuse a `--features` argument
of their own and take `--build-options`, which they pass to the build; `spacetime build` takes
`--features` (the CLI at 2.11.0, argument parsing only, against a path that does not exist). A
static placed in a named link section appears in a `wasm32-unknown-unknown` artefact (a crate of
one file, rustc 1.99.0).

**Browser bind measurements (section 3).** Measured on 2026-11-22 on the same machine; none of the
scripts is in the repository.

*The name rule.* A prototype of the bind route's name derivation, one file, run under Node 24.22.0
(the account service's runtime) over 74 return addresses and six database names, printing for each
the URL parser's own origin and the name signed or the reason for refusal. Its public-suffix test
was a stand-in of seven suffixes, and its address test a hand-written table of the special-purpose
blocks; the built route takes both from the published lists. It was run three times, and a copy of it once by the red-team over more addresses: the first
run's table of blocks held `::ffff:0:0/96`, which `net.BlockList` matched against every IPv4
address; the red-team's copy signed four IPv6 addresses outside `2000::/3` and seven hosts with a
character no host name holds (`*`, `$`, `_`, `!`, `'`, `,`, `{`); the third run, with the rule
tightened, is the one reported. An
`xn--` label that is not valid Punycode (`xn--a.example.com`) is still signed: Node's
`domainToUnicode` passes it through.

*The browser.* Playwright 1.61.1 driving its headless Chromium 149.0.7827.55 against loopback HTTP
servers that stood in for the account service, a gate, a third site and a hostile page: a form
posted across origins, and the same post from pages with each of four `Referrer-Policy` values; a
303 whose `Location` carries a fragment; a return path that redirects; a window opened by a
hostile page, with and without `Cross-Origin-Opener-Policy`; one origin held first by a server
that registers a service worker and writes `localStorage`, then by another; and, in a run with no
worker, one origin held first by a server that serves a page cacheable for a year, then by
another. The history row used the full Chromium of the same version in its headless mode
with a profile on disk, and read the profile's `History` database afterwards; the attestation was
found in two more files of the profile, `segmentation_platform/ukm_db` and a disk-cache entry for
the redirect, which the stand-in account service did not mark `no-store` as the route does. Loopback origins
differ by port and share a site, and nothing was run over TLS, in Firefox or in Safari.

**What was not measured.** A battle, a trade or any load but walking; more than eight players; a
session longer than an hour, so growth of the world's own tables with play and anything a later
snapshot does; real low-end hardware; either shell's memory; the Steam overlay; the command-line
tool's network use; the in-module signature check on any other machine; the largest reducer
argument a WebSocket call carries; an Ed25519 key in any key service, and a JOSE library writing
either `alg` name (read, not tried); the access design of section 3 beyond the module half of fork (a), which is measured above (its gate half and forks (b), (c) and (e) are unmeasured);
what a row filter costs a subscription; a host version other than 2.11.0 on any access
measurement; whether the ownership features leave the schema and the generated bindings
unchanged; and, of a browser's bind, anything end to end (no part of it is built), any browser but
Chromium, an ACME order for an IP address, what Steam's sign-in pages do with an opener, and when
a browser drops a service worker whose script has stopped answering.
