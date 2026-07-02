// ui/evolutionModel.ts — pure view-model for the evolution/fusion screen (M10c).
//
// No DOM, no SDK, no side effects. Takes store data, returns the view-model.
// The thin DOM shell (evolutionView.ts) renders these; the loop refreshes on batch.
// SSOT: the server computes `evolvesTo` on each monster row (ADR-0019). The client
// NEVER derives evolution eligibility from level/item/bond — it reads the server flag.
// No fusion recipe logic in TS; the view lets the user select two monsters and attempt
// fusing — the server rejects invalid recipes (reject-not-clamp, ADR-0019).
// TOTAL: never throws on empty/unknown/missing input — a throw here starves sibling
// store batch-listeners (store.ts one-way flow).
import type { StoreMonsterPub, StoreSpeciesRow } from '../net/store';

export interface EvolutionMonsterViewModel {
  readonly monsterId: bigint;
  readonly speciesName: string;
  readonly nickname: string;
  readonly level: number;
  readonly bond: number;
  /** The name of the evolution target species, or null if no evolution is available. */
  readonly evolvesToSpeciesName: string | null;
  /** True iff the server has set evolvesTo on this monster row (ADR-0019 SSOT). */
  readonly canEvolve: boolean;
}

export interface EvolutionViewModel {
  readonly monsters: readonly EvolutionMonsterViewModel[];
}

function toMonster(
  m: StoreMonsterPub,
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
): EvolutionMonsterViewModel {
  const speciesName = speciesMap.get(m.speciesId)?.name ?? `Unknown (#${m.speciesId})`;
  const { evolvesTo } = m;
  const canEvolve = evolvesTo !== undefined;
  const evolvesToSpeciesName = canEvolve
    ? (speciesMap.get(evolvesTo)?.name ?? `Unknown (#${evolvesTo})`)
    : null;
  return {
    monsterId: m.monsterId,
    speciesName,
    nickname: m.nickname,
    level: m.level,
    bond: m.bond,
    evolvesToSpeciesName,
    canEvolve,
  };
}

export function buildEvolutionViewModel(
  monsters: readonly StoreMonsterPub[],
  speciesMap: ReadonlyMap<number, StoreSpeciesRow>,
): EvolutionViewModel {
  return {
    monsters: monsters.map((m) => toMonster(m, speciesMap)),
  };
}
