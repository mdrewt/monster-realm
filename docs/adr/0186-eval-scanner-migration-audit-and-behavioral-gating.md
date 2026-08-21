# 0186 — Eval scanner migration: audit gate, behavioral+structural enforcement, name-derived gating, and parked residuals

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 14r-c (M-postgate fourteenth-review residuals — `specs/monster-realm-v2/M-postgate-fourteenth-review-residuals.spec.md` §14r-c)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz, tooling-docs
**Amended-by:** ADR-0202
**Decision:** `evals/scanner-migration-audit.eval.mjs` gates a name-derived eval set on two legs (a real `rust-scan.mjs` import plus `assertStripperSound`, and no naive stripper anywhere); six evals migrated, seven parked as capped self-retiring debt.

> **Carries out** ADR-0181's disclosed residual — "~24 + ~8 remain" to migrate onto
> `evals/rust-scan.mjs`. The `**Amends:**` field is left empty deliberately: the
> digest gate requires a reciprocal `**Amended-by:**` line in ADR-0181, and that
> file is outside slice 14r-c's declared `touches:` set. A future slice that lands
> the follow-up should add the back-link to ADR-0181.

## Context

ADR-0181 (13r-c) introduced `evals/rust-scan.mjs` — a string-literal-aware Rust
comment and string scanner that lexes both in a single pass — and migrated three
evals (`currency-integrity`, `ranking-security`, `conversation-privacy`/`wallet-privacy`)
onto it. It explicitly disclosed that the hazard class is wider: "~24 + ~8 remain"
(evals that strip `//` comments with no string-literal awareness, or strip
strings *after* comments, making them blind to a Rust URL literal that truncates
at scheme slashes). Several of those offenders are named `*-security.eval.mjs` /
`*-privacy.eval.mjs` — **security and privacy gates** — so the false-GREEN risk is
real and the indicated follow-up is urgent.

This slice is that follow-up, partially executed. It introduces the audit gate,
migrates six more evals, parks seven more as explicit self-retiring debt for
14r-c-2, and corrects several discrepancies in ADR-0181's counts.

## Decision

### D1 — The migration gate is behavioral+structural, not a regex blacklist

`evals/scanner-migration-audit.eval.mjs` is a tracking gate that classifies every
`*-security.eval.mjs` / `*-privacy.eval.mjs` eval as migrated or not. A file
passes only if it satisfies **both** legs:

**Leg 1** requires a REAL static `import ... from './rust-scan.mjs'` (anchored to
an actual import statement — a string literal containing that text does not count)
plus a real `assertStripperSound(` call site somewhere in executable code.

**Leg 2** requires that **no** naive-stripper regex survives anywhere in the file's
executable code — including in private, unexported helpers. It searches for the
naive signatures `[\s\S]*?` (block-comment stripper) and `[^\n]*` (line-comment
stripper), blanking string/template/comment payloads first so decoys inside
literals are invisible.

**Why Leg 2 is load-bearing:** an earlier export-reflection design was bypassed by
a file that adds a correct, exported, but never-called helper while its real ban
clauses keep a private naive helper. Leg 1 sees the import and assert call, both
real; Leg 2 sees the private helper that Leg 1 cannot. Leg 2 is evadable *in
principle* by respelling the regex (e.g. `String.fromCharCode` concatenation), but
it is measured to hold against every naive copy actually in-tree today. Legs 1 AND
2 together are the contract; neither alone is sufficient.

### D2 — The gated set is name-derived, never hardcoded

The gate discovers every `*.eval.mjs` file in `evals/` and gates every one whose
name ends with `-security.eval.mjs` or `-privacy.eval.mjs`. This is derived from
file names via `readdirSync` + suffix matching, so a future eval with those
suffixes is automatically gated the day it lands. **Do NOT call this an anti-hole
property** — the same review established it is under-inclusive. These files read
Rust source and have naive strippers or other anomalies:

- `trade-escrow-guards.eval.mjs` (whole-crate-blob scanner, highest blast radius)
- `pvp-handshake-guards.eval.mjs`, `pvp-challenge-reaper.eval.mjs`, `pvp-deadline-disconnect.eval.mjs`
- `trade-conservation.eval.mjs`, `no-idle-accrual.eval.mjs`
- `ranking-pve-exclusion.eval.mjs`

All escape the name-derived predicate. That gap is **disclosed, not closed**. The
gate REPORTS the content-detected set (using the same Leg 2 detector on all evals)
without enforcing on it; the report helps future slices identify candidates.

### D3 — Parked work is capped, self-retiring named debt, not an exclusion

Seven `*-reducer-security.eval.mjs` files (`battle`, `evolution`, `npc-dialogue-quest`,
`raising`, `recruit`, `shop`, `trade`) remain unmigrated and were budget-parked to
slice 14r-c-2. Each `KNOWN_UNMIGRATED` entry is validated by the gate:

- The file must exist on disk (T1 pins a removal-detection tooth).
- The file must be a member of the gated set (`*-security.eval.mjs` / `*-privacy.eval.mjs`).
- The file must **still FAIL** Legs 1+2 (the moment a later slice migrates one, this gate REDs demanding the entry be deleted — T5 pins that tooth).

**Membership invariant rationale:** without it, listing `trade-escrow-guards.eval.mjs`
(owned by slice 13r-c-2, touched by ADR-0182) would create a cross-slice merge
deadlock where 13r-c-2's migration REDs a gate it has no reason to touch. The cap
equals the entry count (7), so the debt can only shrink, never accumulate.

### D4 — A third classification: NOT_APPLICABLE_TS_ONLY

`evals/box-view-privacy.eval.mjs` scans exactly one file — `client/src/net/store.ts` —
and reads no Rust source at all. Demanding it import `rust-scan.mjs` and wire
`assertStripperSound` would violate ADR-0181 D4, which **forbids** pointing
`stripRustSource` at TypeScript (blanking a payload makes a ban on a needle that
lives INSIDE a string literal pass vacuously). Such a file is classified
NOT_APPLICABLE_TS_ONLY, **printed by name with its reason** rather than silently
dropped, and Tooth T8 pins that adding a Rust reference to such a file drops it
straight back to UNMIGRATED — so the exemption cannot widen into a blanket opt-out.

### D5 — The delete→blank semantic change is behavior-neutral on the real ban surface, with the measurement

`stripRustSource` (ADR-0181 D2) BLANKS payloads (length/offset-preserving) where
the old naive strippers DELETED them. This slice verified the semantic difference
across all 39 files in `server-module/src/*.rs`:

- 18 files are byte-identical after compact-whitespace normalization.
- 17 files differ but anchor-neutral (the ban-clause needles are at the same offsets).
- 4 files see FEWER anchors after the new scan: `accounts_tests.rs`, `evolution_tests.rs`,
  `npc_tests.rs`, `observability_tests.rs`. **All four anchor losses are phantoms** —
  the anchors sit inside fixture STRING literals, exactly ADR-0181's measured "7
  phantom anchors across 9 files." Example: `economy_tests.rs` had 2 phantom tables
  (`shop_row`, `shop_item_row`) from a Rust fixture string; scanned table count
  went 40 → 38.

**Additional finding:** three of the migrated evals (`encounter-privacy:333`,
`inventory-privacy:623`, `wild-individuality-privacy:426`) glob `server-module/src/**/*.rs`
UNFILTERED, so test files ARE in their scan set. Accordingly, the `assertStripperSound`
desync detector was narrowed to non-test files (per ADR-0181's own "NON-TEST only"
prescription) while the **ban surface still scans every globbed file**. Narrowing a
diagnostic can cost a warning; it can never green a ban.

### D6 — Residual: `}` dropped from `startsRegexLiteral`'s preceding-char set

At `evals/conversation-privacy.eval.mjs:129` and `client/src/main.wiring.test.ts:7924`,
the preceding-character set for regex-literal detection changed from `}=(,[{:;!?&|+-*%<>^~`
to `=(,[{:;!?&|+-*%<>^~` (removed `}`). **Rationale:** an object literal followed by
division (`{a:1} / 2`) was misread as opening a regex literal, swallowing real code.

**Record the trade-off honestly:** this is NOT purely safe. Dropping `}` re-opens ADR-0181 D8
for the compound shape "regex in statement position after a block-closing `}` whose closing
slash abuts a `*`":

```js
const RE = /ab/*
conn.subscribe(['SELECT * FROM player_wallet']);
const noop = 1 */ 2;
```

A red-team PoC measured a `FROM player_wallet` privacy-ban needle surviving WITH `}` and
being SWALLOWED without it, i.e. a potential false-GREEN on an ADR-0015 leak ban. It is
**dormant** in both corpora today: both scanners consume template literals wholesale, so
`${x}/` is never seen in code mode, and the compound shape does not occur in existing
files. That dormancy is now an **ENFORCED standing corpus tooth** rather than a one-time
measurement, so regressing it requires a deliberate review decision. Net call: the
object-literal-division construct is the one that occurs in practice, so dropping `}`
is the right direction, with the compound shape pinned by the standing ban.

### D7 — Corrections of record (they matter because future slices quote ADR-0181's numbers)

- **Already fully migrated by 13r-c:** `currency-integrity` and `ranking-security`.
  ADR-0181 D1 moved these to `rust-scan.mjs` and measured them passing Legs 1+2.
- **Transitively vulnerable, not self-defined:** `playtest-event-privacy` was in
  ADR-0181's vulnerable set only because it imports its stripper from `encounter-privacy`.
  A "defines its own strip regex" measurement cannot see that transitive dependency.
  This slice migrates `encounter-privacy` onto `rust-scan.mjs`, and `playtest-event-privacy`
  passes as a consequence (it no longer has a naive stripper to call; it delegates to the
  moved import).
- **Duplicated Rust `strip_rust_comments` test helper:** ADR-0166 R5 claimed 4 copies.
  Measured: **12 copies in-tree**, all verbatim. Deferred to 14r-c-2 as a pure dedup
  with zero EARS progress.

### D8 — Deferred with the hidden dependency named

ADR-0166 R5's second half — moving the trade-size cap to its `guards.rs` SSOT home
— requires `server-module/src/trading.rs` and `server-module/src/guards.rs`, **both
outside this slice's declared `touches:` set**. It is a hidden dependency, was NOT
attempted, and is handed to the supervisor to re-serialize. R5's first half (a shared
`scan_helpers` home in `lib.rs` for the 12 duplicated test helpers) was also deferred
to 14r-c-2: it is in `touches:` but is pure dedup with zero EARS progress and a
12-file blast radius.

## Consequences

- **Corrected 2026-08-21 (lp-doc-a, ADR-0202) — the original bullet claimed the audit gate
  is expected to be red, and that is no longer true.** The audit gate
  (`scanner-migration-audit.eval.mjs`) is **GREEN**, reporting `18 gated / 10 migrated /
  7 debt / 1 not-applicable`. It is green in the shape the eval's own header already
  describes in the past tense: it *was* expected to be red at 14r-c HEAD, and it *is*
  green once every remaining unmigrated file is named in `KNOWN_UNMIGRATED`. Green is
  therefore **not** a claim that the hazard is gone — seven evals remain unmigrated as
  cap-bounded self-retiring debt, two of which the eval documents as live, reproducible
  needle-swallowers (`evolution-reducer-security`, `raising-reducer-security`), and the
  content-detected set is report-only. Closing the debt is still the indicated follow-up.
- Six evals are now provisioned with string-literal-aware scanning: `encounter-privacy`,
  `inventory-privacy`, `wild-individuality-privacy`, `pvp-action-privacy`, `playtest-event-privacy`,
  `monster-privacy`. Each carries a proof-of-teeth fixture — a URL-scheme literal
  followed by a genuine violation LATER in the same file — that was verified RED
  before the migration and GREEN after.
- `conversation-privacy` and `main.wiring.test.ts` have the `}` drop applied to
  `startsRegexLiteral`. The object-literal-division false-positive is fixed; the
  regex-after-`}` compound shape is pinned by standing corpus tooth rather than
  left as dormant risk.

## EARS status

- **Criterion 1 (migrated evals strip with string-literal-aware scanning and `assertStripperSound` wired):** MET for the six evals migrated by this slice, and the four from ADR-0181.
- **Criterion 2 (zero `*-security`/`*-privacy` evals on comment-strip-without-string-pass):** NOT fully met. Seven remain, as capped self-retiring debt owned by 14r-c-2. Do not overstate this in later design docs — name it plainly as parked. **[STILL OPEN — ownership moved: the seven were re-owned to `15r-sec-mig-a`/`-b`/`-c` (the evals) and `15r-sec-mig-d` (the ledger) by the fifteenth-review-residuals spec. The eval's own `owner:` fields still read `14r-c-2`; updating them is assigned to `15r-sec-mig-a`, not to this slice; recorded by ADR-0202]**
