// owedInputs.ts — the seqs this socket has sent that the server has neither rejected nor
// acknowledged on the own character row.
//
// It answers one question for the two continuation emitters in main.ts: "is an input of mine
// still unaccounted for?" `Predictor.outstandingSteps` answers that only for the ops its own
// instance recorded, and a zone warp replaces the instance while an input can still be on the
// wire. This set lives outside the predictor, so it keeps counting that input until the row's
// `ackedSeq` covers it or its reducer call rejects.
//
// Pure: no clock, no connection, no predictor. The lifecycle is main.ts's job — `sent` when
// the reducer call is issued, `rejected` from its `.catch`, `acked` on every reconcile, and
// `clear` on reconnect, because a call issued on a dropped socket may never settle.

export class OwedInputs {
  readonly #seqs = new Set<number>();

  /** The reducer call for `seq` has been issued. */
  sent(seq: number): void {
    this.#seqs.add(seq);
  }

  /** The reducer call for `seq` rejected: the server will never acknowledge it. */
  rejected(seq: number): void {
    this.#seqs.delete(seq);
  }

  /** The own row published `ackedSeq`: the server has accepted or passed every seq at or
   *  below it (its seq guard is monotonic), so none of them is owed any more. */
  acked(ackedSeq: number): void {
    for (const seq of this.#seqs) {
      if (seq <= ackedSeq) this.#seqs.delete(seq);
    }
  }

  /** The socket was replaced: nothing sent on the old one will be answered. */
  clear(): void {
    this.#seqs.clear();
  }

  /** How many sent inputs are still unaccounted for. */
  get count(): number {
    return this.#seqs.size;
  }
}
