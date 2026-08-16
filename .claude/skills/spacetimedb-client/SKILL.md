---
name: spacetimedb-client
description: Writing the monster-realm TS client against the SpacetimeDB SDK — connection, per-zone subscription, the read-only store, the per-transaction reconcile trigger, and the convert/serde marshaling boundary. Use for net/, convert/, prediction-loop wiring, or any client↔server data-shape work. Complements [[spacetimedb-reducer]] (server) and [[wasm-boundary]].
---

# SpacetimeDB — client side (monster-realm v2)

> Honor the ADRs: 0007 (zoned subscriptions), 0012 (prediction/reconcile), 0013 (smoothness), 0014 (one-way flow). The client owns NO game state — it is a view: `server → store → render`, `input → predictor → net`.

> **Versions (ADR-0197, 2026-08-16).** CLI/host **2.8.1** · Rust module crate **2.8.1** · npm `spacetimedb` **2.6.0** (`^2.6.0`, lockfile-pinned). The npm bump is independent of the CLI bump — verified both directions typecheck clean.
>
> **The committed bindings are now 2.8.1-generated.** Two consequences you will meet immediately:
> 1. **Table/view handles are camelCase** (2.7.0 codegen change): `conn.db.tradeOffer`, `conn.db.healLocationRow`, `conn.db.myMonsterPub`, … The snake_case spellings still work as `@deprecated` aliases (runtime getters *and* TS types) and the whole client still `tsc --noEmit` clean — but they are documented as "removed in the next major", so **write camelCase in new code** and migrate opportunistically.
> 2. **`Option<T>` fields are optional keys** (2.6.1): `{ foo?: T | undefined }`, not `{ foo: T | undefined }`.
>
> **Pending, deliberately not done:** bumping npm `spacetimedb` to 2.8.1. The 2.7.1 SDK auto-reconnects on `visibilitychange`/`focus`/`online`/`pageshow` and resets backoff, which overlaps the hand-rolled reconnect path (ADR-0085/nh3/nh4). Re-verify epoch guards and send-seq floors with a live two-client session before bumping, or expect double reconnects.

## Connect & subscribe

```ts
const conn = DbConnection.builder()
  .withUri(URI).withDatabaseName(DB)
  .onConnect((c, identity) => {
    c.subscriptionBuilder()
      .onApplied(() => { c.reducers.joinGame({ name }); startLoop(); }) // INITIAL snapshot gate only
      .onError(() => {/* ... */})
      .subscribe(['SELECT * FROM character WHERE zone_id = 0', 'SELECT * FROM player']);
  })
  .onConnectError(/* ... */).onDisconnect(/* ... */).build();

conn.db.character.onInsert((_ctx, row) => onRow(row));
conn.db.character.onUpdate((_ctx, _old, row) => onRow(row));
conn.db.character.onDelete((_ctx, row) => store.removeCharacter(row.entityId));
conn.reducers.joinGame({ name });   // reducer args are an OBJECT
identity.toHexString();             // the own-identity key (string)
```

- **Per-zone subscription (ADR-0007):** `WHERE zone_id = ?` — never `SELECT *` across zones.
- **`onApplied` fires once** for the *initial* subscription snapshot — gate the loop on it, do NOT treat it as a per-update hook.

## The per-transaction reconcile trigger (ADR-0013) — the load-bearing bit

There is **no single per-transaction "applied" connection callback** (validation-findings #4; still true at 2.8.1) — only per-row `onInsert/onUpdate/onDelete` (each carries a shared reducer-event `ctx` per transaction). Reconciling per-row mid-transaction rubberbands. **Coalesce** the row burst into one batch:

```ts
let scheduled = false;
function onRow(row) {
  store.upsertCharacter(convert(row), performance.now());
  if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; store.flushBatch(); }); }
}
```

`AuthoritativeStore.flushBatch()` emits ONE batch-applied signal; the loop reconciles once on the coherent snapshot. Keep the coalescing in the (untested) adapter; the store + `flushBatch` are synchronously unit-tested.

## The convert / serde marshaling boundary

`game-core` types cross the wasm boundary via `serde_wasm_bindgen` and the SDK via generated bindings. The two wire shapes DIFFER — `convert.ts` is the only place they meet ("DRY, but **not** across marshaling boundaries"):

| value | SDK binding shape (tagged union) | wasm/serde shape (probed) |
|---|---|---|
| Direction | `{ tag: 'East' }` | `'East'` |
| MoveInput | `{ tag: 'Step', value: { tag: 'East' } }` · `{ tag: 'Jump' }` | `{ Step: 'East' }` · `'Jump'` |
| CharacterState | flat cols `tileX,tileY,facing,action,moveStartedAtMs` | `{ pos:{x,y}, facing, action, move_started_at }` |
| ids (`entity_id`, `seq`) | `bigint` (u64) | stays `bigint` — NEVER downcast to `number` |
| `move_started_at` (`Millis`) | `bigint` (i64) | a plain **number**, floored; a fractional value is REJECTED at the boundary |

- **Probe the actual shape before writing convert** (`node -e "console.log(JSON.stringify(require('./client-wasm/pkg/client_wasm.js').apply_move(state,input,now)))"`) — serde's representation is not guessable. Then round-trip property-test it.
- `characterToPredictedBaseline` rebases `move_started_at` to LOCAL time `max(0, floor(localNow) - 2*stepMs)` (no clock sync) — lossy, never round-tripped.

## Own-character identification

connection `identity.toHexString()` → `player` row (keyed by identity) → `entity_id` → `character` row. Gate movement input on (wasm ready AND own row present). Render the **own** char from the predictor, **everyone else** from the store interpolation buffer — never both for the same entity (your row is also in the subscription → self double-render/ghost otherwise).

## After ANY schema/type change

publish → `just gen` (= `spacetime generate --lang typescript --module-path server-module --out-dir client/src/module_bindings`; verify flags with `--help`) → rebuild wasm if shared `game-core` types changed → run the **bindings-drift** eval.

The committed bindings were generated by CLI **2.6.0** and the drift gate is green against it. The first regeneration on CLI **2.8.1** will produce a real diff (camelCase handles + the `cliVersion` literal) — that is expected, and it must be a deliberate, reviewed commit, not a drive-by.

## Gotchas

_symptom/quirk → cause → **avoid:** action._

- **Reconcile rubberbands** → reconciling per-row mid-transaction. **Avoid:** coalesce rows in a microtask → one `flushBatch` → reconcile once on the coherent snapshot.
- **`onApplied` never fires for updates** → it is the initial-subscription gate only. **Avoid:** use the per-row callbacks for ongoing updates; coalesce them.
- **A `bigint` id silently corrupts** → downcast to `number` past 2^53. **Avoid:** keep `entity_id`/`seq` `bigint` end-to-end; only bounded `CharacterState` fields cross as numbers.
- **serde rejects the state at the wasm boundary** (`invalid type: floating point`) → a fractional `move_started_at` fails the integer `Millis`. **Avoid:** `Math.floor` (+ clamp ≥0) before crossing.
- **convert shapes guessed wrong** → SDK tagged-union `{tag}` vs serde bare string `'East'`. **Avoid:** probe the real wasm + a binding row first; round-trip property-test convert.
- **vitest tries to run the Playwright e2e specs** ("test() did not expect to be called here") → vitest's default glob grabs `e2e/*.spec.ts`. **Avoid:** scope `test.include: ['src/**/*.test.ts']` in vite.config.
