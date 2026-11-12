// net/worldScope.ts — which `character` rows this client subscribes to, as pure state.
//
// PURE. No SDK import, no clock, no timers: the connection shell supplies `now`, executes the
// effects and feeds back each handle's applied / rejected event.
//
// `character` is the one table written on every step, so it is never subscribed whole. A client
// holds one query set for its own row (by `entity_id`) and one per wanted zone (by `zone_id`).
// The own-row set is what carries a warp: the row stays subscribed while its `zone_id` changes,
// so the change arrives as an update and names the next zone to subscribe.

/** A warp tile within this many tiles (Manhattan) of the own tile makes its destination wanted. */
export const PREFETCH_TILES = 4;
/** A zone that stops being wanted stays subscribed this long: a door bounce re-downloads nothing
 *  and one zone costs the host at most one subscribe / unsubscribe pair per window. */
export const LINGER_MS = 5000;
/** A set the client needs that is still not applied after this long means a stalled link. */
export const APPLY_TIMEOUT_MS = 5000;
/** The wait before each in-place retry of a rejected set the client needs. One more rejection
 *  after the last retry ends the connection. */
export const RETRY_BACKOFF_MS: readonly number[] = [250, 500, 1000];
/** The wait before a rejected set the client can do without (a prefetched zone) is tried again. */
export const OPTIONAL_RETRY_MS = 1000;

const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;

// The host shares one query among every subscriber whose SQL text is byte-identical, so these two
// functions are the only place the text is built: single spaces, decimal literal, no semicolon.
// Each literal is validated because a malformed query is a rejected set, and a rejected own-row
// or own-zone set ends the connection.

/** The own-row query. Throws unless `entityId` is a bigint in the u64 range. */
export function ownCharacterQuery(entityId: bigint): string {
  if (typeof entityId !== 'bigint' || entityId < 0n || entityId > U64_MAX) {
    throw new RangeError(`worldScope: entity id ${String(entityId)} is not a u64`);
  }
  return `SELECT * FROM character WHERE entity_id = ${entityId.toString(10)}`;
}

/** One zone's query. Throws unless `zoneId` is an integer in the u32 range. */
export function zoneQuery(zoneId: number): string {
  if (!Number.isInteger(zoneId) || zoneId < 0 || zoneId > U32_MAX) {
    throw new RangeError(`worldScope: zone id ${String(zoneId)} is not a u32`);
  }
  return `SELECT * FROM character WHERE zone_id = ${zoneId.toString(10)}`;
}

export interface ScopeOwn {
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
}

export interface ScopeWarp {
  readonly from: { readonly x: number; readonly y: number };
  readonly to_zone: number;
}

/** The zones worth holding for a character standing at `own`: its zone, plus the destination of
 *  every warp of that zone whose tile is within `k` tiles (Manhattan). None without an own row. */
export function wantedZones(
  own: ScopeOwn | undefined,
  warps: readonly ScopeWarp[],
  k: number,
): ReadonlySet<number> {
  const zones = new Set<number>();
  if (own === undefined) return zones;
  zones.add(own.zoneId);
  for (const warp of warps) {
    const distance = Math.abs(warp.from.x - own.tileX) + Math.abs(warp.from.y - own.tileY);
    if (distance <= k) zones.add(warp.to_zone);
  }
  return zones;
}

/** `own:<entity id>` or `zone:<zone id>`: one key per query set. */
export type ScopeKey = string;
export const ownKey = (entityId: bigint): ScopeKey => `own:${entityId.toString(10)}`;
export const zoneKey = (zoneId: number): ScopeKey => `zone:${zoneId.toString(10)}`;

export interface ScopeEntry {
  readonly query: string;
  /** `pending` from the subscribe until its applied event; a pending set is never unsubscribed. */
  readonly phase: 'pending' | 'active';
  readonly issuedAt: number;
  /** When the key last stopped being wanted; absent while it is wanted. */
  readonly unwantedSince?: number;
}

export interface ScopeRetry {
  /** Rejections in a row; an applied set clears it. */
  readonly attempts: number;
  readonly rejectedAt: number;
}

export interface ScopeState {
  readonly entries: ReadonlyMap<ScopeKey, ScopeEntry>;
  readonly retry: ReadonlyMap<ScopeKey, ScopeRetry>;
  /** The own-row set and the own zone's set are both applied. */
  readonly settled: boolean;
}

export const INITIAL_SCOPE: ScopeState = { entries: new Map(), retry: new Map(), settled: false };

export type ScopeEffect =
  | { readonly kind: 'subscribe'; readonly key: ScopeKey; readonly query: string }
  | { readonly kind: 'unsubscribe'; readonly key: ScopeKey }
  /** `settled` changed. */
  | { readonly kind: 'settled'; readonly settled: boolean }
  /** The connection cannot serve the sets the client needs: end it and reconnect. The returned
   *  state is already `INITIAL_SCOPE`; no handle may be unsubscribed on the way out. */
  | { readonly kind: 'drop'; readonly reason: 'rejected' | 'timeout'; readonly key: ScopeKey };

export interface ScopeInput {
  /** The own character's entity id, from the own `player` row. */
  readonly wantEntity: bigint | undefined;
  /** The zone the own `character` row is in. Always wanted; `wantZones` adds to it. */
  readonly ownZone: number | undefined;
  readonly wantZones: ReadonlySet<number>;
  readonly now: number;
}

export interface ScopeStep {
  readonly state: ScopeState;
  readonly effects: readonly ScopeEffect[];
}

function dropped(state: ScopeState, reason: 'rejected' | 'timeout', key: ScopeKey): ScopeStep {
  const effects: ScopeEffect[] = [];
  if (state.settled) effects.push({ kind: 'settled', settled: false });
  effects.push({ kind: 'drop', reason, key });
  return { state: INITIAL_SCOPE, effects };
}

/**
 * Bring the held sets toward the wanted ones. State-based: call it after any change to the own
 * rows, after every scope event and on a timer; a call with nothing to do returns no effects.
 *
 * A wanted key with no set is subscribed. A set that is no longer wanted is unsubscribed only
 * once it is applied, has been unwanted for `LINGER_MS`, and the own zone's set is applied, so
 * the rows on screen are never dropped before their replacements arrive. The own-row set and the
 * own zone's set are the two the client needs: a rejection of either is retried after
 * `RETRY_BACKOFF_MS`, and one that outlasts the retries, or stays unapplied for
 * `APPLY_TIMEOUT_MS`, yields `drop`.
 */
export function syncScope(state: ScopeState, input: ScopeInput): ScopeStep {
  const { wantEntity, ownZone, now } = input;
  const ownK = wantEntity === undefined ? undefined : ownKey(wantEntity);
  const ownZoneK = ownZone === undefined ? undefined : zoneKey(ownZone);
  const needed = (key: ScopeKey): boolean => key === ownK || key === ownZoneK;

  const wanted = new Map<ScopeKey, string>();
  if (wantEntity !== undefined) wanted.set(ownKey(wantEntity), ownCharacterQuery(wantEntity));
  const zones = ownZone === undefined ? input.wantZones : [ownZone, ...input.wantZones];
  for (const zone of zones) wanted.set(zoneKey(zone), zoneQuery(zone));

  const entries = new Map(state.entries);
  // A retry count belongs to a key that is still wanted; the rest are forgotten.
  const retry = new Map([...state.retry].filter(([key]) => wanted.has(key)));
  const subscribes: ScopeEffect[] = [];
  const unsubscribes: ScopeEffect[] = [];

  for (const [key, query] of wanted) {
    const entry = entries.get(key);
    if (entry !== undefined) {
      if (needed(key) && entry.phase === 'pending' && now - entry.issuedAt >= APPLY_TIMEOUT_MS) {
        return dropped(state, 'timeout', key);
      }
      if (entry.unwantedSince !== undefined) {
        entries.set(key, { query: entry.query, phase: entry.phase, issuedAt: entry.issuedAt });
      }
      continue;
    }
    const failed = retry.get(key);
    if (failed !== undefined) {
      if (needed(key) && failed.attempts > RETRY_BACKOFF_MS.length) {
        return dropped(state, 'rejected', key);
      }
      const wait = needed(key)
        ? (RETRY_BACKOFF_MS[failed.attempts - 1] ?? OPTIONAL_RETRY_MS)
        : OPTIONAL_RETRY_MS;
      if (now - failed.rejectedAt < wait) continue;
    }
    entries.set(key, { query, phase: 'pending', issuedAt: now });
    subscribes.push({ kind: 'subscribe', key, query });
  }

  const ownZoneActive = ownZoneK === undefined || entries.get(ownZoneK)?.phase === 'active';
  for (const [key, entry] of entries) {
    if (wanted.has(key)) continue;
    const since = entry.unwantedSince ?? now;
    if (entry.phase === 'active' && ownZoneActive && now - since >= LINGER_MS) {
      entries.delete(key);
      unsubscribes.push({ kind: 'unsubscribe', key });
    } else if (entry.unwantedSince === undefined) {
      entries.set(key, { ...entry, unwantedSince: since });
    }
  }

  const settled =
    ownK !== undefined &&
    ownZoneK !== undefined &&
    entries.get(ownK)?.phase === 'active' &&
    entries.get(ownZoneK)?.phase === 'active';
  // New sets are requested before old ones are released.
  const effects: ScopeEffect[] = [...subscribes, ...unsubscribes];
  if (settled !== state.settled) effects.push({ kind: 'settled', settled });
  return { state: { entries, retry, settled }, effects };
}

export interface ScopeEvent {
  readonly kind: 'applied' | 'rejected';
  readonly key: ScopeKey;
  readonly now: number;
}

/** Record one handle's outcome. An event for a key with no set changes nothing. The caller runs
 *  `syncScope` afterwards: that is where `settled`, the retry and the drop are decided. */
export function onScopeEvent(state: ScopeState, event: ScopeEvent): ScopeState {
  const entry = state.entries.get(event.key);
  if (entry === undefined) return state;
  const entries = new Map(state.entries);
  const retry = new Map(state.retry);
  if (event.kind === 'applied') {
    entries.set(event.key, { ...entry, phase: 'active' });
    retry.delete(event.key);
  } else {
    entries.delete(event.key);
    retry.set(event.key, {
      attempts: (state.retry.get(event.key)?.attempts ?? 0) + 1,
      rejectedAt: event.now,
    });
  }
  return { entries, retry, settled: state.settled };
}

export interface ScopeSummary {
  /** The own-row set's phase, or null while there is none. */
  readonly own: 'pending' | 'active' | null;
  readonly zones: readonly { readonly zoneId: number; readonly state: 'pending' | 'active' }[];
  readonly settled: boolean;
}

/** The held sets in a form a test or a debug hook can read, zones in ascending id order. */
export function describeScope(state: ScopeState): ScopeSummary {
  let own: ScopeSummary['own'] = null;
  const zones: { zoneId: number; state: 'pending' | 'active' }[] = [];
  for (const [key, entry] of state.entries) {
    if (key.startsWith('zone:')) zones.push({ zoneId: Number(key.slice(5)), state: entry.phase });
    else own = entry.phase;
  }
  zones.sort((a, b) => a.zoneId - b.zoneId);
  return { own, zones, settled: state.settled };
}
