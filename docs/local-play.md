# Local play: licence, shell, sign-in and footprint

What is known and measured about running Monster Realm as a single-player world on the player's
machine and as a server a player hosts for friends: the SpacetimeDB licence state, the desktop
shell, the sign-in design's questions, what one host costs, what it sends off the machine, and the
budgets work on local play holds. It was read and measured on 2026-11-14 against SpacetimeDB 2.11.0
(the version this repository pins) and the module and client built from commit `0e7a089d`. The two
decisions drawn from it are in [`DECISIONS.md`](DECISIONS.md): "The desktop shell is Electron" and
"Local-play budgets".

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
  the HTML document is run", on every top-level navigation). Launcher: it serves the document as a
  classic script ahead of the module script, the delivery the local-play plan gives the browser
  build.
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

The local-play plan has the client read the document as own properties of the global,
synchronously at module scope; this hook meets that contract, and the page cannot replace the
global. With `contextIsolation: false` a preload that assigns the global directly has the same
timing and an ordinary writable property; the isolated form is the one to use.

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
"measured" means observed on a 2.11.0 standalone host on 2026-11-14.

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

**Open.** No account issuer is deployed (`ALLOWED_ISSUERS` in `server-module/src/accounts.rs` is a
placeholder), so this is a requirement on the issuer that gets chosen, not a fact about
SpacetimeDB. SpacetimeDB puts nothing in the way: a host verifies a token from any issuer whose
discovery document it can fetch, and a module reads every claim. The attestation the design needs
is a signed token with its own issuer name and signing key (neither trusted by the official
server), an audience naming one world, a nonce the world chose, and a lifetime of minutes; what
else it must name is the relay question below.

**What would answer it.** Choosing the account issuer, then checking it for a token type with a
separate key and issuer name: a custom token endpoint or OAuth token exchange (RFC 8693). An issuer
that has none still fits the design behind a small attestation endpoint that takes the account's
token and signs the attestation itself; that endpoint is then part of the account service.

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
  or token API, so the verifier is a pure-Rust one compiled into the module with the attestation
  key as module data. A reducer cannot fetch keys; a procedure can make HTTP requests
  (`crates/bindings/src/http.rs`), which a world that must work offline cannot depend on. Key
  rotation is therefore a module or content update.

One part is open: what a signature check costs inside a reducer, and whether a verifier builds for
the module's wasm target without a clock or randomness. A spike answers it before the sign-in work
is elaborated: an ES256 or Ed25519 verifier in the module, one verify timed on the host.

**Rests on.** `crates/core/src/auth/token_validation.rs` lines 211 to 240 (the key cache and fetch);
`crates/bindings/src/http.rs` (procedure HTTP); measured: a token naming an unreachable issuer made
the host look the issuer up and answer 401 about ten seconds later (section 5).

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
module runs on every server, the official one included. So the design needs a rule that does not
exist in code: the official server refuses attestation binding outright and takes accounts only as
connection tokens from the account issuer. With that rule nothing a private host holds reaches an
account on the official server.

Replay to another private world is a separate question, and the design has to close it before a
private server sees a real attestation. An audience and a nonce do not close it: a hostile host can
have its player's client fetch an attestation addressed to another world, carrying that world's
nonce, and present it there as its own. Naming the player's identity in the attestation does not
close it either: every standalone host calls itself "localhost", and a hostile operator holds its
host's signing key and can sign any subject with it, so its player can be given the identity the
operator holds on the other world. The attestation has to name something a hostile host cannot
forge, such as the key that verifies the client's own world token, checked by the client before it
asks. Two parts of that direction are open: a module cannot read its own host's verifying key (a
reducer cannot call `GET /v1/identity/public-key`), and a hostile host that proxies the other
world hands the client a genuine token from it. That is LP6's to design and test.

**Audience-scoped fallback.** Refused at the WebSocket connection, by one check, and only for a
token whose audience list holds no official audience. The private host holds a token from the
account issuer whose audience names the private server. The official host accepts it (it does not
check `aud`), and the official module disconnects it at connect because the issuer is listed and
the audience is not (`provision_or_touch_account`; the wrong-audience control in
`evals/account-e2e.eval.mjs` runs this live over a WebSocket). Three weaknesses:

- `audience_allowed` passes a token if any entry of its audience list is listed, so the issuer must
  never mint one token for both a private server and the official audience.
- The check runs in the connect reducer. Whether a token presented on the host's HTTP routes
  (`/v1/database/<db>/call/<reducer>`, `/v1/database/<db>/sql`) meets it was not tested. One
  wrong-audience token sent to those two routes, with the issuer rig `account-e2e` builds, would
  answer it.
- The token carries the account's official identity, so the host learns which official player
  joined.

The account token the client is built to send is this fallback's dangerous case: its audience is
the build-wide client id, which the official server accepts. That is why the local-play plan
offers no account token to a single-player or friends world.

### What identifies a player between launches

Nothing yet. The client keeps the anonymous reconnect token in per-tab session storage
(`client/src/net/authToken.ts`): it survives a reload, not a closed tab. An app that starts with
empty session storage joins as a new player, and the character from the last launch is out of
reach. Measured: three launches against one world, each with a fresh browser context, made three
players; with the first launch's session-storage entry written back before the page's scripts ran,
three more launches each resumed the first identity. A single-player world needs the shell to
carry that token across launches, or the account binding above, before a second launch finds the
first launch's character.

### The design later work elaborates against

The own-issuer design, with the attestation verified as a reducer argument under the world's own
anonymous token. LP4 (sign in once, then offline) and LP6 (private-server access) elaborate against
it. It holds on four conditions this record leaves open: the in-module verifier spike; an account
issuer (or an endpoint beside it) that can sign the attestation; the official server refusing
attestation binding; and the relay between private worlds closed. If the spike fails, the fallback
is audience-scoped tokens with the official module's
audience check as the single defence, its HTTP-route question answered first, and a private host
then learns official identities.

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

**What was not measured.** A battle, a trade or any load but walking; more than eight players; a
session longer than an hour, so growth of the world's own tables with play and anything a later
snapshot does; real low-end hardware; either shell's memory; the Steam overlay; the command-line
tool's network use; the official module's audience check on the host's HTTP routes; an in-module
signature verifier.
