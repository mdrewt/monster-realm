# 0184 — Trading reducer negative paths: a dynamic three-identity e2e suite, its mutation-visible pins, and its honest gaps

**Status:** Accepted
**Date:** 2026-08-14
**Slice:** 14r-b (M-postgate fourteenth-review residuals — `specs/monster-realm-v2/M-postgate-fourteenth-review-residuals.spec.md` §14r-b)
**Supersedes:** —
**Amends:** —
**Subsystems:** economy-quests, ci-gates, security-authz
**Decision:** Gate the trading reducers' negative paths with a dynamic 3-identity Playwright suite (`client/e2e/trade-zz-negative.spec.ts`) plus mutation-visible in-crate pins; the exact-boundary-accept clause stays statically gated, recorded as debt.

## Context

Spec §14r-b recorded the verified gap: `server-module/src/trading_tests.rs` tests only
pure `game-core` functions plus **static** `include_str!("trading.rs")` source scans;
`evals/trade-reducer-security.eval.mjs` and `evals/trade-conservation.eval.mjs` are pure
static scanners; and the three pre-existing e2e trade specs construct only single-monster,
zero-item, one-directional, **legitimate-party** trades.

Consequence, as written in the spec: **no automated gate would catch** a regression in
propose-time insufficient-inventory rejection (`server-module/src/trading.rs:330` /
`:355`), decline-side deletion (`:439`), non-party cancel rejection (`:747`), or an
`==` → `!=` inversion at the authorize call sites (`:433` / `:472` — the structural
checkers verified *field presence in the argument span*, never the **operator**; an
inversion lets a third party accept someone else's trade).

EARS clauses under test:

> WHEN a non-party calls `cancel_trade` or a wrong-role identity calls
> `respond`/`confirm`, THE SYSTEM SHALL reject, and a dynamic test SHALL fail if it does
> not.
> WHEN a trade offers exactly the full available stack, THE SYSTEM SHALL accept it.

The first clause is fully gated by this slice. The second is **not** — D4 records why, and
what would unblock it.

### Decision drivers

- **Touches discipline.** `touches:` is `server-module/src/trading_tests.rs`,
  `client/e2e/`, `evals/trade-reducer-security.eval.mjs`, `scripts/`. Neither `justfile`
  nor `.github/**` is in scope, so any vehicle needing CI wiring was disqualified.
- **The gap is behavioural, and a third static scanner would not close it** — the flagged
  anti-pattern is answering a "no dynamic coverage" finding with more source-text
  matching.
- **Multi-identity is mandatory.** Non-party cancel (`:747`) and wrong-role respond
  (`:433`) are *unreachable* with fewer than three distinct identities.
- **Seeding is the binding constraint.** A browser-session identity cannot be given items
  by any shipping path (D4's faucet table), which caps what can be proven dynamically.

## Decision

### D1 — Vehicle: Playwright multi-context e2e, chosen for zero-wiring discovery

`client/e2e/trade-zz-negative.spec.ts` — **one `chromium.launch()`, three
`newContext()`** (A = initiator, B = counterparty, C = a joined non-party), each context a
distinct SpacetimeDB identity (precedent: `client/e2e/wallet-balance.spec.ts:825-857`).
Reducers are driven through the `window.__mrTrade` hook (`client/src/main.ts:1910-1955`,
which exposes all four trade reducers plus the item and currency legs) and **server truth**
is read with `spacetime sql` as the module owner.

**The decisive argument is discovery, not ergonomics.** `client/playwright.config.ts:13`
sets `testDir: './e2e'`, so a new `*.spec.ts` is picked up automatically; the CI `e2e` job
(`.github/workflows/ci.yml:97`, `:170 run: just e2e`) therefore runs this suite on every PR
with **zero `justfile` and zero `.github/**` edits** — both of which are outside this
slice's `touches:`.

**Stated precisely, because it would be easy to overclaim:** the `e2e` job is **not** a
branch-protection-*required* check. It is enforced by **merge doctrine** — PR #287 is the
recorded precedent, where `mergeStateStatus` was `UNSTABLE` with `e2e = FAILURE` and the
merge was blocked by policy, not by GitHub. This suite raises a red job that a human must
triage; it does not mechanically block a merge.

**Rejected — a `scripts/` CLI harness.** One identity only; `on_disconnect` deletes the
player row (`scripts/smoke-republish.sh:37-39`, RT-SR-01), while `propose_trade` requires a
*joined* counterparty (`server-module/src/trading.rs:246-250`); and it would need
`justfile` + workflow wiring that is out of touches.

**Rejected — a node-SDK harness.** It does not solve item seeding (D4), and the committed
bindings exclude dev reducers (`.github/workflows/ci.yml:140-143`). YAGNI here, but named
as the **unblocker shape** for the parked scenarios: a **non-spec driver module under
`client/e2e/`** (Playwright globs only `*.spec.ts`, so a driver module sitting beside the
specs is not collected as a test).

14r-g inherits the **pattern** — three contexts plus an `errorOf` helper over the existing
`__mrPvp` hook — **not a harness**. No shared harness is built or needed.

### D2 — The file name is load-bearing; every test is self-contained

`client/playwright.config.ts:30` sets `workers: 1` against one shared published database,
so **spec-file name is run order**.

- `client/e2e/trade-propose.spec.ts` reads `allTradeOffers()[0]` **globally** (`:288`,
  `:307`, `:321`). An offer left behind by an earlier-sorting file lands in its `[0]` slot
  and corrupts it. `trade-zz-negative` sorts **after** `trade-propose`.
- `-` is `0x2D` and `.` is `0x2E`, so the file still sorts **before** `trade.spec.ts`,
  keeping it inside the trade block.
- Precedent: m17.5f named its interlock spec `trade-interlock.spec.ts` for exactly this
  reason.

**Each test creates its own offer, acts, asserts, cleans up, and re-asserts a clean
world.** The bite-proofs run one test at a time (`-g "<title>"`), so a test depending on a
sibling's setup would run against an empty world — and would fail **silently, green**: with
no offer row the trade id is `''`, `BigInt('')` is `0n`, `cancel_trade(0)` returns "trade
offer not found", and a `toContain`-style assertion would pass having proven nothing. Two
defences: no cross-test state, and `pairOfferTradeId` (`:430`) hard-fails unless the id is
a non-empty decimal integer read from server truth **for this pair**. `test.describe` is
deliberately **not** `.serial` (under `.serial` one failure skips the rest, and the D7
register needs the status of *every* test per mutation). An `afterEach` sweep restores
isolation; live offers are cancelled and confirmed gone **before** `browser.close()`, and
the close is not wrapped in a swallowing `try/catch`. Test titles carry no parentheses or
brackets so a full title can be pasted into `-g` and matched literally.

### D3 — Assertion channels

- **Rejections.** A reducer `Err` surfaces to the SDK as a **`SenderError` promise
  rejection** (ADR-0085); `client/src/ui/statusModel.ts:20` keys off that name string.
  `errorOf` (`:536`) awaits the hook call **inside** `page.evaluate`, catches there, and
  returns a plain `{name, message}` (or `null`), hard-failing first if the hook returned
  `undefined`. Every `__mrTrade` call is awaited inside its own `evaluate` — an unhandled
  rejection raises a persistent `#mr-error-overlay` that intercepts later clicks.
- **Three-part pins, exact-message.** not-null + `name === 'SenderError'` + `message`
  `toBe` the **exact** server string. Never `toContain`:
  `"insufficient inventory for item N"` is emitted byte-identically by
  `server-module/src/trading.rs:331` **and** by the `qty == 0` path in
  `game-core/src/trading/rules.rs:93` (via `types.rs:114-116`), and the two are
  indistinguishable by substring. Hence the **leg-differential controls** in 1a/1b/3a/3b:
  the identical proposal *minus* the offending leg must resolve `Ok`, which attributes the
  rejection to the intended guard rather than to any of the guards that run before it.
  5a/6a carry **role-differential** controls instead (same reducer, same offer, called by
  the party for whom it must succeed).
- **State.** Read from server truth with `spacetime sql` as the **module owner** — the
  owner channel is the sanctioned way to read a private table (ADR-0087), which the reaper
  schedule is (D10). Always scoped to the A/B identity pair or to one `trade_id`
  (`tradeOfferRowsForPair` `:358`, `reaperRowsFor` `:374`); never `allTradeOffers()[0]`,
  never a global row count, never the client subscription cache. `parseSqlTable` (`:317`)
  **throws** on an unrecognised shape rather than silently skipping.
- **Not a channel: `#status`.** `__mrTrade` bypasses `sendGuarded`, so the status line is
  never written on these paths and must not be asserted on.

Guard map, as gated:

| Test | Guard | Assertion |
|---|---|---|
| 1a | `trading.rs:330` | initiator item `qty > on-hand` → `insufficient inventory for item N` |
| 1b | `trading.rs:355` | counterparty leg → `counterparty has insufficient inventory for item N` |
| 3a | `trading.rs:287` | initiator currency > balance → `insufficient currency for trade offer` |
| 3b | `trading.rs:304` | counterparty leg → `counterparty has insufficient currency for this trade` |
| 4 | `trading.rs:439` + `:442` | `respond(accepted=false)` deletes the row **and** disarms the reaper (armed-after-propose = 1 → gone-after-decline = 0) |
| 5a | `trading.rs:747` | non-party cancel rejected **and** the offer survives |
| 5b | `trading.rs:747` | counterparty may cancel; row gone |
| 5c | `trading.rs:747` | initiator may cancel; row gone |
| 6a | `trading.rs:433` | non-counterparty responding to a `ConfirmedByCounterparty` offer gets the **role** error, not the status error |
| 6b | `trading.rs:472` | counterparty confirming a `Pending` offer gets the **role** error, not the status error |

### D4 — Scope honesty: the park register and the surviving-mutant ledger

**P1 (scenario 2, item exact-boundary accept) and P2 (scenario 7, near-cap bilateral) are
BLOCKED.** The blocker is item seeding for a browser-session identity. The faucet search is
recorded here so it is not re-run:

| Candidate faucet | Verdict |
|---|---|
| Shop purchase | Cheapest stocked item is 150g (`game-core/content/shops/000-core.ron:19`); the only currency faucet yields 50g. Unreachable. |
| `quest_001` reward | `xp: 0, items: [], currency: 50` (`game-core/content/quests/000-core.ron:12-16`) — **no items**. |
| Starter loadout | No starter items are granted. |
| Battle drops | No such path: the production `grant_item` call sites are `npc.rs:140` (dialogue `GrantItem`), `npc.rs:215` (quest-completion reward items), `economy.rs:165` (buy), `trading.rs:713` (the swap itself) and `taming.rs:295` (`grant_bait`). None is battle-driven. |
| Dialogue `GrantItem` effect | The route exists (`npc.rs:140`) but **zero shipped content uses it** — no `GrantItem` occurrence anywhere under `game-core/content/`. |
| `grant_bait` | Doubly blocked: `#[cfg(feature = "dev_reducers")]` (`taming.rs:280`) **and** self-scoped to `ctx.sender` (`taming.rs:283`, `:295`), so a CLI-identity call cannot seed a browser identity. |
| `qty == 0` proposals | Rejected upstream (`game-core/src/trading/rules.rs:93`), so the degenerate boundary is not a probe. |

Unblocker for both: a **`client/src` grant hook** slice (which also revives
`client/e2e/recruit.spec.ts` R4). Out of this slice's touches.

**P3 (currency exact boundary via the `quest_001` 50-gold faucet) was REJECTED for this
slice**, deliberately and not for convenience: real cost 4-6 minutes of e2e wall clock, a
documented flake history (the wander-retry path redded master on 2026-08-01 on an unrelated
PR), and — decisively — it does not literally satisfy the EARS clause, which says *full
available **stack***, i.e. items. The successor design is recorded so it need not be
re-derived: a **three-point probe** at B−1 / B / B+1 with the balance **read from `sql`**
(never hard-coded to 50), expecting Ok / Ok / Err.

**Surviving-mutant register — the honest-gap ledger.** These mutants survive the whole
slice and are recorded rather than hidden:

1. `>` → `>=` and `>` → `!=` at `trading.rs:330`, `:355`, `:287`, `:304`. With no
   exact-boundary probe available (P1/P2/P3), no test can distinguish them.
2. **Wrong-party operand mutants**: `:341` `filter(counterparty)` → `filter(me)`, `:294`
   `wallet_balance(counterparty)` → `wallet_balance(me)`, and the escrow-operand twins.
   Both identities hold zero of the relevant asset, so either operand reads the same count.
3. **`saturating_sub` dropped** at the four `count.saturating_sub(escrowed)` /
   `bal.saturating_sub(escrowed)` sites — an **equivalent mutant** under ADR-0106 D4: with
   the one-active-offer rule, escrow at these sites is provably `0`
   (`trading.rs:295`, `:345` say so inline). No test can distinguish it.
4. `cancel_trade` `:752` terminal-status guard — **defensively unreachable** (terminal rows
   are deleted), documented as such at `:753`, and ungated here.
5. **Test 6b has no same-reducer positive control in this file.** A successful `confirm`
   executes the swap and would consume A's only asset, breaking later tests; the
   out-of-file control is `client/e2e/trade-full.spec.ts`.

**Therefore the EARS exact-boundary-accept clause is PARTIALLY GATED — statically only**
(the pure `check_item_headroom` boundary cases in `game-core/src/trading/rules.rs`), with
no dynamic reducer-level probe. Recorded, not hidden.

### D5 — Eval tightening: `hasCancelPartyCheck` is a shape tripwire, and says so

`evals/trade-reducer-security.eval.mjs:431-444`. Two narrowing changes:

1. `stripRustStrings(stripRustComments(body))` — a dead
   `let _dead = "if offer.initiator != me && ...";` no longer satisfies the needle.
   Fixture **RT-SEC-03** (`:1026`, asserted `:1031`) proves it.
2. The old `[^{]*?` bridge between the two inequality clauses is replaced by an **anchored
   `\s*&&\s*`**, in **both clause orders**, with `\(?` / `\)?` tolerance for parenthesised
   clauses. The old bridge accepted `||` — the single most damaging realistic mutation of
   this guard, because with `||` *every* caller fails the other clause and `cancel_trade`
   is dead for everyone. Fixture **RT-SEC-02** (`:1011`, asserted `:1018`) proves it.

**Doctrine, written into the eval comment (`:398-412`):** `CANCEL_PARTY_CHECK` is a
**shape tripwire, not a semantics proof**. The semantic authority for TR-17 is
`trade-zz-negative` 5a/5b/5c. A legitimate guard refactor **MAY** update this regex in the
**same PR**, provided 5a-5c stay green — that is the intended maintenance path, not a
loophole. Known **survivors** (`&& false`; the guard inside `if false { ... }`; the correct
condition with an empty body) and known **false-flag shapes** (a `let is_party` binding, De
Morgan, `matches!`, an interposed third clause) are enumerated by name in the comment so a
green here is never over-read.

**14r-c migration surface (ADR-0181), marked in place (`:421-429`).** The file-local
`stripRustComments` + `stripRustStrings` pair at this call site is the **legacy** shape and
is **not endorsed** — `stripRustSource` in `evals/rust-scan.mjs` is the SSOT and is covered
by `assertStripperSound`, which the legacy pair has no equivalent of. The tightening was
written as a **drop-in** for that conversion, not a competing implementation; the identical
call sites in `checkReaperArmed`, `checkRespondAuthorize` and `checkConfirmAuthorize` must
be converted together.

### D6 — Mutation-gate posture: no numeric ratchet, but the survivor set shrank

The e2e half of this slice is **out-of-process** and kills nothing under `cargo-mutants`.
The `mutate-server` cap **324** (`justfile`) and the `MUTATE_SERVER_CAP_BASELINE` ceiling
(`evals/nightly-smoke-wiring.eval.mjs`) are both **untouched and out of touches** — ADR-0183
set them one slice ago, and ADR-0137 D4 requires them to move together.

**But the slice did add mutation-VISIBLE in-crate pins** (`trading_tests.rs` is a crate test
file, so `cargo-mutants` runs it):

- the `check_authorize_call` **operator pin** (D9) — kills `==` → `!=` at `trading.rs:433`
  and `:472`;
- **EA-CANCEL-PARTY-01** (`trading_tests.rs:1673-1743`) — kills `&&` → `||`, either
  `!=` → `==`, and clause-→-constant at `:747`;
- **EA-REAPER-03** (`trading_tests.rs:1574-1646`) — a **prefix anchor** that kills the
  `:180` scheduler-guard inversion *and* the placement games (guard moved after a DB read,
  guard wrapped in dead code).

Net direction: survivors are **removed from the priced set**. The numeric re-ratchet is
**not** taken here — it belongs to the ADR-0183 D4 survivor-kill successor slice, which
owns the cap/ceiling pair. `just mutate-server` was deliberately **not** run in-slice: it
is a multi-hour run whose result is already priced in.

### D7 — Proof-of-teeth register

Executed **twice**: the full register before the post-implementation refactor, a spot set
after it. Every mutation applied **one at a time**, restored by the exact inverse edit, with
`git diff --exit-code -- server-module/src/trading.rs` verified clean after each. Bite-proof
runs used only the target spec. Cascade sets are **expected collateral** and are recorded so
a re-runner does not misread them as flakiness.

| # | Mutation | Observed RED |
|---|---|---|
| B1 | `trading.rs:433` `==` → `!=` | e2e {4, 6a} **and** `ea_authorize_respond_01` — **double-red** |
| B2 | `trading.rs:472` `==` → `!=` | e2e {6b} **and** `ea_authorize_confirm_01` (`inverted-operator`) |
| B3 | `trading.rs:747` both `!=` → `==` | e2e {5a} |
| B4 | `trading.rs:747` `&&` → `\|\|` | **9 e2e red** (all but 4) + eval `CANCEL_PARTY_CHECK` + `EA-CANCEL-PARTY-01` — **triple** |
| B5 | `trading.rs:439` `!accepted` → `accepted` | e2e {4, 6a} (6a-setup cascade) |
| B6 | `trading.rs:442` disarm line deleted | e2e {4} **only** — the disarm assertion is independently gated |
| B7 | `trading.rs:330` `>` → `<` | e2e {1a} — 1:1 |
| B8 | `trading.rs:355` `>` → `<` | e2e {1b} — 1:1 |
| B9 | `trading.rs:287` `>` → `<` | e2e {3a} — 1:1 |
| B10 | `trading.rs:304` `>` → `<` | e2e {3b} — 1:1 |
| B11 | `trading.rs:747` first clause → `true` | 8 e2e red **including 5c** + `EA-CANCEL-PARTY-01` |
| B12 | `trading.rs:180` `!=` → `==` | `EA-REAPER-03` + eval `REAPER_SCHEDULER_GUARD` |
| B13 | `trading.rs:113` table attr + `public` | eval `REAPER_SCHEDULE_PRIVATE` |
| E1 | `\|\|`-joined fixture (RT-SEC-02) | tightened regex flags it; the **old** regex was demonstrated blind on the same fixture; the live mutant fails the eval |

B11 is the reason 5c exists: without an initiator-cancels-own-offer test, a realistic
first-clause-tautology mutant survives the entire suite. The verifier independently
reproduced B1's double-red.

### D8 — Anti-patterns of record

- **`test.fixme` is banned in `client/e2e`.** `evals/spec-gap-revival.eval.mjs` arms
  **file-level** tripwires that fire when a parked-test marker is co-located with a blocker
  token *while CI publishes dev reducers* (true today —
  `.github/workflows/ci.yml:145`, `:169`), and a marker in a **comment** counts. Parks
  therefore live in prose and in this ADR only; the spec file contains no such marker at
  all.
- **`node evals/X.eval.mjs` directly is a VACUOUS NO-OP.** The evals export a default
  contract and are executed by `evals/run.mjs`; running the file directly does nothing and
  exits 0. Use `evals/run.mjs` or an import driver.
- **Pipe-masked exit codes** (`cmd | tail; echo $?`) are the recorded false-green shape —
  the pipeline's status is the last command's.
- **The account e2e eval spawns its own `spacetime`** and collides with a long-running
  local instance on the default data-dir lock. Stop the local instance before a full
  `just ci`.

### D9 — New static-checker hardening in `trading_tests.rs`

`check_authorize_call` (`server-module/src/trading_tests.rs:1001-1171`) gained four
hardenings; the execution order is documented as **(A) → (M) → (C) → (D) → (B)**
(`:868-934`) — call exists → `me` really is the caller → role field → operator → `?`
propagation — ordered so the most security-relevant diagnosis wins.

- **Token-boundary matching** (`token_positions` `:955`, `contains_token` `:976`) with
  **regex-`\b` semantics**: a boundary is enforced only on a side where the needle itself
  ends in an identifier char. This rejects `offer.counterparty == me_spoof` while still
  letting the `letme=` needle match `let me = ctx.sender;`. Getting this wrong is not
  subtle — an unconditional right-boundary check makes every `me`-binding lookup fail.
- **Negated-equality detection** (`:1106-1116`) alongside inverted-operator detection, each
  with its own stable lowercase error token (`me-shadowed`, `role-arg`,
  `inverted-operator`, `negated-equality`, `operator-missing`) so a teeth test can assert
  **which** check fired.
- **Role-argument scoping** (`split_top_level_args` `:982`, applied `:1068-1080`): the
  `required_field` must appear in the **last depth-0 argument** — the role boolean itself.
  This kills the launderer `authorize_respond(&status_for(offer.counterparty == me), true)`,
  which satisfies a span-wide check while the role argument is a constant. The
  `forbidden_field` check is **deliberately left span-wide** (`:1081`); narrowing it would
  weaken the original Finding-B check.
- **`me`-shadowing pin** (`:1037-1062`): the **last** `let me =` binding preceding the call
  must be `let me = ctx.sender;`. Without it, every other check is satisfiable by a
  tautology (`let me = offer.counterparty;` makes the role boolean unconditionally true).
- **String-stripping at both real-source call sites** (`ea_authorize_respond_01` `:1195`,
  `ea_authorize_confirm_01` `:1242`): comments alone left a bypass — delete the real call
  and leave the whole call text inside a dead string literal.

`ea_authorize_operator_01` (`:1301-1526`) ships **7 teeth + 2 positive controls**.

**The JS twin `checkAuthorizeCall` (`evals/trade-reducer-security.eval.mjs:191`)
deliberately stops at (C) — DO NOT PORT the operator pin** (`:178-188`). The pin lives
**only** in the Rust twin on purpose: it exists to make `==` → `!=` visible to
`cargo-mutants`, which runs the crate's own tests and can see neither an eval nor the e2e.
Duplicating it would double-gate one invariant across two independently drifting files.
Both sides are cross-referenced in comments.

### D10 — New eval criterion `REAPER_SCHEDULE_PRIVATE`

`evals/trade-reducer-security.eval.mjs:495-536`. `trading.rs:112` states the intent
("PRIVATE — prevents client schedule manipulation") and `trading.rs:113` declares the table
without `public` — but **nothing gated it**, while
`evals/pvp-challenge-reaper.eval.mjs`'s `CHAL_REAPER_SCHEDULE_PRIVATE` cited **this table
as its precedent**. The asymmetry is closed here.

Why it matters: rows in a scheduled table are reducer arguments, so a **public** schedule
table lets a client insert a row that fires `trade_offer_reaper` with an arbitrary
`trade_id`. The scheduler-only sender guard (`trading.rs:180`) still refuses the *direct*
call — this criterion protects the **other** half, the row the runtime itself delivers.
`checkScheduleTablePrivate` is **copied** from the pvp sibling (comment-strip → string-strip
→ whitespace-squash, in that order) rather than re-derived, so the two gates cannot drift.
Three fixtures: table absent → flag, table `public` → flag, private table → pass. B13 is its
live bite-proof.

## Consequences

- **Positive.** The EARS reject-clause is now gated **dynamically**, at reducer level,
  through the real SDK, with server-truth state assertions: ten self-contained tests, every
  one of them observed to bite. Two previously unkillable mutation classes (`:433`/`:472`
  operator inversion, `:747` party-guard corruption) became **in-process** kills visible to
  `cargo-mutants`, plus the `:180` scheduler-guard inversion. Two eval blind spots closed
  (`||`-joined guard, string-literal bypass) and one ungated precedent closed
  (`REAPER_SCHEDULE_PRIVATE`). All of it landed with **no `justfile` and no workflow edit**.
- **Negative / accepted.** The `e2e` job is merge-doctrine-enforced, not a required check
  (D1). The eval criterion remains a **shape tripwire** that a legitimate refactor will
  false-flag (D5), and both new Rust pins are likewise deliberately narrow shape pins (D6)
  — the maintenance path is "update the needle in the same PR, keep 5a-5c / 6a-6b green".
  The exact-boundary-accept EARS clause stays statically gated (D4), and the mutants listed
  in D4's ledger survive.
- **Residuals — named, deliberately NOT actioned here:**
  1. **P1/P2 unblocker slice** — a `client/src` grant hook, which makes item seeding
     reachable from a browser identity and revives `recruit.spec` R4 as well. Required
     before scenario 2 or 7 can be gated dynamically.
  2. **P3 successor** — the three-point currency-boundary probe designed in D4, if the
     boundary clause is to be dynamically gated before P1 lands.
  3. **14r-c** migrates this eval's legacy strippers onto `stripRustSource` (ADR-0181); the
     call site is marked in place (D5). Note the `touches:` overlap — 14r-c's glob covers
     `evals/*.eval.mjs` and `*_tests.rs`, so this slice's hunks were kept surgical and
     rebase-friendly.
  4. **14r-g** reuses the three-context pattern over `__mrPvp` — the pattern, not a harness
     (D1).
  5. **Known debt, out of this slice's touches:** `extractFunctionBody` in
     `evals/trade-reducer-security.eval.mjs` brace-walks **string-unstripped** source, so a
     brace inside a string literal can mis-bound a body. Latent today; recorded rather than
     fixed inside a slice that does not own that surface.

## Confirmation

- `client/e2e/trade-zz-negative.spec.ts` — ten tests (1a, 1b, 3a, 3b, 4, 5a, 5b, 5c, 6a,
  6b) mapped one-to-one onto the guards in D3's table; auto-discovered by
  `client/playwright.config.ts:13` and run by the CI `e2e` job
  (`.github/workflows/ci.yml:97`, `:170`). Teeth proven by the D7 register.
- `evals/trade-reducer-security.eval.mjs` — `hasCancelPartyCheck` (`:431`) with fixtures
  RT-SEC-01/02/03 (`:999`, `:1011`, `:1026`); `checkScheduleTablePrivate` (`:515`) with
  three fixtures (`:1117`, `:1130`, `:1144`). Runs under `just eval` / `just ci`.
- `server-module/src/trading_tests.rs` — `check_authorize_call` (`:1001`) with
  `ea_authorize_operator_01` (`:1301`, 7 teeth + 2 controls), `ea_reaper_03_*` (`:1575`, 3
  fixtures) and `ea_cancel_party_01_*` (`:1674`, 3 fixtures). Runs under `just test` and is
  visible to `cargo-mutants`.
- **Acceptance checkpoint:** WHEN a non-party calls `cancel_trade`, or a wrong-role identity
  calls `respond_trade`/`confirm_trade`, the reducer rejects and the named e2e test fails if
  it does not — observed for every mutation in the D7 register.

## References

- ADR-0106 (trading rules and the one-active-offer rule whose D4 makes the `saturating_sub`
  mutants equivalent), ADR-0117 (TTL reaper, the role-before-status authorize split at
  `:433`/`:472`), ADR-0113 (`MAX_ITEM_STACK = 9999`,
  `game-core/src/trading/rules.rs:15`; reject-not-clamp), ADR-0085 (the `SenderError`
  rejection channel), ADR-0087 (owner-channel reads of private tables), ADR-0086 (the e2e
  dev_reducers publish topology and the `spec-gap-revival` tripwire), ADR-0181 (scanner
  consolidation — `stripRustSource` as SSOT; the migration surface marked in D5), ADR-0183
  (the cap 324 / ceiling pair this slice deliberately does not move, and its D4
  survivor-kill successor), ADR-0137 D4 (cap/ceiling lockstep), ADR-0088 (the
  equivalent-mutant bar applied in D4), ADR-0056 (scheduler-only convention behind
  EA-REAPER-03), ADR-0010 (proof-of-teeth).
- Spec `specs/monster-realm-v2/M-postgate-fourteenth-review-residuals.spec.md` §14r-b —
  the verified gap, the seven scenarios and the two EARS clauses quoted in Context.
- PR #287 — the `mergeStateStatus: UNSTABLE` with `e2e = FAILURE` precedent behind D1's
  merge-doctrine wording.
