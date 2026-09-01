I have everything I need. Here is the plan.

---

# m22-s4 — Plan: M22 §5 data export (PRV1-11..14)

## 0. Corrections to the brief's "established facts" — read these first

Five load-bearing corrections. Three of them change the right-sizing.

**C1 (NEW BLOCKER, highest impact) — calling `purge_export_bundles` from the S4 reducer is a hard RED in an out-of-touches test.**
`/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/server-module/src/accounts_tests.rs:4906-4935` defines a per-file naming budget consumed by `rb22_purge_named_nowhere_else_in_crate` (`:4992-5036`):

```rust
"privacy.rs" => (
    1,
    "the helper's own declaration and nothing else. TWO means the owning module
     names it a second time — a wrapper or a re-export that hands a different
     owner to a body the frozen-body pin still reports as correct. ..."
),
```

The census counts the **bare token** `purge_export_bundles` over squashed source with **no word boundaries on either side**, so the reducer's call site is occurrence #2 and the assertion is `assert_eq!(n, 1)`. Fact 11 in the brief ("adding callers is fine") is **wrong for privacy.rs itself** — it is true only for *other* modules… and there it is `0`. `accounts_tests.rs` is out of the declared touches.

**C2 (NEW BLOCKER) — privacy.rs may contain no string literal at all, so every JSON token and every table/field name must come from `stringify!`.**
`rb22p_no_bare_quote_in_privacy` (`privacy_tests.rs:783-813`) asserts privacy.rs carries **exactly one** `"…"` literal — the `#[path = "privacy_tests.rs"]` attribute — and **zero** other `"` bytes anywhere, including comments. That kills `format!`, `"monster".to_string()`, string-literal `match` patterns, `"null"`, and every quoted JSON field name. The fix is `stringify!(monster)` / `stringify!(monster_id)` / `stringify!(null)` / `stringify!(true)` plus `char` literals `'{'`, `'}'`, `':'`, `','`, `'['`, `']'`. The brief's fact 7 understates this: it says "no escaped or char-literal double quote"; the real rule is **no double quote byte at all**.

**C3 (NEW BLOCKER) — reading two of the 17 exportable tables trips two shared-eval accessor-scoping gates.**
- `evals/currency-integrity.eval.mjs:217-242` — `hasWalletAccessorBypass` flags `/player_wallet\s*\(\s*\)/` in any file whose path is not exactly in `ACCESSOR_BYPASS_ALLOWLIST = ['economy.rs','economy_tests.rs','schema.rs']`. `ctx.db.player_wallet()` in privacy.rs reds it.
- `evals/ranking-security.eval.mjs:252,272-305` — checker A2 flags `ctx.db.profile()` in **every** non-test `.rs` under `server-module/src` except a hardcoded `if (entry === 'ranking.rs') continue;`. `ctx.db.profile()` in privacy.rs reds it.

Neither is avoidable without delegating into `economy.rs` / `ranking.rs` (also out of touches, and *substantive* code — the worse ADR-0225 shape).

**C4 — adding the `my_export_bundle` view forces two more shared-eval edits.**
`EXPECTED_VIEWS` is pinned index-wise, sorted, in **both** `evals/monster-privacy.eval.mjs:160-166` and `evals/account-privacy.eval.mjs:213-219`; `checkViewInventory` (`monster-privacy.eval.mjs:1004-1027`) walks *all* non-test `.rs` under `server-module/src`, so a view in privacy.rs is seen. Both gates' own text says the edit is the sanctioned procedure, and there is a direct precedent: 15r-sec-a did exactly this for `my_battle` (`ARCHITECTURE.md:1701`).

**C5 — PRV1-14's blocker set is different (and slightly smaller) than the brief assumes.**
Correct: it needs a new `scheduled(...)` table (automigration-frozen, ADR-0221 → table + reducer atomic) → `schema.rs` `DATA_LIFECYCLE_MANIFEST` entry (T1 set-equality, `accounts_tests.rs:3562-3569`) + `evals/baselines/table-schemas.json` + `battle-schema-snapshot.eval.mjs` T-VIS-ANCHORS. **Not** needed: a `REKEY_MANIFEST` entry (an interval reaper schedule carries no `Identity` column — `playtest_reaper_schedule` precedent at `playtest.rs:32-38`), and **not** a `lib.rs` edit: the reaper can self-arm idempotently from `request_data_export` (`ensure_playtest_reaper` precedent, `playtest.rs:183-189`). Also **no game-core TTL constant is needed** — `PLAYTEST_EVENT_TTL_MS` lives in `playtest.rs:10`, so a privacy.rs-local `EXPORT_BUNDLE_TTL_MS` is precedented.

Everything else in the brief checks out. Verified: 17 `exportable: true` tables (`schema.rs:995-1267`, recounted — 12 ERASE + 4 ANONYMIZE + `character`); `EXPORT_CHUNK_ROWS: u32 = 500` (`game-core/src/accounts/deletion.rs:145`) with its own doc telling S4 to cast at the `.chunks()` call site; no `serde_json` in server-module (`server-module/Cargo.toml:12-28`; game-core has it as a **dev**-dep only, `game-core/Cargo.toml:30`); `now_ms` at `marshal.rs:24-26`; `ExportBundle` shape frozen by `export_bundle_struct_shape_and_privacy` (`accounts_tests.rs:4083-4165`); ADR **0226 is free** on disk (highest is 0225) — re-`ls docs/adr/` before minting.

---

## 1. Verdict on the right-sizing

### 1a. Can the TTL reaper (PRV1-14) ship without a new table? **No.** Confirmed.
Every existing schedule table is bound to exactly one reducer via `scheduled(<reducer>)`, so none can be reused. The only table-free alternative is opportunistic expiry inside `request_data_export`, which (i) is not a reaper (it never fires unless someone exports), (ii) would need to sweep *all* owners → a whole-table walk that `rb22p_owner_scoped_filter_never_iter` (`privacy_tests.rs:472-491`) bans in privacy.rs by name, and (iii) for the caller's own chunks is already what purge-before-write does. Record it as the considered-and-rejected alternative in ADR-0226.

### 1b. Does deferring PRV1-14 create a hole worse than recorded? **No, but the residual must be stated precisely.**
- Storage is **bounded**: purge-before-write leaves at most one request's chunks per owner. That also discharges ADR-0220 residual 4(b) ("S4 must cap per-owner live chunk rows — an unbounded chunk count would let a guest inflate `complete_guest_claim` past the reducer budget").
- The gap is **retention, not confidentiality**: the table is private, the view is owner-scoped, so the bundle is readable only by its subject. With S3b also deferred (ADR-0225), an exported bundle persists until the owner's next export or their guest-claim purge — i.e. **indefinitely**. That is genuinely worse than the spec's "7-day TTL prevents an unretained second copy".
- Exposure **today is nil**: `ALLOWED_ISSUERS` is still the fail-closed `.invalid` placeholder (ADR-0225 consequences), so no real account can be provisioned. **S4b must land before the first real account**, same sequencing constraint ADR-0225 puts on PRV1-8.

### 1c. The right-sizing itself — I **agree** with deferring PRV1-14, and **disagree** that the rest fits the declared touches.

The brief's provisional shape ("ship 11/12/13 inside privacy.rs only") is not reachable. C1+C3+C4 mean **five out-of-touches gate files**, four of which are security allowlists being *widened*:

| # | File | Edit | Class |
|---|---|---|---|
| 1 | `server-module/src/accounts_tests.rs:4918-4924` | naming budget `privacy.rs` 1 → 2 | widen a security tooth |
| 2 | `evals/currency-integrity.eval.mjs:238-242` | `+ 'privacy.rs'` | widen an allowlist (gate invites it) |
| 3 | `evals/ranking-security.eval.mjs:288-289` | inline `'ranking.rs'` → named 2-element allowlist | small gate-logic refactor |
| 4 | `evals/monster-privacy.eval.mjs:160-166` | `+ 'my_export_bundle'` (sorted, index 3) | widen (gate invites it) |
| 5 | `evals/account-privacy.eval.mjs:213-219` | same | widen (gate invites it) |

Plus mechanical ritual companions: `client/src/module_bindings/**`, `docs/knowledge/**`, `ARCHITECTURE.md`, `docs/adr/0226-*.md`.

**Recommendation: ship PRV1-11/12/13 complete, defer PRV1-14, and take the five edits under a declared `touches-delta:` — but raise them as a pre-build STOP/WARN and get the supervisor's blessing before writing a line.** The spec itself prescribes this exact procedure (§7.2 note: "S0 edits a shared eval file → WARN, declare it and let the supervisor reconcile"), rb-24 (PR #398) has the touches-delta precedent, and 15r-sec-a has the EXPECTED_VIEWS precedent. The alternative to widening is delegating wallet/profile reads into `economy.rs`/`ranking.rs` — *substantive* code in out-of-touches modules, i.e. the exact shape ADR-0225 refused. Widening four one-line allowlists with compensating in-touches pins is strictly cheaper and strictly more reviewable.

**If the supervisor refuses the eval deltas, S4 cannot ship at all** and must be re-serialized whole with the touch list up front. There is no smaller viable subset: dropping `player_wallet`/`profile` from the export breaks PRV1-11's manifest totality and would require a `schema.rs` `exportable` edit (worse).

### 1d. On the view: ship it (with the ADR-0225 counter-argument recorded)
ADR-0225 rejected the `resolve_all_live_interactions` seam because it would ship with a single, deferred consumer. By parity you could defer `my_export_bundle` to S8 and drop two eval deltas. I recommend **shipping it** anyway: (a) it is 5 lines of a proven idiom, (b) spec §7.3 names the regenerated bindings as an S4↔S8 contract and S8 cannot start without the binding, (c) one bindings regen instead of two, (d) unlike TR-18, no gate goes *semantically* red — the two gates document allowlist-addition as the procedure. Record the deviation-from-parity in the ADR so the next reader sees it was weighed.

### 1e. Sizing warning (M8.9)
Design B below lands privacy.rs at **~900 lines** (≈43-field `monster`, ≈26-field `monster_pub`, 25-arm `NatureKind`, 9 enum encoders, heavy doc style). That is ~1.7× the ~520-line guidance. **Flag a follow-up split** (`privacy.rs` shell + a `privacy_json.rs` core) as a named residual — a new file is out of touches this slice.

### 1f. One timeboxed spike that could halve it (optional, ≤90 min, abort-hard)
`spacetimedb-2.8.1/src/lib.rs:44` re-exports `spacetimedb_lib::sats` publicly, and the SATS serializer trait carries **named** products and **named** variants (`spacetimedb-sats-2.8.1/src/satn.rs:646 TypedNamedProductFormatter`). A ~250-line JSON `Serializer` impl over `spacetimedb_lib::ser::Serialize` would serialize all 16 non-redacted tables generically, with real field/variant names, zero per-table code, and zero name duplication — and new columns would export automatically. **There is no JSON writer in `satn`** (only SATN + PSQL formatters), so this is a from-scratch trait impl. Known wrinkles the spike must resolve: `Identity` is a SATS product over one `u256`, so hex output needs a special case; `u64/i64/u128/i256` must be emitted as quoted strings; and `battle` still needs a hand-rolled redacting serializer. **Abort rule:** if a round-trip unit test over one real row struct is not green in 90 minutes, take Design B and never revisit inside this slice.

---

## 2. Design — privacy.rs additions (Design B, the certain one)

Layout inside the one file, in this order:

### 2.1 Module header (edit, do not rewrite)
`rb22p_stub_probe_regression` (`privacy_tests.rs:940-980`) reads the leading run of `//!` lines and requires the tokens `export_bundle` **and** `rb-22`. Extend the header; **do not** replace it. Restate the scan-hygiene contract with the C2 strengthening ("this file carries exactly one double-quote pair, the `#[path]` attribute; every constant string is `stringify!`").

### 2.2 JSON micro-builder (pure)
```
const JSON_MAX_ESCAPE_LEN            // sizing hint only
fn json_escape_into(out: &mut String, s: &str)
fn json_str_into(out: &mut String, s: &str)          // quote + escape + quote
fn json_u64_into / json_i64_into(out, v)             // QUOTED decimal
fn json_u32_into / json_u16_into / json_u8_into / json_i32_into(out, v)  // bare
fn json_bool_into(out, b)                            // stringify!(true)/stringify!(false)
fn json_null_into(out)                               // stringify!(null)
fn json_identity_into(out, id: Identity)             // quoted lowercase hex
fn field_into(out, first: &mut bool, name: &str)     // emits ',' when !first, then "name":
```

**Escaping contract (exact, testable):**
- `"` (0x22) → `\` + 0x22; `\` → `\\`.
- every byte `< 0x20` → `\u00XX` (uniform; no `\n`/`\t` short forms — one branch, one test family).
- `/` is **not** escaped; 0x7F is **not** escaped.
- everything ≥ 0x20 non-ASCII passes through as UTF-8 (valid JSON; Rust `String` cannot hold a lone surrogate).
- The quote byte is spelled `const JSON_QUOTE: char = '\u{0022}';` — no `"` byte in source, not an escaped quote (`\"`, banned by `rb22p_scan_hygiene`), not a char-literal quote (`'"'`, banned by the production-only clause).

**64-bit rule (decision):** `u64` and `i64` are emitted as **quoted decimal strings**; everything ≤32-bit and `bool` as bare JSON literals. Rationale: `JSON.parse` in the S8 client silently loses precision above 2^53, and `player_wallet.balance`, `trade_offer.*_currency`, `player.last_input_seq` and every `*_id` are `u64`. Test at `u64::MAX`, `i64::MIN` (note `to_string()` on `i64::MIN` is fine; unary negation is not), `0`. Document the rule in the ADR and in the module header so S8's assembler knows to `BigInt()` them.

**Identity rule:** `owner.to_string()` — `Identity`'s `Display` is "fixed-width lowercase hex" (`guards.rs:54`), and `to_string()` needs no format-string literal. Test asserts length 64, `[0-9a-f]` only, over `Identity::from_byte_array([0xAB;32])` (constructible in the *test* file; the constructor stays banned in privacy.rs by `rb22p_no_identity_constructor`).

### 2.3 Value encoders for schema types (pure)
Nine exhaustive `match`es with **no wildcard arm** (so a new variant is a compile error), each arm `stringify!(Variant)`:
`NatureKind` (25), `TrustTier` (5), `TradeStatus` (2), `ChallengeStatus` (4), `AccountStatus` (2), `Direction` (4), `ActionState` (3); plus payload enums `MoveInput` (`{"kind":"Step","direction":"North"}` / `{"kind":"Jump"}`) and `PvpAction` (`{"kind":"Attack","skill_id":3}` / `{"kind":"Swap","team_index":1}`). Plus `TradeItem` and `MonsterCard` object encoders and `Vec<u64>` / `Vec<String>` array helpers.

### 2.4 Per-table serializers (pure, directly unit-testable)
```rust
fn json_monster(row: &Monster) -> String
fn json_monster_pub(row: &MonsterPub) -> String
… 15 more …
fn json_battle(row: &Battle, me: Identity) -> String     // redacting; takes the requester
```
Every one takes the **row struct by reference** and returns a complete JSON object. Row structs have `pub` fields and are constructible in `privacy_tests.rs` — so all 17 are behaviorally tested with no `ReducerContext`. Field order = declaration order.

### 2.5 The `battle` redaction (the only redaction that does anything)
Spec §5 makes `battle` + `battle_action` the only redacted tables. **`battle_action` redaction is vacuous by construction** and must be documented as such: the own-rows filter is `player_identity == me`, so no counterparty row is ever in the result set (`schema.rs:889-906`, no index on `player_identity` — see §2.7). For `battle`:

```
pure: fn battle_side_of(me, row) -> BattleSideOwnership  // A | B | Both | Neither
```
- `Neither` → the row must never be emitted (a pure guard against a filter bug); the serializer returns an error/None and the reducer fails loud.
- `A` (me == `player_identity`): emit `player_identity`, `party_monster_ids`; emit `opponent_identity: null`, `opponent_monster_ids: null`.
- `B`: mirror image.
- `Both` (practice battle, `player_identity == opponent_identity`, `battle.rs`): redact nothing, and the row is visited **exactly once** — reuse the `my_battle` dedup-by-construction idiom (`schema.rs:428-442`), never `player_identity != opponent_identity`.

**`battle.state` (`BattleState`) is deliberately NOT exported.** It is a deep game-core structure (`BattleSide{active, team: Vec<BattleMonster>}` × 2 + `BattleOutcome` + `Option<WeatherEffect>`, `game-core/src/combat/types.rs:74-176`), and one of its two sides **is** "the counterparty's private state" that spec §5 requires redacting. Field-by-field redaction of a nested blob is more code and more risk than omission, and the requester loses nothing: their own monsters are fully exported in the `monster` chunk. Emit instead `battle_id`, both identity columns (redacted per above), `outcome`, `turn_number`, `created_at_ms`, and the own-side monster-id list. **This is a deliberate fidelity decision and belongs in ADR-0226 with that exact justification.**

### 2.6 Manifest-driven dispatch with mechanical totality
```rust
type ExportRows = fn(&ReducerContext, Identity) -> Result<Vec<String>, String>;
const EXPORTERS: &[(&str, ExportRows)] = &[
    (stringify!(monster),      rows_monster),
    (stringify!(monster_pub),  rows_monster_pub),
    …17 entries…
];
```
Totality is enforced **three** ways, strongest first:

1. **Compile-time.** `const fn str_eq(&str,&str)->bool` + `const fn exporters_cover_manifest(&[DataLifecycleEntry], &[(&str, ExportRows)]) -> bool` (both directions: every `exportable:true` table has an exporter; every exporter names an `exportable:true` table), consumed by
   `const _: () = assert!(exporters_cover_manifest(DATA_LIFECYCLE_MANIFEST, EXPORTERS));`
   — mirroring `schema.rs:1298`'s `const _: () = assert!(manifest_is_wellformed(DATA_LIFECYCLE_MANIFEST));` verbatim in shape. A new `exportable:true` table becomes a **compile error**, not a runtime gap. This const-eval read also keeps `EXPORTERS` (and therefore every `fn` item it names) live in the lib target under `-D warnings` — the "lib-target dead_code needs a const-eval consumer" trap.
2. **Runtime fail-loud arm.** The reducer walks `DATA_LIFECYCLE_MANIFEST`, and for any `exportable:true` entry with no `EXPORTERS` match it returns `Err` naming the table. Reachable, and it is the arm PRV1-11 actually promises.
3. **Behavioral test** (legibility): recompute both sets, assert set equality **both directions** plus `len == 17`, with a message that names the offending table. A compile error is correct but illegible; this test is what tells the next author what to do.

Dispatch order = manifest order (deterministic, and the manifest is the documented partition order).

### 2.7 Read shapes per table (own-rows only)
Index-backed (`.find` on PK / `.filter` on btree): `monster`, `monster_pub`, `inventory`, `player_quest` (btree `owner_identity`); `player_dialogue_state`, `player_conversation`, `heal_cooldown`, `player_wallet`, `player`, `profile`, `account` (PK); `trade_offer` (btree `initiator` **+** `counterparty`, dedup by `trade_id`); `battle_challenge` (btree `challenger` + `target`, dedup); `battle` (btree `player_identity` + `opponent_identity`, `my_battle` dedup); `character` (via `player.entity_id` → `character.entity_id().find(..)`, the `ViaJoin("player")` pin).

**Two full-table scans, unavoidable and to be documented:** `battle_action.player_identity` (`schema.rs:898` — no index) and `playtest_event.identity` (`playtest.rs:21` — no index). Both tables are bounded (`battle_action` = 2 rows/turn, deleted on resolve; `playtest_event` capped at `PLAYTEST_EVENT_CAP = 20_000` globally, `playtest.rs:11`). Note in the ADR; do **not** add indexes (schema.rs out of touches, and an index add is a separate migration decision).

### 2.8 Chunking (pure) — **request-wide** `chunk_index`, **request-wide** `total_chunks`
```rust
struct PlannedChunk { table: &'static str, chunk_index: u32, payload: String }
fn plan_export_chunks(per_table: Vec<(&'static str, Vec<String>)>) -> Vec<PlannedChunk>
// total_chunks = plan.len() as u32, identical on every row of the request
```
**Justification against the client's rule.** Spec §5 states the client "waits for `chunks.length === total_chunks` before assembling". Per-table `total_chunks` makes that rule unimplementable (the client cannot know how many tables to expect, and would have to group-then-check-each-group). Request-wide `total_chunks` makes the spec's literal rule correct, satisfies PRV1-13's "sharing one `request_id` with a stable `total_chunks`" in the strongest sense (*every* row carries the same number), and still supports per-table reassembly: group by `table_name`, order by `chunk_index` — a globally monotone index is monotone within every group. This requires a **two-pass** build (collect all chunks → count → write), which is exactly why the planner is a pure function.

**Empty tables:** emit **one chunk with an empty `rows` array, unconditionally, for every `exportable:true` table.** That is PRV1-11's letter ("one chunk per table"), it makes the written `table_name` set testably equal to the manifest's exportable set, and it tells the subject "we hold nothing for you here" — meaningful in a compliance export. Implementation trap: `slice::chunks(500)` on an **empty** slice yields **zero** chunks; the planner must special-case `rows.is_empty()`. Its own named test.

Sub-chunking uses `EXPORT_CHUNK_ROWS as usize` at the `.chunks()` call site only (`deletion.rs:143-144` explicitly instructs this).

**Payload shape:** `{"table":<name>,"rows":[ {...}, ... ]}` — self-describing after download, and nothing duplicated from the columns beyond the name.

### 2.9 `request_id` minting
`now_ms(ctx) as u64` (`marshal.rs:24-26` returns `.max(0)`, so the cast is lossless and non-negative). Rationale: monotone, meaningful, derived from the injected clock, **no RNG** (server RNG is not a CSPRNG here and the module bans it in security-sensitive paths), and directly testable. Global uniqueness is not required: purge-before-write means exactly one request is live per owner at any time, and the reducer-enforced uniqueness tuple is `(owner, request_id, table_name, chunk_index)` per `accounts_tests.rs:4158-4163`. Bind `now` **once** and feed it to both `request_id` and `created_at_ms` — the rb-24 "shadowed `now`" red-team cheat applies verbatim.

### 2.10 Cooldown (reject, never clamp) — with **zero new state**
```rust
const EXPORT_REQUEST_COOLDOWN_MS: i64 = 60_000;  // honest-basis comment: DoS knob, not a legal figure
pub(crate) fn export_cooldown_elapsed(last_at_ms: Option<i64>, now_ms: i64) -> bool
// None => true (no prior export)  |  Some(t) => now.saturating_sub(t) >= COOLDOWN
```
State source: `max(created_at_ms)` over the owner's **existing** `export_bundle` chunks, read via the `owner_identity` btree **before** the purge. Because purge-before-write leaves exactly the last request's chunks, that maximum *is* the last request time — no new column, no new table, no schema change.

Why it belongs in this slice and is not speculative generality: `request_data_export` is the only reducer in the module that walks 17 tables for the caller; SpacetimeDB reducers are serial under one global write mutex, so an unthrottled client loop is a module-wide DoS this slice itself creates. Spec §8.3 escalates the transaction-size risk for exactly this reducer.

**Polarity trap to call out in the code and the test:** `export_cooldown_elapsed(None, _) == true` is the *opposite* polarity from `is_deletion_due(None, _) == false` (`deletion.rs:63-68`). Copy-pasting that function inverts the gate silently.

Reason string: a distinct static reject reason. It cannot be a literal in privacy.rs (C2) — build it from `stringify!` fragments, or have the reducer return `Err` built from `stringify!` tokens. Keep it short and pin it in `privacy_tests.rs`.

### 2.11 Reducer body order (this is the whole security shape)
```
1  let me  = ctx.sender();
2  let now = now_ms(ctx);
3  let last = max(created_at_ms) over export_bundle.owner_identity().filter(me)
4  if !export_cooldown_elapsed(last, now) { return Err(<static reason>); }   // ONLY early return
5  purge_export_bundles(ctx, me);                                            // C1 call site
6  build per-table rows via EXPORTERS, in manifest order  (Err on any gap)
7  let plan = plan_export_chunks(rows); let total = plan.len() as u32;
8  for c in plan { ctx.db.export_bundle().insert(ExportBundle{ chunk_id: 0, owner_identity: me,
                       request_id: now as u64, table_name: c.table.to_string(),
                       chunk_index: c.chunk_index, total_chunks: total,
                       payload_json: c.payload, created_at_ms: now }); }
9  Ok(())
```
Steps 5–8 are one transaction, so a mid-write abort leaves the prior bundle intact (SpacetimeDB reducer atomicity, ADR-0106 D8). Step 4 is the **only** `return` before the writes — pin its position.

### 2.12 The view
```rust
#[spacetimedb::view(accessor = my_export_bundle, public)]
fn my_export_bundle(ctx: &spacetimedb::ViewContext) -> Vec<ExportBundle> {
    ctx.db.export_bundle().owner_identity().filter(ctx.sender()).collect()
}
```
Verbatim `my_monster_pub` idiom (`schema.rs:375-382`). `public` on the attribute is inert; **this body is the entire security boundary** and must be pinned by *equality*, signature included (a 1.12/2.x view accepts extra args, so an `owner: Identity` param is a caller-chosen-owner leak — ADR-0154 D2 / ADR-0194 D2). Placed in `privacy.rs`, not `schema.rs` (spec §7.2 assigns all S4 machinery here; the "views live beside their table" convention is not gate-enforced — `checkViewInventory` and `[A/view-set]` are path-agnostic). Record the convention deviation in ADR-0226.

---

## 3. Functional-core / imperative-shell split

**Pure (behavioral + property tests, zero `ReducerContext`):**
`json_escape_into`, `json_str_into`, all number/bool/null/identity emitters, `field_into`; the 9 enum encoders; `TradeItem`/`MonsterCard`/`Vec` helpers; all 17 `json_<table>(row)` serializers; `battle_side_of` + `json_battle(row, me)`; `plan_export_chunks`; `export_cooldown_elapsed`; `exporters_cover_manifest` / `str_eq` (const fns).

**Shell (source-structure pins only — `ReducerContext` is not constructible, ADR-0225 D5):**
the 17 `rows_<table>(ctx, owner)` readers; `request_data_export`; `my_export_bundle`.

**Rules-in-one-place discipline:**
- `EXPORT_CHUNK_ROWS` is **imported** from `game_core`, never re-spelled (a test asserts the planner's boundary equals `game_core::EXPORT_CHUNK_ROWS`, so a hardcoded 500 reds).
- Table names come from `DATA_LIFECYCLE_MANIFEST` at dispatch time and from `stringify!(<accessor ident>)` in `EXPORTERS`; the const-eval assertion ties the two together. No third roster.
- Nothing that belongs in game-core is re-derived: the export contains **no game rule**. `EXPORT_REQUEST_COOLDOWN_MS` and `EXPORT_BUNDLE_TTL_MS` (S4b) are server-module operational knobs, precedented by `PLAYTEST_EVENT_TTL_MS` (`playtest.rs:10`) and by ADR-0221's decision to keep `deletion_fire_at_ms` out of game-core; record the future consolidation as a residual (ADR-0221 R5's sibling).

---

## 4. Test plan (all new tests in `server-module/src/privacy_tests.rs`, prefix `m22s4_`)

| Criterion | Tests |
|---|---|
| **PRV1-11** (one chunk per exportable table, own rows only) | `m22s4_serializer_per_table_shape` (17 sub-cases over constructed row structs, incl. **empty-owner fixture** → every serializer still produces a well-formed object); `m22s4_exporter_set_equals_manifest_both_directions` (+ `len == 17`, + a `stale exporter` negative and a `missing exporter` negative built from *fixture* manifests, since the real one is compile-locked); `m22s4_reducer_filters_every_read_on_sender` (source-structure: each `rows_<table>` body contains the table's REKEY-manifest identity column and either `.find(owner)`/`.filter(owner)` or an `.iter()` immediately followed by an `== owner` predicate; fail-loud floor of 17 facts) |
| **PRV1-12** (exportable:false never included) | `m22s4_no_exportable_false_table_is_named` — over squashed privacy.rs, assert the accessor tokens `battle_wild(`, `guest_claim(`, `pvp_deadline_schedule(`, `battle_challenge_reaper_schedule(`, `trade_offer_reaper_schedule(`, `config(` … (derived from the manifest, not hand-listed) occur **0** times; assert `individuality_seed` occurs 0 times (the spec's own `[DEL-05]` BAD fixture). Rust twin of `[DEL-05]`, which S6 will own |
| **PRV1-13** (sub-chunk split) | `m22s4_plan_chunks_boundaries` (0→1 chunk, 1→1, 499→1, 500→1, 501→2, 1000→2, 1001→3); `m22s4_plan_chunks_request_wide_invariants` (every chunk carries the same `total_chunks == plan.len()`; `chunk_index` is exactly `0..N-1`, unique, contiguous; per-table order preserved; grouping by `table_name` then sorting by `chunk_index` reproduces the input row order) — **proptest** over random `(table_count, rows_per_table)`; `m22s4_chunk_boundary_is_game_core_constant` |
| **redaction** | `m22s4_battle_side_of_truth_table` (A / B / Both / Neither); `m22s4_battle_redacts_counterparty` (sender==A: opponent id + opponent ids are `null`; sender==B: mirror; **practice battle**: nothing redacted, emitted once); `m22s4_battle_state_blob_is_never_emitted`; `m22s4_battle_action_own_rows_only` (documented-vacuous redaction, asserted structurally) |
| **escaper** | `m22s4_escape_edge_cases` (`"`, `\`, every byte 0x00–0x1F → `\u00XX`, `/` unescaped, 0x7F unescaped, 4-byte emoji and CJK pass through); `m22s4_escape_roundtrip_property` (**proptest**: for any `String`, a reference unescaper *defined in the test file only* maps `json_escape` back to the input); `m22s4_escape_output_has_no_raw_control_or_quote` (proptest); `m22s4_u64_i64_are_quoted_strings` (`u64::MAX`, `i64::MIN`, `0`); `m22s4_small_ints_are_bare`; `m22s4_identity_is_64_lowercase_hex` |
| **cooldown** | `m22s4_cooldown_truth_table` (`None`→allow, exact boundary `==COOLDOWN`→allow, one below→reject, future-dated→reject, `i64::MIN/MAX` no panic); an explicit assertion that the `None` polarity is the **opposite** of `is_deletion_due`'s |
| **reducer wiring** (source-structure) | `m22s4_reducer_statement_order` (squashed: cooldown-read < cooldown-reject < `purge_export_bundles(ctx,me)` < first `export_bundle().insert(`; the purge call appears **exactly once** at brace depth 0; **exactly one** `return` token before the first insert); `m22s4_now_bound_once` (one `now_ms(ctx)` binding, and `request_id`/`created_at_ms` both read it — the rb-24 shadowed-`now` cheat); `m22s4_insert_row_fields_exact` (the `ExportBundle{…}` literal names all 8 columns, `chunk_id: 0`, `owner_identity: me`) |
| **view wiring** | `m22s4_view_declared_once_attr_sig_body_exact` — attribute `accessor=my_export_bundle,public` exactly once; signature exactly `(ctx:&spacetimedb::ViewContext)->Vec<ExportBundle>`; body **equality** to `ctx.db.export_bundle().owner_identity().filter(ctx.sender()).collect()` (accept the `&ctx.sender()` borrow twin, the `my_monster_pub` precedent) — **plus a positive control** that derives the pinned literal from source text through the live strip pipeline, so the pin is proven satisfiable (`rb22p_machinery_comment_string_blind`'s (b) arm, verbatim in shape). This is the ADR-0154 D2 decoy attack: a presence check is passed by `let _decoy = …filter(ctx.sender()); …filter(other)` |
| **cross-manifest** | `m22s4_filter_columns_are_rekey_manifest_columns` — `include_str!("../../evals/guest-claim-integrity.eval.mjs")`, reuse `m22_rekey_manifest_keys`-shaped extraction (fail loud below 20 keys), and assert **filter-columns ⊆ REKEY_MANIFEST columns** for each exportable table (the safe direction — `account.claimed_from` is an identity column that is deliberately *not* a filter, so equality would be wrong), with a ≥17 floor. **Formatter trap:** biome's `\'` rewrite has silently truncated an `include_str!` key scan before (memory: "Text-scan consumer breaks under the formatter"); ship the co-scan twin asserting the extracted key list is non-empty and contains the `account.identity` anchor |
| **regression** | the entire existing `rb22p_*` suite must stay green unmodified except the two deliberate additions below |

**Deliberate `privacy_tests.rs` changes (in touches):** (i) extend the hygiene bans if anything new is warranted; (ii) add the **compensating pin** for the C1 budget widening — assert privacy.rs names `purge_export_bundles` exactly twice, once as `pub(crate) fn …` and once as the call `purge_export_bundles(ctx,me)` inside `request_data_export` at depth 0, with `me` bound from `ctx.sender()`. Without that pin, widening `accounts_tests.rs`'s budget to 2 is a net loosening (memory: "Widening a gate matcher can loosen it — measure fork-vs-HEAD").

---

## 5. Anti-patterns to avoid (named, concrete)

1. **Any `"` in privacy.rs.** No `format!`, no `.to_string()` on a literal, no `"table"` `match` patterns, no `"` inside a `//` comment. Two bare quotes on two comment lines make the strings-first stripper blank every character between them — measured, and it hid an arbitrary-Identity `account` delete (`privacy_tests.rs:760-812`).
2. **`.insert(` on a `Vec`/`String`/`HashMap`.** `rb22p_write_targets` (`privacy_tests.rs:343-377`) counts every `.insert(`/`.update(`/`.delete(` as a DB write and poisons any that is not anchored to a same-statement `ctx.db.` chain. Use `.push()`. Same for `.remove(`-adjacent temptations.
3. **`let db = &ctx.db;` or any context alias**, and any `&ReducerContext` parameter not named `ctx` (`rb22p_no_db_or_ctx_alias`).
4. **A raw identifier** (`r#type`, `r#match`) — `rb22p_scan_hygiene` bans the substring `r#` outright.
5. **Rewriting the module header.** `rb22p_stub_probe_regression` needs `export_bundle` and `rb-22` in the leading `//!` run.
6. **Renaming or reshaping `purge_export_bundles`** — three frozen pins (two in `privacy_tests.rs`, one in `accounts_tests.rs:4746+`) and the crate-wide census; and any new fn whose name *starts with* `purge_export_bundles` (a `_v2` twin) false-REDs the boundary-free census.
7. **Wildcard `_ =>` arms in the enum encoders.** The whole point is that a new `NatureKind`/`TrustTier` variant is a compile error.
8. **A hand-typed `500`.** Import `game_core::EXPORT_CHUNK_ROWS`.
9. **Per-table `total_chunks`** — breaks the spec's own client wait rule (§2.8).
10. **`slice::chunks()` on an empty vec** silently yields zero chunks and silently drops a table from the export while every count-based test stays green.
11. **Emitting `u64`/`i64` as bare JSON numbers** — silent precision loss above 2^53 in the S8 client.
12. **Widening the `accounts_tests.rs` budget without the compensating pin** (§4) or widening `ranking-security` A2 by relaxing the *needle* instead of adding a named path allowlist.
13. **Appending `'my_export_bundle'` to the end of `EXPECTED_VIEWS`** instead of inserting at sort index 3 — both arrays are compared **index-wise** and both carry an explicit "KEEP THIS ARRAY SORTED" warning (`account-privacy.eval.mjs:210-212`).
14. **A `Neither`-ownership `battle` row silently serialized** — make it a loud `Err`, not a default arm.
15. **`log::`/`println!`/`dbg!`** anywhere in privacy.rs (hygiene ban, and `spacetime generate` rejects print macros → reds `bindings-drift`, not the build).

---

## 6. Acceptance ledger — `memory/projects/gates/m22-s4.gates.md`

House format per `m22-s3.gates.md`. Run `mr-gates check --slice m22-s4` **from the slice worktree** with the toolchain PATH exported. Package: `monster-realm-module`. Every gate needs an `ID:`-with-colon and an `EVIDENCE:` placeholder.

```
- [ ] X1: [PRV1-11 pure serializers] WHEN each exportable table's row is serialized THE SYSTEM SHALL emit a
      well-formed JSON object with every column in declaration order, correct number/string/identity
      encodings, and a well-formed object for an owner with no data.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_serializer_per_table_shape) + test(m22s4_serializer_empty_owner)'
  EXPECT: 2 tests run: 2 passed
  EVIDENCE: pending

- [ ] X2: [PRV1-11/12 dispatch totality] WHEN the exporter registry is compared with DATA_LIFECYCLE_MANIFEST
      THE SYSTEM SHALL agree as a SET in BOTH directions at exactly 17 tables, enforced additionally as a
      const-eval compile assertion.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_exporter_set_equals_manifest_both_directions) + test(m22s4_exporter_registry_const_assert_is_live)'
  EXPECT: 2 tests run: 2 passed
  EVIDENCE: pending

- [ ] X3: [PRV1-12 negative] WHEN privacy.rs is scanned THE SYSTEM SHALL name no exportable:false table's
      accessor and no battle_wild seed field (the Rust twin of spec [DEL-05]).
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_no_exportable_false_table_is_named)'
  EXPECT: 1 test run: 1 passed
  EVIDENCE: pending

- [ ] X4: [PRV1-13 chunking] WHEN a table's per-owner row count crosses EXPORT_CHUNK_ROWS THE SYSTEM SHALL
      split it while every chunk of the request shares one request-wide total_chunks and a contiguous,
      unique, globally monotone chunk_index; an empty table SHALL still emit exactly one chunk.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_plan_chunks_boundaries) + test(m22s4_plan_chunks_request_wide_invariants) + test(m22s4_chunk_boundary_is_game_core_constant)'
  EXPECT: 3 tests run: 3 passed
  EVIDENCE: pending

- [ ] X5: [PRV1-11 own-rows-only] WHEN each table is read THE SYSTEM SHALL filter on an identity column
      derived from ctx.sender(), with at least 17 filter facts proven and every unindexed scan followed by
      an equality predicate.
  CHECK: cargo nextest run -p monster-realm-module -E 'type=[m22s4_reducer_filters_every_read_on_sender] + test(m22s4_filter_columns_are_rekey_manifest_columns)'
  EXPECT: 2 tests run: 2 passed
  EVIDENCE: pending

- [ ] X6: [spec §5 redaction] WHEN a battle row is exported THE SYSTEM SHALL redact the counterparty's
      identity and monster list, never emit battle.state, emit a practice battle once with nothing redacted,
      and refuse a row the requester participates in on neither side.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_battle_side_of_truth_table) + test(m22s4_battle_redacts_counterparty) + test(m22s4_battle_state_blob_is_never_emitted) + test(m22s4_battle_action_own_rows_only)'
  EXPECT: 4 tests run: 4 passed
  EVIDENCE: pending

- [ ] X7: [JSON escaping contract] WHEN any player-authored string is serialized THE SYSTEM SHALL escape the
      quote, the backslash and every C0 control char as \u00XX, pass non-ASCII through, round-trip under a
      reference unescaper, and emit 64-bit integers as quoted decimal strings.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_escape_edge_cases) + test(m22s4_escape_roundtrip_property) + test(m22s4_escape_output_has_no_raw_control_or_quote) + test(m22s4_u64_i64_are_quoted_strings) + test(m22s4_small_ints_are_bare) + test(m22s4_identity_is_64_lowercase_hex)'
  EXPECT: 6 tests run: 6 passed
  EVIDENCE: pending

- [ ] X8: [flood control] WHEN request_data_export is called inside the cooldown window THE SYSTEM SHALL
      reject with a distinct static reason and write nothing (reject, never clamp), with None meaning
      "no prior export" — the opposite polarity from is_deletion_due.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_cooldown_truth_table) + test(m22s4_cooldown_polarity_differs_from_is_deletion_due)'
  EXPECT: 2 tests run: 2 passed
  EVIDENCE: pending

- [ ] X9: [reducer wiring] WHEN request_data_export runs THE SYSTEM SHALL bind now exactly once, take the
      cooldown reject as its only pre-write return, call purge_export_bundles exactly once at statement
      depth 0 before the first insert, and insert all eight ExportBundle columns.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_reducer_statement_order) + test(m22s4_now_bound_once) + test(m22s4_insert_row_fields_exact)'
  EXPECT: 3 tests run: 3 passed
  EVIDENCE: pending

- [ ] X10: [view is the whole security boundary] WHEN my_export_bundle is declared THE SYSTEM SHALL carry
      exactly the sanctioned attribute, the one-parameter ViewContext signature, and a body EQUAL to the
      sender-keyed owner_identity filter — with a positive control proving the pin is satisfiable.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(m22s4_view_declared_once_attr_sig_body_exact) + test(m22s4_view_pin_positive_control)'
  EXPECT: 2 tests run: 2 passed
  EVIDENCE: pending

- [ ] X11: [scan hygiene survives the growth] WHEN privacy.rs grows to carry the export machinery THE SYSTEM
      SHALL still carry exactly one double-quote pair, no block comment, no raw string, no log/print macro,
      and exactly two namings of purge_export_bundles pinned to the declaration and the one call site.
  CHECK: cargo nextest run -p monster-realm-module -E 'test(rb22p_scan_hygiene) + test(rb22p_no_bare_quote_in_privacy) + test(rb22p_purge_body_exact) + test(rb22p_writes_only_export_bundle) + test(m22s4_purge_named_twice_declaration_and_call)'
  EXPECT: 5 tests run: 5 passed
  EVIDENCE: pending

- [ ] X12: [non-regression] WHEN the full server-module suite runs THE SYSTEM SHALL pass with zero failures
      and zero skips.
  CHECK: cargo nextest run -p monster-realm-module
  EXPECT: /[1-9]\d* tests run: \d+ passed, 0 skipped/
  EVIDENCE: pending

- [ ] X13: [lint] WHEN the lint gate runs THE SYSTEM SHALL be fmt/clippy(-D warnings)/biome clean — the
      compile-level proof that every new symbol has a production or const-eval consumer (no dead_code, no allow).
  CHECK: node -e "const{execSync}=require('child_process');try{execSync('just lint',{stdio:'inherit'});console.log('m22s4-X13:'+'LINT-GREEN')}catch(e){console.log('m22s4-X13:'+'LINT-RED');process.exit(1)}"
  EXPECT: m22s4-X13:LINT-GREEN
  EVIDENCE: pending

- [ ] X14: [generated docs fresh] WHEN the knowledge bundle and ADR digest gates run THE SYSTEM SHALL report
      zero drift (request_data_export's reducer doc regenerated; DIGEST.md includes ADR-0226).
  CHECK: node -e "const{execSync}=require('child_process');try{execSync('just knowledge-check',{stdio:'inherit'});execSync('just adr-digest-check',{stdio:'inherit'});console.log('m22s4-X14:'+'DOCS-FRESH')}catch(e){console.log('m22s4-X14:'+'DOCS-DRIFT');process.exit(1)}"
  EXPECT: m22s4-X14:DOCS-FRESH
  EVIDENCE: pending

- [ ] X15: [full gate] WHEN the complete `just ci` runs in the slice worktree THE SYSTEM SHALL exit 0
      (including bindings-drift = 0 after the regen, and the four widened gate allowlists green).
  CHECK: node -e "const{execSync}=require('child_process');try{execSync('just ci',{stdio:'inherit'});console.log('m22s4-X15:'+'CI-GREEN')}catch(e){console.log('m22s4-X15:'+'CI-RED');process.exit(1)}"
  EXPECT: m22s4-X15:CI-GREEN
  EVIDENCE: pending

- [ ] X16: [ADR-0226 content — the digest gate is header-only, so cite the body manually] WHEN ADR-0226 ships
      THE SYSTEM SHALL record: the five-file touches-delta and why each is a gate-invited allowlist widening
      rather than a hidden dependency; the accounts_tests.rs budget widening and its compensating pin; the
      request-wide chunk_index/total_chunks decision measured against the client's chunks.length rule; the
      64-bit-as-string decision; the deliberate omission of battle.state and its redaction justification;
      the empty-chunk-per-table decision; request_id = now_ms; the cooldown's zero-new-state derivation and
      its inverted None polarity; the view's placement deviation from the schema.rs convention and the
      ADR-0225-parity counter-argument that was weighed; the PRV1-14 deferral with its bounded-storage
      mitigation, its indefinite-retention residual, and the "before the first real account" sequencing
      constraint; the two unindexed full scans; and the M8.9 file-split residual.
  MANUAL: prose content of an ADR body; the adr-digest gate checks headers only.
  EVIDENCE: pending

DEFER: X17 -> backlog (S4b) — PRV1-14 (export TTL reaper). A scheduled(...) table is automigration-frozen
  (ADR-0221), so table + reducer must ship atomically, and the table forces schema.rs
  (DATA_LIFECYCLE_MANIFEST set-equality, accounts_tests.rs:3562), evals/baselines/table-schemas.json and
  evals/battle-schema-snapshot.eval.mjs T-VIS-ANCHORS — all out of touches. No REKEY_MANIFEST entry and no
  lib.rs edit are needed (an interval schedule carries no Identity column; the reaper self-arms from
  request_data_export, the ensure_playtest_reaper precedent). Mitigation while deferred: purge-before-write
  bounds per-owner storage at one request, the bundle is readable only by its subject, and no real account
  is provisionable yet. S4b MUST land before the first real account.
```

---

## 7. Step-by-step task list (tester → implementer)

**T0 — SCOPE STOP (before any code).** Present the five-file `touches-delta:` to the supervisor with §1c's table and rationale. **Do not start until it is blessed.** If refused, the slice defers whole and the ledger becomes all-DEFER.

**T0b — optional spike (≤90 min, hard abort).** SATS-generic JSON serializer (§1f). Green → Design A for 16 tables + hand-rolled `battle`. Red → Design B.

**T1 (tester).** Author `privacy_tests.rs` additions per §4, staged to `/tmp` (the write guard blocks `.claude/`, where worktrees live). The orchestrator applies them and runs the RED proof — `tester` has no Bash.

**T2 (implementer, in order).**
1. JSON micro-builder + the `stringify!`/`'\u{0022}'` idiom. Run `cargo nextest -E 'test(m22s4_escape)'` early — this is where the quote ban bites.
2. Enum + nested-struct encoders.
3. The 17 pure `json_<table>` serializers + `battle` redaction.
4. `plan_export_chunks` + `export_cooldown_elapsed`.
5. `EXPORTERS` + the `const _: () = assert!(...)` totality assertion. **Compile here** — this is where a manifest/exporter mismatch surfaces.
6. The 17 `rows_<table>(ctx, owner)` shell readers. **Run `node evals/currency-integrity.eval.mjs` and `node evals/ranking-security.eval.mjs` immediately after adding the wallet and profile readers** — expect two REDs; that is the measured proof the allowlist edits are necessary, and it belongs in the ADR.
7. `request_data_export`.
8. The view. **Run `node evals/monster-privacy.eval.mjs` and `node evals/account-privacy.eval.mjs`** — expect `[I/set]` and `[A/view-set]` RED. Same proof.
9. Apply the four eval allowlist edits + the `accounts_tests.rs:4918` budget widening. Re-run all five; expect green.

**T3 — ritual (risky, in this order).**
1. `just lint` — **the format hook uses unpinned `npx biome` while `just lint` uses the pinned `client/node_modules` one**; a hook reformat can red CI and read like a deleted test.
2. `cargo nextest run -p monster-realm-module` — full, 0 skipped.
3. `spacetime generate` → `client/src/module_bindings/**`. Expect **new** `request_data_export_reducer.ts`, `my_export_bundle_table.ts`, `index.ts` re-exports; expect **no** `export_bundle_table.ts` (private table — its presence means the table went public, and `checkBindings` in both privacy evals would catch it). Watch for the interactive delete prompt. `spacetime generate` **rejects print macros** — another reason for the hygiene ban.
4. `node evals/bindings-drift.eval.mjs` → 0. **Before this, check `ps` for a live `spacetime` / dev server**: `account-e2e` holds a global spacetime lock (no `--data-dir`), and a concurrent `evals/run.mjs` rebuilds `client-wasm` under a live vite server. Also: a fresh worktree needs `npm ci` in `client/` or `account-e2e` FAILs on a ts-resolve error that reads like a real red.
5. `just knowledge` (regen) — **only after** the code commit; `okf-export.mjs:432` stamps `gitDate(schema.rs)`, and since schema.rs is untouched this slice the dates should be stable. Expect a new `docs/knowledge/reducers/request_data_export.md` + `reducers/index.md` + `index.md` reducer count. `just knowledge-check` → clean.
6. `ls docs/adr/` → confirm 0226 is still free (numbers race merges), then write it. `just adr-digest` then `just adr-digest-check`. Use `Extends:`, never `Amends:` (a reciprocal back-link edit is a hidden-dependency STOP); Decision header caps at 240 chars.
7. `ARCHITECTURE.md`: the `privacy.rs` row at `:455` (add `request_data_export` + `my_export_bundle`), the M22 paragraph at `:395`, and a new slice paragraph in the 15r-sec-a house style.
8. `just ci` (X15). Commit with `-F` + a quoted heredoc (backticks in `-m "…"` shell-expand and the amend-fix then hits the force-push guard).

**`touches-delta:` to declare in the PR body**
```
server-module/src/accounts_tests.rs   # rb22_purge_naming_budget("privacy.rs") 1 -> 2; compensating call-site pin ships in privacy_tests.rs
evals/currency-integrity.eval.mjs     # ACCESSOR_BYPASS_ALLOWLIST += 'privacy.rs' (read-only wallet row, no write verb)
evals/ranking-security.eval.mjs       # A2 allowed-home 'ranking.rs' -> named allowlist ['ranking.rs','privacy.rs']
evals/monster-privacy.eval.mjs        # EXPECTED_VIEWS += 'my_export_bundle' (sorted insert, index 3)
evals/account-privacy.eval.mjs        # EXPECTED_VIEWS += 'my_export_bundle' (sorted insert, index 3)
client/src/module_bindings/**         # spacetime generate: new reducer + view bindings (mechanical ritual)
docs/knowledge/**                     # okf-export regen: reducers/request_data_export.md + indexes (mechanical ritual)
```

---

## 8. Recommended workflow pattern

**Solo build + a mandatory red-team pass on the shipped artifact** (not on the plan).

One-line cost/benefit: the design space is already closed by the spec and by five mechanical constraints, so brainstorm/debate/compete buy nothing — but this slice widens four security allowlists and hand-rolls an escaper, and a red-team that *writes the cheats* is the only lens that catches an over-wide allowlist, a decoy view body, or a `\u00XX` bypass that every text pin reports green.

---

## Key files
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/server-module/src/privacy.rs`
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/server-module/src/privacy_tests.rs`
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/server-module/src/schema.rs` (read-only: `ExportBundle` :928-942, `DATA_LIFECYCLE_MANIFEST` :995-1267, const-assert idiom :1276-1298, view idiom :375-382 / :428-442)
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/server-module/src/accounts_tests.rs` (:3125-3211, :3401-3475, :3507-3590, :4010-4045, :4083-4165, :4906-5036)
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/game-core/src/accounts/deletion.rs` (:145 `EXPORT_CHUNK_ROWS`)
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/evals/currency-integrity.eval.mjs` (:217-242)
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/evals/ranking-security.eval.mjs` (:252-305)
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/evals/monster-privacy.eval.mjs` (:160-166, :1004-1056)
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/evals/account-privacy.eval.mjs` (:213-219, :328-351, :369-392)
- `/home/mdrewt/projects/ai-apps/claude-harness/projects/monster-realm/docs/adr/0220-guest-export-orphan-purged-at-claim.md`, `0221-…md`, `0225-…md`
- `/home/mdrewt/projects/ai-apps/claude-harness/memory/projects/gates/m22-s3.gates.md` (ledger format of record)

---

# AMENDMENTS after plan review (reviewer + red-team + /simplify, 2026-09-01)

All three lenses ran; the five plan corrections (C1..C5) were independently re-verified accurate.

## A. Security amendments (red-team)

**A1 (was CRITICAL #1) — subject-existence guard.** Anonymous connections receive working identities
(lib.rs:206-212 accepts `!has_jwt()`), so a zero-state identity could farm 17 empty chunks per call
forever (purge is per-owner; the TTL reaper is deferred). Fix shipped this slice: `request_data_export`
rejects (distinct static reason) unless the caller has an `account` row OR a `player` row. Residual: a
guest who joins the game once can still accumulate one request's chunks; S4b (TTL reaper) must land
before ANY public exposure (incl. guest play) — recorded in the DEFER line and ADR-0226.

**A2 (was CRITICAL #2) — reducer signature pin.** New gating test `m22s4_reducer_signature_exact`:
`pub fn request_data_export(ctx: &ReducerContext) -> Result<(), String>` with exactly one parameter —
an added `on_behalf_of: Option<Identity>` parameter is a full cross-account read bypass that passes
every other planned pin (PoC'd). Same severity language as the view pin.

**A3 (was HIGH #3) — sole-identity-source pin.** New gating test
`m22s4_sender_bound_once_and_sole_identity_source`: in the reducer body, `ctx.sender()` occurs exactly
once (`let me = ctx.sender();`), every `rows_<table>` call is the `(ctx, me)` shape, and the body
contains no other identity-typed table read outside the sanctioned dispatch (PoC'd: a read-a-victim-
identity-off-a-wallet-row substitution passes all other pins).

**A4 (was HIGH #5) — §4.7 deletion-gate call.** `request_data_export` writes a manifest-classified
(Erase) table, so PRV1-7's rule applies. Decision: call `accounts::is_pending_deletion(ctx, me)` and
REJECT with a distinct static reason. Rationale: satisfies PRV1-7's letter with zero out-of-touches
edits (STATE_TRANSITION_OWNERS is game-core and semantically wrong for a non-transition reducer);
product-defensible (during grace the subject can cancel-then-export; a terminal account's data is
already erased). GDPR-tension note goes in ADR-0226 for operator review.

**A5 (was MED #6) — behavioral own-rows predicates.** The two unindexed scans get extracted pure
predicates `battle_action_is_own(&BattleAction, Identity)` / `playtest_event_is_own(&PlaytestEvent,
Identity)` with two-identity same-battle_id fixtures — the highest-value leak surface
(schema.rs:876-887) gets a behavioral proof, not only a regex.

**A6 (was MED #7/#8).** One planner-scale test at PLAYTEST_EVENT_CAP=20k rows (chunk count 40,
no pathological cost). Purge-then-abort atomicity accepted on ADR-0106 D8 precedent — noted in
ADR-0226, no integration test possible off-instance.

## B. Correctness amendments (reviewer)

**B1 — X5 CHECK syntax fixed** (invalid `type=[...]` → `test(...)`).
**B2 — §4/§6 test-name reconciliation:** every gate CHECK now names standalone `#[test]` fns the
tester will write under exactly those names (list in the ledger). The `const-assert-is-live` runtime
twin is DROPPED (house convention: const asserts are proven by compilation — schema.rs:1298 precedent);
its teeth come from `m22s4_exporter_totality_negative_fixtures` (fixture-manifest negatives).
**B3 — chunking contract:** request-wide `chunk_index`/`total_chunks` CONFIRMED (the spec's own
client rule `chunks.length === total_chunks` is incoherent under per-table scope); recorded as a
frozen S4↔S8 contract decision in ADR-0226 + PR risks for supervisor visibility.
**B4 — battle.state rationale corrected:** BattleState holds NO hidden fields (schema.rs:395-400) and
`my_battle` already returns full state to both participants — the plan's "counterparty private state"
justification was wrong. `state` stays OMITTED, on the corrected grounds: (i) the spec's redaction
mandate covers the counterparty's half of a durable artifact, (ii) field-level redaction of a deep
nested game-core struct is high-cost/high-risk vs omission, (iii) the requester's live access via
`my_battle` is unaffected. Named residual: own-side transient in-battle state is absent from the
export — flagged in ADR-0226 + PR for operator confirmation.
**B5 — C3 widenings need no dedicated compensating pin:** the whole-file
`rb22p_writes_only_export_bundle` already closes the write direction; one-line note in ADR-0226.

## C. Simplify amendments

Implement only the numeric-width/array helpers that actually occur in the 17 structs; drop
`JSON_MAX_ESCAPE_LEN`; no trait-generic builder machinery; SATS spike CUT (recorded as rejected
alternative — explicit per-field serializers are also the safer privacy posture: a future secret
column cannot silently auto-export, and exhaustive struct literals in tests force a deliberate
decision per new column).

## D. Revised reducer body order (the security shape, final)

```
1  let me  = ctx.sender();                                  // sole ctx.sender() occurrence
2  subject-existence guard (account row OR player row)      // Err: distinct static reason
3  deletion gate: is_pending_deletion(ctx, me)              // Err: distinct static reason
4  let now = now_ms(ctx);                                   // sole now binding
5  cooldown: max(created_at_ms) over own chunks             // Err: distinct static reason
6  purge_export_bundles(ctx, me)                            // the C1 call site, exactly once
7  build per-table rows via EXPORTERS in manifest order     // Err names any gap table
8  plan_export_chunks -> insert loop (8 columns, chunk_id 0)
9  Ok(())
```
Exactly three guard `return`s before the purge; nothing between purge and inserts.
