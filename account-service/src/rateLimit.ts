/** A sliding-window limiter: at most `limit` hits per key within any `windowSeconds`. */
export interface RateLimiter {
  /**
   * Records a hit for `key` and returns true, unless `key` already has `limit` live hits: then it
   * returns false and records nothing.
   */
  take(key: string): boolean;
  /** Removes the most recent hit of `key`, if it has one. */
  giveBack(key: string): void;
  /** Whole seconds until `take(key)` would record a hit: 0 when it would now, otherwise at least 1. */
  retryAfter(key: string): number;
  /** How many keys have at least one live hit now. */
  readonly size: number;
}

/**
 * A hit taken at `t` is live while `now() - t < windowSeconds`. `now` gives the time in epoch
 * seconds and is taken not to run backwards.
 *
 * Keys come from callers the service does not trust, so memory is bounded by the hits taken within
 * one window: every hit joins a queue in the order it was taken, and each `take`, `retryAfter` or
 * `size` read drops the dead hits from the front of that queue and forgets a key left with none.
 */
export function createRateLimiter(options: {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly now?: () => number;
}): RateLimiter {
  const { limit, windowSeconds } = options;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer');
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new RangeError('windowSeconds must be a positive number');
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const hitsByKey = new Map<string, number[]>();
  let queue: Array<{ readonly at: number; readonly key: string }> = [];
  let head = 0;

  const dropDead = (): void => {
    const time = now();
    while (head < queue.length) {
      const oldest = queue[head];
      if (time - oldest.at < windowSeconds) break;
      head += 1;
      const hits = hitsByKey.get(oldest.key);
      if (hits === undefined) continue;
      let dead = 0;
      while (dead < hits.length && time - hits[dead] >= windowSeconds) dead += 1;
      if (dead === hits.length) hitsByKey.delete(oldest.key);
      else if (dead > 0) hits.splice(0, dead);
    }
    if (head > 1024 && head * 2 > queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
  };

  return {
    take(key) {
      dropDead();
      const hits = hitsByKey.get(key);
      if (hits !== undefined && hits.length >= limit) return false;
      const at = now();
      if (hits === undefined) hitsByKey.set(key, [at]);
      else hits.push(at);
      queue.push({ at, key });
      return true;
    },
    giveBack(key) {
      const hits = hitsByKey.get(key);
      if (hits === undefined) return;
      hits.pop();
      if (hits.length === 0) hitsByKey.delete(key);
    },
    retryAfter(key) {
      dropDead();
      const hits = hitsByKey.get(key);
      if (hits === undefined || hits.length < limit) return 0;
      // Room opens when the oldest live hit turns a window old.
      return Math.max(1, Math.ceil(hits[0] + windowSeconds - now()));
    },
    get size() {
      dropDead();
      return hitsByKey.size;
    },
  };
}
