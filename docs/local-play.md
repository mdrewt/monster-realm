# Local play: licence, shell, sign-in and footprint

What is known and measured about running Monster Realm as a single-player world on the player's
machine and as a server a player hosts for friends: the SpacetimeDB licence state, the desktop
shell, the sign-in design's questions, what one host costs, what it sends off the machine, and the
budgets work on local play holds. Everything here was read or measured on 2026-11-14 against
SpacetimeDB 2.11.0 (the version this repository pins) and the module and client built from commit
`0e7a089d`. The two decisions drawn from it are in [`DECISIONS.md`](DECISIONS.md): "The desktop
shell is Electron" and "Local-play budgets".

The local-play plan's milestones are named here by their plan labels: LP2 (desktop shell with the
bundled server), LP3 (worlds), LP4 (sign in once, then offline), LP5 (open to friends), LP6
(private-server access) and LP7 (standalone server package).

## 1. Licence state

This section states what the licence files say and what is open. It adopts no reading of what the
licence permits; that is the operator's negotiation with the licensor.

| | Text read on 2026-11-12 | Host this repository pins |
|---|---|---|
| Source | `LICENSE.txt` on the SpacetimeDB repository's default branch | `LICENSE.txt` at tag `v2.11.0` |
| Licence | Business Source License 1.1 | Business Source License 1.1 |
| Licensor | Clockwork Laboratories, Inc. | Clockwork Laboratories, Inc. |
| Licensed Work | SpacetimeDB 2.16.0 | SpacetimeDB 2.11.0 |
| Change Date | 2031-11-10 | 2031-09-15 |
| Change License | GNU Affero General Public License v3.0 with a linking exception | the same |

- **The two texts differ only in the version and the Change Date** (compared byte for byte on
  2026-11-14). 2.16.0 is the default branch's version and has no release tag; the newest release,
  v2.15.0 of 2026-11-10, carries the Change Date 2031-11-05. Each release converts on its own date:
  the 2.11.0 host this repository pins converts on 2031-09-15, the text read on 2026-11-12 on
  2031-11-10.
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
  grant counts them is the question the negotiation exists to settle.
- **The conversion.** On a release's Change Date that release becomes available under the GNU
  Affero General Public License v3.0 with a linking exception. The exception is two additional
  permissions appended to the AGPL text in the same file: one to convey a work made by linking or
  combining with SpacetimeDB, one lifting the requirement of AGPL section 13 to offer the source to
  users who interact with a modified version over a network.
- **Other parts carry other licence files.** The repository's licence says a subdirectory's own
  `LICENSE` governs that subdirectory. At `v2.11.0` the host's crates (`crates/standalone`,
  `crates/core`, `crates/client-api`) and the command-line tool point their `LICENSE` at
  `licenses/BSL.txt`. The module bindings crate (`crates/bindings`, published as `spacetimedb`) and
  the libraries under it (`crates/lib`, `crates/sats`) point theirs at `licenses/apache2.txt`, while
  crates.io lists the published crate's licence as "non-standard". The TypeScript SDK's
  `package.json` says `ISC`.
- **Negotiation.** The operator has been negotiating terms with the licensor since 2026-11-12. No
  terms are recorded yet.
- **What waits on it.** LP2 (a desktop build that ships the host inside the game) and LP7 (a
  standalone server package) wait on the negotiated terms. Nothing else in the local-play plan
  distributes the host. If the terms do not allow bundling, the desktop shell connects to a server
  the player installs separately; that changes LP2's scope and nothing below.

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

The unweighted totals are level; the weights decide it. Electron leads on the two heaviest
criteria and loses on size.

**What decided each criterion.**

- *Hosts the unchanged web build.* Electron ships its own Chromium (156 in Electron 45.3.2), the
  engine family the e2e suite runs (Chromium 149). Tauri renders in the operating system's webview:
  WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux and the Steam Deck, the last two
  engines no test here runs. The launcher renders in whatever browser the player has. Measured: the
  bundle, unchanged, joined a live server and drew the player's own character inside Electron from
  a custom protocol, and over loopback HTTP in a WebKit build (WebGL2, no `navigator.gpu`) and in
  Firefox 151 (no WebGL2 context in headless mode). That is one boot and join per engine with
  software rendering, not the e2e suite, and the WebKit build is Playwright's, not WebKitGTK as a
  distribution ships it.
- *Page global before module scripts.* Electron: measured (below). Tauri: documented, not run
  (`WebviewBuilder::initialization_script` adds a script "run after the global object has been
  created, but before the HTML document has been parsed and before any other script included by
  the HTML document is run", on every top-level navigation). Launcher: it serves
  `shell-config.js` itself, the browser build's own mechanism.
- *Starts and stops a child server.* Electron and Tauri both spawn a native child and must kill it
  on quit; neither documents what happens to the child when the shell is killed. The launcher
  controls the child fully but cannot tell that the player closed the browser tab.
- *Installer and memory size.* Electron 45.3.2 adds a 151 MiB archive on Windows (118 MiB Linux,
  115 MiB macOS arm64) and unpacks to 274 MB on Linux; Tauri adds nothing on a Windows that has
  WebView2. The bundled server binary is 133 MB whichever shell carries it. Neither shell's idle
  memory was measured.
- *Steamworks and overlay.* Nothing was measured: the measuring machine has no Steam client.
  Electron has a documented route (`steamworks.js`, whose README has the main process call
  `electronEnableSteamOverlay()`) with mixed community reports that it needs GPU flags. Tauri's
  issue about making the Steam overlay work (tauri-apps/tauri issue 6196) is closed as not
  planned. The launcher has no window for the overlay or Steam
  Input to attach to.
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

So the client's read of the document as own properties, at module scope, sees it. The page cannot
replace the global. With `contextIsolation: false` a preload that assigns the global directly has
the same timing and an ordinary writable property; the isolated form is the one to use.

**What the choice rests on that is not measured.** The Steam overlay drawing over an Electron
window on Windows. The first slice of the desktop shell proves it (or shows it cannot be made to
work) before anything else is built on the shell. The judge named it as the one unknown that turns
the result: without an overlay Electron scores 44, level with the launcher and one above Tauri.

## 3. Sign-in

The proposed design: a world's server is its own issuer; the account issuer attests "this account
is valid" to one server, once, and the player's identity in that world comes from the world, never
from the account issuer. The fallback: audience-scoped tokens from the account issuer. The
questions below are answered at SpacetimeDB 2.11.0. Source paths are in the SpacetimeDB repository
at tag `v2.11.0` unless they start with `server-module/` or `evals/` (this repository); "measured"
means observed on a 2.11.0 standalone host on 2026-11-14.

### Which token claims a module can read at connect

**Answer.** All of them. `ctx.sender_auth().jwt()` gives the connection's claims: `subject()`,
`issuer()`, `audience()`, `identity()` and `raw_payload()`, the whole JSON payload, so a custom
claim (a nonce, an expiry, anything an issuer adds) is read by parsing it. It is available in the
connect lifecycle reducer and in every reducer a client calls, and absent in scheduled and `init`
calls. The host has already verified the signature and the expiry (a missing `exp` means no
expiry); it requires only `sub` and `iss` and does not check `aud`, so audience and any other claim
are the module's to check.

**Rests on.** `crates/bindings/src/lib.rs` (`JwtClaims`, `AuthCtx::jwt`; lines 1937 to 2066 of the
published 2.11.0 crate); `crates/core/src/auth/token_validation.rs` lines 141 to 186
(`REQUIRED_CLAIMS`, `validate_aud = false`, the expiry rule). This module reads issuer and audience
at connect (`provision_or_touch_account` in `server-module/src/accounts.rs`), and
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

Two limits shape the design. A host mints only anonymous tokens: no host route and no module API
issues a token for a chosen subject (`POST /v1/identity/websocket-token` re-signs the caller's own
claims for 60 seconds). And a host tries its own key first, then, for any other issuer named in the
token, fetches that issuer's keys (below).

**Rests on.** `crates/standalone/src/subcommands/start.rs` lines 56 to 182 (the key flags);
`crates/client-api/src/auth.rs` line 34 (`LOCALHOST`) and lines 184 to 197 (`SpacetimeAuth::alloc`);
`crates/standalone/src/lib.rs` line 101; `crates/client-api/src/routes/identity.rs` lines 102 to 179;
`crates/core/src/auth/token_validation.rs` lines 98 to 117 (own key first, then the issuer).

### Whether an account issuer can mint an attestation as a second token type

**Open.** No account issuer is deployed (`ALLOWED_ISSUERS` in `server-module/src/accounts.rs` is a
placeholder), so this is a requirement on the issuer that gets chosen, not a fact about
SpacetimeDB. SpacetimeDB puts nothing in the way: a host verifies a token from any issuer whose
discovery document it can fetch, and a module reads every claim. The attestation the design needs
is a signed token with its own issuer name and signing key (neither trusted by the official
server), an audience naming one world, a nonce the world chose, and a lifetime of minutes.

**What would answer it.** Choosing the account issuer, then checking it for a token type with a
separate key and issuer name: a custom token endpoint or OAuth token exchange (RFC 8693). An issuer
that has none still fits the design behind a small attestation endpoint that takes the account's
token and signs the attestation itself; that endpoint is then part of the account service.

### How a world server verifies an attestation

**Answer.** As a reducer argument. Both routes exist at 2.11.0, and only one fits.

- *As the connection token.* The host verifies it: on first sight of the issuer it fetches
  `<iss>/.well-known/openid-configuration` and the issuer's keys (cached, refreshed after 300 s,
  dropped after 7200 s). The module then reads the claims at connect.
  This needs the network from the host's machine whenever the keys are not cached, so it fails the
  offline requirement; it makes the player's identity in that world a function of the attestation
  issuer and subject, the same in every world; and a host cannot exchange a short-lived attestation
  for a token of its own (the limit above), so every session would need a fresh one.
- *As a reducer argument.* The client connects under the world's own anonymous token, which is how
  a single-player or friends world is joined today, and calls a reducer with the attestation. The
  module verifies the signature and checks audience, nonce and expiry itself, then records the
  binding. No network is needed afterwards, and the identity is the world's own. SpacetimeDB gives
  a module no signature or token API, so the verifier is a pure-Rust one compiled into the module
  with the attestation key as module data. A reducer cannot fetch keys; a procedure can make HTTP
  requests (the documentation marks procedures unstable), which a world that must work offline
  cannot depend on. Key rotation is therefore a module or content update.

One part is open: what a signature check costs inside a reducer, and whether a verifier builds for
the module's wasm target without a clock or randomness. A spike in LP4's first slice answers it: an
ES256 or Ed25519 verifier in the module, one verify timed on the host.

**Rests on.** `crates/core/src/auth/token_validation.rs` lines 211 to 240 (the key cache and fetch);
`crates/bindings/src/http.rs` (procedure HTTP) and the documentation page
`spacetimedb.com/docs/functions/procedures`; measured: a token naming an unreachable issuer made
the host look the issuer up and answer 401 about ten seconds later (section 5).

### Can a token a private host receives be replayed to the official server

**Own-issuer design.** No. A private host holds two things. The world's own token is signed by the
private host's key: the official host refuses it (`InvalidSignature`, measured between two hosts).
The attestation is signed under an issuer name the official server does not list: with no
discovery document published for that issuer (the reducer-argument route needs none) the official
host cannot verify it and answers 401; if one is published, the host accepts the connection and
the module treats an unlisted issuer as an anonymous guest whose identity is unrelated to the
account's (`provision_or_touch_account`). Neither token reaches the account. The attestation's
audience and nonce keep it from being replayed to another world, which is that world's check to
make.

**Audience-scoped fallback.** Refused, by one check. The private host holds a token from the
account issuer whose audience names the private server. The official host accepts it at the
connection (it does not check `aud`), and the official module disconnects it because the issuer is
listed and the audience is not (`audience_allowed` in `server-module/src/accounts.rs`; the
wrong-audience control in `evals/account-e2e.eval.mjs` runs this live). The whole defence is that
one allow-list, and the token carries the account's official identity, so the host learns which
official player joined. The account token in use today is this fallback's dangerous case: its
audience is the build-wide client id, which the official server accepts. That is why no account
token is offered to a single-player or friends world.

### The design later work elaborates against

The own-issuer design, with the attestation verified as a reducer argument under the world's own
anonymous token. LP4 (sign in once, then offline) and LP6 (private-server access) elaborate against
it. It holds on two conditions this record leaves open: the in-module verifier spike, and an
account issuer (or an endpoint beside it) that can sign the attestation. If the spike fails, the
fallback is audience-scoped tokens with the official module's audience check as the single
defence, and a private host then learns official identities.

## 4. Footprint

Modest-machine profile: the host process is confined to the two hardware threads of one physical
core and to 2 GiB of memory with no swap. The machine under it is a 16-core workstation, so this
bounds parallelism and memory only. Clock speed and disk speed are not modelled: a laptop core is
slower than these and its disk slower than this one. One run on real low-end hardware replaces the
profile when one is available. Method, commands and per-run numbers are in section 7.

Each cell is the median of three runs, with the range of the three in brackets.

| Condition | Runs | Window, min | Peak resident memory, MiB | Resident memory at window end, MiB | CPU, % of one core | Commit log growth, MiB per hour | Data directory growth, MiB per hour |
|---|---|---|---|---|---|---|---|
{{ROW_EMPTY}}
{{ROW_IDLE1}}
{{ROW_WALK1}}
{{ROW_WALK8}}

- *Peak resident memory* is the process's high-water mark since it started, so it includes
  publishing the module, which is where the peak falls. *CPU* is processor time used over the
  window divided by the window, as a share of one hardware thread.
- *Nobody connected*: a world with the module published and no client, ever.
- *One idle player*: the real client in a headless browser, joined, sending no input.
- *One walking player* and *Eight walking players*: `mr_load_driver` clients sending one move
  intent every 200 ms, the fastest a character walks. The eight-player row is a walking-only floor:
  the driver sends movement and nothing else, and its clients hold only the character
  subscriptions, so a friends server with battles and trades costs more than this.
- A cross-check, one run: the real client walking at the same rate cost {{WR_CPU}} % of one core
  and {{WR_CLOG}} MiB of commit log per hour, so the driver stands in for a real client's walking
  load.

**What the numbers say.**

- With nobody connected the host runs one heartbeat reducer a minute and writes no commit log; the
  growth in its data directory is log files.
- A connected player who stands still is not free: the movement tick runs five times a second
  while anyone is in a zone, and each tick commits a transaction, about {{IDLE_BYTES_PER_TICK}}
  bytes of commit log each, {{IDLE_CLOG}} MiB an hour.
- Walking writes {{WALK1_CLOG}} MiB an hour for one player and {{WALK8_CLOG}} for eight. Nothing
  compacts the commit log; the host took no snapshot in any run, so a world's disk use grows by
  this much for every hour played.
- Memory is flat or falling over every window; no run approached the 2 GiB limit.

Start-up, from the host process starting to the client's first frame with its own character drawn:

| Path | Runs | Host answers, ms | Module published, ms | Page navigation to that frame, ms | Process start to that frame, ms |
|---|---|---|---|---|---|
{{ROW_OPEN}}
{{ROW_CREATE}}

- *Open an existing world* is the launch a player repeats: a data directory that already holds the
  world, and a browser profile that already holds the player's reconnect token.
- *Create a world* starts from an empty data directory and publishes the module before the client
  loads; the publish is most of it.
- The browser process was already running; the page was served from loopback by `vite preview`;
  the files were in the page cache. A desktop shell adds its own start to these.

## 5. What the host sends off the machine

**Result.** {{NET_RESULT}}

Observed window: {{NET_MINUTES}} minutes, from before the host process started.

**Method.** A packet capture in a network namespace built for the purpose. The namespace has a
loopback interface and one dummy interface that holds the IPv4 and IPv6 default routes, so any
packet addressed off the machine is sent to the dummy interface, and the resolver named in
`/etc/resolv.conf` is itself off the machine, so a name lookup is such a packet. A capture on a raw
packet socket recorded every frame on every interface for the whole run and wrote a count every
60 seconds; only loopback TCP to and from the host's own port was counted without being logged.
The host ran inside the namespace across its start-up on an empty data directory, two minutes with
nothing published, the module publish (over the HTTP API, with `curl`, so no other program was in
the namespace), ten minutes of one `mr_load_driver` client walking, and then with nobody connected.
The capture saw: {{NET_CAPTURE_SUMMARY}}

A positive control closed the run, to show the capture sees an attempt: a TCP connection to a
public IPv4 address, a name lookup, and a TCP connection to a public IPv6 address, each made on
purpose with `curl` or `getaddrinfo`, each recorded on the dummy interface.

**What makes a host call out.** Three things, none of which happened in the run above:

- *A token naming another issuer.* Presented with a token whose `iss` was
  `https://lpg0-issuer.example.org`, the host looked that name up and tried to fetch
  `/.well-known/openid-configuration` from it ({{NET_PROBE_SUMMARY}}). The host has no list of
  allowed issuers: any `http` or `https` issuer named in a token is fetched
  (`crates/core/src/auth/token_validation.rs`, lines 233 to 240 and 420). So a client decides where
  a host connects. A single-player or friends world is offered no account token, and its own
  tokens name "localhost", so the game's own client never causes this; anyone who can reach a
  friends server's port can.
- *A module that asks.* Procedures may make outbound HTTP requests unless the host's `config.toml`
  sets `[module-http] enabled = false`. This module defines no procedure.
- *The command-line tool*, which is a different program from the host and was kept out of the
  namespace. It was not observed.

The host listens on every interface unless told otherwise (`--listen-addr` defaults to
`0.0.0.0:3000`); a single-player world passes a loopback address.

## 6. Budgets

Budgets for the modest-machine profile of section 4, measured with the method of section 7. Each
derives from a median reported above; none is more than twice it. Work that changes what the host
does per tick, per connection or at start-up re-measures and holds these.

| Budget | Median it derives from | Budget | Unit | Headroom |
|---|---|---|---|---|
{{BUDGET_ROWS}}

- The single-player rows derive from the one-player conditions: memory from the highest one-player
  peak, idle CPU from the idle-player run (a player standing still is the idle a single-player
  world has), disk growth from the walking run.
- The friends-server rows derive from the eight-player and nobody-connected conditions: idle CPU
  from the host with nobody connected (an always-on server's idle). Memory and disk growth come from
  the walking-only floor, so they are the least a friends server needs, to be re-set when battles
  and trades are measured (LP5).
- Start-up is the same host and module for both, so both rows derive from "Open an existing
  world".

## 7. Method

**Machine.** AMD Ryzen 9 9950X (16 cores, 32 hardware threads), 45 GiB visible, Ubuntu 24.04.4
under WSL2 (kernel 6.18.33.2), data on ext4 over a virtual disk. Other work ran on the machine
during the runs; the one-minute load average over the windows was {{LOAD_MEDIAN}} (median) and
{{LOAD_MAX}} (highest), on 32 threads.

**Software.** `spacetimedb-standalone` 2.11.0 (sha256 `71b5cff7…a72729`), started directly, not
through the `spacetime` command-line tool. The module is `monster_realm_module.wasm` from
`spacetime build --module-path server-module` at commit `0e7a089d` (3.05 MB, not run through
`wasm-opt`). The load driver is `cargo build --release -p sim-harness --bin mr_load_driver`. The
browser client is `vite build` of `client/` with the development hooks kept (`NODE_ENV=development`,
`--mode development`) so `window.__game()` reports what was drawn, served by `vite preview`, in
Playwright's Chromium 149, headless.

**Constraints.** Each host ran in its own systemd scope with a memory limit, pinned to one core's
two threads; every driver, browser and web server was pinned to other threads:

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
wait 60 seconds, then the window (60 minutes with nobody connected, 30 minutes otherwise). The
three runs of a condition are therefore concurrent, not consecutive.

**Sampling.** Every 5 seconds: resident memory and its high-water mark from `/proc/<pid>/status`,
processor time from the scope's `cpu.stat`, and the size of each part of the data directory
(`replicas/1/clog` is the commit log). The driver also reads the host's `/v1/metrics` every
30 seconds, which the walking rows therefore include.

**Start-up.** One script per run: start the host as above and note the time; poll `/v1/ping` every
5 ms until it answers; open the page in a new browser context; wait, checking every animation
frame, until `window.__game().rendered` contains the player's own entity. "Create a world" publishes
before opening the page. "Open an existing world" reuses the first created world's data directory
and that run's browser storage. Run before the load runs, with a load average under 1.

**Off-machine capture.** `unshare -Urn`, then inside it: `ip link add dummy0 type dummy`, IPv4 and
IPv6 addresses and default routes on it, router solicitations off, the capture (a Python
`AF_PACKET` socket over all interfaces), then the host. The capture's log holds a line per frame
that is not loopback traffic on the host's port, and a count line per minute.

**Per-run numbers.**

| Run | Condition | Window, min | Memory at window start, MiB | Memory at window end, MiB | Highest in window, MiB | Peak since start, MiB | Scope memory peak, MiB | CPU, % of one core | Highest CPU over any 60 s, % | Commit log, MiB per hour | Log files, MiB per hour | Data directory, MiB per hour | Data directory at end, MiB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
{{RAW_ROWS}}

Start-up, per run, in milliseconds:

| Path | Run | Host answers | Module published | Page navigation to frame | Process start to frame |
|---|---|---|---|---|---|
{{RAW_STARTUP_ROWS}}

**What was not measured.** A battle, a trade or any load but walking; more than eight players; a
session longer than an hour, so growth of the world's own tables with play; real low-end hardware;
either shell's memory; the Steam overlay; the command-line tool's network use.
