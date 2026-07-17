// ui/leaderboardModel.test.ts — RED gating tests for m17b §RL-13 + §RL-15.
//
// Slice: m17b · Source-of-truth spec: M17-ranked-ladder.spec.md §RL-13 / §RL-15
//
// RED REASON: leaderboardModel.ts does not exist yet.
// Every test below will fail with:
//   "Failed to resolve import './leaderboardModel'" (module-not-found)
//
// WRONG-IMPL-KILLED list (one per criterion):
//   - "rating desc sort omitted"          → sort-order tests catch it
//   - "tie-break on displayName not name" → case-sensitivity + empty-name tests catch it
//   - "no identity tie-break"             → three-way tie test catches it
//   - "in-place sort of input array"      → frozen-array + determinism tests catch it
//   - "locale-compare instead of code-unit" → 'Bob' < 'alice' case-sensitivity test catches it
//   - "isOwn uses displayName not identity" → isOwn tests catch it
//   - "empty identity always marks own"   → identity-'' test catches it
//   - "isEmpty not computed"              → isEmpty tests catch it
//   - "comparator overflow for i32 extremes" → extremes test catches it
//   - "wins/losses dropped"               → passthrough tests catch it
//   - "module_bindings imported"          → RL-15 source-scan catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.
// Corrections must be traced to the spec and must not weaken the bite.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StoreProfile } from '../net/store';
import {
  buildLeaderboardViewModel,
  type LeaderboardRowViewModel,
  type LeaderboardViewModel,
} from './leaderboardModel';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeProfile(
  identity: string,
  rating: number,
  name: string,
  wins = 0,
  losses = 0,
): StoreProfile {
  return { identity, name, rating, wins, losses };
}

// ---------------------------------------------------------------------------
// RL-13: sort + display
// ---------------------------------------------------------------------------

describe('RL13-sort: buildLeaderboardViewModel sorts by rating descending', () => {
  it('RL13-sort-01 BITES: higher rating appears first — kills an impl with ascending sort or no sort', () => {
    // Kills: sort ascending (b.rating - a.rating reversed), no sort (insertion order).
    const profiles: StoreProfile[] = [
      makeProfile('aaa', 1000, 'Alice'),
      makeProfile('bbb', 1200, 'Bob'),
      makeProfile('ccc', 900, 'Carol'),
    ];
    const vm = buildLeaderboardViewModel(profiles, '');
    expect(vm.rows[0]!.rating).toBe(1200);
    expect(vm.rows[1]!.rating).toBe(1000);
    expect(vm.rows[2]!.rating).toBe(900);
  });

  it('RL13-sort-02 BITES: a single-element list keeps that one element at index 0', () => {
    // Kills: an impl that returns an empty array for length-1 inputs.
    const vm = buildLeaderboardViewModel([makeProfile('aaa', 1500, 'Alice')], '');
    expect(vm.rows).toHaveLength(1);
    expect(vm.rows[0]!.rating).toBe(1500);
  });
});

describe('RL13-tiebreak-name: equal rating → tie-break by raw name ascending, code-unit, case-sensitive', () => {
  it('RL13-name-01 BITES: "Bob" (B=66) < "alice" (a=97) at equal rating — kills localeCompare, toLower, or comparator-on-displayName', () => {
    // Spec: raw name asc, code-unit, case-sensitive; localeCompare('Bob','alice') gives
    // locale-dependent result that varies by platform and treats 'B' > 'a' in en-US.
    // Code-unit comparison: 'B'.charCodeAt(0)=66 < 'a'.charCodeAt(0)=97 → 'bbb' row first.
    // Assert identityHex (not displayName) so a comparator-on-displayName mutant is killed:
    // displayName equals raw name for non-empty names, so a displayName-comparator produces
    // the same displayName order but the identityHex assertion proves which profile won
    // the tiebreak regardless of how the comparator is expressed.
    // Kills: localeCompare / Intl / toLowerCase / comparator-on-displayName.
    const profiles: StoreProfile[] = [
      makeProfile('aaa', 1000, 'alice'),
      makeProfile('bbb', 1000, 'Bob'),
    ];
    const vm = buildLeaderboardViewModel(profiles, '');
    // 'Bob' (B=66) sorts before 'alice' (a=97) by code-unit → 'bbb' identity first
    expect(vm.rows[0]!.identityHex).toBe('bbb');
    expect(vm.rows[1]!.identityHex).toBe('aaa');
    // Confirm displayName matches raw name (non-empty names never use fallback)
    expect(vm.rows[0]!.displayName).toBe('Bob');
    expect(vm.rows[1]!.displayName).toBe('alice');
  });

  it('RL13-name-02 BITES: "Alice" < "alice" at equal rating (uppercase before lower, code-unit) — kills comparator-on-displayName', () => {
    // 'A'(65) < 'a'(97): profile 'bbb' (name='Alice') must sort before 'aaa' (name='alice').
    // Assert identityHex: a comparator-on-displayName mutant produces the same displayName
    // ordering here (displayName === name), so only identityHex independently kills it.
    // Kills: case-insensitive comparison, comparator-on-displayName.
    const profiles: StoreProfile[] = [
      makeProfile('aaa', 1000, 'alice'),
      makeProfile('bbb', 1000, 'Alice'),
    ];
    const vm = buildLeaderboardViewModel(profiles, '');
    // 'Alice' (A=65) < 'alice' (a=97) → 'bbb' identity first
    expect(vm.rows[0]!.identityHex).toBe('bbb');
    expect(vm.rows[1]!.identityHex).toBe('aaa');
    expect(vm.rows[0]!.displayName).toBe('Alice');
    expect(vm.rows[1]!.displayName).toBe('alice');
  });

  it('RL13-name-03 BITES: "Z" < "a" code-unit (Z=90 < a=97) — all uppercase before all lowercase; kills comparator-on-displayName', () => {
    // 'Z'(90) < 'z'(122): profile 'bbb' (name='Zulu') must sort before 'aaa' (name='zebra').
    // localeCompare puts 'Z' after 'a' in many locales. identityHex assertion kills it AND
    // the comparator-on-displayName mutant.
    // Kills: localeCompare, comparator-on-displayName.
    const profiles: StoreProfile[] = [
      makeProfile('aaa', 500, 'zebra'),
      makeProfile('bbb', 500, 'Zulu'),
    ];
    const vm = buildLeaderboardViewModel(profiles, '');
    // 'Zulu' (Z=90) < 'zebra' (z=122) by first code-unit → 'bbb' first
    expect(vm.rows[0]!.identityHex).toBe('bbb');
    expect(vm.rows[1]!.identityHex).toBe('aaa');
    expect(vm.rows[0]!.displayName).toBe('Zulu');
    expect(vm.rows[1]!.displayName).toBe('zebra');
  });
});

describe('RL13-tiebreak-identity: equal rating AND equal name → tie-break by identityHex ascending', () => {
  it('RL13-id-01 BITES: three-way tie uses identity as final tiebreak — kills no-identity-tiebreak impl', () => {
    // Kills: an impl that only has a two-level comparator (rating, name) and leaves
    // identity-tied entries in arbitrary/insertion order (non-deterministic).
    const profiles: StoreProfile[] = [
      makeProfile('ccc', 1000, 'Same'),
      makeProfile('aaa', 1000, 'Same'),
      makeProfile('bbb', 1000, 'Same'),
    ];
    const vm = buildLeaderboardViewModel(profiles, '');
    expect(vm.rows[0]!.identityHex).toBe('aaa');
    expect(vm.rows[1]!.identityHex).toBe('bbb');
    expect(vm.rows[2]!.identityHex).toBe('ccc');
  });
});

describe('RL13-determinism: any input order produces identical output', () => {
  it('RL13-det-01 BITES: reversed input order produces the same rows array — kills in-place-sort impl', () => {
    // Kills: an impl that sorts in-place and the result depends on input order
    // (e.g. an unstable sort that gives different results for equal-key elements
    // in different input orders — the three-level comparator makes this a total order).
    const forward: StoreProfile[] = [
      makeProfile('aaa', 1200, 'Alice'),
      makeProfile('bbb', 1000, 'Bob'),
      makeProfile('ccc', 800, 'Carol'),
    ];
    const reversed: StoreProfile[] = [
      makeProfile('ccc', 800, 'Carol'),
      makeProfile('bbb', 1000, 'Bob'),
      makeProfile('aaa', 1200, 'Alice'),
    ];
    const vmF = buildLeaderboardViewModel(forward, '');
    const vmR = buildLeaderboardViewModel(reversed, '');
    expect(vmF.rows).toEqual(vmR.rows);
  });

  it('RL13-det-02 BITES: fixed permuted input produces identical rows to original — total-order check', () => {
    // Fixed permutation (no RNG): indices [2,0,3,1] applied to a 4-element array.
    // Kills: a comparator that is not a total order (non-transitive), producing
    // different sort results depending on the algorithm's pivot choices.
    const base: StoreProfile[] = [
      makeProfile('aaa', 1100, 'Alice'),
      makeProfile('bbb', 1100, 'Bob'),
      makeProfile('ccc', 900, 'Carol'),
      makeProfile('ddd', 900, 'Dave'),
    ];
    // Fixed permutation [2, 0, 3, 1]:
    const permuted: StoreProfile[] = [base[2]!, base[0]!, base[3]!, base[1]!];
    const vmBase = buildLeaderboardViewModel(base, '');
    const vmPerm = buildLeaderboardViewModel(permuted, '');
    expect(vmPerm.rows).toEqual(vmBase.rows);
  });
});

describe('RL13-emptyname: empty name → displayName is "#" + identityHex.slice(0,8); tiebreak uses raw name', () => {
  it('RL13-empty-01 BITES: empty name shows "#<hex8>" as displayName — kills no-fallback impl', () => {
    // Kills: an impl that passes '' as displayName for empty-name profiles.
    const vm = buildLeaderboardViewModel([makeProfile('deadbeefcafe1234', 1000, '')], '');
    expect(vm.rows[0]!.displayName).toBe('#deadbeef'); // first 8 chars of identityHex
  });

  it('RL13-empty-02 BITES: empty name sorts BEFORE any non-empty name at equal rating (raw-name tiebreak)', () => {
    // The tiebreak uses the RAW empty string '' — not the '#deadbeef' fallback.
    // ''  (code-unit 0 at first char) < 'A' (65) in JS string comparison.
    // Kills: an impl that compares displayName ('#deadbeef') instead of raw name ('')
    // in the comparator — '#' is code-unit 35, which is less than letters, so the
    // sort would still put '#deadbeef' first. But the CORRECT kill is: if the
    // identity-matching player has a short hex prefix that sorts AFTER 'A', e.g.
    // 'aaa...' → '#aaaaaaaa', '#'(35) < 'A'(65) → still first, no difference.
    // Use identity 'zzz...' → '#zzzzzzzz', '#'(35) < 'A'(65) → STILL first.
    // The only way to distinguish is: raw '' < any non-empty name; but '#...' may
    // have '#'(35) which also sorts before letters. To make the test bite:
    // compare displayName-sort vs raw-sort on a name that starts with '!' (33):
    // If tiebreak is on displayName '#aaa...' (35), '!' (33) < '#' (35) → '!' wins.
    // If tiebreak is on raw name '' < '!' → '' wins. Pin this scenario.
    const profiles: StoreProfile[] = [
      makeProfile('aaa00000', 1000, '!'), // name='!' displayName='!'
      makeProfile('bbb00000', 1000, ''), // name='' displayName='#bbb00000'
    ];
    const vm = buildLeaderboardViewModel(profiles, '');
    // Raw empty '' < '!' → empty-name profile at index 0
    expect(vm.rows[0]!.identityHex).toBe('bbb00000'); // empty name sorts first (raw)
    expect(vm.rows[1]!.identityHex).toBe('aaa00000'); // '!' sorts after ''
    expect(vm.rows[0]!.displayName).toBe('#bbb00000'); // but displays the fallback
  });
});

describe('RL13-isown: isOwn flag', () => {
  it('RL13-own-01 BITES: exactly the row matching viewer identity has isOwn=true — kills all-false impl', () => {
    // Kills: an impl that never sets isOwn=true (e.g. identity comparison missing).
    const profiles: StoreProfile[] = [
      makeProfile('alice', 1200, 'Alice'),
      makeProfile('bob', 1000, 'Bob'),
      makeProfile('carol', 800, 'Carol'),
    ];
    const vm = buildLeaderboardViewModel(profiles, 'bob');
    const own = vm.rows.filter((r) => r.isOwn);
    expect(own).toHaveLength(1);
    expect(own[0]!.identityHex).toBe('bob');
  });

  it('RL13-own-02 BITES: all non-own rows have isOwn=false — kills all-true impl', () => {
    // Kills: an impl that sets isOwn=true for all rows.
    const profiles: StoreProfile[] = [
      makeProfile('alice', 1200, 'Alice'),
      makeProfile('bob', 1000, 'Bob'),
    ];
    const vm = buildLeaderboardViewModel(profiles, 'alice');
    const notOwn = vm.rows.filter((r) => !r.isOwn);
    expect(notOwn).toHaveLength(1);
    expect(notOwn[0]!.identityHex).toBe('bob');
    expect(notOwn[0]!.isOwn).toBe(false);
  });

  it('RL13-own-03 BITES: viewer identity "" → every row isOwn=false — kills identity-equality-absent impl', () => {
    // Kills: an impl that compares identity against '' and treats first-row as own,
    // or that never initializes isOwn and it defaults to undefined/truthy.
    const profiles: StoreProfile[] = [
      makeProfile('alice', 1200, 'Alice'),
      makeProfile('bob', 1000, 'Bob'),
    ];
    const vm = buildLeaderboardViewModel(profiles, '');
    for (const row of vm.rows) {
      expect(row.isOwn).toBe(false);
    }
  });
});

describe('RL13-empty: empty input → isEmpty=true; non-empty → isEmpty=false', () => {
  it('RL13-isEmpty-01 BITES: empty profiles array → { rows:[], isEmpty:true } — kills hardcoded-false impl', () => {
    // Kills: an impl that always returns isEmpty:false, or that returns rows.length > 0 for [].
    const vm = buildLeaderboardViewModel([], '');
    expect(vm.rows).toHaveLength(0);
    expect(vm.isEmpty).toBe(true);
  });

  it('RL13-isEmpty-02 BITES: non-empty profiles → isEmpty=false — kills hardcoded-true impl', () => {
    // Kills: an impl that always returns isEmpty:true.
    const vm = buildLeaderboardViewModel([makeProfile('aaa', 1000, 'Alice')], '');
    expect(vm.isEmpty).toBe(false);
  });
});

describe('RL13-immutable: input array is not mutated', () => {
  it('RL13-mut-01 BITES: frozen input does not throw; original order preserved — kills in-place-sort impl', () => {
    // Kills: an impl that calls profiles.sort() directly on the input (throws on frozen array).
    const profiles: readonly StoreProfile[] = Object.freeze([
      makeProfile('ccc', 800, 'Carol'),
      makeProfile('aaa', 1200, 'Alice'),
      makeProfile('bbb', 1000, 'Bob'),
    ]);
    // Must not throw (TOTAL model requirement — plan D2).
    expect(() => buildLeaderboardViewModel(profiles, '')).not.toThrow();
    // Original frozen array order must be undisturbed.
    expect(profiles[0]!.identity).toBe('ccc');
    expect(profiles[1]!.identity).toBe('aaa');
    expect(profiles[2]!.identity).toBe('bbb');
    // Result must still be sorted correctly.
    const vm = buildLeaderboardViewModel(profiles, '');
    expect(vm.rows[0]!.identityHex).toBe('aaa'); // rating 1200
    expect(vm.rows[1]!.identityHex).toBe('bbb'); // rating 1000
    expect(vm.rows[2]!.identityHex).toBe('ccc'); // rating 800
  });
});

describe('RL13-extremes: i32 min/max ratings sort correctly without overflow', () => {
  it('RL13-ext-01 BITES: i32 MAX (2147483647) before MIN (-2147483648) — kills subtraction-overflow impl', () => {
    // Comparator `b.rating - a.rating`: if ratings are treated as 32-bit integers
    // in C, 2147483647 - (-2147483648) overflows. In JS numbers are f64 so this
    // specific case fits (diff = 4294967295 < 2^53). The test pins the CORRECT
    // descending order so any comparator sign inversion is caught.
    // Kills: `a.rating - b.rating` (ascending) or `Math.sign(b-a) overflow` shim.
    const profiles: StoreProfile[] = [
      makeProfile('bbb', -2147483648, 'Min'),
      makeProfile('aaa', 2147483647, 'Max'),
    ];
    const vm = buildLeaderboardViewModel(profiles, '');
    expect(vm.rows[0]!.identityHex).toBe('aaa'); // MAX rating first (descending)
    expect(vm.rows[0]!.rating).toBe(2147483647);
    expect(vm.rows[1]!.identityHex).toBe('bbb'); // MIN rating second
    expect(vm.rows[1]!.rating).toBe(-2147483648);
  });
});

describe('RL13-passthrough: wins and losses carried unchanged', () => {
  it('RL13-wl-01 BITES: wins and losses from StoreProfile appear on the ViewModel row — kills drop impl', () => {
    // Kills: an impl that constructs LeaderboardRowViewModel without wins/losses.
    const vm = buildLeaderboardViewModel([makeProfile('aaa', 1000, 'Alice', 42, 7)], '');
    expect(vm.rows[0]!.wins).toBe(42);
    expect(vm.rows[0]!.losses).toBe(7);
  });

  it('RL13-wl-02 BITES: zero wins/losses are preserved (not treated as falsy/absent)', () => {
    // Kills: an impl that defaults wins/losses to undefined when the value is 0.
    const vm = buildLeaderboardViewModel([makeProfile('aaa', 1000, 'Alice', 0, 0)], '');
    expect(vm.rows[0]!.wins).toBe(0);
    expect(vm.rows[0]!.losses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RL-15 structural tooth: leaderboardModel.ts must NOT import from module_bindings
// or call any reducer/connection — pure subscription model (ADR-0014).
// ---------------------------------------------------------------------------

describe('RL15-structural: leaderboardModel.ts source contains no server write paths', () => {
  it('RL15-model-scan BITES: source does not reference module_bindings, reducers, or conn — kills any write-path impl', () => {
    // This is the client-side RL-15 mirror; the server-side teeth live in m17c's
    // ranking-security eval. A leaderboardModel.ts that imports from module_bindings
    // or calls reducers violates ADR-0014 (pure subscription view) and RL-15.
    // Uses .includes() — no dynamic RegExp (eslint ReDoS ban).
    // fileURLToPath: robust against percent-encoding in import.meta.url (m17b req #5).
    const modelPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'leaderboardModel.ts',
    );
    let src: string;
    try {
      src = readFileSync(modelPath, 'utf8');
    } catch (err) {
      // File must exist post-impl. Throw so the test is RED (not vacuously-green)
      // until the implementer ships leaderboardModel.ts (m16.5a vacuous-revival-gate
      // precedent: catch { return; } is a vacuous-pass hole).
      throw new Error(
        'leaderboard source could not be read — post-impl the file must exist: ' + String(err),
      );
    }
    const forbidden = [
      'module_bindings',
      '.reducers',
      'reducers.',
      'conn.conn',
      'DbConnection',
      // set_profile_name is the only profile-write reducer the spec acknowledges
      // (ADR-0119 D6). Transitive-import indirection is out of scope for this scan
      // (review-caught), but a direct reference here is a clear RL-15 violation.
      'set_profile_name',
    ];
    for (const needle of forbidden) {
      expect(
        src.includes(needle),
        `leaderboardModel.ts must not contain "${needle}" (RL-15: pure subscription view, no write path)`,
      ).toBe(false);
    }
  });
});
