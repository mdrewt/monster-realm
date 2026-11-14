// ui/a11yCopy.test.ts — the flat a11y copy catalog + t(key).
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M23-accessibility.spec.md §2.8, §5.1 [A11Y-04], §6 A11Y-4.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR only.

import { describe, expect, it } from 'vitest';
import { a11yCopy, t } from './a11yCopy';
import { CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR } from './i18n/catalog.fr';
import { setLocale } from './i18n/resolver';
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
    // this cannot hide between two "passing" gates.
    //
    // SCOPING — READ THIS BEFORE "fixing" this test to be stricter: this test
    // deliberately does NOT assert that `a11yCopy` contains ONLY `a11y.overlay.*` keys, and does
    // NOT assert any catalog SIZE ceiling. S1 lands `a11y.world.region` (and more `a11y.world.*`
    // / `a11y.announce.*` keys) the moment it starts; a global "catalog has exactly N keys" or
    // "catalog has ONLY this namespace" check would force S1 to weaken an S0 gate. The check
    // below is filtered to keys starting with `a11y.overlay.` — S0's own namespace — on both
    // sides of the comparison. `a11y.world.*` orphan-checking belongs to S1 (`world.ts`), by the
    // "a namespace is orphan-checked by the slice that owns its consumer" convention (D5).

    // ANTI-VACUITY, ASSERTED FIRST. ctl-12b (named intentional change): 17 -> 18, `controlsView`
    // (Options › Controls) joined the manifest, so `a11y.overlay.controlsView.title` joins the
    // derived key set.
    // uif-16b (named intentional change): 18 -> 16: renameView, claimView, privacyView left, profileView joined.
    expect(OVERLAY_IDS.length, 'the manifest must hold 16 mutual-exclusion overlays').toBe(16);
    expect(
      Object.keys(a11yCopy as Record<string, unknown>).length > 0,
      'ANTI-VACUITY: a11yCopy must not be empty, or every set-equality check below is vacuous',
    ).toBe(true);

    const derivedKeys = OVERLAY_IDS.map((id) => `a11y.overlay.${id}.title`);
    // uif-16b (named intentional change): 18 -> 16 derived keys, same three out, profileView in.
    expect(
      new Set(derivedKeys).size,
      'ANTI-VACUITY: the 16 derived keys must be pairwise distinct',
    ).toBe(16);
    expect(derivedKeys, 'the Controls overlay`s derived key').toContain(
      'a11y.overlay.controlsView.title',
    );

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
    // uif-16b (named intentional change): 18 -> 16: renameView, claimView, privacyView left, profileView joined.
    expect(resolved, 'ANTI-VACUITY: all 16 ids must have been resolved').toBe(16);
  });

  it('A11YCOPY-VALUES-ICU-FREE BITES: every catalog value, regardless of namespace, is non-empty after trim and brace-free', () => {
    // This EXTENDS A11Y-3's key-side ICU ban to the VALUE side by §2.8's general prohibition
    // ("no ICU syntax") — it is not itself a numbered EARS criterion, but it is
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
    // key ("a11y overlay box view title") read aloud instead of a real label.
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
    // `t()` then handed the corrupted value to every later caller in the process.
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

// qf-10 (QF10.4): the accessible names of the Monsters and Inventory overlays follow their visible
// titles. The Help overlay's name was deliberately NOT moved here (a separate, deferred change); it
// moved later, in uif-15a, to 'How to Play' (pinned below).
describe('a11yCopy — qf-10: the overlay names match the visible titles', () => {
  it('the boxView and raisingView accessible names read Monsters and Inventory and equal the visible titles; the helpView name is the uif-15a one [QF10-4-A11Y-TITLES]', () => {
    // WRONG IMPL KILLED: names left on the shipped 'Party & Box' / 'Raising & Inventory' (a screen
    // reader announces a dialog the sighted player no longer sees named that); names typed here
    // that drift from the catalog titles the views draw (box.title, raising.title); and a
    // sweeping change that also renames the Help overlay (it moved separately, in uif-15a).
    expect(a11yCopy['a11y.overlay.boxView.title'], 'boxView accessible name').toBe('Monsters');
    expect(a11yCopy['a11y.overlay.raisingView.title'], 'raisingView accessible name').toBe(
      'Inventory',
    );
    const en = CATALOG_EN as Record<string, unknown>;
    expect(
      a11yCopy['a11y.overlay.boxView.title'],
      'the boxView name equals the visible title (box.title)',
    ).toBe(en['box.title']);
    expect(
      a11yCopy['a11y.overlay.raisingView.title'],
      'the raisingView name equals the visible title (raising.title)',
    ).toBe(en['raising.title']);
    expect(t('a11y.overlay.boxView.title'), 't() resolves the boxView name').toBe('Monsters');
    expect(t('a11y.overlay.raisingView.title'), 't() resolves the raisingView name').toBe(
      'Inventory',
    );
    expect(
      a11yCopy['a11y.overlay.helpView.title'],
      'helpView name was not part of qf-10 (it moved in uif-15a)',
    ).toBe('How to Play');
  });
});

// uif-15a (UIF15A.2): the Help overlay's accessible name follows the new visible title. `a11yCopy`
// is the frozen EN view of the catalog (ts-6b-9), so only the en name is pinned here; the localized
// names are pinned in overlayA11y.test.ts (fr) and the visible title (en + fr) in
// helpView.i18n.test.ts.
describe('a11yCopy — uif-15a: the Help overlay name', () => {
  it('UIF15A.2 the helpView accessible name reads How to Play, is the name the registry resolves, and equals the visible help title', () => {
    // WRONG IMPL KILLED: a name left on 'Controls & Goals' while the visible title changed; a
    // labelKey re-pointed at another entry; a name that drifts from chrome.help.title.
    expect(a11yCopy['a11y.overlay.helpView.title']).toBe('How to Play');
    expect(OVERLAY_A11Y.helpView.labelKey).toBe('a11y.overlay.helpView.title');
    expect(t(OVERLAY_A11Y.helpView.labelKey)).toBe('How to Play');
    expect(t(OVERLAY_A11Y.helpView.labelKey)).toBe(
      (CATALOG_EN as Record<string, unknown>)['chrome.help.title'],
    );
  });
});

// ts-6b-9 (R-weekly-review-2026-10-02-F4): a11yCopy is the en view of the catalogs, t follows the locale.
describe('a11yCopy — ts-6b-9: a delegate over the i18n catalogs', () => {
  it('a11yCopy is exactly the a11y.* entries of CATALOG_EN, and t() resolves in the current locale, still throwing on a non-a11y key', () => {
    // WRONG IMPL KILLED: a second hand-kept literal map left in a11yCopy.ts (two SSOTs that drift);
    // a `t` that always answers en; a `t` that no longer throws for a key outside the a11y set
    // (a plain MessageId such as box.title must not resolve through the accessible-name seam).
    const en = CATALOG_EN as Record<string, unknown>;
    const fr = CATALOG_FR as Record<string, unknown>;
    const enA11y = Object.fromEntries(
      Object.entries(en).filter(([k]) => k.startsWith('a11y.')),
    ) as Record<string, string>;
    expect(Object.keys(enA11y), 'ANTI-VACUITY: 17 a11y.* keys in CATALOG_EN').toHaveLength(17);
    expect({ ...a11yCopy }).toEqual(enA11y);
    expect(Object.isFrozen(a11yCopy)).toBe(true);

    setLocale('fr');
    try {
      for (const key of Object.keys(enA11y)) {
        expect(t(key), `t('${key}') under fr`).toBe(fr[key]);
      }
      expect(a11yCopy['a11y.overlay.boxView.title'], 'the view stays en under fr').toBe('Monsters');
      expect(() => t('box.title')).toThrow();
    } finally {
      setLocale('en');
    }
    for (const key of Object.keys(enA11y)) {
      expect(t(key), `t('${key}') back under en`).toBe(enA11y[key]);
    }
    expect(() => t('box.title'), 'a plain MessageId is not an accessible-name key').toThrow();
  });
});

// uif-16b (UIF16B.3): Profile is ONE dialog with ONE name. The three section overlays' names leave
// the a11y.overlay.* namespace (they are sections now, with no a11y of their own) and Profile's joins.
describe('a11yCopy — uif-16b: the one Profile dialog name', () => {
  it('UIF16B.3 the overlay-title namespace is exactly 16 keys, Profile is named Profile (the visible title), and the three section names are gone', () => {
    // WRONG IMPL KILLED: a section name left behind as a stowaway (a screen reader would have two
    // candidate names for one dialog), Profile named after one of its sections ('Name'/'Account'),
    // a name that drifts from the visible frame title (menu.profile.title), or a labelKey pointed
    // at a section's old key.
    const overlayNamespace = Object.keys(a11yCopy as Record<string, unknown>)
      .filter((k) => k.startsWith('a11y.overlay.'))
      .sort();
    // uif-16b (named intentional change): 18 -> 16: renameView, claimView, privacyView left, profileView joined.
    expect(overlayNamespace).toHaveLength(16);
    expect(overlayNamespace).toContain('a11y.overlay.profileView.title');
    for (const gone of ['renameView', 'claimView', 'privacyView']) {
      expect(
        Object.hasOwn(a11yCopy, `a11y.overlay.${gone}.title`),
        `a11y.overlay.${gone}.title must retire with the ${gone} overlay`,
      ).toBe(false);
    }
    expect(a11yCopy['a11y.overlay.profileView.title']).toBe('Profile');
    expect(OVERLAY_A11Y.profileView.labelKey).toBe('a11y.overlay.profileView.title');
    expect(t(OVERLAY_A11Y.profileView.labelKey)).toBe('Profile');
    expect(t(OVERLAY_A11Y.profileView.labelKey)).toBe(
      (CATALOG_EN as Record<string, unknown>)['menu.profile.title'],
    );
  });
});
