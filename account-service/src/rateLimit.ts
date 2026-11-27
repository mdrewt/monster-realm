import type { IncomingMessage } from 'node:http';
import { BlockList, isIP, isIPv6 } from 'node:net';
import type { AddressBlock } from './config.ts';

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
 *
 * `maxKeys` bounds it further, for keys anyone can make at no cost: while that many keys have a
 * live hit, a `take` for any other key is refused. A key that has live hits keeps its own limit.
 */
export function createRateLimiter(options: {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly now?: () => number;
  readonly maxKeys?: number;
}): RateLimiter {
  const { limit, windowSeconds } = options;
  const maxKeys = options.maxKeys ?? Number.POSITIVE_INFINITY;
  if (options.maxKeys !== undefined && !(Number.isSafeInteger(maxKeys) && maxKeys >= 1)) {
    throw new RangeError('maxKeys must be a positive integer');
  }
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
      if (hits === undefined ? hitsByKey.size >= maxKeys : hits.length >= limit) return false;
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

/**
 * Builds the reader of a request's source address, in its one canonical spelling.
 *
 * The source is the address at the other end of the socket. When that address is inside one of
 * `trustedProxies`, the request came through a reverse proxy of ours, and the source is the last
 * entry of its `X-Forwarded-For`: the one that proxy wrote, whatever its sender put before it.
 * Nobody else is believed: from any other address the header is not read.
 *
 * The reader answers undefined when the source cannot be known: the socket is gone, or a trusted
 * proxy wrote no address. It never answers a trusted proxy's own address for a request the proxy
 * forwarded.
 */
export function createSourceAddress(
  trustedProxies: readonly AddressBlock[],
): (req: IncomingMessage) => string | undefined {
  // One list per family: `BlockList` also matches an IPv4 address against an IPv6 block.
  const trusted = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const { address, prefix, family } of trustedProxies) {
    trusted[family].addSubnet(address, prefix, family);
  }
  return (req) => {
    const peer = canonicalAddress(req.socket.remoteAddress);
    if (peer === undefined) return undefined;
    const family = isIPv6(peer) ? 'ipv6' : 'ipv4';
    if (!trusted[family].check(peer, family)) return peer;
    const header = req.headers['x-forwarded-for'];
    const forwarded = Array.isArray(header) ? header.join(',') : header;
    if (forwarded === undefined) return undefined;
    return canonicalAddress(forwarded.slice(forwarded.lastIndexOf(',') + 1).trim());
  };
}

/**
 * The key a per-address limit counts a source address under: an IPv4 address itself, and the /64
 * of an IPv6 address, since whoever holds one IPv6 address usually holds its whole /64.
 */
export function addressLimitKey(address: string): string {
  const canonical = canonicalAddress(address);
  if (canonical === undefined || !isIPv6(canonical)) return canonical ?? address;
  const [head = '', tail] = canonical.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? left
      : [...left, ...new Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).join(':')}::/64`;
}

const MAPPED_IPV4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * The one spelling of an IP address: dotted IPv4, or IPv6 in lower case with its longest run of
 * zeros compressed. An IPv4-mapped IPv6 address is the IPv4 address it carries. Undefined for
 * anything that is not an address, and for an address with a zone.
 */
function canonicalAddress(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const version = isIP(text);
  if (version === 4) return text;
  if (version !== 6 || text.includes('%')) return undefined;
  let host: string;
  try {
    // The URL parser writes an IPv6 host in that spelling.
    host = new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const mapped = MAPPED_IPV4.exec(host);
  if (mapped === null) return host;
  const high = Number.parseInt(mapped[1] ?? '', 16);
  const low = Number.parseInt(mapped[2] ?? '', 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
