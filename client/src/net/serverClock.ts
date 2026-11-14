// net/serverClock.ts — the server-time estimate the battle countdowns read (ts-6b-7.2). A battle clock's
// deadline is a SERVER epoch instant; measuring it against the raw device clock shows a skewed device
// a wrong countdown (a clock 60 s behind hides the "Still there?" warning until after the auto-pass).
//
// The only server instants the client sees are the battle clock rows' `windowOpenMs`, and only a window
// this client watched OPEN carries "now" on the server: a row first seen in a snapshot or after a
// reconnect may have opened minutes ago. So a clock id is remembered on its first sighting, and only a
// later change of its `windowOpenMs` to a new value is a sample. `windowOpenMs` is the server's write
// instant plus the presentation pad (game-core `clock::open_window`, at most the tuning's `pad_cap_ms`),
// and the sample is taken when the batch is applied, after its delivery delay: the estimate is off by
// the pad minus that delay, either way, and only by that — where the raw device clock is off by its
// whole skew. The latest sample wins, so a device clock step is corrected by the next window.
//
// Pure: no clock of its own — every local "now" is an argument (main.ts passes `Date.now()`).

/** The two fields of a battle clock row the estimate reads. */
export interface ClockWindowRow {
  readonly clockId: bigint;
  readonly windowOpenMs: bigint | null;
}

export class ServerClock {
  /** Server time minus device time, from the latest sample; 0 before any. */
  #offsetMs = 0;
  /** Each clock id's last `windowOpenMs` seen (null kept: null → a value is a new window). */
  readonly #seen = new Map<bigint, bigint | null>();

  /** One server-time sample: `serverMs` seen at device time `localNowMs`. A non-finite argument is
   *  ignored. */
  observe(serverMs: number, localNowMs: number): void {
    if (!Number.isFinite(serverMs) || !Number.isFinite(localNowMs)) return;
    this.#offsetMs = serverMs - localNowMs;
  }

  /** The server-time estimate at device time `localNowMs`. */
  now(localNowMs: number): number {
    return localNowMs + this.#offsetMs;
  }

  /** The clock rows of one store batch: a known clock id whose `windowOpenMs` changed to a new value
   *  is a window opened just now, sampled at `localNowMs`; a first sighting is only remembered. */
  observeWindows(rows: readonly ClockWindowRow[], localNowMs: number): void {
    for (const { clockId, windowOpenMs } of rows) {
      const known = this.#seen.has(clockId);
      const before = this.#seen.get(clockId);
      this.#seen.set(clockId, windowOpenMs);
      if (known && windowOpenMs !== null && windowOpenMs !== before) {
        this.observe(Number(windowOpenMs), localNowMs);
      }
    }
  }

  /** Forget every remembered clock id (a reconnect: the next rows are a snapshot); the offset stays. */
  forgetWindows(): void {
    this.#seen.clear();
  }
}
