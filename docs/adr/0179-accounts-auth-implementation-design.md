# 0179 — Accounts & authentication implementation design: OIDC gate, guest-claim, and the re-key SSOT

**Status:** Accepted
**Date:** 2026-08-08
**Slice:** heavy-ceremony M21 planning pass (pre-slice; implementation elaborates in m21a/m21b/m21c
per `specs/monster-realm-v2/M21-accounts-auth.spec.md` §5)
**Supersedes:** —
**Amends:** ADR-0030 (elaborates it into a concrete schema/reducer/client design; clarifies its email
consequence line), ADR-0154 (extends the owner-scoped-view + single-surface pattern to a second
never-delete table), ADR-0150 (extends the client token-handling contract to a second, short-lived
credential class — additive, does not reverse the anonymous-token logic D2/D3 established)
**Subsystems:** security-authz, schema-persistence, economy-quests, client-network
**Decision:** New `accounts.rs` domain module gated by a write-scoped module-isolation invariant
(writes only `account`/`guest_claim`/`guest_claim_reaper_schedule`; delegates every other table write
to a `rekey_*` helper in that table's owning module); a client-minted 256-bit guest-claim secret
(never server RNG); `client_connected` lazy-provisions an `account` row behind a mandatory
issuer-**and**-audience check; guest-claim completion is guarded by three checks (liveness, battle,
destination-collision) rather than mirroring `on_disconnect`'s five-table cleanup; `player_wallet`
and `profile` are re-keyed in place and never deleted; the client replaces stored-token replay with
silent OIDC renewal for authenticated tabs.

## Context

ADR-0030 (accepted, harness spec corpus) made the top-level call for M21: delegate authentication to
an OIDC provider, derive a stable `Identity` from the verified token, add an owner-private `account`
record plus a one-time guest→account claim. **This ADR does not re-decide that call** — it is the
concrete implementation design that ADR-0030 named as a follow-up ("confirm the exact
OIDC/identity-from-token mechanism against the pinned STDB version").

That design was produced by the harness's heavy-ceremony planning pipeline
(`memory/projects/mr-feedback-doctrine.md` §6): an investigation pass, six independent brainstormers
each refined by their own adversarial reviewer, a judge synthesis, and a second adversarial review of
that synthesis. The second review independently re-verified every repo/toolchain citation from the
first synthesis draft against the live `monster-realm` tree and the pinned `spacetimedb 1.12.0`
crate/docs, found all of them accurate, and additionally found:

1. **A build-blocking self-contradiction in the first synthesis draft.** Its own module-isolation
   invariant (D0 below) was stated table-scoped, but its own worked example for guest-claim
   completion read `ctx.db.player()` and wrote across four more tables directly inside `accounts.rs`
   — which the invariant's own proposed gate would have flagged on the design's own reference
   implementation, i.e. the design would have failed its own first `just eval` run. Caught here
   instead of during an unattended build.
2. **A missing OIDC audience check.** The vendor's own canonical `client_connected` pattern —
   confirmed present in the *pinned* `version-1.12.0` docs by direct fetch, not just latest — checks
   both `iss` and `aud`; the first draft checked only `iss`, which does not scope a multi-tenant
   issuer to this application.
3. **A missing index on the claim-reaper's disarm-path column**, inconsistent with the repo's own
   cited precedent (`battle_challenge_reaper_schedule`, ADR-0126).
4. **An unsound client token-handling design**: treating an expiring OIDC JWT the way the codebase
   already treats the long-lived anonymous token (persist-and-replay) silently drops a returning
   account holder into a fresh anonymous identity on effectively every reconnect past the JWT's
   lifetime.
5. **An inconsistently-applied documentation-version caveat** on SpacetimeAuth's Steam support (see
   OQ1 in the spec).

The decisions below are the corrected design. Full evidence log, scoring rubric, and the mandatory
attribution table (which brainstormer contributed which surviving element, and why each rejected
element was rejected) live in the ceremony transcript; this ADR records only the decisions and their
load-bearing rationale.

**Finalization pass (same date, post-acceptance).** Two further independent adversarial reviews
(security/red-team; spec-and-ADR completeness) were run against this ADR and the spec together before
build start. They found: a **CRITICAL** unbounded ranked-rating duplication path (the same guest
identity could donate its ladder stats to an unlimited number of fresh accounts across
disconnect/reconnect cycles, because only the *destination's* claim history was ever tracked, never
the *source's*); a **CRITICAL** gap where no acceptance criterion or gate enforced single-use
consumption of a successfully-completed claim code, leaving a same-code replay window open for up to
the full 15-minute TTL; a **HIGH** false-positive risk in the `REKEY_COMPLETENESS` gate as originally
specified (a raw whole-file `: Identity,` scan matches ~17 pre-existing function-parameter sites that
are not table columns at all); and several smaller completeness gaps (no-PII-in-logs never addressed
for this milestone, two reducer entry preconditions untested, a redundant/unreachable AUTH criterion,
an unspecified `guest_name` provenance). All are fixed in the decisions below — see D2, D4, D6, D7,
the Gates table, and the spec's AUTH-25/AUTH-30/AUTH-34..AUTH-38.

## Decision

**D0 — Module write-isolation is WRITE-scoped, not table-scoped.** `accounts.rs` may insert, update,
or delete rows only in `account`, `guest_claim`, and `guest_claim_reaper_schedule`. Every write to any
pre-existing table must go through a `pub(crate) fn rekey_*(ctx, from, to)` helper living in that
table's owning module. Bare reads of other tables are permitted directly from `accounts.rs` — a read
cannot corrupt another module's write-surface invariant, and none of the project's existing security
evals gate a read except one (see below) — but where an existing shared predicate already covers a
check, it must be reused rather than re-derived inline.

This is forced by three live gates, all confirmed against the actual eval sources this pass:
`evals/ranking-security.eval.mjs` criterion A2 bans `ctx.db.profile()` anywhere outside `ranking.rs`,
via a recursive scan (`findProfileAccessOutsideRanking`) that automatically covers a new
`accounts.rs`; `evals/currency-integrity.eval.mjs` criterion 6 (ACCESSOR_BYPASS) bans
`player_wallet()`/`PlayerWallet{` in any file under `server-module/src` outside
`economy.rs`/`schema.rs`/`economy_tests.rs`, and its regex matches `.find()` calls too — i.e. it gates
*reads*, not just writes, which is why even a read-only wallet-existence check must delegate to
`economy::wallet_exists` rather than touch `ctx.db.player_wallet()` itself; `evals/monster-dual-write.eval.mjs`
requires every function body that writes `monster` to also write `monster_pub` in the *same* body.

*Correction recorded during this ceremony's review pass:* the design's first draft stated this
invariant table-scoped, and its own `complete_guest_claim` worked example read `ctx.db.player()`
directly and called a bespoke five-table `assert_no_live_interactions` helper — which the invariant's
own gate (as then specified) would have flagged. The corrected, write-scoped statement above, plus
D5's replacement guard design below (which proves most of that five-table assert was redundant given
`on_disconnect`'s fixed cleanup ordering, and delegates the one non-redundant check to an existing
SSOT), closes the contradiction. `guards.rs` is itself the proof that a cross-cutting shared module is
normal in this codebase — it hosts `require_owner`, `require_pvp_participant`, and escrow helpers
called from `economy.rs`, `pvp.rs`, `trading.rs`, and `movement.rs` alike (`guards.rs:63,286-309,326`)
— the invariant needed to be precise about *writes*, not blanket-ban all cross-module *reads*.

**D1 — Provider-agnostic gate: `ALLOWED_ISSUERS` and `ALLOWED_AUDIENCE`, both mandatory.** The
module depends on exactly two constants; OIDC provider selection is an open product/ops question (see
the spec's OQ1), not an engineering fork — the module code is identical regardless of provider.
`Identity = Identity::from_claims(iss, sub)` (confirmed against
`spacetimedb-lib-1.12.0/src/identity.rs:196`, BLAKE3 of `"{issuer}|{subject}"`), which is why the
issuer/subject pairing becomes permanently load-bearing at first sign-up: changing the issuer URL
later re-mints every player's `Identity`. Checking `iss` alone does not scope a multi-tenant issuer
(a shared IdP serving several applications, or a general provider like Google/Auth0) to *this*
application — any validly-signed token from an allowed issuer, minted for an unrelated app, would
pass an issuer-only check. The vendor's own canonical `client_connected` example — confirmed present,
byte-structurally identical, in the *pinned* `docs/versioned_docs/version-1.12.0/00200-core-concepts/00500-authentication/00500-usage.md`,
not merely the latest docs — pairs every issuer check with an audience check under the heading
"Restricting auth providers." This design follows that pairing as a hard requirement, not optional
hardening.

**D2 — Schema.** Two new tables, both PRIVATE (no `public`):

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug, spacetimedb::SpacetimeType)]
pub enum AccountStatus { Active, PendingDeletion }

#[spacetimedb::table(name = account)]           // PRIVATE
pub struct Account {
    #[primary_key] pub identity: Identity,
    pub auth_issuer: String,
    pub created_at_ms: i64,
    pub last_login_at_ms: i64,
    pub status: AccountStatus,
    pub deletion_requested_at_ms: Option<i64>,
    pub claimed_from: Option<Identity>,
    pub claimed_at_ms: Option<i64>,
}

#[spacetimedb::view(name = my_account, public)]
fn my_account(ctx: &spacetimedb::ViewContext) -> Option<Account> {
    ctx.db.account().identity().find(ctx.sender)
}

#[spacetimedb::table(name = guest_claim)]        // PRIVATE
pub struct GuestClaim {
    #[primary_key] pub guest_identity: Identity,
    #[unique]      pub code: String,   // 64 lowercase hex chars, CLIENT-minted, stored plaintext
    pub guest_name: String,            // informational snapshot only
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

#[spacetimedb::table(name = guest_claim_reaper_schedule, scheduled(guest_claim_reaper))]
pub struct GuestClaimReaperSchedule {   // PRIVATE
    #[primary_key] #[auto_inc] pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub guest_identity: Identity,
}
```

`my_account` mirrors `my_wallet` (ADR-0154 D1/D2): `public` on the `#[view]` attribute is a mandatory
keyword with no visibility effect of its own (per-caller scoping comes from the host ABI
reconstructing `sender`) — the body is the entire security boundary, and it must stay pinned to
exactly this expression, not merely contain it as a substring (ADR-0154 D2's decoy-`find` attack
applies identically here).

`GuestClaim.code` uses `#[unique]` alone, with no adjacent `#[index(btree)]` — this repo's existing
convention (`npc.npc_id` is `#[unique]` with no adjacent index, confirmed this pass) — since a
`#[unique]` column already supports `.find()`.

`GuestClaimReaperSchedule.guest_identity` carries `#[index(btree)]` specifically so the disarm path
can `.guest_identity().filter(...)` (collect-then-delete) instead of a full-table scan — matching the
`battle_challenge_reaper_schedule` precedent (`pvp.rs:101-109`, ADR-0126), whose `challenge_id` column
carries the identical index for the identical reason.

**No `email`, `email_hash`, or `auth_subject` column** — see D9.

`GuestClaim.guest_name` is populated server-side, from the guest's own
`ctx.db.player().identity().find(ctx.sender).name`, at `start_guest_claim` time — never a second
reducer argument. `start_guest_claim`'s only parameter is `code: String` (D3 point 3); nothing in this
design accepts a client-supplied display-name string for this field, and it must not gain one — it is
rendered back only to the same person completing the claim (a confirmation UI), never to a third
party.

**D3 — The claim secret is client-minted.** `ctx.rng()`/`ctx.random()` is seeded from
`self.timestamp` (`rng.rs:50,128-133`) and the crate's own doc comment states plainly: "because it is
seeded from a publicly-known timestamp, it is not cryptographically secure" (`rng.rs:104-107`). A
server-minted claim token is therefore brute-forceable at roughly the seed space implied by the
attacker's timing uncertainty — for a TTL measured in tens of seconds, on the order of 10⁷ candidate
seeds, trivially enumerable. The fix moves entropy generation to the client:

1. Client generates `code = hex(crypto.getRandomValues(new Uint8Array(32)))` — a real browser CSPRNG,
   256 bits.
2. Client writes `code` to sessionStorage (same store, same key-namespace discipline as
   `authToken.ts`, ADR-0150 D3) *before* calling the reducer.
3. `start_guest_claim(code: String)` binds `code → ctx.sender` — the identity comes from
   `ctx.sender` at mint time, never from an argument, preserving ADR-0030's anti-spoofing rule: the
   argument is a secret the caller invented, not an authorization fact.
4. The server performs zero randomness for this flow.

Because entropy is now real and large, TTL stops being a security parameter and becomes orphan
hygiene only. **TTL = 15 minutes** — covers a redirect through an OIDC provider including MFA or a
magic-link round trip. `battle_wild.individuality_seed` is the repo's existing precedent for storing
a secret plaintext in a private table with no hashing (`schema.rs:388-401`) — though that secret's
threat model differs (must never be read by *anyone*, including the owner), the claim `code`'s
secrecy need only hold against *other users*, and 256 bits of client-minted entropy holds that
regardless of TTL.

**D4 — `client_connected` is a new lifecycle reducer.** `lib.rs` currently declares only `init`,
`sync_content`, and `client_disconnected` (confirmed this pass) — there is no `client_connected` hook
today.

```rust
#[spacetimedb::reducer(client_connected)]
pub fn on_connect(ctx: &ReducerContext) -> Result<(), String> {
    // Anonymous play is first-class. Returning Err here DISCONNECTS the client
    // (crate doc, lib.rs:540-546: "If an error occurs in the reducer, the client
    // will be disconnected."). The vendor's canonical example for this hook
    // REJECTS JWT-less connections — do not copy that pattern here.
    if !ctx.sender_auth().has_jwt() { return Ok(()); }
    accounts::provision_or_touch_account(ctx)
}
```

`provision_or_touch_account` checks `ALLOWED_ISSUERS` then `ALLOWED_AUDIENCE` (D1), then inserts a
fresh `Active` `Account` row or updates only `last_login_at_ms` on an existing one. It does not reject
`PendingDeletion` at connect time — rejecting there would strand the cancel-deletion path; see D7.

Reject-path logging discipline (ADR-0029, every-milestone no-PII-in-logs invariant): if either the
issuer or the audience check calls `guards::log_reject` (`guards.rs:47`) on rejection, the `reason`
argument must be a static literal — never a string interpolating the token's `iss`, `sub`, or `aud`
value. `client_connected`'s reject paths (AUTH-2/AUTH-3) are exactly where a raw claim would otherwise
leak into a log line while debugging a rejected login; AUTH-36 pins this and G12 gates it.

**D5 — Guest-claim completion: three guards, reused where possible, not a mirror of
`on_disconnect`.** SpacetimeDB has no in-place identity upgrade, so the guest connection must end
before the authenticated one begins. `on_disconnect` (`lib.rs:194-219`) runs, in this fixed order,
strictly before the `player` row is deleted: `trading::cancel_trades_on_disconnect`,
`pvp::forfeit_on_disconnect`, `battle::resolve_wild_battle_on_disconnect`,
`pvp::cancel_challenges_on_disconnect`, an inline `player_conversation` delete, then finally
`character` + `player` delete. Confirmed against `lib.rs` verbatim this pass.

That fixed ordering means the guest's `player` row's presence is itself a sufficient liveness oracle
— its absence proves all four prior cleanup steps already ran. `complete_guest_claim` therefore needs
only:

1. **Liveness (T15):** reject if `ctx.db.player().identity().find(guest)` is `Some` — "close your
   other tab, then retry." A bare read, permitted under D0's write-scoped carve-out; `player` has no
   single owning module in this codebase (`movement.rs`, `lib.rs`, `guards.rs` all read it directly
   today), so no delegation seam exists to force here.
2. **Battle liveness (residual, defense-in-depth):** reject if
   `guards::is_in_ongoing_battle(ctx, guest)` or `guards::is_in_ongoing_battle(ctx, caller)` — the
   repo's existing SSOT predicate (`guards.rs:302-309`, ADR-0122 D1: "the single SSOT ongoing-battle
   predicate for every reducer, PvE and PvP alike"). Guard 1 passing already implies the guest's
   trade/battle/challenge/conversation rows are gone (they're all cleared before the `player` delete
   in `on_disconnect`'s ordering); this check exists only so that if that ordering invariant is ever
   violated by a future change, this is the check that catches it — without `accounts.rs` touching
   `ctx.db.battle()` itself.
3. **Destination collision (T12, fail-closed):** reject if `accounts::account_has_game_data(ctx,
   caller)` is true — "claim your guest progress before you start playing." `join_game` grants a
   monster unconditionally on first play, so any account that has ever played has at least one REKEY
   row; without this guard, "sign up → play a bit → then claim" would silently clobber or PK-collide
   the caller's own data. This must fail closed, never merge.

Rejected: a bespoke `assert_no_live_interactions` helper reading `battle`, `battle_action`,
`trade_offer`, `battle_challenge`, and `player_conversation` directly from `accounts.rs`. Five tables
with no delegation seam, no existing precedent to model it on, and — as the D0 correction above notes
— a direct violation of the module-isolation invariant as originally (and now correctly) stated. The
three-guard design above proves four of those five checks redundant given `on_disconnect`'s ordering
and delegates the one non-redundant check to an existing SSOT: fewer lines, no new table coupling, no
D0 violation, same guarantee.

Reducers are fully serialized single-threaded WASM (ADR-0106 D8 precedent) — no TOCTOU exists between
these guards and the re-key that follows them; atomicity is free.

**D6 — Re-key manifest is the SSOT.** `accounts::rekey_all` calls only delegated helpers, in this
order, one per REKEY-policy table:

| Table | Identity column(s) | Policy | Owner module / helper |
|---|---|---|---|
| `monster` + `monster_pub` | `owner_identity` | REKEY — both updated in **one fn body** | `monster_mgmt::rekey_monsters` |
| `inventory` | `owner_identity` | REKEY | `inventory::rekey_inventory` |
| `player_quest` | `owner_identity` | REKEY | `npc::rekey_npc_state` |
| `player_dialogue_state` | `owner_identity` | REKEY | `npc::rekey_npc_state` |
| `heal_cooldown` | `owner_identity` | REKEY | `raising::rekey_heal_cooldown` |
| `player_wallet` | `owner_identity` | REKEY, **never delete**: `economy::grant_currency(ctx, caller, guest_balance)` (real 3-arg signature — `owner: Identity, amount: u64`, confirmed against `economy.rs:29`) then zero the guest's row in place. Must live in `economy.rs` — ACCESSOR_BYPASS bans even a read of `player_wallet()` from elsewhere. | `economy::rekey_wallet` |
| `profile` | `identity` | REKEY, **never delete** (ADR-0119 D1's structural never-deleted scan would fail otherwise): copy `rating`/`wins`/`losses` forward to the caller's row, **then zero `rating`/`wins`/`losses` on the guest's own row** (mirrors `player_wallet`'s credit-forward-then-zero, row above) and overwrite its `name` with `PROFILE_TOMBSTONE_NAME` (≤ `MAX_NAME_LEN` = 24, `lib.rs:74`; `profile.name` carries no DB uniqueness constraint, confirmed this pass, so multiple tombstoned rows never collide). The zero step is load-bearing, not cosmetic: without it the same guest identity's stats remain fully intact and copyable to an unbounded number of *subsequent* fresh accounts (disconnect → new claim code → new destination, repeatable indefinitely — a security-review finding fixed in this revision; see AUTH-25). Must live in `ranking.rs`. Not a `#[reducer]`, so `ranking-security.eval.mjs` A1's "exactly one reducer" count is unaffected. | `ranking::rekey_profile` |
| `player` | `identity` | BLOCKED — guard 1 rejects if present | — |
| `player_conversation` | `owner_identity` | BLOCKED — transitively covered by guards 1/3 | — |
| `battle` | `player_identity`, `opponent_identity` | BLOCKED — guard 2 | — |
| `battle_action` | `player_identity` | BLOCKED — transitively covered (requires an ongoing `battle`) | — |
| `trade_offer` | `initiator`, `counterparty` | BLOCKED — transitively covered by guards 1/3 | — |
| `battle_challenge` | `challenger`, `target` | BLOCKED — transitively covered by guards 1/3 | — |
| `playtest_event` | `identity` | **EXEMPT: dev telemetry**, deliberately stays under the guest identity; M22's cascade erases it | — |
| `config` | `owner_identity` | **EXEMPT: module-owner sentinel**, default is the zero-identity, never a player (`schema.rs`, confirmed this pass) | — |
| `character`, `battle_wild`, `encounter` | — | N/A — no `Identity` column (confirmed by exhaustive grep) | — |

This table was independently re-derived by grep against the live schema during this ceremony's review
pass and found exhaustive — including `playtest_event.identity` (`playtest.rs:16-21`), which no
brainstormer in the ideation stage had enumerated by memory, proving the point that this manifest must
be built and *gated* mechanically, not maintained by hand.

The gate (`REKEY_COMPLETENESS`) scans only the field list of each `#[spacetimedb::table(...)]`-tagged
struct for `: Identity` / `: Option<Identity>` fields — **not** a raw whole-file `: Identity,` line
match. A finalization-pass review confirmed the naive whole-file scan false-positives on ~17
pre-existing function-parameter sites that are not table columns at all (e.g.
`guards::require_owner`'s `owner: Identity,`, `pvp::start_pvp_battle`'s `challenger`/`opponent`
params) — implementing the gate as originally worded would either false-fail on day one or force an
undocumented AST-aware rewrite mid-build. The gate also checks *consumption*, not just declaration:
every REKEY-policy entry's helper name must be referenced from both `rekey_all`'s call chain and
`account_has_game_data`'s existence-check list — a manifest entry with a policy but no corresponding
call in either site (e.g. a future table correctly added to the manifest but never wired into
`rekey_all`) would otherwise pass G6 while silently orphaning data on every claim.

After `rekey_all` returns successfully, `complete_guest_claim` calls
`consume_claim_and_disarm(ctx, code)` — the same helper the expiry-reaper path (AUTH-27) already uses
— to delete the `guest_claim` row and disarm its `guest_claim_reaper_schedule` row in the same
transaction, before returning `Ok`. This is the single-use guarantee (AUTH-34/AUTH-35, gated by G11):
without it, a claim code remains valid in the private table for up to the full 15-minute TTL after a
*successful* claim, and the code is trivially available to the guest identity itself (it minted it),
letting the same code be replayed against a second fresh account.

`account_has_game_data(ctx, identity)` checks every REKEY row-class for that identity, delegating
identically (`economy::wallet_exists`, `ranking::profile_exists`, `monster_mgmt::has_monsters`,
`inventory::has_items`, `npc::has_quest_or_dialogue_state`, `raising::has_heal_cooldown`). The
`account` row itself never counts.

Rejected: a `declare_owner_keyed_table!` macro registry (considered during ideation as a way to force
completeness via the type system). Zero `macro_rules!` precedent exists anywhere in
`server-module/src` or `game-core/src` (confirmed this pass) — a plain `const` manifest plus a
static-scan gate gives the identical completeness guarantee without introducing metaprogramming as an
unattended-build sub-task.

**D7 — `delete_account` ships its M21 half only.** `delete_account(ctx)` requires a JWT — reject any
caller with no JWT (AUTH-37) — sets `status = PendingDeletion` and
`deletion_requested_at_ms = Some(now)`, idempotently. `cancel_account_deletion(ctx)` reverses it,
idempotently, including as a no-op when the account is already `Active` (AUTH-38) — so
`PendingDeletion` is never a trap state within M21's own scope.

M21 gates `PendingDeletion` in exactly **one** place: `complete_guest_claim`, via a small
`pub(crate) fn accounts::is_pending_deletion(ctx, identity) -> bool` predicate — a deliberate SSOT,
mirroring D5's reuse of `guards::is_in_ongoing_battle`, so M22's many additional gameplay call sites
(the full gate this milestone hands off) reuse this helper rather than re-deriving the check.
`start_guest_claim` needs no separate `PendingDeletion` check: AUTH-7 already unconditionally rejects
any JWT-holding caller from `start_guest_claim`, and only a JWT-authenticated identity can ever hold
an `account` row — so `PendingDeletion` can never be true for a caller who reaches that far.
*Correction recorded during the finalization review pass:* the design's prior draft pinned this gate as
an independently-testable criterion (AUTH-30) covering both reducers. The `start_guest_claim` half was
logically unreachable; the `complete_guest_claim` half turned out to be a verbatim duplicate of
AUTH-13 (which already mandates rejecting a `PendingDeletion` caller there). Neither half survives as
an independent criterion, so AUTH-30 was removed outright rather than merely trimmed.

Full gameplay gating, the grace window, and the deletion cascade are M22's, and — per ADR-0031's own
accepted text, confirmed verbatim this pass ("`delete_account` cascades over it [the registry]") — M22
extends *this same reducer body*, not a decoupled sweep keyed off the status flag.

No procedures anywhere in this design: `Procedure`/related APIs in the pinned crate are gated behind
`#[cfg(feature="unstable")]`, confirmed against `lib.rs:1018`. No out-of-module revocation poller: it
would introduce a new always-on service, an unsolved service-credential custody problem, and a new
private-table read path, none of which M21's stated scope needs. Provider-side revocation is deferred
to M22 with the question named there, not silently dropped.

**D8 — Client: silent renewal, never JWT replay.** `client/src/net/authToken.ts` (read in full this
pass) persists exactly one opaque string per `(uri, db)` pair in sessionStorage and replays it via
`.withToken()` on every reconnect, with a suppress-not-clear policy (ADR-0150) tuned for the case
where the persisted token is SpacetimeDB's own long-lived anonymous credential — the module's own
header explains this is deliberate because the SDK collapses a transient 500 and a genuine 401 into
the identical error string, so a rejected token must be *withheld*, never *deleted*, on ambiguous
evidence. It carries no concept of an account-vs-anonymous credential (confirmed absent from the
file).

An OIDC-issued account token is a short-lived JWT (typically minutes to an hour). Once its `exp` has
passed, replaying it fails verification on essentially every reconnect past that lifetime — this is
not a rare edge case the existing suppression logic merely mishandles, it is the *expected* steady
state for any returning account holder, and the existing logic's response (after
`AUTH_REJECT_SUPPRESS_THRESHOLD = 2` rejections: withhold the token and reconnect anonymously)
silently drops the player into a brand-new empty anonymous identity with no prompt. The actual
requirement is that an account credential must never be persisted-and-replayed the way the anonymous
token is:

1. `authToken.ts`'s sessionStorage slot continues to serve only the anonymous-reconnect case, exactly
   as today — no change to its existing logic (ADR-0150 D2/D3 preserved, not reversed).
2. For an authenticated tab, `connection.ts` must obtain a *fresh* token on every (re)build — call the
   OIDC client library's own silent-renewal path (refresh-token exchange, or a silent
   iframe/redirect, depending on the provider from OQ1) immediately before
   `DbConnection.builder().withToken(...)`. If silent renewal fails, surface an explicit
   session-expired state that prompts re-authentication — never fall through to an anonymous
   connection with no prompt.
3. A small boolean marker (a companion sessionStorage key, e.g. `mr.authToken.v1.kind`) lets the UI
   layer distinguish "this tab is/was authenticated" from "this tab has only ever been anonymous"
   without decoding the JWT, so the session-expired branch in (2) is reachable at all.
4. The claim code (D3) lives in sessionStorage, same tab; the OIDC flow must return to the same tab
   (same-tab redirect, or popup + `postMessage`) — a fresh tab has empty sessionStorage and is
   therefore a different anonymous identity.
5. `join_game` must not fire on a freshly authenticated identity while an unconsumed claim code
   exists in this tab (otherwise D5 guard 3 would permanently block the claim).
6. A one-time first-run nudge — "Guest progress transfers only from the device you claim it on." —
   mitigates the symmetric multi-device race, which is undetectable server-side. Named accepted
   residual, not solved.
7. Guest display name is not carried across the claim; the shipped rename UI (ADR-0133) already
   covers renaming post-claim.

**D9 — No `email`, `email_hash`, or `auth_subject` column.** Three reasons, independent of each
other: (a) there is no in-module CSPRNG to securely generate an HMAC pepper for an email hash (same
`rng.rs` finding as D3); (b) an unkeyed hash over the email address space is reversible by dictionary,
so it buys nothing without a pepper; (c) even a same-database pepper does not defend the scenario
that would justify keying at all — a full database dump exposes the pepper alongside the hashes. No
reducer or client feature in M21 or M22 scope reads the field; the IdP's own store already owns the
email. This is read as a **clarification** of ADR-0030's consequence line ("email/PII is
must-never-leak → hashed/private"), not a reversal — that line describes storage discipline *if*
email is captured; this design captures none. See the Amendments section below and the spec's OQ3 for
the governance ack this needs.

**D10 — No `CONTENT_VERSION` bump.** `account`, `guest_claim`, and `guest_claim_reaper_schedule` are
runtime tables, not seeded content — mirrors the M15 D7 / `trade_offer` precedent (ADR-0106).

## Gates

Every checker below needs a BAD fixture it must flag and a GOOD fixture it must pass (ADR-0010
proof-of-teeth discipline):

| ID | Gate | Enforces |
|---|---|---|
| G1 | `evals/account-privacy.eval.mjs` | `account`/`guest_claim` declared without `public`; `my_account` body-exact pin; `ViewContext::new(`/`ViewContext {` banned in `accounts.rs`+`schema.rs` (the constructor is public per `lib.rs:902-908` — a real forgery vector); bindings probe (`account_table.ts` absent, `my_account_table.ts` present) |
| G2 | `evals/guest-claim-integrity.eval.mjs` — NO_CLIENT_IDENTITY | No reducer in `accounts.rs` declares an `Identity`-typed parameter |
| G3 | same file — ANON_PASSTHROUGH + ISSUER_AND_AUDIENCE_CHECKED | `on_connect`'s first statement is the `has_jwt()` early return with no prior `Err`; `provision_or_touch_account`'s body contains both an `.issuer()` comparison and an `.audience()` comparison — a BAD fixture checking only `iss` must fail |
| G4 | same file — NO_SERVER_RNG | `ctx.rng(`/`ctx.random(` absent from `accounts.rs` |
| G5 | same file — MODULE_WRITE_ISOLATION | No `.insert(`/`.update(`/`.delete(` chained off `ctx.db.<t>()` in `accounts.rs` for any `t` other than `account`/`guest_claim`/`guest_claim_reaper_schedule`; literal `ctx.db.battle(` also banned (forces the `guards::is_in_ongoing_battle` indirection); bare reads of `player`/`trade_offer`/`battle_challenge`/`player_conversation` permitted |
| G6 | same file — REKEY_COMPLETENESS | Scans only the field list of each `#[spacetimedb::table(...)]`-tagged struct in non-test `server-module/src/*.rs` for `: Identity`/`: Option<Identity>` fields (NOT a raw whole-file line match — that false-positives on ~17 function-parameter sites, e.g. `guards::require_owner`'s `owner: Identity,`); every such field has an explicit manifest policy; every REKEY-policy entry's helper is referenced from both `rekey_all` and `account_has_game_data` (consumption-completeness, not just declaration-completeness); manifest non-empty; `playtest_event` resolves to EXEMPT |
| G7 | `accounts_tests.rs` | Rust-side mirror of G2–G6 and G11 (toolchain-boundary defense in depth, the `ranking-security.eval.mjs` precedent) |
| G8 | extend `evals/ranking-security.eval.mjs` | Positive fixture proving `rekey_profile` stays green under A2 and doesn't change A1's reducer count |
| G9 | extend `pvp_tests.rs::m17a_rl2_profile_never_deleted_scan` | Add `accounts.rs` + new rekey helper files to its hardcoded `include_str!` list (currently 13 files) |
| G10 | extend `evals/currency-integrity.eval.mjs` | Negative assertion: `accounts.rs` never added to the ACCESSOR_BYPASS allowlist |
| G11 | same file [`guest-claim-integrity.eval.mjs`] — SINGLE_USE_CONSUMED | `complete_guest_claim`'s success (`Ok`) return path calls `consume_claim_and_disarm` before returning; a BAD fixture that only disarms on the expiry branch (leaving the success path unconsumed) must fail (AUTH-34/AUTH-35) |
| G12 | extend `evals/account-privacy.eval.mjs` — NO_PII_IN_REJECT_LOGS | No `guards::log_reject` call inside `on_connect`/`provision_or_touch_account` interpolates a JWT claim value (`iss`/`sub`/`aud`) into its reason string — reason strings must be static literals (ADR-0029; AUTH-36) |

## Amendments

- **To ADR-0030:** the "email/PII is must-never-leak (ADR-0015 → hashed/private)" consequence line is
  clarified to mean "if email is ever captured, it must be hashed/private" — this design captures no
  email at all (D9), because no secure hash pepper can be generated in-module and no consumer needs
  the field. This is a governance ack, not a build fork: the schema already ships without the field as
  its default. Needs an explicit ack from Drew (spec OQ3), not a design decision pending on him.
- **To ADR-0154:** extends the owner-scoped `#[view]` + single-write-surface pattern established for
  `player_wallet`/`my_wallet` to a second table (`account`/`my_account`) and, separately, extends
  `player_wallet`'s never-delete discipline with a second write path into it
  (`economy::rekey_wallet`, called only from `accounts::rekey_all`) that still routes through the
  single sanctioned mutation surface in `economy.rs`.
- **To ADR-0150:** extends the client token-handling contract with a second, short-lived credential
  class (an authenticated-tab OIDC JWT) that must never be persisted-and-replayed the way the
  long-lived anonymous credential is (D8). This is additive — ADR-0150's D2 (suppress-not-clear) and
  D3 (sessionStorage, not localStorage) are unchanged for the anonymous path; nothing here reverses
  them.
- **Module-boundary note:** D0 above is stated write-scoped, not table-scoped, deliberately — see D0's
  own text for why the narrower (table-scoped) statement was tried first during this ceremony and
  found to conflict with its own worked example.

## Consequences

- Positive: no game-data schema churn beyond the two new tables — the M2 identity-keying decision
  pays off exactly as ADR-0030 predicted. Accounts remain provider-agnostic at the code level;
  switching providers later only changes `ALLOWED_ISSUERS`/`ALLOWED_AUDIENCE` and deployment config.
  The D6 manifest gives M22 a ready-made, mechanically-verified registry rather than a fresh
  hand-enumeration.
- Negative / accepted risk: IdP database loss permanently orphans every account
  (`Identity = f(iss, sub)`) if self-hosting is chosen (OQ1) — named, not silently accepted, and a
  launch prerequisite either way. The multi-device guest-claim race (claiming from device A while
  still playing on device B) is undetectable server-side and is mitigated only by a first-run nudge
  (D8.6), not solved. A claimed guest who had ranked-ladder history leaves a permanent **zeroed,
  tombstoned** ladder-entry stub behind (rating/wins/losses reset to 0 the moment they're copied
  forward — never a donatable duplicate, D6) unless OQ2 is answered "accounts required for ranked"
  before build. `start_guest_claim` has no per-identity/per-IP rate limit — anonymous connections are
  free by design (D4), so a script could flood the private `guest_claim`/`guest_claim_reaper_schedule`
  tables; accepted for M21 (bounded by attacker connection throughput, self-cleaning via the
  15-minute reaper), named rather than silently unaddressed. Revisit if abuse is observed.
- Follow-ups: OQ1 (provider) must be answered before M21b's client redirect wiring and before
  deployment; OQ2 (ranked-requires-account) should be answered before or during M21a since it changes
  whether `ranking::rekey_profile` exists at all; OQ3 (email governance ack) needs a reply on this
  ADR's Amendments section but gates no build task. M22 consumes the D6 manifest and extends
  `delete_account`'s body per D7.
