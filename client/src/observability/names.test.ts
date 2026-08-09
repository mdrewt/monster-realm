// observability/names.test.ts — m20c (ADR-0180 body amendment): the S4 wire contract, client side.
//
// SOURCE OF TRUTH (mirrored fixture-for-fixture, never re-derived):
//   ops/observability/alloy/config.alloy:155-158
//     keep_matching_keys(attributes, "^(zone_id|build_sha|device_class)$")
//     delete_key(attributes, "zone_id")      where not IsMatch(…, "^[0-9]{1,4}$")
//     delete_key(attributes, "build_sha")    where not IsMatch(…, "^[0-9a-f]{7,40}$")
//     delete_key(attributes, "device_class") where not IsMatch(…, "^(desktop|mobile|tablet)$")
//   ops/observability/rules/recording.rules.yml:69 — `mr_client_fps_bucket` verbatim.
//
// WHY THIS FILE EXISTS: the client must never ship a datapoint attribute Alloy is going to
// delete. A value that Alloy strips does not "degrade gracefully" — it collapses the point into
// the unlabelled series, which silently corrupts every per-zone/per-build panel while the client
// believes it is reporting. So names.ts owns ONE mirror of the ingest policy and these fixtures
// pin that mirror to the ops file, character for character.
//
// RED REASON: `client/src/observability/names.ts` does not exist. Every import below fails to
// resolve until the implementer creates it — that is the expected first red.
//
// NO `new RegExp(…)` AND NO REGEX LITERAL in the implementation (AM21/T-A2, enforced by
// sourceScan.test.ts): the predicates must be hand-rolled character scans. Semgrep's
// detect-non-literal-regexp is banned repo-wide, and a second regex engine (JS vs Go/RE2) is a
// second policy that drifts from the first.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ATTR_KEYS,
  isValidBuildSha,
  isValidDeviceClass,
  isValidZoneId,
  METRIC_FPS,
  METRIC_FRAME_TIME_MAX_MS,
  METRIC_INTENT_REJECT,
  METRIC_INTERP_GAP_MS,
  METRIC_RECONCILE,
  METRIC_RECONCILE_CORRECTION,
  METRIC_REDUCER_RTT_MS,
  METRIC_WASM_READY_MS,
} from './names';

/** 40 lowercase hex chars — the UPPER edge of Alloy's `{7,40}` bound (AM11). */
const SHA_40 = '0123456789abcdef0123456789abcdef01234567';
/** 41 chars — one past the bound; must be REJECTED, not truncated (AM11). */
const SHA_41 = `${SHA_40}8`;
/** A 64-hex string is what a SpacetimeDB Identity hex looks like. It must be rejected by the
 *  sha predicate as a matter of LENGTH — a second, independent line of defence behind
 *  T-35a's "the word `identity` appears nowhere in observability/*.ts". */
const IDENTITY_64 = `${SHA_40}89abcdef0123456789abcdef`;

describe('names.ts (OBS-25): the metric names are the recording-rule contract', () => {
  it('T-25a-name: the fps metric is EXACTLY `mr_client_fps` (recording.rules.yml:69 depends on it)', () => {
    // WRONG IMPL KILLED (1): a rename (`mr_client_fps_hz`, `client_fps`, `mr.client.fps`).
    //   recording.rules.yml records `histogram_quantile(0.5, … rate(mr_client_fps_bucket[5m]))`;
    //   any other name makes the OBS-25 SLO panel a permanent `vector(0)` — GREEN-looking, and
    //   measuring nothing. The rule file is out of this slice's touch-set, so the client is the
    //   side that must conform.
    // WRONG IMPL KILLED (2): a unit suffix baked into the NAME here (`mr_client_fps_ratio`) —
    //   the `_bucket` suffix Prometheus appends must land directly on this string.
    expect(METRIC_FPS).toBe('mr_client_fps');
    expect(
      `${METRIC_FPS}_bucket`,
      'Prometheus appends `_bucket` to a histogram; recording.rules.yml:69 reads exactly ' +
        '`mr_client_fps_bucket`. If this is not that string, the OBS-25 p50 SLO records an ' +
        'empty series forever.',
    ).toBe('mr_client_fps_bucket');
  });

  it('T-25a-set: all eight signal names are the exact snake_case `mr_client_*` strings', () => {
    // WRONG IMPL KILLED: dotted OTel-style names (`mr.client.fps`). Alloy's prometheus exporter
    // would rewrite the dots to underscores, so the client would "work" while the names it
    // believes it emits and the names Prometheus stores differ — every dashboard query written
    // from the client source would then be wrong.
    expect([
      METRIC_FPS,
      METRIC_FRAME_TIME_MAX_MS,
      METRIC_RECONCILE,
      METRIC_RECONCILE_CORRECTION,
      METRIC_INTENT_REJECT,
      METRIC_INTERP_GAP_MS,
      METRIC_REDUCER_RTT_MS,
      METRIC_WASM_READY_MS,
    ]).toEqual([
      'mr_client_fps',
      'mr_client_frame_time_max_ms',
      'mr_client_reconcile',
      'mr_client_reconcile_correction',
      'mr_client_intent_reject',
      'mr_client_interp_gap_ms',
      'mr_client_reducer_rtt_ms',
      'mr_client_wasm_ready_ms',
    ]);
  });
});

describe('names.ts (OBS-34): ATTR_KEYS is the Alloy keep_matching_keys allowlist, exactly', () => {
  it('T-34a-keys: ATTR_KEYS is set-EQUAL to {zone_id, build_sha, device_class} — never a superset', () => {
    // WRONG IMPL KILLED (1): a fourth key (`player_name`, `session_id`, `identity`). Alloy drops
    //   it, so nothing breaks visibly — but the client has already put it on the wire, which is
    //   the OBS-34/35 violation itself (the criterion is about what LEAVES the browser, not
    //   about what Prometheus stores).
    // WRONG IMPL KILLED (2): a MISSING key — `.includes`-style assertions cannot see that, which
    //   is why this is a sorted exact-equality (anti-pattern 9 in the plan).
    expect([...ATTR_KEYS].sort()).toEqual(['build_sha', 'device_class', 'zone_id']);
  });
});

describe('names.ts (T-A1): the value predicates mirror config.alloy:156-158 fixture-for-fixture', () => {
  // Each row is [input, expected]. The rows are chosen to be exactly the strings that
  // distinguish a correct mirror from the four ways a hand-rolled scan usually goes wrong:
  // trimming, case-folding, prefix/suffix matching, and off-by-one length bounds.
  const ZONE_FIXTURES: ReadonlyArray<readonly [string, boolean]> = [
    ['0', true], // lower edge — a `parseInt(x) > 0` impl reds here
    ['9', true],
    ['42', true],
    ['9999', true], // upper edge, 4 digits
    ['10000', false], // 5 digits — `{1,4}` rejects; a `Number.isInteger` impl accepts (KILLED)
    ['-1', false], // sign is not in [0-9]
    ['+1', false],
    ['', false], // `{1,4}` requires at least one digit
    [' 1', false], // a trimming impl accepts this (KILLED) — Alloy does not trim
    ['1 ', false],
    ['1\n', false], // Go's default `$` is end-of-TEXT; a trailing newline is not accepted
    ['1.0', false],
    ['0x1', false],
    ['1;drop', false], // hostile: the injection-shaped value from the T-34b corpus
    ['１', false], // fullwidth digit — `[0-9]` is ASCII-only; a `Number()` impl accepts (KILLED)
    ['1e3', false],
  ];

  const SHA_FIXTURES: ReadonlyArray<readonly [string, boolean]> = [
    ['a1b2c3d', true], // 7 chars — the lower edge of `{7,40}`
    ['0000000', true],
    [SHA_40, true], // 40 chars — the upper edge (AM11)
    [SHA_41, false], // 41 chars — one past (AM11); a `>= 7` impl with no ceiling accepts (KILLED)
    [IDENTITY_64, false], // an Identity hex is 64 chars — rejected on length
    ['a1b2c3', false], // 6 chars — one short
    ['A1B2C3D', false], // uppercase — `[0-9a-f]` is lowercase-only; a case-folding impl accepts
    ['a1b2c3D', false], // mixed case, only the last char wrong — kills a first-char-only scan
    ['g1b2c3d', false], // 'g' is not hex
    ['unknown', false], // buildInfo.ts:44-48 fallback (AM20) — 7 chars, so LENGTH alone passes
    ['', false],
    [' a1b2c3d', false],
    ['a1b2c3d ', false],
  ];

  const DEVICE_FIXTURES: ReadonlyArray<readonly [string, boolean]> = [
    ['desktop', true],
    ['mobile', true],
    ['tablet', true],
    ['Desktop', false], // case-sensitive — a `.toLowerCase()` impl accepts (KILLED)
    ['DESKTOP', false],
    ['tv', false],
    ['', false],
    ['desktop ', false],
    [' desktop', false],
    ['desktopx', false], // kills a `startsWith` impl
    ['xdesktop', false], // kills an `includes` impl
    ['mobil', false],
    ['desktop|mobile', false],
  ];

  it('T-A1a: isValidZoneId mirrors `^[0-9]{1,4}$`', () => {
    for (const [input, expected] of ZONE_FIXTURES) {
      expect(isValidZoneId(input), `isValidZoneId(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it('T-A1b: isValidBuildSha mirrors `^[0-9a-f]{7,40}$` (40 accept / 41 reject — AM11)', () => {
    for (const [input, expected] of SHA_FIXTURES) {
      expect(isValidBuildSha(input), `isValidBuildSha(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it('T-A1c: isValidDeviceClass mirrors `^(desktop|mobile|tablet)$`', () => {
    for (const [input, expected] of DEVICE_FIXTURES) {
      expect(isValidDeviceClass(input), `isValidDeviceClass(${JSON.stringify(input)})`).toBe(
        expected,
      );
    }
  });

  it('T-A1d: every predicate is TOTAL and returns a real boolean for arbitrary hostile text', () => {
    // WRONG IMPL KILLED: a predicate that returns a truthy NON-boolean (the classic
    // `return s.length >= 7 && s` / `return s.match(...)` shape). Downstream, `if (ok)` still
    // behaves — until the value is serialised or compared with `=== true`. Pinning the TYPE is
    // what makes "omit the key" mechanically reliable in attributes.ts.
    // Also kills a predicate that throws on an exotic input (lone surrogates, NUL, emoji).
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(typeof isValidZoneId(s)).toBe('boolean');
        expect(typeof isValidBuildSha(s)).toBe('boolean');
        expect(typeof isValidDeviceClass(s)).toBe('boolean');
      }),
      { seed: 20250809, numRuns: 500 },
    );
  });

  it('T-A1e: a valid zone id is exactly 1-4 ASCII digits — proven over generated strings', () => {
    // The property states the RULE, not a sample of it: any string of 1-4 ASCII digits is
    // accepted, and any string containing a non-digit is rejected regardless of length.
    // WRONG IMPL KILLED: a length-only check (`s.length <= 4`) — 'abcd' would pass it.
    const digits = fc.stringOf(fc.constantFrom('0', '1', '5', '9'), { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(digits, (s) => {
        expect(isValidZoneId(s)).toBe(true);
      }),
      { seed: 20250809, numRuns: 200 },
    );

    const tooLong = fc.stringOf(fc.constantFrom('0', '7'), { minLength: 5, maxLength: 12 });
    fc.assert(
      fc.property(tooLong, (s) => {
        expect(isValidZoneId(s)).toBe(false);
      }),
      { seed: 20250809, numRuns: 200 },
    );
  });

  it('T-A1f: a valid build sha is 7-40 LOWERCASE hex chars — proven over generated strings', () => {
    // WRONG IMPL KILLED: an impl that accepts uppercase hex (a `toLowerCase()` before the scan).
    // Alloy would delete such a key, so the client would ship a doomed label.
    const hexChar = fc.constantFrom('0', '3', '9', 'a', 'c', 'f');
    const okSha = fc.stringOf(hexChar, { minLength: 7, maxLength: 40 });
    fc.assert(
      fc.property(okSha, (s) => {
        expect(isValidBuildSha(s)).toBe(true);
      }),
      { seed: 20250809, numRuns: 300 },
    );

    const upperHex = fc.constantFrom('A', 'B', 'C', 'D', 'E', 'F');
    const badSha = fc
      .tuple(fc.stringOf(hexChar, { minLength: 6, maxLength: 39 }), upperHex)
      .map(([body, upper]) => `${body}${upper}`);
    fc.assert(
      fc.property(badSha, (s) => {
        expect(isValidBuildSha(s)).toBe(false);
      }),
      { seed: 20250809, numRuns: 300 },
    );
  });

  it('T-A1g: isValidDeviceClass accepts the three literals and NOTHING else', () => {
    // WRONG IMPL KILLED: a `Set`-membership check built from a wider list (e.g. one that also
    // carries 'tv' or 'console' "for later"). Alloy's allowlist is closed; so is this one.
    fc.assert(
      fc.property(fc.string(), (s) => {
        const accepted = isValidDeviceClass(s);
        const isLiteral = s === 'desktop' || s === 'mobile' || s === 'tablet';
        expect(accepted).toBe(isLiteral);
      }),
      { seed: 20250809, numRuns: 500 },
    );
  });
});
