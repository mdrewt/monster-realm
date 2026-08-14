# 0189 — Ranked play requires a full account: server enforcement at both PvP handshake gates

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 14r-g (M-postgate fourteenth-review residuals §14r-g)
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, battle
**Decision:** Both PvP handshake reducers reject unless both parties hold an `account` row (`is_account_holder`, never `has_jwt()`), via one pure `ranked_account_gate` seam before any irreversible effect; inert until a real issuer is configured.

## Context

Issue **mdrewt/monster-realm#307** (Drew's rev13 decision, consumed and closed 2026-08-13) is
the deciding authority: **ranked play requires a full (non-guest) account.** This resolves
ADR-0179's OQ2, which shipped at the default answer "no" — `challenge_pvp` and
`accept_challenge` gated only on a `player` presence row, so guests could enter ranked, and
every human-vs-human battle **is** ranked (`is_ranked_pvp`, `guards.rs`; ADR-0119 D4).

Decision-hook **mdrewt/monster-realm#313** (rev14-guest-rating-legacy) was answered by Drew on
2026-08-14: no PvP ladder ratings have ever been earned by guests, the database is wiped before
each playtest, "just go with the easiest solution" — so **no migration step exists in this
slice at all** (D7).

The deployment reality that shapes D6: `accounts::ALLOWED_ISSUERS` is the **fail-closed
RFC-2606 `.invalid` placeholder** under ADR-0182 D18's hard sequencing gate (flips only when
OQ1/13r-c-2 lands a real auth provider). The only code path that ever creates an `account` row
sits behind that allowlist, so **no identity in any environment — local, CI, playtest — can be
an account holder today.** An unconditionally-active gate would therefore (a) disable PvP for
100% of identities everywhere including production playtests, and (b) red the three CI
merge-gate e2e specs that drive guest challenge→accept (`client/e2e/pvp-full.spec.ts`,
`pvp-side-b.spec.ts`, `ranked-forfeit.spec.ts`), while protecting nobody (there is no account
population whose ladder needs defending yet).

## D1 — The two handshake reducers are the complete ranked-battle cover

`start_pvp_battle` is called from exactly one site (`accept_challenge`); `start_battle`
(battle.rs) rejects any non-self, non-WILD opponent, so no other path can construct a
human-vs-human battle; and `is_ranked_pvp` classifies every human-vs-human battle as ranked.
Gating `challenge_pvp` + `accept_challenge` therefore covers all ranked-battle creation. Wild
encounters and practice self-battles (the "friendly" class) are untouched — guests keep full
PvE access. The cover is **pinned mechanically**: within `pvp.rs`, EA-RA-04 and
ranking-security criterion D `[D/ctor-cover]` count `start_pvp_battle` (bare token, so a
fn-pointer alias also trips) == 2 and `.battle().insert(` == 1; and because
`start_pvp_battle` is `pub(crate)`, `[D/ctor-cover-crossfile]` additionally requires the bare
token to appear in **zero** other non-test domain files (any cross-file call must name the
symbol at least once, `use`-alias included — the criterion-B2/AM-1 logic). A future second
constructor, in-file or cross-file, reds the gate.

## D2 — `is_account_holder` is the predicate, never `has_jwt()`

`accounts::is_account_holder` (account row exists) is the SSOT: only a verified
allowed-issuer/audience token ever produces an `account` row. `has_jwt()` is true for **every**
connection (anonymous SDK connections carry the host's own token) and would make the gate
vacuous. Calls are **fully qualified** (`crate::accounts::is_account_holder(`) so a local
module shim cannot silently redirect them, and `pvp.rs` never touches `ctx.db.account()`
directly (pinned: `has_jwt` count == 0, `ctx.db.account(` count == 0 file-wide).

## D3 — The accept-time re-check is load-bearing, not redundant

The invariant is anchored at battle creation: *no ranked battle exists unless both parties held
accounts at `start_pvp_battle` time.* The challenge-time gate is UX fail-fast; the accept-time
gate is the enforcement point. It covers (a) `Pending` challenge rows created **before**
enforcement activation, and (b) any future account-revocation path. Today holder status is
effectively irrevocable (`delete_account` only flips status to `PendingDeletion`; nothing
hard-deletes an `account` row) — this is defense-in-depth **by design**; do not "simplify" it
away. At activation, in-flight guest-vs-guest `Pending` challenges become unacceptable; the
challenge TTL reaper (ADR-0126) collects them, so no softlock.

## D4 — `PendingDeletion` accounts still count as holders

`is_account_holder` is status-blind by spec. Gating `PendingDeletion` identities out of ranked
is gameplay-lifecycle policy that M22 owns (`is_pending_deletion` is its documented SSOT);
adding it here would front-run that slice. Recorded so the M22 author sees a deliberate choice,
not an oversight.

## D5 — One pure seam, two distinct static reasons

`ranked_account_gate(enforced, caller_has_account, opponent_has_account) -> Result<(), &'static str>`
is pure (no ctx, no I/O) so its full truth table is unit-tested in-crate — reducer bodies are
not executable in-process, so an inline check would be verifiable only by source scan. The
caller leg is evaluated first (both-guest → caller reason; pinned by the truth table).

Two reasons, not one: `"ranked play requires an account"` (caller leg) vs
`"opponent must have an account for ranked play"` (opponent leg). The distinction is required
for (a) mutation-killing an argument swap (the truth table distinguishes the rows only via the
reason values) and (b) the parked client affordance, which keys a sign-in CTA off the
caller-side string — a merged reason would show a sign-in prompt when the *opponent* is the
guest. The values are a **client contract**: do not reword without updating EA-RA-05, criterion
D, and the client slice. No existence-oracle concern requires merging them (contrast
`ERR_INVALID_CODE`, ADR-0179 D3): account-holding of an online player is observable gameplay
state, and D8 bounds the disclosure.

## D6 — Deployment-conditional activation with a self-expiring canary

The gate is live iff the deployment can actually mint accounts:

- `issuers_configured(issuers: &[&str])` — true iff **any** entry differs from the exact
  committed placeholder (`concat!("https:/", "/auth.monster-realm.invalid/")`, same source-text
  split as `accounts.rs`). Exact equality, not a substring sniff: a mixed allowlist
  (real + leftover placeholder) **enforces** (fail-closed for ranked integrity), and a real
  issuer whose host merely contains `.invalid` counts as real. Empty slice → inert (no issuer
  can mint an account; bricking PvP for everyone would protect nobody).
- `ranked_enforcement_active()` = `issuers_configured(crate::accounts::ALLOWED_ISSUERS)`.
  If the local placeholder const ever drifts from `accounts.rs`'s actual value, enforcement
  flips **on** and the canary reds loudly — drift cannot be silent.

Honest wording: **inert = enforcement OFF** — availability-biased, not "fail-closed" with
respect to EARS-1. The EA-RA-06a canary (`assert!(!ranked_enforcement_active())`) self-expires
the moment OQ1 lands a real issuer; its failure message carries the activation checklist the
flipping slice must complete: **(1)** ship the EARS-3 client affordance (pvpModel/pvpView +
main.ts wiring, claim-prompt reuse), **(2)** convert the three guest-PvP e2e specs to
account-holding identities (the `evals/account-e2e.eval.mjs` `patchAllowedIssuers` apparatus is
the starting point), **(3)** remove the conditional + this canary and update this ADR,
**(4)** regenerate the knowledge bundle, **(5)** confirm no ongoing PvP battles straddle the
flip and settle the ladder-wipe question (the D7 residual).

Enforcement-shape choice: the call sites are pinned by **exact-equality squashed-statement
needles** (tests + eval), which subsume argument identity, the enforced-flag literal, Result
consumption, and module-shim evasions — chosen over the stronger witness-type alternative
(a private-field `RankedOk` proof token demanded by the battle constructor) for diff
minimality. The red-team record (7/7 first-draft evasions) and the witness option are preserved
here for the OQ1 slice to revisit when the conditional is removed.

## D7 — No migration; rekey semantics unchanged (#313)

Nothing migrates: no guest-earned ratings exist and the DB is wiped per playtest (Drew, #313,
2026-08-14). `ranking::rekey_profile`, `tombstoned_profile`, and the G8 tombstone-arg eval pin
**stay** — ADR-0179 predicted OQ2="yes" might make `rekey_profile` unnecessary, but deleting it
is a separate reviewed decision (guest profiles can still exist, and G8 is the live guard
against the rating-donation bypass). Accepted for the dev phase (revisit if playtest wipes stop
before launch): a guest who somehow earns a rating and then claims an account imports that
rating via the claim rekey, and battles in flight at activation settle rated.

## D8 — Oracle residual, bounded

The opponent-leg check runs **after** the target-joined+online guard in `challenge_pvp`, so
account existence is only ever disclosed for a target the caller can already observe online —
never for arbitrary 32-byte identities (the enumeration path ADR-0179 G1/D3 exists to prevent;
`accept_challenge`'s challenger is a joined player by construction). The caller leg is
evaluated first, so a guest caller never learns the opponent's status — the oracle is
available only to account holders, about online joined players. Residual accepted: that one
bit, unthrottled, inherent in EARS-1's distinct-reason requirement; if it ever matters, the
mitigation is the `movement.rs` `RateLimiter` pattern on the reject path, not a guard reorder
(which would fight this decision and its ordering pins).

## Relation to ADR-0179

This ADR resolves ADR-0179 **OQ2** as "yes — ranked requires an account" (authority: #307).
ADR-0179 carries no `Amended-by:` back-link because this slice's declared file set does not
include it (the adr-backlink-integrity eval requires reciprocal edits land together); the
supervisor may add the reciprocal `Amends`/`Amended-by` pair at doc reconcile.

## EARS disposition

- **EARS-1** (guest calls either reducer → distinct reject): implemented; **dormant until
  activation** per D6 (no account can exist today, so the WHEN-clause is currently
  unsatisfiable in every environment). Truth-table + structural + eval coverage prove the
  active-path behavior now.
- **EARS-2** (both hold accounts → admitted unchanged): holds by the truth table's
  `(true, true, true) → Ok` row and the unchanged guard chain; the three existing PvP e2e
  specs prove the inert path behaviorally.
- **EARS-3** (guest PvP UI shows account-required affordance): **parked** as an activation
  prerequisite (D6 checklist item 1) — `client/src/main.ts` and `client/e2e/` are outside this
  slice's declared touches.

## Confirmation

- `server-module/src/pvp_tests.rs` — EA-RA-01 (8-row value-exact truth table), EA-RA-02/03
  (exact-statement pins + depth fence + ordering vs the irreversible effects), EA-RA-04
  (SSOT + ctor-cover counts + stripper-desync canary), EA-RA-04b (seam/reducer symbol
  uniqueness + shadow-assignment bans), EA-RA-05 (reason-value pins), EA-RA-06a/b/c (canary +
  `issuers_configured` matrix + predicate-body pin).
- `evals/ranking-security.eval.mjs` — criterion D (tagged fail-loud clauses mirroring the
  above, toolchain-boundary defense-in-depth) with per-tag proof-of-teeth BAD fixtures that
  are executed in the eval's teeth block before the live checks.
