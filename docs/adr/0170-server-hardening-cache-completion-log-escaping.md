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
`isFree` ignores currency entirely (a pure content edit arms a silent-debit trap);
(4) `log_reject` interpolates rejection reasons into hand-built JSON unescaped, so a
RON/serde parse error containing quotes emits malformed log lines.

Constraints that shaped the decisions: the slice's declared touch-set is
`server-module/src/{movement,battle,raising,guards,content_cache,schema}.rs` +
`client/src/ui/healModel.ts` (+ sibling tests, docs) — `content.rs`, `pvp.rs`,
`taming.rs`, and the client net layer are OUT of scope; there is no reducer-executing
test harness (ADR-0156 P7), so every new behavior must be a pure function or a
source-scan invariant; and the repo's source-scan substrate (eval W-pre in
`zone-warp-server-runtime.eval.mjs` + per-file stripper helpers) hard-fails on raw
double-quote char literals and unpaired block-comment openers in production source.

## D1 — Version-keyed, rebuildable type-chart cache (not a LazyLock, not a sync hook)

Type relations come from DB rows (`type_relation_row`), seeded by `sync_content` — a
plain `LazyLock` would serve a permanently stale chart after any reseed (cache
poisoning of every battle's damage math). The chosen design is a
`static Mutex<Option<(u32, Arc<TypeChart>)>>` keyed on the singleton `config` row's
`content_version`:

- **Coherence proof:** `type_relation_row` has exactly one writer —
  `sync_content_inner` (delete-all + insert, content.rs:171-175) — and the same reducer
  transaction sets `cfg.content_version = CONTENT_VERSION` (content.rs:285). Module init
  seeds `content_version: 0` (lib.rs:146-148). A version match therefore guarantees the
  cached chart was built from the current rows; a mismatch triggers a rebuild via
  `marshal::type_chart_from_rows(ctx.db.type_relation_row().iter())`.
- **Err is never cached** — unlike the compile-time-embedded LazyLock registries (whose
  cached Err is deterministic, content_cache.rs module doc), DB-derived data can be fixed
  by a later transaction. A failed rebuild returns `Err`, keeps any previously cached
  older-version entry, and retries on the next call.
- **Mutex poisoning recovers** (`PoisonError::into_inner`): one unrelated panic must not
  brick every battle for the process lifetime.
- **Invariant:** no code path that writes `type_relation_row` may call
  `cached_type_chart` in the same transaction (a rolled-back write could be cached).
  Pinned by a source-scan test asserting `content.rs` contains zero
  `cached_type_chart` occurrences — not by a comment.
- **Structure:** a pure inner (`cache cell + version + rebuild closure`) carries all the
  logic and is unit-tested directly; the `ReducerContext` wrapper is ~5 lines.

**Rejected:** plain `LazyLock` over DB rows (stale-after-reseed poisoning); an
invalidation hook inside `sync_content` (requires editing out-of-scope `content.rs`,
couples content seeding to a cache, and is forgettable — the version key is
correct-by-construction even if a future writer forgets the hook *provided* it bumps
the version, which the CONTENT_VERSION minimum-bump gate already enforces); no cache
(leaves ADR-0089 incomplete, which is this slice's point).

## D2 — `cached_abilities()` completes ADR-0089's M14.5e park — for battle.rs only

`load_abilities()` is compile-time-embedded RON, so it joins the six existing
`LazyLock` statics unchanged in shape. Call-site swaps land in `battle.rs` only
(`start_battle` :242, `begin_encounter` :412, `submit_attack` :596, `swap_active`
:733, plus the two `type_chart_from_rows` sites :574/:719), and the now-false
`PARK(ADR-0089 amendment, M14.5e)` comments there are deleted. `pvp.rs:280/:392` and
`taming.rs:205` (abilities) and `pvp.rs:383` / `taming.rs:191` (type chart) are
OUTSIDE the declared touch-set: they stay untouched, their PARK comments remain
*true*, and they are recorded as residuals for a follow-up swap slice. The call-site
gate tests are scoped to `battle.rs` bodies precisely so they cannot force an
out-of-boundary edit.

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
- `healModel.ts` seam: `HealLocationViewModel` gains a required `costCurrency: number`;
  builder inputs widen locally to `StoreHealLocationRow & { readonly costCurrency?: number }`
  (absent ⇒ `?? 0`); `isFree` requires `costCurrency === 0`. The seam is **inert**
  (store rows lack the field until the column leg lands — ux2/ADR-0154 precedent) but
  the isFree contract and tests are fixed now, so the follow-up is mechanical wiring.

## D4 — Rate-limited wild-encounter failure logging

Both swallow sites in `movement_tick`'s grass block become logged no-ops (still
`continue` — a content fault must never abort the zone tick, ADR-0066), matching the
sibling `movement_tick_error` JSON shape with reasons passed through `json_escape`:

- **Two independent rate limiters** (evt `encounter_table_error` and
  `begin_encounter_error`) — a spammy bad-content zone must not mask
  `begin_encounter` failures. Process-static `AtomicI64` last-emit + `AtomicU32`
  suppressed counter per kind; a per-zone map would be unbounded growth for a log
  path (YAGNI); the zone id rides in the payload and the emitted `suppressed` count
  makes any loss visible.
- **Window 5000 ms** on the tick's injected clock (`now_ms(ctx)`, ADR-0003 — no wall
  clock). Sentinel `i64::MIN` = never-emitted; elapsed math saturates; a
  clock-backwards `now < last` emits and re-anchors rather than suppressing forever.
- **Pure decision function** (`last_log_ms, suppressed, now_ms, window_ms → Emit{suppressed} | Suppress`,
  exhaustive enum) carries all logic and is unit-tested directly; no test-only reset
  door exists on the statics.
- The two pre-existing `movement_tick_error` sites (:186/:193) gain `json_escape` on
  their interpolated reason (same defect class, in-file) but are **not** rate-limited:
  they fire at most once per zone per tick, so the per-step spam risk does not apply.

## D5 — `json_escape` at the `log_reject` choke point

`pub(crate) fn json_escape(s: &str) -> String` escapes backslash, double-quote, and
every control char below 0x20 (`\n`/`\r`/`\t` short forms, else `\u00XX`); non-ASCII
passes through (valid JSON as UTF-8). `log_reject` escapes **both `reducer` and
`reason`** — `reducer` is a string literal at all 31 call sites today, but that is an
unenforced invariant and this is the reject path, never a hot path. `sender` stays
unescaped: `Identity`'s Display is hex, structurally safe (documented inline).

**Repo invariant elevated:** the double-quote is spelled `'\u{0022}'` (never a raw
`'"'` char literal) and no comment contains an unpaired block-comment opener — eval
W-pre and the per-file stripper helpers hard-fail otherwise. A local Rust test
mirrors W-pre over the touched files so the failure surfaces in `cargo test` seconds,
not at eval time.

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

1. **`HealLocationRow.cost_currency` column — PARKED (hidden dependency).** Needs
   `schema.rs:430-441` + `content.rs:702` seed + bindings regen +
   `client/src/net/{store,rowConvert}.ts` + `healView.ts` display; amends ADR-0083 §A
   (its m13c/m13d constraint has expired); u64→number narrowing at `rowConvert.ts:522`.
2. **ADR-0089 residual call sites (PARK comments remain TRUE):** `pvp.rs:280/:392`,
   `taming.rs:205` (`load_abilities`); `pvp.rs:383`, `taming.rs:191`
   (`type_chart_from_rows`). Follow-up swaps + delete `taming.rs:203`'s PARK comment.
3. `movement_tick_error` sites (:186/:193) escaped but not rate-limited (once per
   zone per tick — no spam risk).
4. No proactive cache invalidation from `sync_content`: the type-chart cache relies on
   the `content_version` key; the "no `cached_type_chart` in `content.rs`" invariant is
   pinned by source-scan only.
5. No reducer-executing harness (ADR-0156 P7): items gated by pure-fn tests +
   source-scan call-site guards; end-to-end reducer behavior deferred to e2e/playtest.
6. `begin_encounter` still returns bare `Err` strings without internal `log_reject`
   (the grass path logs at the call site; `start_wild_battle` already log-rejects).
