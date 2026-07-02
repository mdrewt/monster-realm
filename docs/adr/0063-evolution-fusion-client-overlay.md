# 0063. Evolution & fusion client overlay: subscription shape, overlay key, fusion recipe display

- Status: accepted
- Date: 2026-07-02
- Milestone: M10c (client evolution/fuse UI)

## Context and problem statement

M10c adds the client-side evolution/fusion overlay (KeyE, `EvolutionView`). Several
non-obvious design decisions arose:

1. **`evolvesTo` decode** — `option(u32)` on a primitive type decodes as
   `number | undefined` (not a tagged union), unlike `option(StatKind)` which decodes
   as `{ tag: string } | undefined`. The client must not falsy-test `evolvesTo` because
   species id 0 is a valid value; the guard must be `evolvesTo !== undefined`.
2. **`StoreMonsterPub` interface → type** — `as Record<string, unknown>` casts in
   tests require an object-literal type alias, not an `interface` (TS lacks the implicit
   index-signature overlap for interfaces). Changed to `type` alias, matching the pattern
   established by `StoreInventory` and `StoreItemRow`.
3. **Fusion recipe display vs. eligibility** — ADR-0019 mandates the server as SSOT for
   evolution eligibility. The client subscribes to `SELECT * FROM fusion` for *display*
   (showing recipe hints so the player knows which pairs to try), not to drive eligibility
   logic. `buildEvolutionViewModel` accepts `fusions?: readonly StoreFusionRow[]` and
   resolves them to `FusionRecipeViewModel` display names — pure pass-through with no
   decision logic.
4. **Overlay mutual exclusion** — KeyE closes box (B) and raising (I) before toggling
   evolution. KeyB and KeyI close evolution. Battle supersedes all (existing ADR-0014
   exit ordering). All three guard sites in `main.ts` include `evolutionView?.visible`.
5. **Card visual refresh** — `#cardEls: Map<bigint, HTMLDivElement>` stores live card
   elements so `#toggleSelect` can update background/border immediately without waiting
   for the next server batch tick.
6. **Evolve button debounce** — The evolve button is disabled immediately on click and
   re-enabled on the next `refresh()` call (next server tick). This prevents double-fire
   before the server responds. Fuse already self-protects by clearing `#selected`.
7. **Coverage exclusion** — `evolutionView.ts` is a DOM/imperative shell (same category
   as `battleView.ts`, `boxView.ts`, `raisingView.ts`); it is added to
   `vite.config.ts coverage.exclude` and gated by the `dom-shell-coverage-exclusion`
   eval (ADR-0009/0010 discipline: coverage measures unit-testable logic, not DOM shells).

## Decision

- `evolvesTo` field: `readonly evolvesTo?: number` on `StoreMonsterPub` (optional, no
  tag wrapper); `canEvolve = evolvesTo !== undefined` (never `!evolvesTo`).
- `StoreMonsterPub` declared as `type` alias (not `interface`).
- `FusionRecipeViewModel` added to `evolutionModel.ts` — species names resolved at model
  layer; view receives display strings only (no ids).
- `EvolutionViewModel.fusionRecipes: readonly FusionRecipeViewModel[]` — populated from
  `[...store.fusions()]` in `refreshEvolution()`.
- Overlay key: KeyE (confirmed unused by any other binding; B = box, I = inventory).
- `evolutionView.ts` excluded from coverage; `dom-shell-coverage-exclusion.eval.mjs`
  gates that all DOM shells remain in the exclude list.

## Consequences

- Players see fusion recipe hints without the client making eligibility decisions.
- Server rejects invalid `evolve`/`fuse` calls (reject-not-clamp, ADR-0019).
- Coverage gate remains meaningful (no 0%-shell lines counted against threshold).
- The `dom-shell-coverage-exclusion` eval must be updated whenever a new `*View.ts`
  shell is added.
