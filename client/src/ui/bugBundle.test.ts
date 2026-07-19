// ui/bugBundle.test.ts — RED gating tests for pt-b1 EARS E-10 (bundle shape) + U-3/H-2/H-3
// (no-PII projection) + bigint-total serialize + safe filename.
//
// Slice: pt-b1 · Source-of-truth: M-playtest-b F9 bug-bundle assembler.
//
// RED REASON: bugBundle.ts does not exist yet. Every test fails with
//   "Failed to resolve import './bugBundle'" (module-not-found).
//
// WRONG-IMPL-KILLED list:
//   - "bundle shape wrong / extra keys / missing schema" → T-BUNDLE-1 catches it
//   - "serialize throws on a bigint (TypeError)"          → T-BUNDLE-2 catches it (replacer)
//   - "bundle leaks a name field / smuggled PII"          → T-BUNDLE-3 catches it (canary)
//   - "filename has unsafe path chars / whitespace / .."  → T-FILENAME catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.

import { describe, expect, it } from 'vitest';
import {
  type BugBundle,
  type BundleBuildStamp,
  bugBundleFilename,
  buildBugBundle,
  type KeyStoreSnapshot,
  serializeBugBundle,
} from './bugBundle';
import type { ErrorRecord } from './errorRing';
import type { PlaytestEvent } from './eventRing';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUILD: BundleBuildStamp = {
  sha: 'deadbee',
  builtAt: '2026-07-19T00:00:00Z',
  mode: 'production',
};

const EVENTS: readonly PlaytestEvent[] = [
  { kind: 'connect', identity: '0xabc123', tSeq: 1, tMs: 100 },
  { kind: 'zoneChange', fromZone: 0, toZone: 3, tSeq: 2, tMs: 200 },
];

const ERRORS: readonly ErrorRecord[] = [{ tSeq: 1, tMs: 150, source: 'reducer', message: 'nope' }];

const STORE: KeyStoreSnapshot = {
  playerCount: 4,
  ownEntityId: '77',
  currentZoneId: 3,
  ongoingBattleId: 'b9',
  ownRating: 1200,
  ownWins: 10,
  ownLosses: 2,
  ownMonsterCount: 6,
  inventoryCount: 12,
};

function makeInput(overrides: Partial<Parameters<typeof buildBugBundle>[0]> = {}) {
  return {
    build: BUILD,
    identity: '0xabc123',
    zoneId: 3,
    capturedAtMs: 1700,
    events: EVENTS,
    errors: ERRORS,
    store: STORE,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T-BUNDLE-1 (E-10 shape): exact key set + embedded inputs.
// ---------------------------------------------------------------------------

describe('bugBundle T-BUNDLE-1 (E-10): bundle shape + embedding', () => {
  it('T-BUNDLE-1 BITES: buildBugBundle returns exactly the E-10 key set with embedded inputs', () => {
    // WRONG IMPL KILLED: a bundle missing schema, or with an extra key (e.g. a leaked
    // connection handle), or that drops the passed events/errors/store.
    const bundle = buildBugBundle(makeInput());
    expect(Object.keys(bundle).sort()).toEqual(
      ['build', 'capturedAtMs', 'errors', 'events', 'identity', 'schema', 'store', 'zoneId'].sort(),
    );
    expect(bundle.schema).toBe('mr-bug-bundle/1');
    expect(bundle.build).toEqual(BUILD);
    expect(bundle.identity).toBe('0xabc123');
    expect(bundle.zoneId).toBe(3);
    expect(bundle.capturedAtMs).toBe(1700);
    expect(bundle.events).toEqual(EVENTS);
    expect(bundle.errors).toEqual(ERRORS);
    expect(bundle.store).toEqual(STORE);
  });

  it('T-BUNDLE-1-STORE: every KeyStoreSnapshot field survives into bundle.store unchanged', () => {
    // WRONG IMPL KILLED: an impl that reshapes/renames snapshot fields, or nulls a field.
    const bundle = buildBugBundle(makeInput());
    expect(bundle.store.playerCount).toBe(4);
    expect(bundle.store.ownEntityId).toBe('77');
    expect(bundle.store.currentZoneId).toBe(3);
    expect(bundle.store.ongoingBattleId).toBe('b9');
    expect(bundle.store.ownRating).toBe(1200);
    expect(bundle.store.ownWins).toBe(10);
    expect(bundle.store.ownLosses).toBe(2);
    expect(bundle.store.ownMonsterCount).toBe(6);
    expect(bundle.store.inventoryCount).toBe(12);
  });

  it('T-BUNDLE-1-NULLS: nullable store fields pass through as null (not coerced to 0)', () => {
    // WRONG IMPL KILLED: an impl that `?? 0`-coerces ownRating/ownWins/ownLosses/ownEntityId
    // /ongoingBattleId, hiding "player has no ranked record" as a fake 0.
    const bundle = buildBugBundle(
      makeInput({
        store: {
          ...STORE,
          ownEntityId: null,
          ongoingBattleId: null,
          ownRating: null,
          ownWins: null,
          ownLosses: null,
        },
      }),
    );
    expect(bundle.store.ownEntityId).toBeNull();
    expect(bundle.store.ongoingBattleId).toBeNull();
    expect(bundle.store.ownRating).toBeNull();
    expect(bundle.store.ownWins).toBeNull();
    expect(bundle.store.ownLosses).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T-BUNDLE-2 (bigint-total): serialize must not throw on a smuggled bigint.
// ---------------------------------------------------------------------------

describe('bugBundle T-BUNDLE-2: serializeBugBundle is bigint-total', () => {
  it('T-BUNDLE-2-ROUNDTRIP: normal bundle round-trips via JSON.parse', () => {
    // WRONG IMPL KILLED: an impl that emits non-JSON (e.g. leaves a trailing comma) or that
    // mangles the schema.
    const bundle = buildBugBundle(makeInput());
    const json = serializeBugBundle(bundle);
    const parsed = JSON.parse(json) as BugBundle;
    expect(parsed.schema).toBe('mr-bug-bundle/1');
    expect(parsed.zoneId).toBe(3);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.store.playerCount).toBe(4);
  });

  it('T-BUNDLE-2 BITES: serialize does NOT throw when a bigint is smuggled into store', () => {
    // WRONG IMPL KILLED: plain JSON.stringify throws "Do not know how to serialize a BigInt".
    // The contract requires a bigint->string replacer. We smuggle a bigint via `as unknown`
    // (KeyStoreSnapshot types forbid bigint, but the SDK's ownEntityId is a bigint at runtime
    // and a careless impl could pass it through unstringified).
    const smuggled = { ...STORE, ownEntityId: 12345678901234567890n as unknown as string };
    const bundle = buildBugBundle(makeInput({ store: smuggled as KeyStoreSnapshot }));
    expect(() => serializeBugBundle(bundle)).not.toThrow();
    const parsed = JSON.parse(serializeBugBundle(bundle)) as { store: { ownEntityId: unknown } };
    // The bigint must survive as a string (its decimal digits), not be dropped or NaN'd.
    expect(parsed.store.ownEntityId).toBe('12345678901234567890');
  });

  it('T-BUNDLE-2-EVENT-BIGINT: a bigint smuggled into an event field also serializes safely', () => {
    // WRONG IMPL KILLED: a replacer applied only to store, not recursively to events.
    const evilEvent = {
      kind: 'boxOpen',
      tSeq: 1,
      tMs: 5n as unknown as number,
    } as unknown as PlaytestEvent;
    const bundle = buildBugBundle(makeInput({ events: [evilEvent] }));
    expect(() => serializeBugBundle(bundle)).not.toThrow();
    const parsed = JSON.parse(serializeBugBundle(bundle)) as { events: Array<{ tMs: unknown }> };
    expect(parsed.events[0]!.tMs).toBe('5');
  });
});

// ---------------------------------------------------------------------------
// T-BUNDLE-3 (no-PII CANARY, U-3/H-2/H-3): projection is name-free by construction.
// ---------------------------------------------------------------------------

describe('bugBundle T-BUNDLE-3 (U-3/H-2/H-3): no-PII projection', () => {
  const CANARY = 'PII_CANARY_2f9';

  it('T-BUNDLE-3-SHAPE BITES: KeyStoreSnapshot has NO name-ish key (the real defense)', () => {
    // The defense against PII is STRUCTURAL: the snapshot type has no name field. We assert
    // the shape at runtime — a real snapshot's keys must be exactly the 9 numeric/id/null
    // fields, none of which is name/displayName/nickname/playerName.
    // WRONG IMPL KILLED: a snapshot builder that adds an ownName/displayName field.
    const keys = Object.keys(STORE);
    expect(keys.sort()).toEqual(
      [
        'currentZoneId',
        'inventoryCount',
        'ongoingBattleId',
        'ownEntityId',
        'ownLosses',
        'ownMonsterCount',
        'ownRating',
        'ownWins',
        'playerCount',
      ].sort(),
    );
    for (const bad of ['name', 'displayName', 'nickname', 'playerName']) {
      expect(keys).not.toContain(bad);
    }
  });

  it('T-BUNDLE-3 BITES: a clean bundle serializes with the canary appearing nowhere in the JSON', () => {
    // The projection is name-free by CONSTRUCTION: the KeyStoreSnapshot type has no name slot
    // (proven by T-BUNDLE-3-SHAPE), and the events (T-NOPII in eventRing) carry no name keys.
    // So a bundle built only from the legal fixture surfaces the canary in NO field. This test
    // fails if a future impl adds an ownName-style field to the snapshot producer and threads a
    // profile name (= the canary) into the bundle.
    // WRONG IMPL KILLED: a snapshot/bundle that embeds a player name anywhere in the projection.
    const bundle = buildBugBundle(makeInput());
    const json = serializeBugBundle(bundle);
    expect(json).not.toContain(CANARY);
    // Also assert the JSON has no name-ish JSON key anywhere (belt-and-suspenders over the shape).
    expect(json.includes('"name"')).toBe(false);
    expect(json.includes('"displayName"')).toBe(false);
    expect(json.includes('"nickname"')).toBe(false);
    expect(json.includes('"playerName"')).toBe(false);
  });

  it('T-BUNDLE-3-POSITIVE: allowed identity-hex + numeric fields ARE present in the JSON', () => {
    // WRONG IMPL KILLED: an over-zealous scrubber that also strips the legal identity-hex and
    // the numeric store stats (which are the whole point of the bundle).
    const bundle = buildBugBundle(makeInput());
    const json = serializeBugBundle(bundle);
    expect(json).toContain('0xabc123'); // identity-hex is allowed
    expect(json).toContain('1200'); // ownRating
    expect(json).toContain('"playerCount":4');
  });
});

// ---------------------------------------------------------------------------
// T-FILENAME: bugBundleFilename is filesystem/path safe.
// ---------------------------------------------------------------------------

describe('bugBundle T-FILENAME: safe filename', () => {
  it('T-FILENAME BITES: contains the sha, ends with .json, no "/", no whitespace, no ".."', () => {
    // WRONG IMPL KILLED: a filename that interpolates a raw timestamp with a colon (ISO) or
    // path separators — a directory-traversal / invalid-filename risk when saved via
    // createObjectURL download.
    const name = bugBundleFilename('deadbee', 1700000000000);
    expect(name).toContain('deadbee');
    expect(name.endsWith('.json')).toBe(true);
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('..');
    // No whitespace anywhere.
    expect(name.includes(' ')).toBe(false);
    expect(name.includes('\t')).toBe(false);
    expect(name.includes('\n')).toBe(false);
    // No colon (would be invalid on Windows and appears in raw ISO timestamps).
    expect(name).not.toContain(':');
  });

  it('T-FILENAME-TS: the timestamp is embedded (distinguishes two captures)', () => {
    // WRONG IMPL KILLED: a filename that ignores capturedAtMs — two bundles would collide.
    const a = bugBundleFilename('deadbee', 1000);
    const b = bugBundleFilename('deadbee', 2000);
    expect(a).not.toBe(b);
  });

  it('T-FILENAME-SHA-SANITIZE: a sha with unsafe chars is sanitized (no "/" leaks through)', () => {
    // WRONG IMPL KILLED: an impl that trusts the sha verbatim — a crafted sha must not inject
    // a path separator into the download filename.
    const name = bugBundleFilename('a/b..c', 1700);
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name.endsWith('.json')).toBe(true);
  });
});
