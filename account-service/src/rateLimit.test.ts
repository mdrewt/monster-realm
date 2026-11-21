import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRateLimiter, type RateLimiter } from './rateLimit.ts';

const T0 = 1_700_000_000;
let t = T0;
const now = (): number => t;

beforeEach(() => {
  t = T0;
});

afterEach(() => {
  vi.useRealTimers();
});

function limiter(limit = 5, windowSeconds = 600): RateLimiter {
  return createRateLimiter({ limit, windowSeconds, now });
}

function takes(rl: RateLimiter, key: string, count: number): boolean[] {
  return Array.from({ length: count }, () => rl.take(key));
}

describe('take', () => {
  test('five hits are let through within ten minutes and the sixth is refused acs-2.3', () => {
    const rl = limiter(5, 600);
    const answers: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      t = T0 + i * 100;
      answers.push(rl.take('player@example.com'));
    }
    expect(answers).toEqual([true, true, true, true, true, false]);
  });

  test('a hit is live while less than the window has passed: at 599 s it counts, at 600 s it does not acs-2.3', () => {
    const rl = limiter(1, 600);
    expect(rl.take('k')).toBe(true);
    t = T0 + 599;
    expect(rl.take('k')).toBe(false);
    t = T0 + 600;
    expect(rl.take('k')).toBe(true);
    t = T0 + 1199;
    expect(rl.take('k')).toBe(false);
    t = T0 + 1200;
    expect(rl.take('k')).toBe(true);
  });

  test('a refused take records nothing, so only the hits let through age out acs-2.3', () => {
    const rl = limiter(5, 600);
    for (let i = 0; i < 5; i += 1) {
      t = T0 + i;
      expect(rl.take('k')).toBe(true);
    }
    // Refusals between the fifth hit and the first one ageing out.
    for (let i = 5; i < 600; i += 50) {
      t = T0 + i;
      expect(rl.take('k')).toBe(false);
    }
    t = T0 + 600; // only the hit at T0 has aged out
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
    t = T0 + 601; // and now the hit at T0 + 1
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
  });

  test('the window slides: hits age out one by one, oldest first', () => {
    const rl = limiter(3, 10);
    t = T0;
    expect(rl.take('k')).toBe(true);
    t = T0 + 4;
    expect(rl.take('k')).toBe(true);
    t = T0 + 8;
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
    t = T0 + 10;
    expect(takes(rl, 'k', 2)).toEqual([true, false]);
    t = T0 + 14;
    expect(takes(rl, 'k', 2)).toEqual([true, false]);
  });

  test('keys are counted apart, and keys differing only in case or spacing are different keys acs-2.3', () => {
    const rl = limiter(2, 600);
    expect(takes(rl, 'a@example.com', 3)).toEqual([true, true, false]);
    expect(takes(rl, 'b@example.com', 3)).toEqual([true, true, false]);
    expect(takes(rl, 'A@example.com', 3)).toEqual([true, true, false]);
    expect(takes(rl, 'a@example.com ', 3)).toEqual([true, true, false]);
    expect(rl.take('a@example.com')).toBe(false);
  });

  test('a window that is not a whole number of seconds is honoured', () => {
    const rl = limiter(1, 0.5);
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
    t = T0 + 1;
    expect(rl.take('k')).toBe(true);
  });

  test('without a clock it reads whole seconds of the wall clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 * 1000);
    const rl = createRateLimiter({ limit: 1, windowSeconds: 10 });
    expect(rl.take('k')).toBe(true);
    vi.setSystemTime((T0 + 10) * 1000 - 1); // second T0 + 9
    expect(rl.take('k')).toBe(false);
    vi.setSystemTime((T0 + 10) * 1000);
    expect(rl.take('k')).toBe(true);
  });
});

describe('giveBack', () => {
  test('giving back a hit frees one slot and only one acs-2.3', () => {
    const rl = limiter(5, 600);
    expect(takes(rl, 'k', 6)).toEqual([true, true, true, true, true, false]);
    rl.giveBack('k');
    expect(takes(rl, 'k', 2)).toEqual([true, false]);
  });

  test('giving back removes the most recent hit, so the older ones still age out on time acs-2.3', () => {
    const rl = limiter(2, 600);
    expect(rl.take('k')).toBe(true); // T0
    t = T0 + 300;
    expect(rl.take('k')).toBe(true); // T0 + 300
    t = T0 + 301;
    rl.giveBack('k'); // removes the T0 + 300 hit
    expect(rl.take('k')).toBe(true); // T0 + 301
    expect(rl.take('k')).toBe(false);
    t = T0 + 600; // the T0 hit ages out; T0 + 301 is still live
    expect(takes(rl, 'k', 2)).toEqual([true, false]);
  });

  test('giving back on a key with no hit does nothing, to it or to any other key', () => {
    const rl = limiter(2, 600);
    expect(takes(rl, 'other', 2)).toEqual([true, true]);
    rl.giveBack('never-seen');
    rl.giveBack('never-seen');
    expect(rl.size).toBe(1);
    expect(takes(rl, 'never-seen', 3)).toEqual([true, true, false]);
    expect(rl.take('other')).toBe(false);
  });

  test('giving back more often than there were hits never adds a slot', () => {
    const rl = limiter(3, 600);
    expect(rl.take('k')).toBe(true);
    for (let i = 0; i < 5; i += 1) rl.giveBack('k');
    expect(takes(rl, 'k', 4)).toEqual([true, true, true, false]);
  });

  test('giving back on a key whose hits have all aged out never adds a slot', () => {
    const rl = limiter(2, 600);
    expect(takes(rl, 'k', 2)).toEqual([true, true]);
    t = T0 + 600;
    rl.giveBack('k');
    rl.giveBack('k');
    expect(takes(rl, 'k', 3)).toEqual([true, true, false]);
  });
});

describe('size', () => {
  test('counts the keys with a live hit, each key once', () => {
    const rl = limiter(5, 600);
    expect(rl.size).toBe(0);
    takes(rl, 'a', 3);
    rl.take('b');
    expect(rl.size).toBe(2);
    takes(rl, 'a', 4); // includes refusals
    expect(rl.size).toBe(2);
    rl.take('c');
    expect(rl.size).toBe(3);
  });

  test('a key whose only hit was given back is no longer counted', () => {
    const rl = limiter(5, 600);
    rl.take('a');
    rl.take('b');
    rl.giveBack('a');
    expect(rl.size).toBe(1);
  });

  test('keys whose hits have aged out are not counted, read alone or after a take', () => {
    const rl = limiter(5, 600);
    rl.take('a'); // T0
    t = T0 + 100;
    rl.take('b');
    t = T0 + 200;
    rl.take('a'); // a now has a later hit too
    expect(rl.size).toBe(2);
    t = T0 + 650; // a's first hit is gone, its second is live; b's is live
    expect(rl.size).toBe(2);
    t = T0 + 750; // b's only hit is gone
    expect(rl.size).toBe(1);
    t = T0 + 800; // a's second hit is gone
    expect(rl.size).toBe(0);
    rl.take('c');
    expect(rl.size).toBe(1);
  });

  test('a thousand keys that age out leave nothing counted', () => {
    const rl = limiter(5, 600);
    for (let i = 0; i < 1000; i += 1) {
      t = T0 + (i % 10);
      rl.take(`key-${i}`);
    }
    expect(rl.size).toBe(1000);
    t = T0 + 609;
    expect(rl.take('fresh')).toBe(true);
    expect(rl.size).toBe(1);
  });
});

describe('keys are exact strings', () => {
  const odd = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype', ''];

  test.each(odd)('%j is an ordinary key with its own count', (key) => {
    const rl = limiter(2, 600);
    expect(takes(rl, key, 3)).toEqual([true, true, false]);
    expect(rl.size).toBe(1);
    rl.giveBack(key);
    expect(takes(rl, key, 2)).toEqual([true, false]);
    expect(takes(rl, 'someone-else', 2)).toEqual([true, true]);
    expect(rl.size).toBe(2);
    t = T0 + 600;
    expect(rl.size).toBe(0);
  });

  test('all the odd keys together are counted apart from each other', () => {
    const rl = limiter(1, 600);
    for (const key of odd) expect(rl.take(key), key).toBe(true);
    for (const key of odd) expect(rl.take(key), key).toBe(false);
    expect(rl.size).toBe(odd.length);
    expect(rl.take('fresh')).toBe(true);
  });
});

describe('options', () => {
  const bad: ReadonlyArray<readonly [string, number, number]> = [
    ['limit 0', 0, 600],
    ['a negative limit', -1, 600],
    ['a fractional limit', 1.5, 600],
    ['a NaN limit', Number.NaN, 600],
    ['an infinite limit', Number.POSITIVE_INFINITY, 600],
    ['a limit past the safe integers', 2 ** 53, 600],
    ['a string limit', '5' as unknown as number, 600],
    ['window 0', 5, 0],
    ['a negative window', 5, -600],
    ['a NaN window', 5, Number.NaN],
    ['an infinite window', 5, Number.POSITIVE_INFINITY],
    ['a string window', 5, '600' as unknown as number],
  ];

  test.each(bad)('%s is a RangeError', (_name, limit, windowSeconds) => {
    expect(() => createRateLimiter({ limit, windowSeconds, now })).toThrow(RangeError);
  });

  test('the smallest and largest allowed values are accepted', () => {
    expect(() => createRateLimiter({ limit: 1, windowSeconds: 0.5, now })).not.toThrow();
    const big = createRateLimiter({
      limit: Number.MAX_SAFE_INTEGER,
      windowSeconds: Number.MAX_VALUE,
      now,
    });
    expect(takes(big, 'k', 3)).toEqual([true, true, true]);
  });
});

describe('retryAfter', () => {
  test('is 0 for a key never seen and for a key below the limit acs-3.3', () => {
    const rl = limiter(3, 600);
    expect(rl.retryAfter('nobody')).toBe(0);
    expect(takes(rl, 'k', 2)).toEqual([true, true]);
    expect(rl.retryAfter('k')).toBe(0);
    expect(rl.take('k')).toBe(true);
  });

  test('at the limit it is the seconds until the oldest live hit is a window old, as the clock moves acs-3.3', () => {
    const rl = limiter(3, 600);
    expect(rl.take('k')).toBe(true); // T0
    t = T0 + 100;
    expect(rl.take('k')).toBe(true);
    t = T0 + 200;
    expect(rl.take('k')).toBe(true);
    expect(rl.retryAfter('k')).toBe(400);
    t = T0 + 250;
    expect(rl.retryAfter('k')).toBe(350);
    t = T0 + 599;
    expect(rl.retryAfter('k')).toBe(1);
    t = T0 + 600; // the T0 hit is dead: room again
    expect(rl.retryAfter('k')).toBe(0);
    expect(rl.take('k')).toBe(true);
    // Full again; the oldest live hit is now the one at T0 + 100.
    expect(rl.retryAfter('k')).toBe(100);
  });

  test('a fractional remainder is rounded up, and a full key is never told less than 1 acs-3.3', () => {
    let fractional = T0 + 0.25;
    const rl = createRateLimiter({ limit: 1, windowSeconds: 10, now: () => fractional });
    expect(rl.take('k')).toBe(true);
    fractional = T0 + 3.75; // 6.5 seconds left
    expect(rl.retryAfter('k')).toBe(7);
    fractional = T0 + 10.2; // a twentieth of a second left
    expect(rl.retryAfter('k')).toBe(1);
    fractional = T0 + 10.25;
    expect(rl.retryAfter('k')).toBe(0);

    const short = createRateLimiter({ limit: 1, windowSeconds: 0.5, now });
    expect(short.take('k')).toBe(true);
    expect(short.retryAfter('k')).toBe(1);
  });

  test('after that many seconds take lets the key through, and one second earlier it does not acs-3.3', () => {
    const rl = limiter(5, 600);
    for (let i = 0; i < 5; i += 1) {
      t = T0 + i * 37;
      expect(rl.take('k')).toBe(true);
    }
    t = T0 + 300;
    const wait = rl.retryAfter('k');
    expect(wait).toBe(300);
    t = T0 + 300 + wait - 1;
    expect(rl.take('k')).toBe(false);
    t = T0 + 300 + wait;
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
  });

  test('records nothing: asking many times changes neither what take answers nor size acs-3.3', () => {
    const rl = limiter(2, 600);
    for (let i = 0; i < 50; i += 1) expect(rl.retryAfter('ghost')).toBe(0);
    expect(rl.size).toBe(0);
    expect(rl.take('k')).toBe(true);
    for (let i = 0; i < 50; i += 1) expect(rl.retryAfter('k')).toBe(0);
    expect(rl.size).toBe(1);
    expect(rl.take('k')).toBe(true);
    const full = rl.retryAfter('k');
    expect(full).toBe(600);
    for (let i = 0; i < 50; i += 1) expect(rl.retryAfter('k')).toBe(full);
    expect(rl.take('k')).toBe(false);
    expect(rl.size).toBe(1);
    rl.giveBack('k');
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
  });

  test('after giveBack a full key is told 0 again acs-3.3', () => {
    const rl = limiter(2, 600);
    expect(takes(rl, 'k', 2)).toEqual([true, true]);
    expect(rl.retryAfter('k')).toBeGreaterThanOrEqual(1);
    rl.giveBack('k');
    expect(rl.retryAfter('k')).toBe(0);
    expect(rl.take('k')).toBe(true);
    expect(rl.retryAfter('k')).toBeGreaterThanOrEqual(1);
  });

  test('keys are answered apart acs-3.3', () => {
    const rl = limiter(2, 600);
    expect(takes(rl, 'a', 2)).toEqual([true, true]); // T0
    t = T0 + 50;
    expect(takes(rl, 'b', 2)).toEqual([true, true]);
    t = T0 + 100;
    expect(rl.retryAfter('a')).toBe(500);
    expect(rl.retryAfter('b')).toBe(550);
    expect(rl.retryAfter('c')).toBe(0);
    rl.giveBack('a');
    expect(rl.retryAfter('a')).toBe(0);
    expect(rl.retryAfter('b')).toBe(550);
  });

  test('hits that have aged out do not count, read before any take or size acs-3.3', () => {
    const rl = limiter(2, 600);
    expect(rl.take('k')).toBe(true); // T0
    t = T0 + 1;
    expect(rl.take('k')).toBe(true);
    t = T0 + 600; // the T0 hit is dead, the T0 + 1 hit is live
    expect(rl.retryAfter('k')).toBe(0);
    t = T0 + 601;
    expect(rl.retryAfter('k')).toBe(0);
    expect(takes(rl, 'k', 3)).toEqual([true, true, false]);
  });
});
