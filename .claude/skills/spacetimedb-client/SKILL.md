---
name: spacetimedb-client
description: Writing the monster-realm TS client against the SpacetimeDB SDK — connection, subscription, the read-only store, the per-transaction reconcile trigger, and the convert/serde marshaling boundary. Use for net/, convert/, prediction-loop wiring, or any client↔server data-shape work. Complements [[spacetimedb-reducer]] (server) and [[wasm-boundary]].
---

# SpacetimeDB: client side (monster-realm v2)

> The client owns no game state; it is a view: `server → store → render` and
> `input → predictor → net`. Mechanics: `ARCHITECTURE.md` ("Client").

> **Versions.** CLI/host, Rust crate and npm `spacetimedb` all 2.11.0 (`^2.11.0`,
> locked, in lockstep since 2026-10-15). The committed bindings are 2.11.0-generated, which means:
> 1. **Table and view handles are camelCase** (`conn.db.myTradeSession`,
>    `conn.db.myMonsterPub`). The snake_case spellings still work as `@deprecated`
>    aliases; write camelCase in new code.
> 2. **`Option<T>` fields are optional keys** (`{ foo?: T | undefined }`).
>
> Upgrading the npm SDK is separate from the CLI and needs a live two-client session:
> newer SDKs auto-reconnect on focus and visibility events, which overlaps the
> client's own reconnect, predictor epoch and send-seq handling.

## Connect and subscribe (`net/connection.ts`)

- The builder takes the URI and database from the shell document: the page's host serves
  `/shell-config.js`, which sets `globalThis.__MR_SHELL_CONFIG__` before the client module
  runs (`net/shellDocument.ts`), and `net/connectionConfig.ts` resolves it (reject, never
  clamp; a production build refuses a missing document and the dev database `monster-realm`).
  `shell/config.ts` exports the result as `URI`, `DB` and `TARGET_KIND`. `VITE_STDB_URI` and
  `VITE_STDB_DB` are inputs of the Vite plugin that serves that script in `vite dev` and
  writes it on a build when `VITE_STDB_DB` is set; client code never reads them.
- The base subscription batch is the public tables the client renders and the
  owner-scoped views. Public: `player` (every player, unfiltered), the content and world
  tables (`species_row`, `skill_row`, `item_row`, `evolution_path`, `heal_location_row`, `npc`,
  `zone_def`, `shop_row`, `shop_item_row`), `player_quest`, `battle_challenge`, `profile`.
  Views: `my_monster_pub`, `my_battle`, `my_inventory`, `my_wallet`, `my_conversation`,
  `my_account`, `my_export_bundle`, `my_pending_evolution_notices`, `my_trade_session`, and
  the tactical-battle views (`my_tactical_battle`, `my_battle_units`, `my_battle_queue`,
  `my_battle_deploy`, `my_battle_clock`, `my_battle_events`, `my_formation`). Public tables
  the client does not render are left out: the drain-only `trade_offer` (trades are read
  through `my_trade_session`), `config` and `type_relation_row`. `character` is not in the
  batch either (next bullet).
- `character` is never subscribed whole. Each connection holds one set for its own row
  (`WHERE entity_id = <E>`) and one per wanted zone (`WHERE zone_id = <Z>`).
  `net/worldScope.ts` builds both query strings and decides when a set is subscribed
  and released; `connection.ts` executes that. The wanted zones are the own row's zone
  and the destination of each warp within `PREFETCH_TILES` of it, and a zone no longer
  wanted stays subscribed for `LINGER_MS`, so the store can hold a zone that is not
  drawn; the render filter leaves it out. Anything that reads `store` characters for
  the world on screen filters by zone.
- **Never subscribe to a private table.** It fails the whole batch, and `onApplied`
  never fires. Subscribe to its view.
- `onApplied` fires once, for the initial snapshot. Treat it as a readiness gate, not
  a per-update hook.
- Reducer arguments are one object: `conn.reducers.joinGame({ name })`.

## The per-transaction reconcile trigger (the load-bearing part)

There is no per-transaction callback in the SDK, only per-row `onInsert`,
`onUpdate` and `onDelete`. Reconciling per row, mid-transaction, rubberbands.
`net/batch.ts` coalesces a burst of row callbacks into one microtask;
`AuthoritativeStore.flushBatch()` then emits one batch signal, and the loop reconciles
once. Views declare no primary key, so the SDK delivers view changes as insert/delete
pairs; `connection.ts` rebuilds view-backed collections from the SDK cache before
flushing. Keep that logic in the adapter; the store and `flushBatch` are unit-tested.

## The convert / serde boundary (`convert/convert.ts`, `net/rowConvert.ts`)

`game-core` types cross the wasm boundary through `serde_wasm_bindgen` and reach the
SDK through generated bindings. The two shapes differ, and the converters are the only
place they meet:

| Value | SDK binding shape | wasm/serde shape |
|---|---|---|
| `Direction` | `{ tag: 'East' }` | `'East'` |
| `MoveInput` | `{ tag: 'Step', value: { tag: 'East' } }` · `{ tag: 'Jump' }` | `{ Step: 'East' }` · `'Jump'` |
| `CharacterState` | flat columns `tileX, tileY, facing, action, moveStartedAtMs` | `{ pos: {x, y}, facing, action, move_started_at }` |
| ids (`entity_id`, `seq`, `monster_id`) | `bigint` (u64) | stays `bigint`; never downcast |
| `move_started_at` (`Millis`) | `bigint` (i64) | a whole **number**; a fraction is rejected at the boundary |

- **Probe the real shape before writing a converter** (call the wasm export from
  `node` and print the JSON). serde's representation cannot be guessed. Then
  round-trip property-test it.
- The predictor's baseline rebases `move_started_at` to local time with no clock
  sync. It is lossy and never round-tripped.

## Own character

`identity.toHexString()` → the `player` row → `entity_id` → the `character` row. Gate
movement input on wasm readiness and the own row being present. Render the own
character from the predictor and everyone else from the store's interpolation buffer,
never both for one entity (your own row is in the subscription too).

## After a schema or type change

Publish → `just gen` (never hand-edit `client/src/module_bindings/`) → `just wasm` if
shared `game-core` types changed → `just eval` (`bindings-drift`,
`client-surface-privacy`). A new subscription or view also needs its converter and
store wiring.

## Gotchas

- **Rubberband after a change** → reconciling per row. **Avoid:** go through the
  microtask flush.
- **Updates never arrive after connect** → the batch included a private table or a
  misspelled name. **Avoid:** subscribe to the view; check names.
- **A `bigint` id corrupts silently** → downcast to `number` past 2^53. **Avoid:** keep
  ids `bigint` end to end; parse currency input with `BigInt`, never `Number`.
- **serde rejects the state** (`invalid type: floating point`) → a fractional
  `move_started_at`. **Avoid:** `Math.floor` (and clamp ≥ 0) before crossing.
- **vitest picks up Playwright specs** → `client/vite.config.ts` scopes
  `test.include` to `src/**/*.test.ts`. Keep it that way.
