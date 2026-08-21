# 0169 — Wallet view runtime path: `my_wallet` subscription, insert-only ingest, and a three-site call-site tooth

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** 11r-e (M-postgate-eleventh-review-residuals — ux2b wallet view completion; EARS 11r-e-1..11r-e-9)
**Supersedes:** —
**Amends:** ADR-0154
**Subsystems:** client-ui, economy-quests, security-authz
**Amended-by:** ADR-0202
**Decision:** Subscribe the owner-scoped `my_wallet` view, ingest it insert-only with no delete handler, and pass `store.ownWallet(identity)` at all THREE `buildShopViewModel*` call sites, pinned by a contiguous-needle ingest tooth and a count tooth.

## Context

ADR-0154 (ux2) shipped the server half — an owner-scoped `#[view] my_wallet` over the private
`player_wallet` table — and the pure client half (`store.upsertWallet`/`store.ownWallet`,
`ShopBalanceViewModel`, `shopView`'s `#shop-balance` node). It deliberately left the **runtime
path** unwired: the subscription, the row converter, the `main.ts` call sites and the behavioral
e2e all sat outside ux2's declared touch-set. ADR-0154 **D7** specified this follow-up slice
file-by-file and named its two failure modes; **accepted risk 1** assigned the two-identity
behavioral privacy proof here, because ux2's only in-slice proof was structural.

The user-visible consequence until now is Drew's original 2026-07-25 playtest complaint verbatim:
a cost is listed, but the player cannot see how much money they have.

Two of D7's stated facts were **stale on arrival** and are corrected here.

## Decision

**D1 — `my_wallet` joins the single `.subscribe([...])` array; the exclusion comment is rewritten.**
`connection.ts` gains `'SELECT * FROM my_wallet'` alongside the sibling owner-scoped
`my_conversation` view. The adjacent comment previously asserted that `player_wallet` "produces no
client subscription — excluded"; after this slice that sentence is false in a security-sensitive
file, so it is rewritten into the `my_conversation` form (private table, owner-scoped view
subscribed instead, subscribing the private table would error the whole batch and `onApplied` would
never fire). The gating test asserts the **raw** source no longer contains the stale phrase — a
comment-stripped scan cannot see comment rot.

Consequently the subscription tooth's negative clause is scoped to **inside the `.subscribe([...])`
array**, not the whole file: the sanctioned comment legitimately names the private table, exactly as
`my_conversation`'s does.

**D2 — the ingest is insert-only, and is pinned by a whole-file CONTIGUOUS needle.**
One handler, no `onDelete`, no `onUpdate` — ADR-0154 D4: no server path deletes a `player_wallet`
row, and through a view a row UPDATE arrives as unordered `onInsert(new)` + `onDelete(old)`, so on a
buy-then-sell round trip the coalesced `I(50) I(100) D(100) D(50)` makes **any** net-effect delete
gate remove the *live* row. The nearest precedent (`my_conversation`'s `shouldRemoveOnViewDelete`
gate) is therefore the single most likely implementation mistake, and copying it is both dead and
wrong.

Two weaker formulations were rejected:

- **A sentinel-bounded region** (`// UX2B-WALLET-INGEST-BEGIN/END`, the `UXD2-SHOPOPEN` idiom). EARS
  11r-e-3b is a *whole-file* negative, and a region-bounded negative cannot see a handler relocated
  200 lines away. It would also have been the first sentinel region in `connection.ts`, whose test
  convention is natural code anchors.
- **Presence-only assertions** (`upsertWallet` is called; `batcher.schedule()` is called). These
  admit a *conditional* ingest — `if (store.ownWallet(identity) === undefined) { …upsertWallet… }`
  — which compiles, reads as a plausible reading of "insert-wins", and **freezes the balance after
  the first delivery**: buy or sell anything and the readout is stale forever. It also passes every
  behavioral gate here, because this slice's e2e is deliberately designed so the balance never
  changes (see D4).

The shipped tooth asserts, over the whole comment-stripped whitespace-squashed file, that the exact
contiguous statement
`conn.db.my_wallet.onInsert((_ctx, row) => { store.upsertWallet(playerWalletRowToStore(row as unknown as SdkPlayerWalletRow)); batcher.schedule(); });`
occurs exactly once, that `conn.db.my_wallet.onDelete` and `.onUpdate` occur zero times, and that
`shouldRemoveOnViewDelete` still occurs exactly once (i.e. only `my_conversation`'s). One needle
pins shape, conversion, argument, ordering, `batcher.schedule()` and uniqueness; the fourth clause
is a tooth against the copy-paste that no region form can express.

**D3 — the converter is pass-through, and coercion is banned.**
`playerWalletRowToStore` maps `ownerIdentity` through `toHexString()` and passes `balance: bigint`
through untouched. `Number(row.balance)` loses precision near `MAX_BALANCE` and lies about the type;
`row.balance ?? 0n` fabricates "broke" from "dark" — the exact D6 collapse; `String(row.ownerIdentity)`
yields `"[object Object]"` and permanently defeats `ownWallet`'s owner filter, rendering `unknown`
forever. `rowConvert.ts` is pure and importable, so this is the one surface with real behavioral unit
tests; `50` is exactly representable as a `number`, so **no e2e can see the lossy cast**.
`SdkPlayerWalletRow` is exported from `rowConvert.ts` (the dominant convention, and the smaller
option) rather than re-declared locally in `wireTables` as the four M12d converters do.

**D4 — there are THREE call sites, not two; all three pass the wallet, and a count tooth freezes
that number.** ADR-0154 D7 and the slice spec both say two (`main.ts:701-708 / 1265-1279` and
`main.ts:719, 1286` respectively). Both predate uxd2/ADR-0161 D5, which added
`buildShopViewModelForShop`. The live sites are `main.ts:1378` (the dialogue listener's deferred
greet-then-shop open), `:1436` (the shop batch listener's bound arm) and `:1443` (its unbound arm).

D7's mandated call-site-count tooth asserts exactly 3 and requires `store.ownWallet(identity)` inside
each call's argument list, sliced by the file's **existing** balanced-paren walker (`callArgs`,
extended with a start offset rather than reimplemented). It additionally asserts that `main.ts` is
the only non-test `client/src` file naming either function, and that the import specifier is the
contiguous unaliased form — closing the two bypasses a `main.ts`-only count leaves open.

A hand-rolled escape-aware string-literal stripper was specified and then **rejected**: a string
literal containing the needle can only *increase* the count past 3 (hard red), never mask an
unpatched site, so the stripper defended a false-RED that does not occur; and running it before
comment-stripping would desynchronise on the ~40 unpaired apostrophes in `main.ts` comments
("Biome's", "shopkeeper's", …), collapsing the observed count 3 → 1 and leaving only `:1378`
standing — calibrating the tooth to the worst possible number. Comment-stripping alone is sound
(`main.ts` contains no `://`). The residual — an unmatched `)` inside a string literal could
terminate a paren walk early — is the accepted exposure of the existing `callArgs` helper.

**D5 — no `identity === ''` guard is added at the dialogue-listener call site.** That listener,
unlike its shop sibling, has no such guard. None is needed: `store.ownWallet('')` returns `undefined`
→ `{kind:'unknown'}` → hidden node. Never a wrong balance. Adding one would be untested dead code.

**D6 — the behavioral proof uses the deterministic quest faucet, not a battle win.**
A fresh identity has **no wallet row at all** (`join_game` grants a starter monster, no gold, no
items; `grant_currency`'s zero-guard prevents a phantom row), so the shop renders the `unknown` arm
rather than "Gold: 0". Gold must therefore be *earned* in-run. `quest_001` ("Find the Elder") has
`start_conditions: []`, a single `Talk(elder_oak)` step and `reward.currency: 50`; the `Talked`
trigger fires in **`talk`** (not `advance_dialogue`), and `QuestComplete` deletes the `player_quest`
row and calls `grant_currency` in the same arm — the only `player_quest` delete in the module, so
"the quest left the log" is an exact server-side witness that 50 gold was granted. Talk → choose
"I seek a quest." → talk again ⇒ exactly 50 gold, zero RNG.

The battle-win faucet (`battle_currency_reward`, ≈31 gold) was rejected: it needs `recruit.spec`'s
grass shuttle walk, encounter loop, HP-restore loop and flee heuristics — hundreds of lines of
stochastic machinery for a *non-deterministic* amount.

**D7 — the e2e captures FIRST PAINT, not just the settled state.** The `character` subscription is
globally unfiltered and `movement_tick` runs per zone at `STEP_MS = 200`, so the shop batch listener
re-renders an open overlay roughly every 200 ms with no player input. A retrying `toHaveText`
therefore **cannot** distinguish a correct implementation from one that patched only the batch
listener (`:1436`) and blanks on open — ADR-0154 D7's other named half-catastrophe. The spec
installs an `addInitScript` `MutationObserver` on the buyer's page that records, **from the mutation
records themselves rather than by reading the settled DOM**, the balance text written at the
transition to visible, and asserts on that in addition to the polled text.

The recorder deliberately captures the balance **text** and not the `data-balance-state` attribute.
`shopView.ts:97-100` writes `textContent`, `hidden` and `dataset.balanceState` from one boolean in
three adjacent statements, so for any single render `textContent === 'Gold: 50'` ⟺
`balanceState === 'known'` — the attribute channel is derived, not independent. Recovering it needed
a backward scan plus an `oldValue`-chaining lookahead plus a live-DOM fallback, and that fallback is
the read-the-settled-DOM anti-pattern the recorder exists to avoid: had it ever triggered it would
have converted a `:1436`-only FAIL into a PASS. The text is recovered directly from the childList
record's `addedNodes` with no chaining, and a blank pre-`show()` render leaves no text record before
the open, so the assertion reds. One channel, no fallback, strictly stronger.

The same observer counts `data-balance-state` writes, giving a direct witness that
`buildShopViewModel*` was re-invoked (the naive witness — "the other player's character moved" —
proves nothing, because character rows are written by the row callback directly and the listener
body is `try`/`catch`-wrapped). A sticky "was `known` ever observed" latch on the second identity
turns its negative assertion from a spot check into a whole-session claim.

## Consequences

The player can finally see their own gold, sourced from server-authoritative state that cannot
drift. `player_wallet` stays private; no write surface was added.

**Note added 2026-08-21 (lp-doc-a, ADR-0202):** `11r-e-1`, `11r-e-3` and `11r-e-9` are the
EARS acceptance-criterion ids of THIS slice, which shipped — they are **not** outstanding
residuals, and an upstream plan that listed them as untriaged residual ids was wrong. Each
is live-tested (`client/src/net/connection.test.ts`, `client/e2e/wallet-balance.spec.ts`).
Recorded so the false lead is not re-derived; see ADR-0202.

**Which gate owns what** (so no later slice cuts the "redundant" one): 11r-e-3's `batcher.schedule()`
and 11r-e-3b's no-`onDelete` are **structurally unreachable by any e2e** — with `schedule()` omitted
the next NPC wander tick re-renders and the e2e self-heals, and D4's catastrophe needs a wallet
*update*, which the 150-gold price floor makes impossible in a 50-gold run. Conversely the e2e is the
only surface that can see a wiring that source-scans green. Both are load-bearing. Note also that
`main.ts:1443` (the unbound arm) is unreachable at runtime — the overlay only opens bound — so the
behavioral witness covers 2 of the 3 sites and the count tooth covers the third.

**What the two-identity e2e does NOT gate — stated so it is not later miscited.** It gates the
CLIENT owner filter and render path, **not** server-side view scoping. `store.upsertWallet` stores
unconditionally and `ownWallet(identity)` filters on *read*, so if the view were ever widened, the
second identity's client would **receive and store** the first's row and still render `unknown` —
observably identical to correct behaviour, while another player's balance sits in browser memory.
Server-side scoping remains owned by `evals/wallet-privacy.eval.mjs` `[B/2c]` and
`economy_tests.rs::my_wallet_view_is_owner_scoped`, whose pinned view body is the entire security
boundary (ADR-0154 D2). (This is a scope disclaimer, not a decision, which is why it lives here
rather than among D1–D7.)

Accepted risks and named residuals:

1. **`evals/wallet-privacy.eval.mjs:37-43` names this slice as the owner of a strengthening edit**
   (a positive `FROM my_wallet` anchor for its check S, closing the absence-only/concat-bypass trap
   that `conversation-privacy`'s check D already closed). `evals/**` is outside this slice's declared
   touch-set, so it was **not** edited. Nothing goes red — check S needles `FROM player_wallet` and
   stays green — and the identical windowed anchor ships in `client/src/net/connection.test.ts`,
   which gates merges under `just client-test` exactly as the eval does under `just eval`. Folding it
   back into the eval is deferred to the next slice that owns `evals/`; until then the eval header
   contains a forward claim this slice did not discharge.
2. **A second identity with a *different nonzero* balance is deferred — and it is reachable.**
   `propose_trade` carries `initiator_currency`/`counterparty_currency` legs with no proximity guard
   and is already driven from e2e via the `__mrTrade` DEV hook, so `A: 50 → 0` / `B: 0 → 50` is
   deterministic. It would additionally prove behaviorally that `0n` renders **`Gold: 0`, not blank**
   — ADR-0154 D6's central "broke ≠ dark" distinction, which after this slice remains unit-tested
   only. It is deferred because it costs a full multi-step trade round trip through the
   escrow/`has_active_trade` interlock machinery, **not** because it is unreachable. This is the
   strongest named follow-up.
3. **Deployment ordering.** A client subscribing `my_wallet` against a module published *before* ux2
   gets the whole subscription batch rejected — `onApplied` never fires and the world stays blank.
   It is reported, not silent (`connection.ts:543` forwards the payload to the status line). CI is
   safe: `just ci` does not run e2e, and `client/e2e/global-setup.ts` republishes with
   `--delete-data`. Local developers must `just publish`. Isolating the wallet into a second
   `.subscribe()` call was rejected — both `conversation-privacy` check D and `wallet-privacy` check
   S index the *first* `.subscribe([` occurrence.
4. **Inherited below-the-fold defect** (ADR-0154 accepted risk 2): `#shop-overlay` is a known
   in-flow shell (ADR-0151), so the now-live balance still sits below the fold until
   `M-postgate-overlay-registry` lands. Playwright's `toBeVisible()` does not require in-viewport, so
   the e2e passes while a human must still scroll. Viewport-anchoring the balance node alone was
   already rejected by ADR-0154.
5. **The quest-completion e2e path is new.** `dialogue.spec.ts` proves talk → advance → `StartQuest`
   and asserts the quest *still active at step 0*; the `QuestComplete → grant_currency` half has no
   prior e2e precedent. The bounded-loop machinery it reuses is CI-proven; the completion assertion
   itself is not yet.
6. **No drift gate binds the hand-written `Sdk*Row` interfaces to the generated bindings.**
   `row as unknown as SdkPlayerWalletRow` deliberately erases tsc's view of the real SDK row. If a
   server column were renamed, `just gen` would regenerate `module_bindings/my_wallet_table.ts`,
   `bindings-drift` would stay green, `SdkPlayerWalletRow` would silently keep the old field name,
   and the readout would render `unknown` forever — indistinguishable from an unwired feature, with
   every unit test still passing (they build their own fixtures). This is the established repo-wide
   convention (`SdkProfileRow`, `SdkConversationRow`, `SdkTradeOfferRow`, …), not a regression
   introduced here, and the de facto shape gate is the new e2e (which runs in the GitHub `e2e` job,
   not in local `just ci`). The durable fix — one eval parsing `module_bindings/*_table.ts` field
   names and asserting each hand-written `Sdk*Row` is a structural subset — is a repo-wide follow-up.
7. **Two pre-existing client-wide defects the new readout inherits, both fail-safe.** (a) `main.ts`'s
   `identity` is assigned only from `opts.onReady` and is never refreshed on reconnect, while
   `createAuthTokenGate` can withhold a rejected token and cause the server to mint a *new* identity
   — after which `store.ownWallet(staleIdentity)` never matches and the balance is permanently blank
   for the session (never another player's number). (b) `wireTables`' row callbacks carry no
   `stale()` guard and are never unwired, so a superseded build's socket can still write into the
   live store; the single-slot design means another identity's row can become *resident* (though the
   read-time owner filter keeps it from rendering). Both predate this slice and affect
   `ownMonsters`/`ownInventory`/`ownCharacter` equally; recorded here because a user-visible balance
   makes (a) newly noticeable. Multi-tab is not a vector — the auth gate is `sessionStorage`-scoped
   (ADR-0150 D3).
