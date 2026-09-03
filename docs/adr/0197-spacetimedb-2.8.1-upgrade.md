# 0197 — SpacetimeDB 2.8.1: upgrade the CLI/host AND the module SDK (1.12.0 → 2.8.1), and correct four load-bearing false facts

**Status:** Accepted
**Date:** 2026-08-16
**Slice:** stdb-281 (toolchain upgrade; operator-initiated)
**Supersedes:** —
**Amends:** ADR-0037, ADR-0054, ADR-0086, ADR-0180
**Subsystems:** tooling-docs, schema-persistence, ci-gates
**Decision:** Upgrade the spacetime CLI/host 2.6.0 to 2.8.1 and the module crate 1.12.0 to 2.8.1 in one slice via a mechanical source port; accept a `--delete-data` republish (2.8.1 renames enum variants); correct four recorded false facts.

> **Amended in-slice, 2026-08-16.** This ADR was first written to *defer* the crate bump (D1/D2
> below, struck through). The operator bumped `spacetimedb = "2.8.1"` together with the CLI, which
> made the module stop compiling — so the migration was executed in the same slice instead of
> being deferred. **It is done and verified** (see "Execution record"). The deferral reasoning is
> preserved because it is why the port was already measured and therefore cheap to execute.

## Context

Drew is upgrading the installed SpacetimeDB from **2.6.0** to **2.8.1** (Latest, 12 Aug 2026).
Five releases separate them (2.6.1, 2.7.0, 2.7.1, 2.8.0, 2.8.1; 153 commits). There is **no
official 2.6→2.8 upgrade guide** — `/docs/upgrade/` is still the 1.0→2.0 document — so the
release notes plus tagged-source diffs are the only migration sources.

This project's entire corpus was written against 2.6.0 (and, on the module side, against assumptions inherited from the 1.12.0-era CLI before that). The concern that prompted
this slice was not the upgrade mechanics but the **knowledge debt**: specs, ADRs, skills and
memory cards that a future agent would read as current. Investigating that turned up four
recorded "verified" facts that are wrong.

### The four false facts

**FF1 — "crate version != product version" (ADR-0037; ADR-0180 V1; `Cargo.toml`;
`M-loop-infrastructure` W0-6; `spacetimedb-client` SKILL; `docs/validation-findings.md` #6).** The corpus states the `spacetimedb` crate and the
CLI/product version are "intentionally decoupled", and that crate 1.12.0 is what 2.6.0 uses.

This is false, and there was never a decoupling to appeal to. SpacetimeDB is a **single-version
monorepo**: `[workspace.package] version` equals the product version at *every* tag, in both
majors — `v1.0.0`→`"1.0.0"`, `v1.11.0`→`"1.11.0"`, `v1.12.0`→`"1.12.0"`, `v2.6.0`→`"2.6.0"`,
`v2.8.1`→`"2.8.1"` — and the crate is published from it. Crate `2.6.0` went to crates.io on
2026-06-16, the same day as CLI 2.6.0; crate `2.8.1` on 2026-08-12 with CLI 2.8.1. **`1.12.0`
(4 Feb 2026) is the last 1.x crate**, published 16 days before 2.0.0.

The likely origin is benign and now visible on disk: `~/.local/share/spacetime/bin/` contains
`1.12.0`, `2.6.0` and (as of today) `2.8.1`. The crate was pinned to match the CLI *of the
day* (1.12.0, Feb 2026); the CLI later moved to 2.6.0 and the crate pin never followed. The
"decoupled" story was reconstructed afterwards to explain the mismatch, and then propagated
into four documents as a verified finding.

**Consequence:** the server module has been building against a **pre-2.0** SDK for six months
— no 2.x context capabilities, and every 2.x doc an agent could fetch described an API the
module does not have. `M-loop-infrastructure` W0-6 even records the correct *symptom* ("the
`spacetimedb-docs-v2-6-0` MCP server serves master-branch docs describing a later view API
(`accessor =`, `ctx.from`, `impl Query<T>`) that 1.12.0 does not have") while drawing the
wrong conclusion from it — the MCP server was right; the pin was stale.

**FF2 — "there is no cargo-feature passthrough" (ADR-0054, propagated to ADR-0086).**
ADR-0054 records as a "Load-bearing toolchain fact (verified, spacetime 2.6.0)" that
`spacetime build` "exposes only `--module-path/--lint-dir/--debug`". That observation is
accurate — but the inference is not. `spacetime build --features` **exists**, verified in the
tagged CLI source at v1.11.0, v1.12.0, v2.0.1, v2.2.0, v2.4.0, v2.6.0 and v2.8.1. It is
`.hide(true)`:

```rust
// crates/cli/src/subcommands/build.rs — identical at v2.6.0 and v2.8.1
// TODO: Make this into --extra-build-args (or something similar) ...
Arg::new("features").long("features")
    .help("Additional features to pass to the build process ...")
    // We're hiding this because we think it deserves a refactor first (see the TODO above)
    .hide(true)
```

`spacetime publish --build-options=...` also exists at both versions. So
`--build-options='--features dev_reducers'` is very likely viable.

**This does not invalidate ADR-0054's decision.** Keeping `dev_reducers` out of `default` is
correct regardless. It bears only on ADR-0086's `--bin-path` + `MR_DEV_MODULE_WASM` CI
machinery — and since the flag is hidden *and* carries a vendor TODO to rename it to
`--extra-build-args`, `--bin-path` is arguably the more stable choice. Recorded as a
correction, **not** as a mandate to change. The lesson is methodological: a flag's absence
from `--help` is not proof of its absence from the CLI.

**FF3 — the RLS status was right, but recorded as version-contingent.** ADR-0180 D18a/V3
found `client_visibility_filter` is `unstable`-gated and carries the crate's own
`// TODO: RLS filters are currently unimplemented, and are not enforced.` That was true at
1.12.0 and — verified this slice — **is byte-identical at 2.8.1**. Recording it here so the
next upgrade does not re-litigate it, and so nobody "modernises" onto RLS on the assumption
that a newer host fixed it.

**FF4 — "Procedures are still `unstable`" (added after adversarial review of this ADR's own first
draft; the draft asserted it too).** Verified in `crates/bindings/src/lib.rs`:

| tag | `pub use spacetimedb_bindings_macro::procedure;` |
|---|---|
| `v1.12.0` | preceded by `#[cfg(feature = "unstable")]` |
| `v2.6.0` | **no `cfg` gate** |
| `v2.8.1` | **no `cfg` gate** |

Same for `ProcedureContext`. The `unstable` feature still exists; it simply no longer gates
procedures. **Procedures have been stable for the entire 2.x line** — the gate this project sees is
an artifact of its own 1.12.0 pin.

This matters because ADR-0180's 2026-08-08 amendment explicitly weighed "adopt a **BETA**
SpacetimeDB API (scheduled Procedures with outbound HTTP, the `unstable` Cargo feature)" and
**M20 OBS-48 forbade enabling `features = ["unstable"]`** partly on that footing **[SOFTENED 2026-08-28 to require-justification — see the 2026-09-03 amendment at the end of this ADR and ADR-0180's amendment of the same date]**. After the crate
bump that premise is simply false. It does **not** automatically overturn the verdict — D14–D18 also
rested on `mr-trace-relay` being simpler and on keeping an HTTP egress path out of the module — but
the call must be **re-adjudicated on corrected facts**, not inherited. Filed as a follow-up, not
decided here.

*Methodological note:* the first draft of this ADR repeated the docs' claim because a research pass
checked the **docs** ("the `features = ["unstable"]` requirement text is byte-identical between the
v2.6.0 and v2.8.1 docs") rather than the crate. That is precisely the failure mode FF3 exists to
warn about, committed while writing the warning. **Check the crate.**

### Why the upgrade is safe for the existing module *binary* (but not its data)

Verified from tagged source, not inferred. **Scope note:** everything in this table is about whether
the 2.8.1 host will LOAD and RUN the module. It says nothing about whether an existing database's
DATA survives a republish — that is D2a, and the answer there is no without `--delete-data`.

| Axis | 1.12.0 module | 2.8.1 host | Verdict |
|---|---|---|---|
| Wasm module ABI | imports `spacetime_10.0`…`10.4` | implements `10.5` — **as does the 2.6.0 host today** | same major, host minor ≥ module minor → **accepted** (`crates/core/src/host/wasm_common/abi.rs`). The upgrade changes nothing here: the module already runs on a `10.5` host |
| `RawModuleDef` | V9 | accepts `V8BackCompat \| V9 \| V10` | **accepted** |
| Wire protocol | — | `crates/client-api-messages` has **zero** changed files 2.6.0→2.8.1 | unchanged |
| On-disk | — | snapshot MAGIC/version and commitlog MAGIC/format version identical | **existing local DB survives** |
| Automigration | — | strictly more permissive (new `AutoMigrateStep::AddConstraint`) | existing schema still publishes |

So there is **no forcing function** to port the module. The crate bump becomes a deliberate
improvement, sequenced on its own.

### What the port would actually cost (measured, not estimated)

Probed in an isolated `git archive` copy, crate bumped to 2.8.1:

- Baseline **591 errors** reported by rustc, of which **542** carry an error code: 469 ×
  `no method named <table>` on `Local` (all cascading from the failed `name =` attribute), 66 ×
  `field sender ... is private`, 7 × invalid reducer signature; the rest are uncoded secondary
  diagnostics from the same macro failures. The surface is small — **51 attribute sites**
  (45 `#[table(name =`, 6 `#[view(name =`, 0 `#[index(name =`) plus the `sender` sites.
- **Two mechanical transforms take it to 0 errors**, `cargo check --target
  wasm32-unknown-unknown` green: `#[table|view|index(name = X)]` → `accessor = X`, and
  `ctx.sender` → `ctx.sender()`. `crates/bindings-macro/src/table.rs` emits this advice in its
  own compile errors.
- **Schema-neutral:** the canonical SQL table name defaults to the accessor identifier
  (`let table_name = table_ident.unraw().to_string()`; `name` is only an override), so the
  rename produces **no table renames and no migration**.
- Residual: 7 deprecation warnings (`ReducerContext::identity` → `database_identity`).
- `cargo test -p monster-realm-module`: **613 passed, 16 failed** — every failure is a
  source-text-scanning teeth test that hardcodes the `name =` spelling or pins an exact view
  body. A vacuity guard fired correctly rather than passing silently.

That last line is why this is a slice and not a drive-by: ~16 Rust scanners plus several
`evals/*.eval.mjs` scanners encode the attribute syntax and must move in the same commit.

## Decision

**D1 — ~~Upgrade the CLI/host to 2.8.1; leave `spacetimedb = "1.12"` alone for now.~~ SUPERSEDED
in-slice: both were upgraded together.** The original reasoning — that bundling an unverifiable
refactor onto a routine toolchain bump is bad practice — still holds *in general*. What changed is
that it stopped being unverifiable: once the CLI was on 2.8.1, `spacetime build`, `spacetime
generate` and the full gate suite could all close the loop locally, so the port was executed and
verified rather than deferred.

**D2 — ~~The module SDK bump is its own slice.~~ EXECUTED** as
`specs/monster-realm-v2/M-stdb-2x-module-sdk.spec.md` slices sdk-a/b/c, in this slice. See the
execution record below.

**D2a — The migration is exactly three mechanical substitutions in SOURCE, but it is NOT
schema-neutral: it requires `--delete-data` (or a manual migration) on any pre-existing database.**
`#[table|view(name = X)]` → `accessor = X`; `ctx.sender` → `ctx.sender()`;
`ctx.identity()` → `ctx.database_identity()` (the last is required, not cosmetic — the old spelling
is deprecated and CI runs `cargo clippy -- -D warnings`). No table was renamed: `accessor` names the
Rust accessor and the canonical SQL name defaults to that identifier (77/77 table names verified
byte-identical).

**But table names were the wrong thing to check.** Crate **2.8.1 emits sum-type variant names in
lowerCamelCase where 1.12.0 emitted PascalCase** — a change to the *column type* of every
enum-typed column, invisible to any source-text scanner because the Rust variant identifiers are
untouched. Reproduced by publishing the 2.8.1 module over a database published by the 1.12.0
module:

```
Changing the type of column affinity in table species_row
  from (Fire: () | Water: () | Plant: () | Electric: () | Earth: () | Wind: () | Light: () | Dark: ())
  to   (fire: () | water: () | plant: () | electric: () | earth: () | wind: () | light: () | dark: ()),
  with a renamed variant, requires a manual migration
Aborting because publishing would require manual migration or deletion of data
  and --delete-data was not specified.
```

Affected: every table with an enum column — `species_row.affinity`, `skill_row.affinity`,
`account.status`, `battle_challenge.status`, `trade_offer.status`, `character.direction` /
`action_state`, `npc.interaction`, `monster.nature_kind` / `trust_tier`, `battle.state`, … (
`ScheduleAt`'s `Interval`/`Time` are a library type and stay PascalCase).

**The client is unaffected**: `spacetime generate` still emits the Rust identifier casing, so
`module_bindings/types.ts` is byte-identical to HEAD, `bindings-drift` is green, `tsc --noEmit`
passes and all 2447 client tests pass. The exposure is purely server-side republish.

**Operationally this is acceptable and was accepted**: the project is pre-launch, its only live
databases are local playtest/e2e ones, and ADR-0177 already documents a `--delete-data` runbook.
It would NOT be acceptable post-launch, which is exactly why it is recorded here rather than
discovered later.

*How this was nearly missed:* the first verification published to a **fresh** database, which
succeeds and proves nothing about migration. A schema-compatibility claim must be tested by
publishing **over a database created by the previous version**, never onto an empty one.

**D2b — npm `spacetimedb` stays at 2.6.0 for now.** It is genuinely independent of the CLI and crate
(a 2.8.1 SDK typechecks against 2.6.0-generated bindings and a 2.6.0 SDK against 2.8.1-generated
bindings — both verified). The reason to hold is behavioural, not mechanical: **2.7.1 added SDK
auto-reconnect** on `visibilitychange`/`focus`/`online`/`pageshow` with backoff reset, which overlaps
the hand-rolled reconnect path (ADR-0085, nh3's epoch guard, nh4's suppress-not-clear token
recovery). That interaction can only be judged in a live two-client session, so it is a separate,
deliberately-scoped change.

**D3 — Correct FF1/FF2/FF3 at every live site, and leave history alone.** Amend the
forward-looking documents (`Cargo.toml` comments, `AGENTS.md`, both SpacetimeDB skills, the
harness research doc, `M-loop-infrastructure` W0-6). Do **not** rewrite ADR-0054/0086/0180
prose or archived handoffs — they are dated records; this ADR is the correction, linked from
them via `**Amended-by:** ADR-0197`.

**D4 — Treat these as post-upgrade breakages, not surprises.** Both are recorded in the
migration spec's runbook:
- `scripts/verify-release-reducers.mjs` parses `spacetime describe --json` expecting the flat
  `{"reducers":[…]}` (V9) shape. **CLI 2.8.0+** emits `RawModuleDefV10` (`{"sections":[…]}`). It
  will **throw** — loudly, by design — and `just playtest-publish` calls it via
  `just playtest-verify-release`. **This is a CLI property, not a host property**
  (`crates/cli/src/api.rs::module_def` requests `version=10` and, on a client error, falls back to
  `version=9` and *upgrades* the result to V10 before printing), so the fix must key off the
  payload shape, never a probed host version.
- 2.8.0 quieted routine host logs "to quieter levels or module logs". `mr-trace-relay`
  (ADR-0191) reconstructs spans from **module-emitted** `log::` breadcrumbs, which should be
  unaffected — but this must be re-verified, not assumed.

**D5 — Adopt `spacetime mcp` as opt-in, not always-on.** New in CLI **2.8.1 exactly** (absent
at 2.8.0), marked UNSTABLE: a stdio↔HTTP MCP bridge exposing `list_databases`, `ping`,
`get_schema`, `sql`, `call` against a **running** instance. Because it needs a live database
it is documented in `.mcp.json` as a `$comment` rather than declared — the harness's
cost-aware routing doctrine (`docs/routing.md` **in the harness repo**, not this project) is
explicit that a connected server costs context every session merely by existing. It is a live-DB introspection bridge and does **not**
replace a docs-fetch MCP.

## Execution record (2026-08-16, verified locally on CLI 2.8.1)

| Step | Result |
|---|---|
| `spacetimedb` 1.12.0 → 2.8.1 (`Cargo.toml` + lock) | 591 errors before the port |
| 3 substitutions across `server-module/src/*.rs` | **0 errors**; 51 attribute sites (45 table, 6 view, 0 index) |
| `cargo clippy -p monster-realm-module --all-targets --all-features -- -D warnings` | **clean** (the 7 `identity()` deprecations migrated) |
| `spacetime build --module-path server-module` | **success** on 2.8.1 |
| `spacetime publish` to a **fresh** in-memory 2.8.1 instance | **success** — 48 reducers, zero dev reducers. NB: a fresh publish exercises no migration path |
| `spacetime publish` **over a 1.12.0-published database** | **ABORTS** — renamed enum variants require manual migration (D2a) |
| **SDK-4 schema compatibility** | **PARTIAL — see D2a.** 77/77 table *names* byte-identical, but every **enum column's type** changed (PascalCase → lowerCamelCase variants). Publishing over a pre-bump database **ABORTS**; `--delete-data` (or a manual migration) is required |
| `just gen` (bindings regeneration) | **one file** changed — `module_bindings/index.ts`, 202 lines: camelCase handles + the `cliVersion` header |
| `npx tsc --noEmit` (client, still on npm 2.6.0) | **clean** — the `@deprecated` snake_case aliases carry the existing ~23 accessors |
| Teeth re-baseline | 21 source-scanning tests moved to the 2.x spelling (slice sdk-b, separate author per golden rule #2) |
| `scripts/verify-release-reducers.mjs` | fixed for V10 (`sections[].Reducers[].source_name`), V9 path kept, fail-loud preserved; V10 fixtures added to `playtest-verify.eval.mjs` |
| CI pins | `.github/workflows/{ci,nightly}.yml` 2.6.0 → 2.8.1 (3 sites) |

**The V10 shape was captured from a live instance, not inferred:** `spacetime describe --json`
returns `{"sections":[{"Typespace":…},{"Types":…},{"Tables":…},{"Reducers":[…]},{"Views":…},
{"Schedules":…},{"LifeCycleReducers":…},{"ExplicitNames":…}]}`, and reducer entries carry
**`source_name`**, not `name`. That field rename is what would have silently turned a
dev-reducer-leak check into a no-op had the parser's fail-loud guard not caught it.

## Considered alternatives

- **(a) Bump CLI and crate together in this slice.** Rejected: the crate port cannot be
  verified end-to-end without the already-upgraded CLI (`spacetime generate`, bindings drift,
  e2e), so it would land unverified, against `AGENTS.md` rule "if you can't verify a change,
  say so". It also requires editing ~16 gating teeth tests, which golden rule #2 keeps out of
  the implementing loop.
- **(b) Leave the crate at 1.12.0 permanently.** Rejected: it is a full major behind, the docs
  an agent can fetch describe a different API, and the gap widens every release. Deferred, not
  abandoned.
- **(c) Rip out ADR-0086's `--bin-path` machinery now that FF2 is corrected.** Rejected for
  this slice: the enabling flag is hidden and slated for rename; `--bin-path` is the more
  stable contract. Recorded as an option, unexercised.
- **(d) Silently fix the false facts without an ADR.** Rejected: FF1 was recorded as a
  verified finding in four places and cited as "must not be re-derived". A correction of that
  standing needs a citable record.

## Consequences

- (−) **Existing databases do not survive the republish.** Enum variant casing changed, so any
  pre-bump database needs `--delete-data` (dev) or a hand-written migration. Acceptable pre-launch;
  it would not have been post-launch.
- (+) Four documents that actively misinform agents about the crate/product relationship are
  corrected, and the correction is citable.
- (+) The module-SDK port is now a measured, bounded slice (two transforms + scanner updates)
  instead of an unknown.
- (+) The module is on the current SDK: 2.x context capabilities, view primary keys and stable
  Procedures all become **available** (available, **not yet adopted** — see below), and every
  doc an agent can fetch now matches the code.
- (−) Agents must write **2.x** syntax; anything copied from a pre-2026-08-16 ADR, memory card or
  commit will not compile. Both SpacetimeDB skills now lead with the three changed spellings.
- (+) `just playtest-publish` keeps working: the `describe --json` parser now accepts V9 and V10.
- (→) Follow-ups: bump npm `spacetimedb` to 2.8.1 behind a live reconnect check (D2b); re-verify
  `mr-trace-relay` breadcrumbs against 2.8.0's quieter host logs; ~~re-adjudicate M20 OBS-48 now
  that Procedures are stable (FF4)~~ **[CLOSED 2026-09-03, slice `17r-c` — re-adjudicated: require-justification]**; revisit `15r-sec-a` now that view primary keys exist — note
  they are **available but NOT yet adopted**: none of the five `#[spacetimedb::view(…)]`
  declarations in `schema.rs` carries `primary_key`, so `client/src/net/store.ts`'s hand-rolled
  insert/delete reconciliation (ADR-0194) remains load-bearing; adoption is tracked as the
  `M-stdb-2x-module-sdk` **sdk-d** opportunistic follow-up; consider
  the new `spacetime_scheduled_function_delay_seconds` metric and `spacetime lock` for the
  playtest DB (M20); consider `spacetime sql --format json`, which may unblock the
  `just playtest-report` JSON gap recorded in the 2026-07-25 playtest-gate decision.

---

## Amendment (2026-08-22, slice `16r-d`) — the `spacetime sql --format json` follow-up is CLOSED: adopted

The final Consequences follow-up above ("consider `spacetime sql --format json`, which may unblock
the `just playtest-report` JSON gap") is resolved **ADOPT**. `scripts/playtest-report.mjs` now
consumes `--format json` and its hand-written pipe-table parser (`parseSqlTable`) is deleted.

Header block deliberately untouched: appending a header line shifts every inbound `ADR-0197:<line>`
citation (7 of 13 were broken once by exactly that), and the ADR digest gate reads headers only.

### D19 — consume `--format json`, not the rendered pipe table

`--format json` exists on the pinned 2.8.1 CLI (`--format <text|json>`, default `text`) and prints
the **raw HTTP response body verbatim** to stdout — `crates/cli/src/subcommands/sql.rs` at `v2.8.1`
short-circuits with `if format == Format::Json { println!("{json}"); return Ok(()) }` before any
rendering. The `WARNING: UNSTABLE` banner stays on stderr, so stdout is pure JSON.

The decisive argument is **not** that the pipe table is broken — it is not; verified below that it
still parses correctly at 2.8.1. It is that the text output is a *human display* format rendered
through `PsqlWrapper` with no stability contract, and this ADR already documents it changing
silently across exactly this version bump: sum variants went `Mild` → `mild` (D2a). A display-format
change is invisible to every gate this repo has, and its failure mode in a rates report is a **wrong
number**, not a crash. `--format json` is the same payload the SDKs consume and carries the column
schema authoritatively instead of inferring it from a header line.

Accepted residual: the JSON envelope is itself unversioned and under the same UNSTABLE banner. It is
made safe by the fail-loud contract in D21 — a future envelope change must exit non-zero with a
diagnostic, never emit a plausible-looking report.

### D20 — the verified 2.8.1 envelope shape (this ADR is its durable home)

Captured live 2026-08-22 from a 2.8.1 standalone instance, querying the real `playtest_event` table
(`spacetime sql -s <server> --format json <db> 'SELECT event_id, kind, identity, species_id,
hp_permille, bait_item_id, success FROM playtest_event'`):

```json
[{"schema":{"elements":[{"name":{"some":"event_id"},"algebraic_type":{"U64":[]}},
                        {"name":{"some":"identity"},"algebraic_type":{"Product":{"elements":[
                           {"name":{"some":"__identity__"},"algebraic_type":{"U256":[]}}]}}}]},
  "rows":[[10,1,["0xc200…7da6"],7,300,0,true]],
  "total_duration_micros":316,
  "stats":{"rows_inserted":0,"rows_deleted":0,"rows_updated":0}}]
```

Load-bearing properties, each observed rather than inferred:

- The top level is an **array of statement results**, one per statement.
- `rows` are **positional arrays** aligned to `schema.elements` order — *not* objects keyed by
  column name. Row arity is therefore the corruption detector.
- Column names live at `schema.elements[i].name.some`; the `name` is an Option, so an unnamed
  column would arrive as `{"none":{}}`.
- Integers (`U8`/`U16`/`U32`/`U64`/`I64`) arrive as **bare JSON numbers**; `bool` as a real JSON
  boolean; `String` as a JSON string.
- `Identity` is typed `Product{[__identity__: U256]}` and its **value is a one-element array holding
  the hex string**: `["0xc200…"]`. `String(["0x…"])` happens to yield the bare hex, so a naive
  decoder appears to work — but a two-element array would join to `"a,b"` and silently **merge two
  players into one aggregation group key**. The unwrap is validated, not incidental.
- Sum/enum values arrive as `[variantIndex, payload]` (e.g. `[16,[]]`).

### D21 — parse-don't-validate at the boundary: fail loud, never a plausible-looking empty report

`decodeSqlJson(stdout)` replaces `parseSqlTable`. It throws — never returns `[]`, never returns
partial rows — on: non-JSON stdout; a non-array top level; a top-level array whose length is not
exactly 1; a non-object statement result; missing/non-array `schema.elements`; zero columns; any
column `name` that is not `{some:<non-empty string>}`; duplicate column names; missing/non-array
`rows`; a non-array row; and **any row whose length differs from the column count**. `rows: []`
(a validated-empty result) returns `[]` without throwing.

This preserves the property the pipe parser was hardened for (reviewer finding m-3): a bogus
"0 events captured" report is worse than a crash. Three specific traps drove the rules:

- **Arity mismatch is the critical one.** A short row zipped positionally leaves
  `bait_item_id === undefined`; `Number(undefined)` is `NaN`; and `aggregateReport` counts bait via
  `bait_item_id !== 0` — `NaN !== 0` is **`true`**, so a truncated row silently *inflates*
  `baitRate`. The same latent bug existed in `parseSqlTable`'s short-line case and is now closed.
- **No `?.`/`??` in the decoder.** `envelope[0]?.rows ?? []` would turn every malformed shape back
  into a silent empty report — the exact regression this slice exists to prevent.
- **Row objects use `Object.create(null)`.** The decoder keys an object by server-supplied column
  names; a column literally named `__proto__` would otherwise reassign that row's prototype.
  Low likelihood (it needs control of the catalog), zero cost to defend.

`coerceRow` correspondingly stops being type-tolerant. Under the text format it accepted
`true | 'true' | 1 | '1'` for `success` because rendering erased types; under JSON `success` is a
real boolean, so the tolerance is deleted — carrying it forward would *mask* a shape change instead
of surfacing it. `coerceRow` now also throws on a missing key, a non-finite numeric field, and an
`identity` that is neither a string nor a one-element array of a string.

Accepted, documented residual: `u64` values above 2^53 lose precision inside `JSON.parse` before the
decoder ever sees them. `event_id` is `#[auto_inc]` from 1, so this is unreachable in practice, and
the same precision is lost today the moment `Number()` is applied to a pipe-table digit string. No
BigInt reviver — that would be gold-plating an unreachable path.

### D22 — three version-sensitive claims re-verified against 2.8.1 (EARS: comments must match the pin)

All three were labelled "2.6.0" in the scripts. The **constraints are all still true**; only the
version labels were stale, and both scripts now say 2.8.1 with the re-verification date.

| Claim | Verified 2026-08-22 on CLI 2.8.1 | Verdict |
|---|---|---|
| `spacetime sql` rejects `ORDER BY` | `Error: Unsupported: SELECT … ORDER BY …` → 400 Bad Request | still true — `sortByEventId` stays client-side (PT-B2-RT-01) |
| `spacetime call` takes **per-arg** JSON, never a wrapped array | `join_game '"Name"'` succeeds; `join_game '["Name"]'` fails *Invalid arguments provided for reducer* | still true — `smoke-republish.sh`'s form is correct (ADR-0088) |
| the pinned CLI has no JSON output mode | **false at 2.8.1** — `--format json` exists (2.7.0+) | corrected; this is what D19 adopts |

### D23 — `smoke-republish.sh` keeps its text-output greps (comment-only change)

Its three `spacetime sql` calls are **presence** checks (`grep -qE '[0-9]+'` for a surviving monster
row; a word-anchored match for the bumped `content_version`), not value decodes. Converting them to
JSON would need `jq` — not guaranteed on the nightly runner — or a Node helper, to harden a nightly
assertion that already works. Declined as scope creep; recorded here so the omission reads as a
decision rather than an oversight. Its stale "2.6.0" comment is corrected, which is the EARS
obligation actually in scope.

### Non-scope (flagged, deliberately untouched)

`client/e2e/wallet-balance.spec.ts` and `client/e2e/trade-zz-negative.spec.ts` each carry their
**own independent** local `parseSqlTable` pipe-table helper (verified: neither imports the script;
ADR-0184's `parseSqlTable (:317)` citation points at the e2e copy and stays valid). They inherit the
same display-format coupling and are candidates for the same treatment in a later slice. Out of this
slice's `touches:` set — flagged, not touched.

---

## Amendment (2026-09-03, slice `17r-c`) — the FF4 OBS-48 re-adjudication follow-up is CLOSED

The Consequences follow-up "re-adjudicate M20 OBS-48 now that Procedures are stable (FF4)" — filed by
this ADR because §5/FF4 corrected the false premise that `#[procedure]` is `unstable`-gated — is
resolved. Drew's ruling on issue https://github.com/mdrewt/monster-realm/issues/342 (answered 2026-08-28, consumed and closed by review 17): OBS-48 becomes **require-justification** rather than a blanket forbid. The full <!-- A9b: this sentence must keep `require-justification` and the issue URL on ONE line -->
reasoning, the general cross-dependency policy it generalises to, and the enforcement mechanism are
recorded in **ADR-0180's amendment of the same date**; this note exists so a reader arriving at FF4
is not left with an open question.

Sharpening FF4 itself: `#[procedure]`, `ProcedureContext`, `http::HttpClient` and `HttpClient::send`
are all ungated at crate 2.8.1 (verified against the vendored source). The `unstable` feature and the
Procedure/outbound-HTTP surface are therefore **independent** concerns, and a gate that treats "no
unstable feature" as implying "no Procedures" is asserting something false.

Header block deliberately untouched: appending a header line shifts every inbound `ADR-0197:<line>`
citation (7 of 13 were broken once by exactly that), and the ADR digest gate reads headers only.
