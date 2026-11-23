# A world's server checks a player's account itself

The design record for lpw-35 (harness spec `M-local-play.spec.md`). It decides how a single-player
or friends world learns whether a player's account owns the game: at the player's first contact
with the world, at each later connection, and once a day for the account that hosts the world,
with the world asking our account service itself through SpacetimeDB procedures. None of it is
built. The building slices are named in section 5.8. Measurements were made on SpacetimeDB 2.16.1
(the pinned host) on 2026-11-23, on this machine (`docs/local-play.md` §7).

## 1. What is built, and what binds every alternative

Built:

- **The attestation binding** (lpw-15, lpw-21, lpw-22; `server-module/src/world_binding.rs`). A
  client asks `POST /attest` (acs-3, `account-service/src/attest.ts`) for a five-minute Ed25519
  attestation naming the world as the player's software authenticated it and carrying a nonce the
  world chose. `bind_world_account` checks it with `ed25519-dalek` against the build's key list and
  writes `world_binding {identity, account_subject, bound_at_ms, entitled, key_id}`.
  `entitled(ctx, profile)` (`server-module/src/accounts.rs`) reads that row. The binding is checked
  once and kept.
- **The browser bind** (lpw-19) is designed in `docs/local-play.md` §3, forks (f) and (g), and is
  not built.

Specced and not built: lpw-23 and lpw-24 (the client fetches a new attestation at every connection,
and the host's client re-checks the host once a day) and lpw-36 (every reducer gated on
`entitled`).

What every alternative must meet (the operator's rulings, recorded in the harness spec's
"Decisions the operator owns"):

1. **A check at every connection** (monster-realm#848). Case 1: an answer about the account
   admits or refuses the connection and is stored. Case 2: with no answer, an identity the world
   does not know is refused. Case 3: with no answer, a known identity is admitted or refused by its
   last stored status, which never expires.
2. **The daily check is the server's own** (monster-realm#855). It covers only the account that
   hosts the server. A joining player is checked at each connection only, which for a browser
   means at the start of each browser session.
3. **A character follows the account, not the client** (monster-realm#855). One account in one
   world is one character, whether it joins from the desktop app or from any browser. "At sign-in
   the account service supplies the identity the world authenticates and authorizes." A browser
   keeps nothing past its session. The desktop client may keep the identity it was given. A, B
   and C read "the identity" as a handle the service supplies, which the world holds against one
   of its own connection identities (section 3). D reads it as the connection identity itself.
4. **The world is named as the player's software authenticated it** (fork (c),
   `docs/local-play.md` §3). A hostile host given what a player gives it reaches no other world as
   that player.
5. **The publisher key never leaves the account service.** It is the Steam Web API key that checks
   tickets and ownership.
6. **A first bind needs the world's host online.**
7. **An address that changes hands** (`decision-defaulted:address-changes-hands=accept-narrowed-for-early-access`)
   is narrowed two ways. A friend's server serves its page with no persistent cache and no service
   worker. The server's daily check confirms the public address it is reached at.

What lpw-15 and acs-3 built is not a criterion (operator, 2026-11-22). Section 3.4 reports the
cost of removing it, and the scores do not count it.

## 2. What a procedure can do on the pinned host

**Method.** The prototype was one crate outside the repository, built with `spacetimedb` 2.16.1 and
`unstable` on. Two procedures did the work:

- `fetch(label, url, timeout_ms)` is client-callable. It sends one GET through `ctx.http.send`.
  It records two times: the request's start (`ctx.timestamp`), and its end, which is the timestamp
  of a `ctx.with_tx` transaction opened after the answer.
- `scheduled_check(row)` is scheduled. It stores a status row only on a 200 answer. Each schedule
  row picks one of three ways to fail. Mode 0 records the failure and returns. Mode 1 panics before
  opening any transaction. Mode 2 writes the status inside its transaction and then panics there.

The host had a scratch data directory and home, and ran inside a network namespace
(`unshare -rn`). The namespace's only interface was loopback, holding 127.0.0.1 and 1.2.3.4. No
special-purpose range covers 1.2.3.4. A probe HTTP server (Python `ThreadingHTTPServer`) listened on
both addresses. It could answer at once, after a set delay, with a set status, or never. The
namespace had no route off the machine. For the black-hole rows, a dummy interface took the default
route, so packets left and nothing answered. Every request was plain `http:`, so TLS was not
measured. Calls went through the host's HTTP API (`POST /v1/database/<db>/call/<name>`) and were
timed by `curl`. Row P7 and P10's CPU figure come from a second host run on the same data
directory: in the first run, appending a second `[module-http]` table stopped the host from
starting. The probe's source, raw output and logs are kept with the slice's acceptance record, in
the harness at `memory/projects/gates/lpw-35.procedure-probe/`. Source lines below are at tag
`v2.16.1` of `clockworklabs/SpacetimeDB`.

| Row | What was measured | Result (2.16.1) |
| --- | --- | --- |
| P1 | A request to an ordinary address | Answered. Median 3,734 µs inside the procedure and 7.57 ms for the client's whole call, over 10 runs (table below). |
| P2 | A request to a loopback or private address | Refused in under 0.13 ms (3.4 ms for `localhost`, which is looked up first), and the probe server on 127.0.0.1 logged no request. The error is "refusing to connect to private or special-purpose addresses". Refused: `127.0.0.1`, `localhost`, `10.1.2.3`, `192.168.1.1`, `172.16.0.1`, `[::1]`. By source, the host also refuses 100.64/10, 169.254/16, the documentation and benchmarking ranges and fc00::/7, whether the URL holds the address itself or a name that resolves to it (`crates/core/src/host/instance_env.rs:1115-1124, 1214-1365`). |
| P3 | The default timeout | 30.003 s against a server that accepted and never answered. 30.004 s against a black-holed address. Source: `HTTP_DEFAULT_TIMEOUT` is 30 s, and a longer requested timeout is clamped to `HTTP_MAX_TIMEOUT`, 180 s (`instance_env.rs:1105-1111, 1205, 1211`). |
| P4 | A timeout the procedure sets (`http::Timeout`) | 100 ms gave up at 0.105 s, 1,000 ms at 1.005 s, and 2,000 ms against a black hole at 2.005 s. The error is "operation timed out". |
| P5 | No 500 ms ceiling | An answer delayed 1.5 s arrived after 1.505 s with no timeout set. The crate's doc comment, "subject to a maximum timeout of 500 milliseconds" (`vendor/spacetimedb/src/http.rs:495`), does not hold at 2.16.1. |
| P6 | No network | A name failed in 4.5 ms ("Temporary failure in name resolution"). An IP address failed in 4.2 ms ("Network is unreachable"). A network that drops packets takes the timeout (P3, P4). |
| P7 | `[module-http] enabled = false` in the host's `config.toml` | Every request failed at once with "module outbound HTTP requests are disabled". The probe server's count after the call was 7: the 6 earlier requests and the count request itself. The key ships commented out, and requests are allowed unless it is set (`instance_env.rs:1038-1040`). The default file already holds a `[module-http]` table, so appending a second one stops the host from starting (its log: "duplicate key `module-http` in document root"). |
| P8 | A one-shot scheduled procedure that fails | The row is spent after its one run in all three modes, and the procedure is never run again. The status row was unchanged after each mode, including mode 2, whose write was rolled back with the panic. |
| P9 | An interval scheduled procedure that fails | The row is kept. Every 1 s run panicked (mode 1) and was run again: 5 requests in 5.2 s, with the status unchanged. After the URL was fixed, the next run (0.99 s later) stored the answer. |
| P10 | What a procedure's wait costs the reducer thread | 20 reducer calls made while one procedure waited 3.005 s on HTTP all committed inside that wait. Their median client round trip was 7.22 ms, against 5.675 ms with nothing waiting (table below). The two sets were paced differently (back to back, and 50 ms apart), so the probe does not attribute the 1.5 ms. Two procedures each waiting 2 s finished in 2.02 s together. The host's procedure instance pool defaults to one per core (the `[wasm]` table of the default `config.toml`). A procedure's own transactions are what it costs: 6 of them, each inserting one row, took 0.697 ms of CPU in all (`spacetime_txn_cpu_time_sec`, `txn_type="Procedure"`, each under 0.5 ms). No transaction time counts the HTTP wait. |

P1's runs:

| Run | Inside the procedure (µs) | Client round trip (ms) |
| --- | --- | --- |
| 1 | 5451 | 11.77 |
| 2 | 3769 | 7.96 |
| 3 | 3944 | 7.57 |
| 4 | 3772 | 7.84 |
| 5 | 3907 | 7.28 |
| 6 | 3699 | 7.87 |
| 7 | 3622 | 6.93 |
| 8 | 3678 | 7.57 |
| 9 | 3573 | 6.75 |
| 10 | 3646 | 7.58 |

P10's reducer calls (`ping`, one row inserted), client round trip in ms, before and during a
procedure's 3 s HTTP wait. All 20 "during" calls committed between the procedure's start and its
end:

| Call | Nothing waiting | During the wait |
| --- | --- | --- |
| 1 | 5.68 | 7.22 |
| 2 | 5.67 | 6.79 |
| 3 | 5.61 | 6.75 |
| 4 | 5.48 | 7.27 |
| 5 | 5.33 | 7.11 |
| 6 | 5.78 | 7.22 |
| 7 | 5.71 | 6.49 |
| 8 | 5.41 | 6.86 |
| 9 | 5.71 | 6.84 |
| 10 | 5.77 | 7.33 |
| 11 | 5.42 | 6.43 |
| 12 | 5.77 | 7.35 |
| 13 | 6.31 | 7.50 |
| 14 | 5.86 | 8.59 |
| 15 | 5.73 | 6.75 |
| 16 | 5.50 | 7.47 |
| 17 | 5.37 | 7.57 |
| 18 | 5.62 | 7.57 |
| 19 | 5.89 | 7.51 |
| 20 | 5.50 | 7.10 |

**What these facts mean for any design that has the world ask.**

- **Address.** The account service a world checks against must have a public address under a
  public name. P2 refuses `local-dev` (`http://localhost:4455`) and any instance on a LAN. A local
  test of the whole path needs the probe's rig: a network namespace with an ordinary address on
  loopback, which needs no privilege on this machine. The host's `allow_loopback_http_for_tests`
  is a compile-time feature of the host (`instance_env.rs:1252, 1312`), and the release binary
  refuses loopback (P2). The module's half is tested on the native test host with the HTTP answer
  stubbed.
- **Network.** A host with no route off the machine (P6), or whose `[module-http]` is off (P7),
  checks nobody. `decision-defaulted:bundled-host-module-http=disabled` (lpw-12) turns off the
  check for every shell world.
- **Timeout.** A procedure that waits on the default 30 s holds a joining player for 30 s (P3), so
  each request sets its own timeout (P4).
- **Retry.** A failed run is retried only by an interval row. A one-shot row is spent (P8, P9).
- **Cost.** Reducers keep committing while a procedure waits (P10). What a procedure costs the
  reducer thread is the transaction it opens, about 0.12 ms of CPU for a one-row insert.
- **Native tests.** The vendored crate's native branches refuse a `ProcedureContext`
  (`vendor/spacetimedb/src/lib.rs:1614, 1661, 1865` panic, and `src/http.rs:573-576` returns an
  error, at 2.16.1). A native test of a procedure therefore needs a `cfg` edit in
  `vendor/native-host.patch` and `procedure_*` host functions in
  `server-module/src/native_host_tests.rs`. The entry "Server-module tests run on our own host
  ABI, over the two vendor crates patched where they refuse a native host" allows exactly that.

## 3. The alternatives

### The identity every alternative needs

The world's tables key a character on the connection's SpacetimeDB identity. A browser that keeps
nothing past its session connects under a new identity each session. A world can meet ruling 3 in
one of two ways:

- **(i) The account service supplies the connection identity.** It issues a token per account per
  world, whose `iss` is ours and whose `sub` is a per-world pseudonym. The host validates it as an
  outside issuer's token, so `ctx.sender()` is the same from every client.
- **(ii) The world keys the character on a per-world pseudonym the service gives it (a handle).**
  It moves the character to whichever of its own identities last proved that handle (section
  5.4).

(i) fails ruling 1's case 3 on the host as pinned. The host holds an outside issuer's keys in
memory (`crates/core/src/auth/token_validation.rs:199-207`, over `async_cache` 0.3.2). It refreshes
them every 300 s and keeps the old keys when a refresh fails. It drops an issuer after a 7,200 s
window in which no token of that issuer was validated, so after 2 to 4 hours idle, and a restart
loses them at once. A host without the keys refuses the token at connect, before the module runs.
So while our service is down, a known player is refused if the host restarted or sat idle, and a
host that has not reached the service since it started refuses at once, for example a laptop with
no internet playing its own world. The token's `exp` is checked as well
(`token_validation.rs:162-173`). (ii) keeps the world's own identities, which the host validates
with its own key and no network. A, B and C use (ii). D is (i).

**The handle** is the account and the world's database identity, encrypted deterministically under
an account-service key (an AEAD such as AES-SIV, with a key id in front). So there is one handle
per account per world. The world cannot read it, the service can, and the service keeps no table of
which account joined which world. The world states its own database identity
(`ctx.database_identity()`). A world copied to another machine keeps it, and a restore into a new
database does not. A handle is a pseudonym, not a credential: nothing is ever granted for
presenting one. A and B derive it the same way, so in both a host that states another world's
database identity receives that world's handle for the player.

### The four

- **A — keep the attestation, and re-check by handle from a scheduled procedure.** lpw-15 stays.
  The attestation also carries the handle, which the binding stores in place of the account's
  subject. When a known identity connects, `client_connected` arms a one-shot procedure that sends
  the handle to the service and stores the answer. An interval procedure does the same for the
  host's handle once a day, and confirms the address as B does. A first bind remains a
  client-fetched attestation.
- **B — a one-use join ticket that the world redeems.** The client tells the service which world
  it is joining, named as in fork (c), and receives a one-use ticket. The world's procedure
  presents the ticket together with its own names and database identity. The service answers with
  the handle and the entitlement. After that, the world re-checks by handle on its own, as in A. No
  build holds an attestation key, the module has no verifier crate, and there is no nonce table.
- **C — Steam's own ticket on the desktop, B in a browser.** The shell's main process gets a Steam
  Web API ticket (`getAuthTicketForWebApi`) whose identity string is the world's name. The world's
  procedure presents it to the account service. The service verifies it with Steam
  (`ISteamUserAuth/AuthenticateUserTicket` with that identity, then the ownership check) using the
  publisher key, and answers as in B. A browser uses B.
- **D — the account service issues the world's connection token.** The token is issued per account
  per world. Its `aud` is the world's name, its `sub` is the handle, and its `mr_ent` is the
  entitlement. The host validates it through OIDC discovery, and `client_connected` reads its
  claims. The token is the check, so the world has no procedure. It therefore has no daily check of
  its own and no address check (rulings 2 and 7).

### 3.1 What each party learns and keeps about a player

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| The world | Learns the handle, the entitlement and the signing key's `kid` at bind. Learns the entitlement again at each connection and, for the host, daily. Keeps the handle, the entitlement, the check time and the identity that holds the character. | Learns the handle and the entitlement at first contact and at each connection, and the host's handle daily, with the address the service saw. Keeps the handle, the entitlement, the check time, the identity that holds the character, and its own egress address. | As B. A desktop player's first contact carries a Steam ticket instead of our ticket. | Learns the token's claims at each connection: the handle, `mr_ent`, `aud` and `exp`. Keeps the entitlement and check time per identity. |
| Its host | Everything the world keeps. The commit log also keeps every bind's attestation and nonce, because a reducer's arguments are kept in the clear (`docs/local-play.md` §3, fork (a)). An attestation is spent once its nonce is. | Everything the world keeps. The commit log keeps every value the world stored, so it holds the history of the world's egress address. A procedure is not a transaction, and whether the host keeps a procedure's arguments is not measured. A ticket is spent at the service before the world stores anything. | As B, plus the Steam ticket in the procedure's argument. By the public ticket formats it carries the player's SteamID, an identifier common to every world (not measured). | The player's bearer token for this world, kept by a desktop client for its life. It opens this world only, and the host already controls everything in this world. |
| The account service | The account, the world and the time of each attestation. It keeps the account and the time, and not the world (as acs-3 does today). At each re-check it decrypts the handle to an account and keeps nothing. | The account, the world's name and the time of each ticket, kept for the ticket's 60 s under the ticket's SHA-256. At each redeem or re-check it sees the world's database identity and source address and keeps neither. It logs the account and the time only. | As B. For a desktop ticket it also learns the Steam ID, and Steam learns the world's name as the ticket's identity string. | The account and the world's name for each token. It learns the host's address when the host fetches its keys. |
| A reader of the world's data directory | Handles, entitlement flags, check times, which identity holds each character, and the commit log's attestations. | Handles, entitlement flags, check times, which identity holds each character, and the egress address and its history. No account subject, which lpw-15's `world_binding.account_subject` keeps today. A reader can present a handle and learn whether that account is entitled now (section 5.2). | As B. | Entitlement flags and check times. A desktop player's token is on that player's machine, not in the world's directory. |

### 3.2 What a hostile host can replay or relay, and where it is refused

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| Relays to another world | An attestation for its own world, presented at another world. That world refuses it in `bind_world_account`: the `aud` is not one of its names, and the nonce is not one it issued. Built and proved: `mod relay_rig`, `server-module/src/world_binding_tests.rs`. | A ticket for its own world, presented by another world's procedure. The service refuses it at redeem, because the ticket's world is not among the names that world presents. The host cannot get a ticket that names the other world, because the client names only what it authenticated. One case gets through: a host that holds an address the other world still lists. Section 5.4 limits what that ticket can do. | A Steam ticket for its own world, relayed. Steam refuses it, by its documentation, because the service passes the presented name as the identity and the ticket was issued for another. Not measured: Steamworks is not available here (acs-12 waits on `operator-steamworks`). | Its own token, presented at another world. That world's `client_connected` refuses it, because the `aud` is not one of its names. |
| Replays at this world | An attestation the host saw, presented again. It is refused, because its nonce is spent and its `exp` passed. | A ticket the host saw, presented again. The service refuses it, because a ticket is spent at its first redeem and lives 60 s. If the host redeems first, it binds the player's handle for its own world to an identity it holds, inside its own world. | As B, for our tickets. Whether Steam refuses a second check of one Web API ticket is not measured. | The player's token, until its `exp`. It opens this world only. |
| What it learns that works elsewhere | Another world's handle for the player, by stating that world's database identity at bind. It identifies the player only to someone who also holds that world's data. | The same as A, by stating that world's database identity at redeem. | As B. | As B, if the service derives the handle from a database identity the host states. The official server does not trust the world-token issuer. |

### 3.3 Offline

The world's host offline: nobody connects, in every alternative (ruling 6). "The player offline"
means a client without internet that can still reach the world, for example on a LAN. Every
browser session is a first contact (ruling 3), so in every alternative an outage of our service
keeps every browser player out until it ends.

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| First bind, the world's host offline | Impossible. | Impossible. | Impossible. | Impossible. |
| First bind, the player offline | Refused: the client cannot fetch an attestation (case 2). | Refused: the client cannot fetch a ticket (case 2). | Refused: no Steam ticket, and no ticket from us. | Refused: the client cannot fetch a token. |
| First bind, the service offline | Refused (case 2). | Refused (case 2). | Refused (case 2). | Refused. |
| First bind, the world cut off from the internet while the client is not | Works: the world checks the signature itself. | Refused: the redeem cannot leave the world (P6, P7). | Refused (P6, P7). | Works while the host holds the issuer's keys in memory; refused after a restart or an idle window. |
| Re-check, the world's host offline | None is due: nobody is connected. The daily check waits for the host to come back. | As A. | As A. | No daily check exists (rulings 2 and 7). |
| Re-check, the player offline | The world asks for itself, so the player's network does not matter. | As A. | As A. | A desktop token is used until its `exp`. The browser cannot sign in. |
| Re-check, the service offline | The known identity is admitted by its stored status, with no expiry (case 3). The stored status is unchanged (P8, P9). | As A. | As A. | The known player is refused once the host has lost the issuer's keys (a restart, or 2 to 4 hours idle), and at once on a host that never fetched them. Case 3 fails. |

### 3.4 What each adds and removes against lpw-15 and acs-3

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| Tables | Keeps `world_binding`, `world_bind_nonce`, `world_name` and `world_allowlist`; `account_subject` holds a handle. Adds two schedule tables and the egress table. | Removes `world_binding` and `world_bind_nonce`. Adds `world_account`, `world_move`, `world_egress`, `world_check_budget` and two schedule tables (section 5.3). Keeps `world_name` and `world_allowlist`; the allowlist's entries become handles. | As B. | Removes `world_binding` and `world_bind_nonce`. Adds a stored status per identity. Keeps `world_name` and `world_allowlist`. |
| Reducers and procedures | Keeps the five binding reducers and the two views. Adds two scheduled procedures. | Removes `request_bind_nonce`, `request_bind_nonce_for`, `bind_world_account`, `bind_world_account_for`, `my_bind_nonce` and `my_world_binding`. Adds four procedures (section 5.6), the reducer `set_host_identity`, and the views `my_world_account` and `my_world_move`. Keeps `unbind_world_account`, `set_world_names` and `set_world_allowlist`, the first and last rewritten to read `world_account`. | As B. | Removes what B removes. Adds no procedure: `client_connected` reads the token's claims. |
| Crates | Keeps `ed25519-dalek`, `base64`, `serde` and `serde_json` in the module. | Removes `ed25519-dalek` and `base64` from the module. Keeps `serde` and `serde_json`, which then build the request and parse the answer. No crate is added. | As B. | Removes `ed25519-dalek` and `base64`. Keeps `serde` and `serde_json` only if something else then uses them. No crate is added. |
| Build key lists | Keeps `DEV_ATTESTATION_KEYS`, `PRODUCTION_ATTESTATION_KEYS` and `BuildProfile::attestation_keys`. Adds the account service's check address per build profile. | Removes `AttestationKey`, `LOCAL_DEV_ATTESTATION_KEY`, `DEV_ATTESTATION_KEYS`, `PRODUCTION_ATTESTATION_KEYS` and `BuildProfile::attestation_keys`. Adds the account service's check address per build profile: production on `world`, `hosted-dev` on the dev builds, none on `official`. | As B. | Removes the key lists. Adds the world-token issuer to the dev and `world` builds' issuer lists, and lpw-12's gate must admit that issuer. |
| Account-service routes | Keeps `POST /attest` and adds the handle claim to it. Adds `POST /world/check` for a re-check by handle. Keeps the attestation key files and `attestation-public-keys.json`. | Removes `POST /attest`, the attestation key files, `attestation-public-keys.json` and its generation. Adds `POST /ticket` and `POST /world/check`. Fork (f)'s code redemption returns a ticket. | B's routes. `POST /world/check` also takes a Steam ticket and calls Steam's Web API. | Removes `POST /attest`. Adds a world-token route, plus OIDC discovery and keys for a second issuer name. |

## 4. Scores

A `judge` scored the four alternatives from sections 1 to 3, without section 5. The rubric was
fixed before scoring. Five criteria, each 0 to 20, total 100:

1. Rulings 1 to 3 met as written.
2. Ruling 4 closed: relay, replay, and a host's knowledge carried to another world.
3. What the world, its host and a reader of its data learn and keep.
4. What the module and every build hold that a mistake or a key compromise could turn against a
   player: verifier code, key lists, bearer credentials kept on a machine.
5. How it fails: the service down, a world cut off, a test that cannot run, latency added to a
   join.

The cost of removing what lpw-15 and acs-3 built was not scored. Ties would have been broken by
criterion 1, then 2; none arose.

| Criterion | A | B | C | D |
| --- | --- | --- | --- | --- |
| 1. Rulings 1 to 3 met as written | 17 | 17 | 16 | 6 |
| 2. Relay, replay and a host's knowledge carried elsewhere | 17 | 15 | 11 | 14 |
| 3. What the world, its host and a data reader keep | 12 | 14 | 10 | 15 |
| 4. What a mistake or a key compromise could turn | 7 | 16 | 13 | 9 |
| 5. How it fails | 16 | 11 | 8 | 13 |
| Total | 69 | 73 | 58 | 57 |

The judge's reasons:

- **A (69).** Its relay and replay refusal is built and proved (`mod relay_rig`), and a first bind
  works from a world that is cut off or has module HTTP off. It loses criterion 4: a verifier crate
  and compiled key lists sit in every world build, and a leaked attestation key would move
  characters.
- **B (73, first).** It meets rulings 1 to 3 as A does, with no verifier, no key list, no nonce
  table and no signed record in the commit log. It costs a first contact from a cut-off or
  module-HTTP-off world, and its main path is a procedure, which is harder to test.
- **C (58).** It has B's costs plus Steam's. On the desktop its relay and replay closure rests on
  Steam behaviour nobody here can measure. The host receives a Steam ticket, which likely carries
  the SteamID. Steam also adds latency, an outage path and a step that cannot be tested.
- **D (57).** It is best on criterion 3 and on testability. But the host refuses known players
  before the module runs once our issuer's keys leave its memory, or once a token expires, so case
  3 fails. It also has no daily check of its own.

**What would overturn the result.** B's lead over A comes from criteria 4 (+9) and 3 (+2). If the operator keeps
`decision-defaulted:bundled-host-module-http=disabled`, B lets no new player into a shell world,
its criteria 1 and 5 fall, and A wins. If keeping a verifier and compiled key lists were shown to
be no riskier than trusting a TLS answer, A would win too. Section 5.8 asks for the first default
to change.

The judge's check of sections 1 to 3 against the sources found eight statements false or
unsupported, about seven matters. The sections above state the corrected facts:

- the host's key-cache behaviour, which is idle-window and restart loss;
- a local test of the whole path, which the probe's rig allows;
- A's handle, which leaks as B's does;
- A's service, which learns the world without keeping it;
- D's missing daily check;
- the quoted sentence of ruling 3;
- the SteamID in C's ticket.

## 5. The chosen design: B, with the world re-checking by handle at each connection

### 5.1 The flow

1. **First contact.** This happens when the world does not know the connection's identity: a
   player's first visit, or a browser session's fresh identity.
   - The client asks `POST /ticket` for a ticket naming the world as the player's software
     authenticated it (fork (c)). A browser gets its ticket from fork (f)'s code redemption.
   - It then calls the procedure `check_account(ticket)`. The procedure refuses a ticket that is
     not 43 base64url characters. It also refuses once the world has sent 30 first-contact
     redeems in the current minute (the `world_check_budget` row), telling the caller to try again.
     Neither refusal sends anything. An attacker with free identities in an `Open` world can spend
     that budget and delay newcomers. The host's answer is to close the world to friends or move
     it to `Password`.
   - Otherwise it presents the ticket at `POST /world/check`, with the world's accepted names and
     its database identity, under a 3 s timeout.
   - With the answer it opens one transaction. That transaction re-reads every row it decides on,
     because the HTTP wait let other transactions run, and `with_tx` may run its body twice. It
     stores the handle and the entitlement, takes the world's egress address from the answer
     (section 5.5), and returns the outcome to the caller.
   - An identity the world's access rule does not admit is refused at connect, so it never
     reaches `check_account`. For that identity the host's gate relays the ticket through the
     owner-only `check_account_for(who, ticket)`, as it relays the door today
     (`docs/DECISIONS.md`, "A world that is not open refuses an unadmitted identity at connect
     and in every reducer; the owner relays the door").
2. **Each later connection.** `client_connected` arms a one-shot `recheck_account` row for an
   identity that holds a `world_account` row, unless that row was checked in the last 10 minutes
   or a re-check is already armed.
   - The connection is admitted by the stored status (case 3) until the answer lands (case 1),
     one service round trip later.
   - A negative answer stops the player at lpw-36's gate from then on. A module cannot close a
     connection, so the player's subscriptions run until it disconnects.
   - A failed run leaves the status unchanged and is not retried (P8): the next connection asks
     again.
3. **The daily check.** `host_account_check` runs from an interval row every hour, with no
   client. It reads the `world_account` row the owner marked with `set_host_identity(who)`.
   - That reducer is owner-only. It marks the row of the identity the host plays as, clears the
     mark from any other row, and moves nothing. At most one row is marked. The owner credential stays out of the page
     (`decision-defaulted:world-owner-credential=shell-held-never-in-page`), so the host plays
     under an identity other than `config.owner_identity`.
   - The check makes its request only when its last success is 23 hours old or more, or when the
     owner has changed the world's names since then.
   - A negative answer marks the host's identity not entitled, as any player's would be. Joiners
     are unaffected.
   - A failed run leaves the status unchanged and is tried again at the next tick (P9).
4. **The official build** declares the procedures and refuses all four as their first statement:
   it names no account service for worlds. Its players are entitled by their login token
   (acs-6).

### 5.2 The account service

- **`POST /ticket`** takes `Authorization: Bearer <ID token>` and `{ "world": "<name>" }`, with
  the name as `POST /attest` takes it today. It answers `{ "ticket": "<32 random bytes, base64url>" }`.
  It keeps the account, the world and an expiry 60 s later, under the ticket's SHA-256. It issues a
  ticket whether or not the account is entitled, because the redeem answers either way (lpw-23.5's
  negative answer).
- **Fork (f)'s code redemption** returns such a ticket in place of an attestation. The page a gate
  serves never holds an ID token.
- **`POST /world/check`** is called by a world. It takes no token, and the caller is not
  authenticated. It accepts one of two bodies:
  - `{ "ticket", "names", "world" }`. The service spends the ticket. It answers `403` when the
    ticket is unknown, spent or expired, or when its world is not one of `names`. Otherwise it
    answers `{ "handle", "entitled", "address", "name" }`, where `name` is the name the ticket was
    issued for.
  - `{ "handle", "world" }`. It answers `{ "handle", "entitled", "address" }`. An account that is
    gone answers `entitled: false`, the same as an account that is not entitled, so the route tells
    no one that an account was deleted. A handle that does not decrypt to an account and that
    `world` answers `entitled: false` and no `handle`.

  `address` is the request's source address as the service saw it. `handle` is under the service's
  current key. When the key rotates, a world replaces the stored handle in `world_account` and in
  `world_allowlist` in the same transaction. The service keeps
  retired keys for decryption. Limits apply per source address and per handle-and-source pair, so
  harvested handles cannot lock a player out of an honest world. A log line holds the account and
  the time, never a world, name, handle or address.
- **For the address check**, the service answers on one name that resolves to IPv4 only and one
  that resolves to IPv6 only. The world asks the one whose family its `ip:` names use.

### 5.3 What the world keeps

All private, written only by `server-module/src/account_checks.rs`:

- `world_account {handle (primary key), identity (unique), entitled, checked_at_ms, is_host}`.
- `world_move {identity (primary key), moved_at_ms}`: an identity a character was moved away
  from, and when. The identity's next check-in deletes it.
- `world_egress {family (primary key), address, confirmed_at_ms}`: at most one row per address
  family, written from the `address` of every answer.
- `world_check_budget {id, minute_start_ms, redeems}`: one row, counting the current minute's
  first-contact redeems.
- `recheck_schedule`: one-shot rows.
- `host_check_schedule`: one interval row, armed by `set_host_identity`.

An identity reads its own rows through `my_world_account` and `my_world_move`. The deletion cascade
erases the caller's `world_account` and `world_move` rows. The data export includes them.

### 5.4 One character per account, whatever the client (lpw-35.5)

**Moving a character** is a primitive of its own, not the claim flow's `rekey_all`. That function
leaves the source holding a dialogue-state marker (`server-module/src/npc.rs`), which
`account_has_game_data` counts, so a character could never move back. The move:

- carries every row that makes up the character, the `player` row and position included, and
  leaves the source identity holding nothing a later move, deletion or export must find. Finished
  battles stay as history under the old identity, as the claim flow leaves them;
- refuses while either identity is in a battle or a trade;
- when the source identity is connected, moves its live position too, and that identity's later
  disconnect writes nothing;
- runs only through a ticket that named a `spki:` name or an `ip:` name the world has confirmed
  (section 5.5), or a `dns:` name, which keeps its certificate's limit. The address of a moved
  server can change hands within the day before its name lapses, and a ticket through such a name
  could otherwise carry a character to the address's new holder;
- writes a `world_move` row for the identity it left, so that client is told when its character
  moved.

| Claim | How | The test that proves it |
| --- | --- | --- |
| A world maps a signed-in account to one player identity | `check_account`, given a handle held by another identity, moves the character to the caller and points the handle at it. A caller that already owns a character is refused ("this identity already plays a character here"). | `server-module/src/account_checks_tests.rs` (new, lpw-23), a native test with the HTTP answer stubbed. After two identities check in with the same handle, the second holds every row of the character and the first holds none. A third check-in by the first moves it back. |
| What the desktop client keeps, and where | The world's own reconnect token for that world, in the shell's persistent storage, keyed as lpw-18 keys it. Never an account token or a ticket. | lpw-2's e2e for the shell kind (a relaunch resumes the identity with no ticket request), and `client/src/net/authToken.test.ts`. |
| A browser keeps nothing past its session | In a browser, a `local` or `private` target keeps its token per tab, as `official` does, and lpw-2's `localStorage` for those kinds is removed there. A ticket is held in memory until it is spent. A browser that restores a session restores its tabs' storage, and two tabs move the character back and forth. | `client/src/net/authToken.test.ts`: a browser's `private` target never writes `localStorage`. The whole path in a browser runs against `hosted-dev`, or locally inside the probe's network-namespace rig, because a procedure cannot reach a local account service otherwise (P2). |
| What a player who signed in at one client sees at another | Their character, moved to the new client. The first client's identity holds nothing. Its `world_move` row makes its next screen "this character is playing on another client", with the time, and an offer to sign in again, which moves the character back. | The same native test: the first identity reads its `world_move` row, and its `join_game` is refused. `client/src/main.worldAccount.test.ts` (new, lpw-24) checks the message. |

### 5.5 The daily check, and an address that changes hands (lpw-35.6)

| Claim | How the chosen design does it | The test that proves it, or the measured reason it cannot |
| --- | --- | --- |
| The daily check of the hosting account | `host_account_check`, from an interval row, presents only the handle `set_host_identity` marked. It refuses a caller that is not the database itself. A failed run is retried at the next hourly tick (P9). | `server-module/src/account_checks_tests.rs` (new, lpw-23). The procedure, run as the scheduler runs it, presents the host's handle and no other, and a client's call to it is refused. A stubbed failure leaves the status unchanged, and the next tick asks again. |
| No joining player is re-checked within a connection | The only schedule a joining player's handle reaches is the one-shot row `client_connected` arms. Nothing re-arms it while the connection lasts, and the daily row reads the host's handle only. | `server-module/src/account_checks_tests.rs`. One connection arms at most one `recheck_schedule` row. After 48 simulated hours of hourly ticks, no request has named the joiner's handle. |
| A friend's page with no persistent cache and no service worker | The gate serves the client page and every asset with `Cache-Control: no-store`, and with a content security policy holding `worker-src 'none'`. The client registers no service worker. An earlier holder's code survives only in a tab left open across the change, which the operator accepted. | `desktop/src/hostGate.test.ts` (new, lpw-18, and lpw-17's gate): every page response carries both headers. An e2e beside lpw-18.7's: `navigator.serviceWorker.register` rejects, `getRegistrations()` is empty, and a reload after the gate stops loads nothing. |
| A moved server stops accepting its old address within a day | Every answer from the service, the daily check's included, stores the `address` the service saw, per family. The world presents an `ip:` name in two cases: while no address of its family is stored yet, so a new world's first contact can redeem; and while the stored address equals it and was confirmed in the last 25 hours. Once a check reports a different address, or a day of checks has failed, the world stops presenting the name, and a ticket naming the old address is refused at redeem. The daily check needs no presented name, since it sends the host's handle, so it confirms the new address and recovers a world whose checks failed. It falls due 23 hours after the last one and runs within the next hour. `spki:` names are unaffected. A `dns:` name keeps its certificate's limit (`docs/DECISIONS.md`, "An attestation names the server as the player's own software authenticated it"). | `server-module/src/account_checks_tests.rs`. Once a stubbed answer reports a new address, and also once the last confirmation is 25 hours old, a stubbed redeem receives `names` without the old `ip:` name, and a `spki:` name stays. A new world with no stored address presents its `ip:` name, and its first answer confirms it. The measured reason this cannot be exact: the service sees where the world's requests leave from, not where friends reach it. A server whose outgoing address differs from its listed one (a NAT gateway, a reverse proxy, a VPN, IPv6 temporary addresses) never confirms its `ip:` name, and one that shares an address behind NAT confirms it whatever port it listens on. |

A stronger check is open to the operator: at redeem, the service could refuse an `ip:` name that
differs from the request's source address. That would close the window at once and remove
`world_egress`. The defaulted ruling names the daily call, so the record keeps it.

### 5.6 The procedures, the definition check and the census (lpw-35.3)

| Procedure | Called by | Schedule |
| --- | --- | --- |
| `check_account` | a client, with a ticket | none |
| `check_account_for` | the world's owner, relaying a ticket for an identity it has not admitted | none |
| `recheck_account` | the scheduler only, as the database identity | one-shot, armed by `client_connected` |
| `host_account_check` | the scheduler only, as the database identity | interval, every hour |

- **The module-definition check** (`findDefinitionViolations`, `scripts/verify-release-reducers.mjs`)
  lists `Procedures` among the section kinds it knows and refuses none of them today. It must
  allow exactly `check_account`, `check_account_for`, `recheck_account` and `host_account_check`,
  and refuse any other procedure. Its `Schedules` section must hold exactly
  `recheck_schedule` → `recheck_account` and `host_check_schedule` → `host_account_check` beside
  the module's existing schedules. It must keep refusing every HTTP handler, HTTP route and row
  filter.
- **The reducer census** (`server-module/src/privacy_enforcement_tests.rs`) refuses any `procedure`
  attribute today. It must allow exactly the same four, in the one module that declares them
  (`server-module/src/account_checks.rs`). It must also attribute their writes inside `with_tx` as
  it attributes a reducer's. Those writes are the tables of section 5.3, plus the tables the
  character move writes (section 5.4), which are the deletion manifest's tables.
- **The client-callable surface.** `check_account` joins the surface that
  `evals/client-surface-privacy.eval.mjs` and the census check. The other three stay off it, behind
  the owner and scheduler guards.

### 5.7 What this changes in the slices as specified (lpw-35.4)

| Slice | Change |
| --- | --- |
| lpw-2 | In a browser, `local` and `private` targets keep their token per tab. The desktop shell keeps it on the device. lpw-2.1 and lpw-2.5 hold for the shell only. |
| lpw-23 | Rewritten as the module half of section 5: the four procedures and `set_host_identity`; the tables of section 5.3; the character move; the check address per build profile; the definition-check and census allow-lists; and the address check. `entitled(ctx, profile)` reads `world_account`. It is a schema slice, and it runs after lpw-41 and acs-14. |
| lpw-24 | Rewritten as the client half. The client asks for a ticket and calls `check_account` only when the world does not know its identity. The host's daily re-check (lpw-24.3) moves to the server. The client shows "playing on another client" and the not-owned message (lpw-15.8, unchanged). |
| lpw-19 | The browser bind redeems its one-use code for a ticket in place of an attestation. Its post carries no nonce, and a page asks at every browser session instead of "once a day otherwise". The return path, consent and `Origin` rules are unchanged. |
| lpw-22 | `unbind_world_account` deletes the caller's `world_account` row and, as now, its admission row. |
| lpw-36 | The gate reads `entitled(ctx, profile)` unchanged. Its exempt list loses the four nonce and bind reducers and gains `set_host_identity`. `check_account` and `check_account_for` are procedures, not reducers, so lpw-36 does not gate them. |
| acs-3 | Superseded: acs-14 adds the routes, and acs-15 removes `POST /attest` and the attestation keys. |
| acs-12 | The shell sends its ID token to `POST /ticket` for each world it joins. Its Steam sign-in is unchanged. |
| lpw-21 | `is_admitted` and the allowlist seeding read `world_account` handles. A friend is listed by the handle the world recorded at the friend's first check, relayed through the door. |
| lpw-12 | `decision-defaulted:bundled-host-module-http=disabled` must become enabled, since a shell world checks nobody with it off (P7). This changes a default the operator owns, and the operator may overrule it, at the cost of shell worlds admitting only identities they already know. |
| lpw-14 | The gate's door relays a joiner's ticket through `check_account_for`. |
| lpw-18 | The gate serves the page as section 5.5 states. |
| acs-13 | Dead: there is no attestation key to hold. |

### 5.8 The slices that build it, and what they remove

- **acs-14** (new): `POST /ticket` and `POST /world/check` on the account service, the handle key
  and its rotation, the limits, and fork (f)'s redemption returning a ticket.
- **lpw-41** (new): the native test host runs procedures, with the HTTP answer stubbed
  (`vendor/native-host.patch`, `server-module/src/native_host_tests.rs`).
- **lpw-23** and **lpw-24**, rewritten as above.
- **lpw-33** removes the module items the chosen design leaves dead.
- **acs-15** (new, after lpw-33): removes `POST /attest`, the attestation key files and
  `account-service/attestation-public-keys.json`.
- **The operator** decides `decision-defaulted:bundled-host-module-http`. The judge's result rests
  on it becoming enabled (section 4).

lpw-15's items that the chosen design leaves dead, for lpw-33 to remove:

| Item | Kind | Where |
| --- | --- | --- |
| `world_binding` | table | `server-module/src/schema.rs` |
| `world_bind_nonce` | table | `server-module/src/schema.rs` |
| `my_world_binding` | view | `server-module/src/schema.rs` |
| `my_bind_nonce` | view | `server-module/src/schema.rs` |
| `request_bind_nonce` | reducer | `server-module/src/world_binding.rs` |
| `request_bind_nonce_for` | reducer | `server-module/src/world_binding.rs` |
| `bind_world_account` | reducer | `server-module/src/world_binding.rs` |
| `bind_world_account_for` | reducer | `server-module/src/world_binding.rs` |
| `ed25519-dalek` | crate | `server-module/Cargo.toml` |
| `base64` | crate | `server-module/Cargo.toml` |
| `AttestationKey` | key list | `server-module/src/accounts.rs` |
| `BuildProfile::attestation_keys` | key list | `server-module/src/accounts.rs` |
| `DEV_ATTESTATION_KEYS` | key list | `server-module/src/accounts.rs` |
| `PRODUCTION_ATTESTATION_KEYS` | key list | `server-module/src/accounts.rs` |
| `LOCAL_DEV_ATTESTATION_KEY` | key list | `server-module/src/accounts.rs` |

The deletion manifest's entries for the two tables go with them, together with the functions that
serve only them: `verify_attestation`, `trusted_binding`, `bound_entitled`, `bound_accounts`,
`erase_world_binding` and `binds_nothing`.

lpw-15's items the chosen design keeps:

| Item | Kind | Where | What changes |
| --- | --- | --- | --- |
| `world_name` | table | `server-module/src/schema.rs` | nothing |
| `set_world_names` | reducer | `server-module/src/world_binding.rs` | nothing |
| `world_allowlist` | table | `server-module/src/schema.rs` | its entries are handles |
| `set_world_allowlist` | reducer | `server-module/src/world_binding.rs` | it reads `world_account` |
| `unbind_world_account` | reducer | `server-module/src/world_binding.rs` | it deletes the `world_account` row |
| `serde` | crate | `server-module/Cargo.toml` | it serves `account_checks.rs` |
| `serde_json` | crate | `server-module/Cargo.toml` | it serves `account_checks.rs` |

### 5.9 Not measured

- **Steam's Web API ticket**, for C. Steamworks is not available here.
- **TLS.** Every probe request was plain `http:`, so the handshake's share of the 3 s timeout over
  the internet is unknown.
- **Whether the host keeps a procedure's arguments.** This decides whether a spent ticket's text
  stays in the host's data. A spent ticket opens nothing.
- **What the character move costs** for a player with a full collection.
- **Every round trip over the internet.** The probe's server was on the host's own machine.
  `POST /world/check` must answer well inside the procedure's 3 s timeout.
