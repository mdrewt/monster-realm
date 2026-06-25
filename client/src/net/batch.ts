// net/batch.ts — coalesce a transaction's row callbacks into ONE flush.
//
// SpacetimeDB 2.6 delivers a transaction's row callbacks (onInsert/onUpdate/
// onDelete) synchronously with NO per-transaction "applied" connection hook
// (validation-findings #4). Reconciling per row mid-transaction rubberbands
// (ADR-0013). This batches a synchronous burst of `schedule()` calls into a single
// `flush` on the next microtask, so the loop reconciles ONCE on a coherent snapshot.
// Kept tiny + injectable so it is unit-testable without the live SDK.
export class MicrotaskBatcher {
  #scheduled = false;
  readonly #flush: () => void;

  constructor(flush: () => void) {
    this.#flush = flush;
  }

  /** Request a flush. The first call in a synchronous burst schedules a microtask;
   *  subsequent calls in the same burst are absorbed (one flush per transaction). */
  schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }
}
