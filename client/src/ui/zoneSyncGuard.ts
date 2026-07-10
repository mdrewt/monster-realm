// ui/zoneSyncGuard.ts — pure zone-sync failure threshold guard (M13.5e e-2).
//
// Separates the comparison from the stateful counter in main.ts so the threshold
// logic is unit-testable without threading module state through the reconcile loop.

/**
 * Returns true when the number of consecutive zone-sync failures has reached or
 * exceeded the reporting threshold (default 3, per spec EARS §e-2).
 *
 * WHY pure: main.ts owns the counter; this owns only the comparison, making it
 * independently testable and the threshold independently configurable.
 */
export function shouldReportZoneSyncFailure(consecutiveFailures: number, threshold = 3): boolean {
  return consecutiveFailures >= threshold;
}
