// observability/attributes.test.ts — m20c (ADR-0180 body amendment), OBS-34/35 + T-34a/T-34b.
//
// SOURCE OF TRUTH: EARS OBS-34/35 + the Alloy datapoint policy (config.alloy:155-158), mirrored
// client-side by names.ts. `buildAttributes` is the ONE place a datapoint attribute set is
// constructed, and its contract is deliberately narrow:
//
//   1. the key set is a SUBSET of ATTR_KEYS — never a superset, at any input;
//   2. a value that names.ts rejects causes its KEY to be OMITTED — never coerced, never
//      trimmed/lowercased into validity, never "left for Alloy to filter" (anti-pattern 3);
//   3. the returned object is FROZEN and is the object handed to `record()`/`add()` verbatim
//      (AM10) — so no call site can spread-and-append a per-call dimension;
//   4. it is rebuildable: a zone switch produces a NEW frozen object with the new zone_id (AM1).
//
// WHY OMIT RATHER THAN SHIP-AND-LET-ALLOY-DROP: Alloy only sees what already left the browser.
// OBS-34/35 are about the wire, not the store. And a shipped-then-dropped value collapses the
// point into the unlabelled series — silently corrupting every per-zone panel while the client
// believes it reported.
//
// RED REASON: `client/src/observability/attributes.ts` does not exist yet.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type AttributeInput, buildAttributes } from './attributes';
import { ATTR_KEYS, isValidBuildSha, isValidDeviceClass } from './names';

const SHA_7 = 'a1b2c3d';
const SHA_40 = '0123456789abcdef0123456789abcdef01234567';
const SHA_41 = `${SHA_40}8`;
/** 64 lowercase hex — the shape of a SpacetimeDB Identity. Must never become a label. */
const IDENTITY_64 = `${SHA_40}89abcdef0123456789abcdef`;

const VALID: AttributeInput = { zoneId: 0, buildSha: SHA_7, deviceClass: 'desktop' };

/** ATTR_KEYS widened to `readonly string[]` so `.includes(someString)` is well-typed here.
 *  Deliberately NOT a re-typed literal copy: the values still come from names.ts. */
const ALLOWED_KEYS: readonly string[] = ATTR_KEYS;

describe('buildAttributes (T-34a): the key set is exactly the Alloy allowlist, never a superset', () => {
  it('T-34a: all three valid inputs produce EXACTLY {zone_id, build_sha, device_class}', () => {
    // WRONG IMPL KILLED (1): a fourth key — `player_name`, `session_id`, `identity`,
    //   `entity_id`, `nickname`. Any of them is an OBS-34/35 breach the moment the request is
    //   sent, and Alloy's silent deletion means NOTHING downstream would ever reveal it.
    // WRONG IMPL KILLED (2): a MISSING key. This is a sorted EXACT-equality, not a `.includes`
    //   (plan anti-pattern 9): a containment check cannot see an omission, and a permanently
    //   missing build_sha makes every "is this regression in the new build?" question
    //   unanswerable.
    const attrs = buildAttributes(VALID);
    expect(Object.keys(attrs).sort()).toEqual(['build_sha', 'device_class', 'zone_id']);
    expect(attrs).toEqual({ zone_id: '0', build_sha: SHA_7, device_class: 'desktop' });
  });

  it('T-34a-keys-are-the-SSOT: the produced key set is set-equal to ATTR_KEYS from names.ts', () => {
    // Binds this module to the ONE mirror of config.alloy rather than to a second literal list
    // written here. If someone widens ATTR_KEYS, this reds until buildAttributes agrees — and
    // names.test.ts's T-34a reds against the ops file. Two locks, one key.
    const attrs = buildAttributes(VALID);
    expect(Object.keys(attrs).sort()).toEqual([...ATTR_KEYS].sort());
  });

  it('T-34a-frozen: the returned object is frozen (AM10 — no call site can append a dimension)', () => {
    // WRONG IMPL KILLED: returning a plain mutable record. main.ts and telemetry.ts both hold
    // this object for the whole session; ONE `attrs.zone_id = …` or `attrs.player = …` anywhere
    // would retro-actively re-label every future datapoint. Freezing makes the "one attribute
    // object per zone, rebuilt on switch" claim structural instead of aspirational.
    const attrs = buildAttributes(VALID);
    expect(Object.isFrozen(attrs)).toBe(true);

    // And prove the freeze BITES at runtime, not just as a flag: the write is rejected (ESM
    // modules are strict mode, so the assignment throws) and the object is unchanged either way.
    try {
      (attrs as Record<string, string>).player_name = 'Drew';
    } catch {
      // strict-mode TypeError is the expected outcome; the state assertion below is the tooth.
    }
    expect(Object.keys(attrs).sort()).toEqual(['build_sha', 'device_class', 'zone_id']);
  });
});

describe('buildAttributes (T-34b): a non-conforming value OMITS its key — never coerced', () => {
  it('T-34b-omit-each: each invalid field drops its OWN key and leaves the others intact', () => {
    // WRONG IMPL KILLED: an all-or-nothing guard (one bad field ⇒ `{}`), which silently
    // un-labels every datapoint of a session that happens to run a dev build with sha
    // 'unknown'. Per-key omission is what Alloy does (three independent delete_key statements);
    // the client mirrors it per key.
    expect(buildAttributes({ ...VALID, zoneId: 10000 })).toEqual({
      build_sha: SHA_7,
      device_class: 'desktop',
    });
    expect(buildAttributes({ ...VALID, buildSha: 'unknown' })).toEqual({
      zone_id: '0',
      device_class: 'desktop',
    });
    expect(buildAttributes({ ...VALID, deviceClass: 'tv' })).toEqual({
      zone_id: '0',
      build_sha: SHA_7,
    });
  });

  it('T-34b-empty: an EMPTY input produces an empty object — never the string "undefined"', () => {
    // WRONG IMPL KILLED (measured-shaped, the classic): `{ zone_id: String(input.zoneId) }` with
    // no presence check. `String(undefined)` is the 9-character label value "undefined", which
    // is well-formed enough to be SENT (it is Alloy that deletes it) and, for device_class,
    // would even look plausible in a client-side log. The whole point is to not send it.
    const attrs = buildAttributes({});
    expect(attrs).toEqual({});
    expect(Object.keys(attrs)).toEqual([]);
    expect(Object.isFrozen(attrs)).toBe(true);
  });

  it('T-34b-no-coercion: values are passed through VERBATIM or omitted — no trim, no case-fold', () => {
    // WRONG IMPL KILLED (1): a `.trim()` before validation. Alloy does not trim, so ' a1b2c3d '
    //   is a value the ingest deletes; "helpfully" trimming it client-side means the two
    //   policies disagree and the client's belief about what it labelled is wrong.
    // WRONG IMPL KILLED (2): a `.toLowerCase()` before validation, which would let 'A1B2C3D'
    //   through as 'a1b2c3d' — a DIFFERENT sha than the build actually ran, i.e. a wrong label
    //   rather than a missing one. Wrong is worse than absent.
    expect(buildAttributes({ buildSha: ' a1b2c3d ' })).toEqual({});
    expect(buildAttributes({ buildSha: 'A1B2C3D' })).toEqual({});
    expect(buildAttributes({ deviceClass: 'Desktop' })).toEqual({});
    expect(buildAttributes({ deviceClass: ' desktop' })).toEqual({});

    // The accepted value must be the INPUT string, identical char for char.
    const attrs = buildAttributes({ buildSha: SHA_40, deviceClass: 'tablet' });
    expect(attrs.build_sha).toBe(SHA_40);
    expect(attrs.device_class).toBe('tablet');
  });

  it('T-34b-identity: a 64-hex Identity-shaped sha is REJECTED on length (41 too, 40 accepted)', () => {
    // AM11 upper edge + OBS-35. A build sha and an Identity hex are the same alphabet; only the
    // LENGTH bound separates them. An impl with `>= 7` and no ceiling ships the Identity.
    expect(buildAttributes({ buildSha: IDENTITY_64 })).toEqual({});
    expect(buildAttributes({ buildSha: SHA_41 })).toEqual({});
    expect(buildAttributes({ buildSha: SHA_40 })).toEqual({ build_sha: SHA_40 });
  });

  it('T-34b-zone: the zone value is String(zoneId) and 5-digit / negative / non-integer are dropped', () => {
    // WRONG IMPL KILLED (1): `Number.isInteger(zoneId)` as the whole guard — 12345 passes it and
    //   fails Alloy's `{1,4}`, so the point silently loses its zone label.
    // WRONG IMPL KILLED (2): zero-padding or `.toFixed()` formatting — '0000' and '0.0' are both
    //   rejected by the ingest AND are a different series key than the server's zone id.
    expect(buildAttributes({ zoneId: 0 }).zone_id).toBe('0');
    expect(buildAttributes({ zoneId: 42 }).zone_id).toBe('42');
    expect(buildAttributes({ zoneId: 9999 }).zone_id).toBe('9999');
    for (const bad of [10000, 12345, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(buildAttributes({ zoneId: bad }), `zoneId=${String(bad)} must be omitted`).toEqual({});
    }
  });

  it('T-34b-hostile: over a hostile corpus, every key is either ABSENT or an exact valid echo', () => {
    // The generalisation of every fixture above, stated as the rule the implementation must
    // obey rather than as a list of samples. Corpus: an Identity hex, UTF-8 player text, an
    // injection-shaped value, the buildInfo 'unknown' fallback, edge-length shas, arbitrary
    // strings from fast-check.
    // WRONG IMPL KILLED: "let Alloy filter it" in ANY form — pass-through of an unvalidated
    // string, a fallback default ('unknown' / 'na' / '0') substituted for an invalid value
    // (which mints a real, wrong series), or a truncation to fit the bound.
    const hostile = fc.oneof(
      fc.string(),
      fc.constantFrom(
        IDENTITY_64,
        SHA_41,
        SHA_40,
        SHA_7,
        'unknown',
        'Drew',
        'デスクトップ',
        '1;drop',
        'desktop',
        'Desktop',
        'mobile',
        'tablet',
        'tv',
        '',
        ' ',
      ),
    );

    fc.assert(
      fc.property(hostile, hostile, fc.integer({ min: -20, max: 20010 }), (sha, dev, zone) => {
        const attrs = buildAttributes({ buildSha: sha, deviceClass: dev, zoneId: zone });

        // (a) no key outside the allowlist, ever.
        for (const key of Object.keys(attrs)) {
          expect(
            ALLOWED_KEYS.includes(key),
            `unexpected attribute key ${JSON.stringify(key)}`,
          ).toBe(true);
        }

        // (b) presence is EXACTLY the predicate's verdict, and the value is the untouched input.
        expect(Object.hasOwn(attrs, 'build_sha')).toBe(isValidBuildSha(sha));
        if (isValidBuildSha(sha)) expect(attrs.build_sha).toBe(sha);

        expect(Object.hasOwn(attrs, 'device_class')).toBe(isValidDeviceClass(dev));
        if (isValidDeviceClass(dev)) expect(attrs.device_class).toBe(dev);

        // (c) zone: present iff its decimal rendering is 1-4 ASCII digits, and equal to it.
        const zoneOk = zone >= 0 && zone <= 9999;
        expect(Object.hasOwn(attrs, 'zone_id')).toBe(zoneOk);
        if (zoneOk) expect(attrs.zone_id).toBe(String(zone));

        // (d) always frozen — including on the degenerate all-invalid path.
        expect(Object.isFrozen(attrs)).toBe(true);
      }),
      { seed: 20250809, numRuns: 600 },
    );
  });
});

describe('buildAttributes (AM1): the zone-switch rebuild path', () => {
  it('AM1-rebuild: a new zoneId yields a NEW frozen object with the new zone_id', () => {
    // AM1: zone_id must TRACK zone switches. The façade rebuilds the attribute object on
    // `setZone`, so the builder must be callable again and must not memoise on first call.
    // WRONG IMPL KILLED (1): a module-scope singleton computed once at import (a "global mutable
    //   meter" in miniature, plan anti-pattern 6) — the second call would return zone 0 forever
    //   and every post-warp datapoint would be attributed to the starting zone.
    // WRONG IMPL KILLED (2): MUTATING the previous object in place. The old object is already
    //   frozen, so the mutation would silently no-op (or throw inside the telemetry try/catch),
    //   and the identity tooth in telemetry.test.ts would see a stale reference.
    const first = buildAttributes({ ...VALID, zoneId: 0 });
    const second = buildAttributes({ ...VALID, zoneId: 1 });

    expect(first.zone_id).toBe('0');
    expect(second.zone_id).toBe('1');
    expect(second).not.toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    // The non-zone dimensions are unchanged by a zone switch.
    expect(second.build_sha).toBe(first.build_sha);
    expect(second.device_class).toBe(first.device_class);
  });
});
