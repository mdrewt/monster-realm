// ui/a11yCopy.test.ts — m23-s0 RED gating tests for the flat a11y copy catalog + t(key).
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M23-accessibility.spec.md §2.8, §5.1 [A11Y-04], §6 A11Y-4.
//   docs/adr/0205-overlay-a11y-metadata-ssot-and-copy-catalog.md D4, D5 (BINDING).
//
// RED REASON: `client/src/ui/a11yCopy.ts` DOES NOT EXIST YET. This is a BRAND-NEW spec file, so
// (unlike the appended block in `overlayRegistry.test.ts`) a plain static import here is safe —
// its resolution failure reds only THIS file, never the pre-existing 1078-line
// `overlayRegistry.test.ts` suite. `OVERLAY_A11Y` is likewise not yet exported from
// `overlayRegistry.ts`; importing it here can at worst red every test in this new file, which is
// exactly the desired starting state.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR only.

import { describe, expect, it } from 'vitest';
import { a11yCopy, t } from './a11yCopy';
import { OVERLAY_A11Y, OVERLAY_IDS } from './overlayRegistry';

const A11Y_KEY_SHAPE_RE = /^a11y\.[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*$/;

describe('a11yCopy — the flat copy catalog and the M24 key seam (m23-s0, ADR-0205)', () => {
  it('A11YCOPY-OVERLAY-NAMESPACE-EXACT BITES: the a11y.overlay.* namespace set-equals the keys DERIVED from OVERLAY_IDS, and every labelKey resolves to a non-empty entry', () => {
    // WRONG IMPL KILLED (1) — the ORPHAN-DIRECTION half: a stowaway catalog entry with no
    // referencing `labelKey` (e.g. a leftover `a11y.overlay.ghostView.title` from a deleted
    // overlay). Caught by the `stowawayInCatalog` check below.
    // WRONG IMPL KILLED (2) — the MISSING-DIRECTION half: an `OVERLAY_A11Y` id whose derived key
    // has no catalog entry at all. Caught by the `missingFromCatalog` check below.
    // WRONG IMPL KILLED (3) — the RESOLUTION half, the one red-team actually found: a typo'd
    // `OVERLAY_A11Y.helpView.labelKey = 'a11y.overlay.helpView.titel'` (note: "titel"). The
    // set-equality checks alone NEVER read `.labelKey`, so a typo that still happens to leave
    // BOTH the correctly-spelled catalog entry AND some (unreferenced) stowaway present would
    // sail through set-equality while the real overlay ships with an unresolvable label. This
    // ONE test carries BOTH the set-equality half AND the per-id resolution half so a typo like
    // this cannot hide between two "passing" gates (ADR-0205 D5).
    //
    // SCOPING (ADR-0205 D5) — READ THIS BEFORE "fixing" this test to be stricter: this test
    // deliberately does NOT assert that `a11yCopy` contains ONLY `a11y.overlay.*` keys, and does
    // NOT assert any catalog SIZE ceiling. S1 lands `a11y.world.region` (and more `a11y.world.*`
    // / `a11y.announce.*` keys) the moment it starts; a global "catalog has exactly N keys" or
    // "catalog has ONLY this namespace" check would force S1 to weaken an S0 gate. The check
    // below is filtered to keys starting with `a11y.overlay.` — S0's own namespace — on both
    // sides of the comparison. `a11y.world.*` orphan-checking belongs to S1 (`world.ts`), by the
    // "a namespace is orphan-checked by the slice that owns its consumer" convention (D5).

    // ANTI-VACUITY, ASSERTED FIRST.
    expect(OVERLAY_IDS.length, 'the manifest must hold 17 mutual-exclusion overlays').toBe(17);
    expect(
      Object.keys(a11yCopy as Record<string, unknown>).length > 0,
      'ANTI-VACUITY: a11yCopy must not be empty, or every set-equality check below is vacuous',
    ).toBe(true);

    const derivedKeys = OVERLAY_IDS.map((id) => `a11y.overlay.${id}.title`);
    expect(
      new Set(derivedKeys).size,
      'ANTI-VACUITY: the 17 derived keys must be pairwise distinct',
    ).toBe(17);

    const catalogKeys = Object.keys(a11yCopy as Record<string, unknown>);
    const overlayNamespaceKeys = catalogKeys.filter((k) => k.startsWith('a11y.overlay.'));

    const missingFromCatalog = derivedKeys.filter((k) => !overlayNamespaceKeys.includes(k));
    const stowawayInCatalog = overlayNamespaceKeys.filter((k) => !derivedKeys.includes(k));
    expect(
      missingFromCatalog,
      'these derived `a11y.overlay.<id>.title` keys have NO a11yCopy entry — the overlay would ' +
        'ship with an unresolvable labelKey',
    ).toEqual([]);
    expect(
      stowawayInCatalog,
      'these `a11y.overlay.*` catalog entries are not derivable from any OVERLAY_IDS member — ' +
        'an orphan entry with no referencing labelKey',
    ).toEqual([]);

    // The RESOLUTION half — must live in the SAME test as the set-equality above (see WRONG IMPL
    // KILLED (3)).
    let resolved = 0;
    for (const id of OVERLAY_IDS) {
      const meta = (OVERLAY_A11Y as Record<string, { labelKey?: unknown }> | undefined)?.[id];
      expect(meta, `OVERLAY_A11Y.${id} must exist`).toBeDefined();

      const expectedKey = `a11y.overlay.${id}.title`;
      expect(
        meta?.labelKey,
        `OVERLAY_A11Y.${id}.labelKey must equal the derived key '${expectedKey}' — verbatim, ` +
          'case-preserved (ADR-0205 D5: the id is kept VERBATIM, never kebab-cased)',
      ).toBe(expectedKey);

      const value = (a11yCopy as Record<string, unknown>)[expectedKey];
      expect(typeof value, `a11yCopy['${expectedKey}'] must be a string`).toBe('string');
      expect(
        String(value).trim().length > 0,
        `a11yCopy['${expectedKey}'] must be non-empty after trim`,
      ).toBe(true);
      resolved += 1;
    }
    expect(resolved, 'ANTI-VACUITY: all 17 ids must have been resolved').toBe(17);
  });

  it('A11YCOPY-VALUES-ICU-FREE BITES: every catalog value, regardless of namespace, is non-empty after trim and brace-free', () => {
    // This EXTENDS A11Y-3's key-side ICU ban to the VALUE side by §2.8's general prohibition
    // ("no ICU syntax") — it is not itself a numbered EARS criterion (ADR-0205 D5), but it is
    // core DoD for this slice's copy catalog and is asserted over EVERY key regardless of
    // namespace (unlike the namespace-scoped test above, a brace-in-the-VALUE ban has no future
    // S1 conflict to guard against — no legitimate copy value should ever need `{`/`}`).
    const entries = Object.entries(a11yCopy as Record<string, unknown>);
    expect(entries.length > 0, 'ANTI-VACUITY: a11yCopy must not be empty').toBe(true);

    let checked = 0;
    for (const [key, value] of entries) {
      expect(typeof value, `a11yCopy['${key}'] must be a string`).toBe('string');
      const v = String(value);
      expect(v.trim().length > 0, `a11yCopy['${key}'] must be non-empty after trim`).toBe(true);
      expect(
        v.includes('{'),
        `a11yCopy['${key}'] ('${v}') must not contain '{' — no ICU syntax in the copy (§2.8)`,
      ).toBe(false);
      expect(
        v.includes('}'),
        `a11yCopy['${key}'] ('${v}') must not contain '}' — no ICU syntax in the copy (§2.8)`,
      ).toBe(false);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every catalog entry must have been examined').toBe(
      entries.length,
    );
  });

  it('A11YCOPY-KEYS-SHAPE BITES: every catalog key, regardless of namespace, matches the segment-shaped regex', () => {
    const keys = Object.keys(a11yCopy as Record<string, unknown>);
    expect(keys.length > 0, 'ANTI-VACUITY: a11yCopy must not be empty').toBe(true);

    let checked = 0;
    for (const key of keys) {
      expect(
        A11Y_KEY_SHAPE_RE.test(key),
        `a11yCopy key '${key}' must match ${A11Y_KEY_SHAPE_RE}`,
      ).toBe(true);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: every catalog key must have been examined').toBe(keys.length);
  });

  it('A11YCOPY-T-RESOLVES BITES: t(key) returns the exact catalog value for every present key', () => {
    const keys = Object.keys(a11yCopy as Record<string, unknown>);
    expect(keys.length > 0, 'ANTI-VACUITY: a11yCopy must not be empty').toBe(true);

    let checked = 0;
    for (const key of keys) {
      expect(t(key), `t('${key}') must equal a11yCopy['${key}']`).toBe(
        (a11yCopy as Record<string, unknown>)[key],
      );
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: t() must have been checked against every catalog key').toBe(
      keys.length,
    );
  });

  it('A11YCOPY-T-THROWS-ON-MISS BITES: t(key) THROWS for an absent key, and the thrown message NAMES the missing key', () => {
    // WRONG IMPL KILLED (1): `t = (key) => a11yCopy[key] ?? key` — returning the key itself
    // makes an UNWIRED catalog look wired; a screen-reader user would hear the literal dotted
    // key ("a11y overlay box view title") read aloud instead of a real label (ADR-0205 D4).
    // WRONG IMPL KILLED (2): `t = (key) => a11yCopy[key] ?? ''` — returning '' ships an
    // UNLABELLED dialog, which ADR-0205 D4 calls out as a WORSE WCAG failure than shipping no
    // dialog role at all.
    const missingKey = 'a11y.overlay.__does_not_exist__.title';
    expect(
      Object.hasOwn(a11yCopy, missingKey),
      'test fixture sanity: the probe key must NOT already be a real catalog entry',
    ).toBe(false);

    expect(
      () => t(missingKey),
      `t('${missingKey}') must throw, not return the key itself or an empty string`,
    ).toThrow();

    let thrown: unknown;
    try {
      t(missingKey);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 't(missingKey) must actually throw an Error').toBeInstanceOf(Error);
    expect(
      (thrown as Error).message.includes(missingKey),
      `the thrown Error's message must NAME the missing key ('${missingKey}') — a bare "not ` +
        'found" message would leave the caller unable to tell which key was unwired',
    ).toBe(true);
  });

  it('A11YCOPY-T-IS-PURE BITES: t is pure — it does not mutate a11yCopy, repeated calls are stable, and a miss never adds an entry', () => {
    const before = Object.keys(a11yCopy as Record<string, unknown>).length;
    const sampleKey = Object.keys(a11yCopy as Record<string, unknown>)[0];
    expect(sampleKey, 'ANTI-VACUITY: a11yCopy must have at least one key to sample').toBeDefined();

    const first = t(sampleKey as string);
    const second = t(sampleKey as string);
    expect(second, 'two calls to t() with the same key must return the same value').toBe(first);
    expect(
      Object.keys(a11yCopy as Record<string, unknown>).length,
      't() must not mutate/extend a11yCopy on a hit',
    ).toBe(before);

    const missingKey = 'a11y.overlay.__still_missing__.title';
    try {
      t(missingKey);
    } catch {
      // Expected — this test is about mutation, not the throw itself (see A11YCOPY-T-THROWS-ON-MISS).
    }
    expect(
      Object.keys(a11yCopy as Record<string, unknown>).length,
      't() must not add an entry to a11yCopy after a miss',
    ).toBe(before);
    expect(
      Object.hasOwn(a11yCopy, missingKey),
      'a11yCopy must not gain the missed key as an own property',
    ).toBe(false);
  });

  it('A11YCOPY-T-IGNORES-PROTOTYPE-CHAIN BITES: t rejects inherited Object.prototype members instead of resolving them', () => {
    // The `key in obj` vs `Object.hasOwn`/`hasOwnProperty` trap: a plain `{}`-literal catalog
    // inherits `toString`/`constructor`/`hasOwnProperty`/`valueOf` from `Object.prototype`, and
    // `key in a11yCopy` is `true` for all four even though none is a real catalog entry. An
    // implementation written as `if (key in a11yCopy) return a11yCopy[key]; throw …` would
    // return the inherited FUNCTION for `t('toString')` instead of throwing.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(
        () => t(key),
        `t('${key}') must throw — it is an inherited Object.prototype member, not a real ` +
          'catalog entry; resolving it would return a function/string instead of throwing',
      ).toThrow();
    }
  });

  it('A11YCOPY-IS-FROZEN BITES: the catalog is Object.freeze()d, so a caller that casts away Readonly<> cannot rewrite it for every other importer', () => {
    // `Readonly<Record<string, string>>` is ERASED at runtime — red-team confirmed
    // `Object.isFrozen(a11yCopy)` was `false` before this landed, so a single careless
    // `a11yCopy[k] = v` (or a hostile cast) silently rewrote the shared module singleton and
    // `t()` then handed the corrupted value to every later caller in the process. S0 ships no
    // consumers, so this is latent today and load-bearing the moment S1 lands them.
    expect(
      Object.isFrozen(a11yCopy),
      'a11yCopy must be Object.freeze()d — the Readonly<> annotation is compile-time only',
    ).toBe(true);

    const victim = 'a11y.overlay.battleView.title';
    const before = t(victim);
    const escaped = a11yCopy as unknown as Record<string, string>;
    try {
      escaped[victim] = 'HIJACKED';
    } catch {
      // A frozen object throws here in strict mode (ESM is always strict) — that is the
      // GOOD outcome; the assertions below hold either way.
    }
    expect(
      t(victim),
      'a write through a cast-away reference must NOT change what t() resolves',
    ).toBe(before);

    try {
      escaped['a11y.injected.key'] = 'injected';
    } catch {
      // Same: frozen objects reject added keys.
    }
    expect(
      Object.hasOwn(a11yCopy, 'a11y.injected.key'),
      'a caller must not be able to inject a brand-new catalog key at runtime',
    ).toBe(false);
    expect(() => t('a11y.injected.key'), 'the injected key must still be a miss').toThrow();
  });
});
