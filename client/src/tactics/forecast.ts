// tactics/forecast.ts — the pure forecast view-model (BT11.7; the panel that paints it is BT11.4's).
// Takes the wasm `ForecastOut` and shapes it for display: which line items show, which skull, the
// First-Stand marker, the status that may apply. Every number is copied from the rules' output; the
// only logic here is choosing which facts to show. No DOM, no resolver, no arithmetic on damage.
import type { ForecastOut, RuleEffectiveness, RuleStatusKind } from './wasm';

export type Skull = 'none' | 'hollow' | 'full';
export type ForecastLine =
  | { readonly kind: 'type'; readonly effectiveness: RuleEffectiveness }
  | { readonly kind: 'stab' }
  | { readonly kind: 'flank'; readonly num: number; readonly den: number }
  | { readonly kind: 'guard'; readonly num: number; readonly den: number };
export interface ForecastVM {
  /** False when no accuracy roll hits (the traces are a miss). */
  readonly hits: boolean;
  readonly hitPct: number;
  /** The §2.4 damage (`d3`) at variance 85 / 100. */
  readonly min: number;
  readonly max: number;
  /** In the order type, stab, flank, guard; none on a miss; only the type line on Immune. */
  readonly lines: readonly ForecastLine[];
  readonly skull: Skull;
  /** "survives at 1 HP": First-Stand catches the roll. */
  readonly firstStand: boolean;
  /** The status the skill may apply on a hit, or null when the target cannot take one. */
  readonly status: RuleStatusKind | null;
}

export function forecastVM(f: ForecastOut): ForecastVM {
  void f;
  throw new Error('bt-11: not implemented');
}
