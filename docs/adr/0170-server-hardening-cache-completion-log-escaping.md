# 0170 — Server hardening basket: version-keyed type-chart cache, ADR-0089 completion, heal-cost seam split, and JSON log escaping

**Status:** Accepted
**Date:** 2026-08-01
**Slice:** 11r-g (M-postgate-eleventh-review-residuals — server hardening basket; EARS G-1..G-5, M-1..M-7, C-1..C-10, H-1..H-3, V-1..V-5)
**Supersedes:** —
**Amends:** ADR-0089
**Subsystems:** battle, movement-netcode, economy-quests
**Decision:** Cache abilities/heal-locations as LazyLock statics and the type chart behind a content_version-keyed rebuild; rate-limit + JSON-escape silent wild-encounter failure logs; ship heal-cost cached read + inert client seam, column parked.

## Context

The eleventh-review residuals spec batches four independent server hardening items into
slice 11r-g: (1) `movement_tick`'s grass-encounter block swallows content faults
(`table_from_encounter_row` Err) and every `begin_encounter` Err silently; (2) ADR-0089's
M14.5e amendment parked `load_abilities()` caching (7 uncached RON re-parses per battle
action) and the per-action `type_chart_from_rows` full-table rebuild; (3) heal currency
cost is re-parsed from the RON registry on every `heal_party` call and the client's
`isFree` ignores currency entirely (a pure content edit arms a silent-debit trap —
note this is a log/UI-correctness and cost-visibility fix, not an exploitable
injection vector: `spend_currency` already charges correctly server-side);
(4) `log_reject` interpolates rejection reasons into hand-built JSON unescaped, so a
RON/serde parse error containing quotes emits malformed log lines.

Constraints that shaped the decisions: the slice's declared touch-set is
`server-module/src/{movement,battle,raising,guards,content_cache,schema}.rs` +
`client/src/ui/healModel.ts` (+ sibling tests, docs) — `content.rs`, `pvp.rs`,
`taming.rs`, `game-core`, and the client net layer are OUT of scope; there is no
reducer-executing test harness (ADR-0156 P7), so every new behavior must be a pure
function (or an instantiable struct) or a source-scan invariant; and the repo's
source-scan substrate (eval W-pre in `zone-warp-server-runtime.eval.mjs` + per-file
stripper helpers) hard-fails on raw double-quote char literals and unpaired
block-comment openers in production source. The workspace release profile sets
`overflow-checks = true`, so any integer overflow in shipped code PANICS — all new
time/counter arithmetic must saturate.

## D1 — Version-keyed, rebuildable type-chart cache (not a LazyLock, not a sync hook)

Type relations come from DB rows (`type_relation_row`), seeded by `sync_content` — a
plain `LazyLock` would serve a permanently stale chart after any reseed (cache
poisoning of every battle's damage math). The chosen design is a
`static Mutex<Option<(u32, Arc<TypeChart>)>>` keyed on the singleton `config` row's
`content_version`:

- **Coherence proof (pure-function-of-committed-state):** the cached value is a pure
  function of `(content_version, committed type_relation_row state)`, and that pair is
  uniquely determined: `type_relation_row` has exactly one writer —
  `sync_content_inner` (delete-all + insert, content.rs:171-181) — and the same reducer
  transaction stamps `cfg.content_version = CONTENT_VERSION` (content.rs:285). Module
  init seeds `content_version: 0` (lib.rs:146-148) and runs `sync_content_inner`
  synchronously before any client reducer can run. A version match therefore
  guarantees the cached chart was built from the current rows; a mismatch triggers a
  rebuild via `marshal::type_chart_from_rows(ctx.db.type_relation_row().iter())`.
  This argument also licenses per-WASM-instance statics with no cross-instance
  coordination: any instance rebuilding from the same committed rows gets the same
  chart (row-order dependence is closed by `validate_content`'s duplicate-pair
  rejection). Reducers execute serially, so no chart can change under a held
  reference within one reducer call.
- **A missing `config` row keys the cache at version 0** (`unwrap_or(0)`) —
  unreachable today (init inserts it), and safe: version 0 is the pre-seed sentinel,
  so a spurious hit merely forces a rebuild on the next real call.
- **Err is never cached** — unlike the compile-time-embedded LazyLock registries (whose
  cached Err is deterministic, content_cache.rs module doc), DB-derived data can be fixed
  by a later transaction. A failed rebuild returns `Err`, keeps any previously cached
  older-version entry (the caller still gets `Err` — stale data is never served), and
  retries on the next call.
- **Mutex poisoning recovers** (`PoisonError::into_inner`) as defense-in-depth: if the
  host unwinds panics and keeps the instance alive, one unrelated panic must not brick
  every battle for the process lifetime. (If the host instead traps/recycles the whole
  instance, statics reset and the recovery path is simply dead code — harmless either
  way; the host's actual behavior is not determinable from source.) `Mutex` over
  `RwLock` (no real read contention — reducers are serial) and over `thread_local`
  (host thread-dispatch is unspecified; a worker pool would make a thread-local
  silently rebuild per call, defeating the cache).
- **`Arc<TypeChart>`, not a `Clone`d chart:** the chart is tiny (~24 relations), but
  deriving `Clone` on `TypeChart` would require editing `game-core` — outside the
  declared touch-set. `Arc::new` at rebuild + `Arc::clone` per hit needs no game-core
  change and is a refcount bump.
- **Invariant:** no code path that writes `type_relation_row` may call
  `cached_type_chart` in the same transaction. A rolled-back write could otherwise be
  cached: mid-`sync_content_inner`, after the row rewrite but before the version
  stamp, a call would store `(old_version, NEW_chart)`; a later panic rolls back the
  DB but NOT the static — a permanently poisoned version-match hit. Pinned by (a) a
  source-scan asserting zero `cached_type_chart` occurrences in `content.rs`,
  `marshal.rs`, AND `evolution.rs` (the files transitively reachable from
  `sync_content_inner` — a one-file lexical scan would miss a transitive call), and
  (b) a doc-comment contract on `cached_type_chart` naming the forbidden callers.
- **Structure:** a pure inner (`cache cell + version + rebuild closure`) carries all the
  logic and is unit-tested directly; the `ReducerContext` wrapper is ~5 lines. The cell
  lock is deliberately HELD across the rebuild closure (racing rebuilds cannot clobber
  each other; safe because reducers are serial) — the trade-off is a re-entrancy
  footgun: any future rebuild path that reacquires the cache would deadlock. Named
  here and in the accessor's doc comment.

**Rejected:** plain `LazyLock` over DB rows (stale-after-reseed poisoning); an
invalidation hook inside `sync_content` (requires editing out-of-scope `content.rs`,
couples content seeding to a cache, and is forgettable — the version key is
correct-by-construction provided writers bump the version, which the CONTENT_VERSION
minimum-bump gate already enforces); no cache (leaves ADR-0089 incomplete, which is
this slice's point); cloning the chart out of the cell (needs an out-of-scope
game-core `Clone` derive).

## D2 — `cached_abilities()` completes ADR-0089's M14.5e park — for battle.rs only

`load_abilities()` is compile-time-embedded RON, so it joins the six existing
`LazyLock` statics unchanged in shape. Call-site swaps land in `battle.rs` only
(`start_battle` :242, `begin_encounter` :412, `submit_attack` :596, `swap_active`
:733, plus the two `type_chart_from_rows` sites :574/:719), and the now-false
`PARK(ADR-0089 amendment, M14.5e)` comment blocks at battle.rs :594-595/:731-732 are
deleted. `pvp.rs:280/:392` and `taming.rs:205` (`load_abilities`, the latter carrying
the remaining true PARK comment at taming.rs:203) and `pvp.rs:383` / `taming.rs:191`
(`type_chart_from_rows` — plain call sites, NO PARK comments exist there) are OUTSIDE
the declared touch-set: they stay untouched and are recorded as residuals for a
follow-up swap slice. The call-site gate tests are scoped to `battle.rs` bodies
precisely so they cannot force an out-of-boundary edit. Note the type-chart caching
itself is a NEW decision in this ADR (D1), not the completion of a prior park —
ADR-0089's M14.5e amendment named only `load_abilities()`.

## D3 — Heal-cost item split: cached read + inert client seam now; the column parked

The spec asked for a `cost_currency` column on `HealLocationRow`. The seed site is a
struct literal in `content.rs:702` — adding the field cannot compile without editing
`content.rs`, which is outside the declared touch-set: a hidden-dependency STOP per
the fan-out doctrine. Moreover, ADR-0083 §A explicitly decided `cost_currency` lives
on `HealLocationDef` (content), NOT on the DB row — its motivating constraint
(m13c/m13d parallel worktrees; `just wasm` bindings-regen collision) has expired, so
the column leg is a legitimate future change, but it **amends ADR-0083 §A** and must
ship with the full runtime path: `schema.rs` column (`#[default(0)]`, additive
ADR-0006), `content.rs:702` seed, bindings regen, `client/src/net/{store,rowConvert}.ts`
(note: `cost_currency` is `u64`; the client convention for heal-row scalars is
`number` — the narrowing lands at `rowConvert.ts:522`), and `healView.ts` display.

What ships now, in scope:
- `cached_heal_locations()` — eighth LazyLock (`load_heal_locations` is embedded RON
  parts) — and `heal_party` (raising.rs:323-329) reads it instead of re-parsing the
  registry per call. Semantics unchanged: find by `location_id`, `cost_currency`,
  `unwrap_or(0)`; the owner-first/spend ordering that
  `economy-sinks-sources.eval.mjs` pins is not reordered.
- `healModel.ts` seam: `HealLocationViewModel` gains a **required** `costCurrency:
  number` (required so every future consumer must reckon with it — an optional field
  could be silently `?? 0`-ed past, reintroducing the gap); builder inputs widen
  locally to `StoreHealLocationRow & { readonly costCurrency?: number }` (absent ⇒
  `?? 0`); `isFree` requires `costCurrency === 0`. The seam is **inert** (store rows
  lack the field until the column leg lands — ux2/ADR-0154 precedent) but the isFree
  contract and tests are fixed now, so the follow-up is mechanical wiring.

**Amendment (12r-d).** The column leg landed: `schema.rs` gained
`HealLocationRow.cost_currency` with `#[default(0u64)]` — the typed literal matters
(a bare `0` BSATN-encodes as 4 bytes and fails the automigration publish, the
ADR-0174 D1 lesson), appended at the tail per ADR-0173 D5's one accepted shape —
plus the `content.rs` seed read, bindings regen, and the client wiring. One
deliberate deviation from this section's text: the client carries the value as
**bigint end-to-end** (`StoreHealLocationRow.costCurrency: bigint`, required; VM
`costCurrency: bigint`; `isFree` compares `=== 0n`), NOT the "u64→number narrowing
at rowConvert.ts:522" suggested above. By 12r-d every sibling u64 row scalar
(`sellPrice`, `buyPrice`, wallet `balance`, the trade currencies) is bigint under
the explicit no-`Number()` doctrine at `playerWalletRowToStore`, and a second
numeric convention for the same currency unit is exactly the unenforced-exception
class D5 exists to remove; the discriminating gate is a `2^53+1` round-trip test
that no `Number()` hop can pass. The inert input-widening type
(`costCurrency?: number`) is deleted; the display arm ships as a pure
`formatHealCostLine()` in `healModel.ts` with `healView.ts` delegating (the shell
is coverage-excluded; the formatter is table-tested, and a currency-only pad no
longer renders `0x Unknown item`). Two related notes: (a) `cooldownMs` remains
typed `number` client-side although the SDK delivers i64 as bigint — a
pre-existing latent mistype, flagged not fixed (nothing consumes it today);
(b) the heal price now has TWO readers — `heal_party` debits from the RON content
cache while the client displays from the DB row — which diverge only in the
republished-but-not-yet-`sync_content`ed window; unifying `heal_party` on
`loc.cost_currency` is a 12r-e candidate (`raising.rs` is 12r-e's declared file).
The sharpest shape of that window (12r-d red-team): `heal_party`'s cache lookup
is `.find(location_id).map(cost_currency).unwrap_or(0)` — a location REMOVED
from RON heals for free while its stale row still displays a price, because the
zone/cooldown/item checks all read the row. The 12r-e unification should also
test the row-present/cache-absent case explicitly. (RON edits themselves cannot
skip the reseed: `content-version.eval.mjs` hashes `game-core/content/**` and
forces the `CONTENT_VERSION` bump that re-runs `sync_content`.)

## D4 — Rate-limited wild-encounter failure logging

Both swallow sites in `movement_tick`'s grass block become logged no-ops (still
`continue` — a content fault must never abort the zone tick, ADR-0066), matching the
sibling `movement_tick_error` JSON shape with reasons passed through `json_escape`:

- **Two independent rate limiters** (evt `encounter_table_error` and
  `begin_encounter_error`) — a spammy bad-content zone must not mask
  `begin_encounter` failures. Justified concretely: one of `begin_encounter`'s Err
  paths ("party has no conscious monster") is ROUTINE gameplay (a fainted party
  walking grass), so it can burst; a shared limiter would let it mask a real content
  defect.
- **The routine fainted-party reason is filtered at source** (post-review hardening):
  that reason is fully client-controlled, so left unfiltered it would let a hostile
  client saturate `BEGIN_ENCOUNTER_ERR_LIMITER`'s single per-window emit slot and
  blind the channel to genuine anomalies. `battle.rs` exports
  `NO_CONSCIOUS_MONSTER_REASON` (a shared const, so the filter cannot drift from the
  Err construction) and `movement.rs` skips both the limiter and the log for it — a
  normal-gameplay non-event, like a no-trigger encounter roll. Remaining
  client-steerable reasons (e.g. a player walking grass with an escrowed party
  monster) can still consume the shared window — see residual 7.
- **Each limiter is an instantiable `RateLimiter` struct wrapping
  `Mutex<(Option<i64>, u32)>`** (`last_emit_ms`, `suppressed`) with a
  `check(now_ms, window_ms) -> Option<u32>` method (`Some(suppressed)` = emit,
  `None` = suppress) — `Option<i64>` makes "never emitted" unrepresentable as a magic
  value (no `i64::MIN` sentinel), the single lock makes the read-decide-write-back
  atomic by construction, and tests construct fresh instances (no test-only reset
  door on the two production statics). Lock poisoning recovers via `into_inner`
  (same policy as D1).
- **All arithmetic saturates** (`saturating_sub`/`saturating_add`): the workspace
  ships `overflow-checks = true` in release, so a bare subtraction on an extreme
  operand would PANIC the zone tick in production — the exact failure this feature
  exists to surface. The suppressed counter saturates at `u32::MAX`.
- **Window 5000 ms** on the tick's injected clock (`now_ms(ctx)`, ADR-0003 — no wall
  clock). A clock-backwards `now < last` emits and re-anchors rather than suppressing
  forever (trade-off, accepted: a persistently jittery host clock would force an emit
  per oscillation — host-reliability scenario, not attacker-reachable).
- **Process-static, not per-zone** (a per-zone map is unbounded growth for a log
  path — YAGNI); the zone id rides in the payload and the emitted `suppressed` count
  makes loss visible. Stated precisely: the count conflates zones and reasons — a
  suppressed window can hide WHICH other zones/reasons fired; only the count
  survives. Accepted for a log path.
- The two pre-existing `movement_tick_error` sites (:186/:193) gain `json_escape` on
  their interpolated reason (same defect class, in-file) but are **not** rate-limited:
  they fire at most once per zone per tick, so the per-step spam risk does not apply.
- Err strings surfaced by the new logs carry only public ids (monster_id/species_id)
  — verified against the side-channel rule (battle.rs:444-448: never seed/IVs/nature).

## D5 — `json_escape` at the `log_reject` choke point

`pub(crate) fn json_escape(s: &str) -> String` escapes backslash, double-quote, and
every control char below 0x20 (`\n`/`\r`/`\t` short forms, else `\u00XX` lowercase);
non-ASCII passes through (Rust `char` iteration cannot produce lone surrogates, so
pass-through is valid JSON as UTF-8 by construction). **Implementation must be a
single forward pass over `s.chars()`** — sequential `str::replace` passes
double-escape the backslashes inserted by earlier passes (attack input: `\` directly
followed by `"`). `log_reject` escapes **both `reducer` and `reason`** — production
holds ~127 `log_reject(` call sites; most pass reducer-name literals but several
(guards.rs/pvp.rs/trading.rs helpers) forward a `&str` parameter, so "always a
literal" is an unenforced convention, and this is the reject path, never a hot path.
`sender` stays unescaped: `Identity`'s Display is fixed-width lowercase hex,
structurally quote-free (documented inline).

**Repo invariant honored:** the double-quote is spelled `'\u{0022}'` (never a raw
`'"'` char literal) and no comment contains an unpaired block-comment opener — eval
W-pre and the per-file stripper helpers hard-fail otherwise. A ~5-line raw-text
guard test over the three files with new escaping-relevant text (guards.rs,
movement.rs, content_cache.rs — battle.rs/raising.rs gained only call-site swaps
with no quote-risk text and stay covered by the repo-wide eval W-pre) gives
`cargo test`-speed feedback without duplicating the eval's stripper as a second
source of truth.

## Consequences

- Per-battle-action cost drops: 1 RON abilities re-parse and 1 full `type_relation_row`
  scan + chart rebuild removed from `submit_attack`/`swap_active` (and the RON parse
  from `start_battle`/`begin_encounter`); `heal_party` stops re-parsing the heal
  registry per call.
- Grass-encounter content faults and `begin_encounter` failures are now visible in
  logs, rate-limited with an explicit suppressed count.
- Reject/error log lines are well-formed JSON for adversarial or parser-generated
  reasons.
- The heal silent-debit trap is NOT yet disarmed — that requires the parked column leg
  (residual 1); the client seam ships inert.

## Residuals (recorded for the supervisor)

1. **CLOSED by 12r-d.** The `HealLocationRow.cost_currency` column, seed read,
   bindings regen, client wiring, and the non-optional display arm all landed —
   see the D3 Amendment above for the shape (bigint end-to-end, superseding this
   bullet's "u64→number narrowing" suggestion) and for the two-readers divergence
   note it leaves behind.
2. **CLOSED by 12r-d.** All five uncached call sites swapped to
   `crate::content_cache::cached_abilities()` / `cached_type_chart(ctx)` (at
   12r-d-time line numbers: `pvp.rs:280/:383/:392`, `taming.rs:193/:207` — this
   bullet's original citations had drifted), the taming PARK comment deleted, and
   the zero-needle state gated by scan teeth in `content_cache_tests.rs` (widened
   per its own doc-comment invitation) plus `pvp_tests.rs`/`taming_tests.rs`.
   Honest scope limit, unchanged from the 11r-g battle.rs gate: the negative scans
   cover those named files — relocating an uncached call into a brand-new module
   would evade them (a hand-maintained crate-wide `include_str!` list fails open
   on new files, so it was not attempted).
3. `movement_tick_error` sites escaped but not rate-limited. Stated honestly: the
   scheduler ticks every zone every STEP_MS (200 ms) regardless of players, so a
   persistent zone-map/content fault would emit ~5 ERROR lines/sec/zone until
   redeploy — a higher frequency than anything this slice rate-limits. Accepted
   because that fault class is compile-time-embedded content (deploy-time
   detectable, never player-triggered); rate-limit them in a follow-up if it bites.
4. No proactive cache invalidation from `sync_content`: the type-chart cache relies on
   the `content_version` key; the "no `cached_type_chart` call reachable from
   `sync_content_inner`" invariant is pinned by a lexical scan of
   content.rs/marshal.rs/evolution.rs + a doc-comment contract, not a call-graph
   analysis or runtime guard.
5. No reducer-executing harness (ADR-0156 P7): items gated by pure-fn tests +
   source-scan call-site guards; end-to-end reducer behavior deferred to e2e/playtest.
6. `begin_encounter` still returns bare `Err` strings without internal `log_reject`
   (the grass path logs at the call site; `start_wild_battle` already log-rejects).
7. The fainted-party routine reason is filtered at source (shared const), but other
   client-steerable `begin_encounter` reasons (e.g. "monster is in an active trade",
   reachable by walking grass with an escrowed party monster) can still consume the
   shared `begin_encounter_error` window and mask rarer anomalies. Full fix =
   per-reason discriminants or typed errors from `begin_encounter` — deliberate
   non-goal this slice.
8. **CLOSED by 12r-d for `battle.rs`/`npc.rs`/`pvp.rs`/`content.rs`.** This
   bullet's citations had drifted; the sites actually escaped (12r-d-time line
   numbers) are `battle.rs:1158/:1240/:1256/:1266/:1382` and `npc.rs:164` (the
   spec-mandated six, all runtime `{e}` validator/parse-error text) plus
   `pvp.rs:501/:518/:612/:625` (same `{e}` class, batched here as this bullet
   directed) and the two `content.rs` `npc_sync_remove`/`npc_sync_repair` sites
   (a WEAKER class, honestly labelled: content-authored `npc_id` strings, which
   no validator charset-restricts — defensive escaping, not a runtime-error
   echo). **Still open, now queued rather than merely disclosed:**
   `evolution.rs:203/:221/:234` interpolate `{e}` into hand-built JSON the same
   way and were outside 12r-d's declared touches — they need a (tiny) slice of
   their own; this milestone's own thesis is that disclosed-but-unqueued
   residuals rot, so the supervisor should queue it, not re-disclose it.
9. The C-7 pin is a hand-maintained three-file lexical list. A stronger inversion —
   scan all of `server-module/src/` for `type_relation_row` WRITES outside
   `content.rs` (fails closed as modules grow) — is a cheap follow-up test.
