// client/src/styles.test.ts — the stylesheet-wide frame / shell guards (ctl-7b), beside the sheet
// they read.
//
// bt-17 (named intentional change, BT17.2): these two cases and their parser helpers moved
// VERBATIM out of ui/battleView.test.ts (deleted with the 1v1 BattleView, BT17.1). They never
// tested the 1v1 view: they guard styles.css itself — the battle layer every battle root shares
// (`.mr-shell--battle`, carried by the deploy panel, the tactical shell and the results panel) and
// the frame / shell selector roster that keeps a stylesheet route around the frame contract out.
// The only change is the sheet's path: this file sits beside styles.css. The read is a bare
// `readFileSync` (no swallowed error), so a missing or moved sheet FAILS every case.
//
// Pure, node env: the sheet is parsed as text by the comment stripper and brace parser below.
//
// Do NOT edit these tests to match a stylesheet change; correct them from the spec only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** styles.css, resolved from this spec's own URL (no cwd dependence). */
const STYLES_CSS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css');

/** One declaration of one top-level or nested rule in styles.css, in source order. */
interface Ctl7bCssRule {
  /** The at-rule preludes this rule sits inside, outermost first (empty at the top level). */
  readonly at: readonly string[];
  readonly selectors: readonly string[];
  readonly decls: ReadonlyArray<readonly [string, string]>;
}

/** Comments out of the sheet. (styles.css holds no comment delimiter inside a string.) */
function ctl7bStripCssComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      out += ' ';
    } else {
      out += css[i];
      i += 1;
    }
  }
  return out;
}

/** Every style rule at any depth, in SOURCE order; `@media` / `@supports` blocks are recursed into. */
function ctl7bParseCss(css: string, at: readonly string[] = []): Ctl7bCssRule[] {
  const rules: Ctl7bCssRule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close === -1) throw new Error('styles.css: unbalanced braces');
    const prelude = css.slice(i, open).trim();
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      rules.push(...ctl7bParseCss(body, [...at, prelude.replace(/\s+/g, ' ')]));
    } else if (prelude !== '') {
      const decls: Array<readonly [string, string]> = [];
      for (const raw of body.split(';')) {
        const colon = raw.indexOf(':');
        if (colon === -1) continue;
        const prop = raw.slice(0, colon).trim().toLowerCase();
        if (prop !== '')
          decls.push([
            prop,
            raw
              .slice(colon + 1)
              .trim()
              .replace(/\s+/g, ' '),
          ]);
      }
      rules.push({
        at,
        selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
        decls,
      });
    }
    i = close + 1;
  }
  return rules;
}

describe('styles.css ctl-7b: the battle layer and the frame / shell roster (moved from battleView.test.ts, bt-17)', () => {
  it('CTL7B-1-BATTLE-LAYER-CSS BITES: styles.css declares .mr-shell--battle once, at the top level, as z-index only, strictly between .mr-shell and .mr-shell--top and after both, so a root carrying every class cascades to z-index 110', () => {
    // WRONG IMPLS KILLED: no `.mr-shell--battle` rule (the battle would sit at the base shell's
    // z-index 100 and lose to every other shell); the rule declared BEFORE `.mr-shell--top`
    // (both selectors have specificity (0,1,0), so the later `--top` z-index 120 would win and the
    // battle would sit level with the menu and help it must stay under); a value at or above 120
    // (over the menu and help, which open over a battle) or at or below 100 (under a plain shell);
    // the rule inside an @media / @supports block (only some viewports would layer it); a
    // modifier that also sets position / an inset / overflow (indexShell.smoke.test.ts bans those
    // on modifiers because they can push the box out of the viewport); `!important`.
    const css = readFileSync(STYLES_CSS_PATH, 'utf8');
    const rules = ctl7bParseCss(ctl7bStripCssComments(css));
    const mentioning = rules.filter((r) => r.selectors.some((s) => s.includes('mr-shell--battle')));
    expect(
      mentioning.length,
      'styles.css must declare `.mr-shell--battle` in exactly one rule (none yet means the ' +
        'battle layer is still an inline z-index)',
    ).toBe(1);
    const rule = mentioning[0] as Ctl7bCssRule;
    expect(rule.at, '.mr-shell--battle is a TOP-LEVEL rule, not inside an at-rule').toEqual([]);
    expect(rule.selectors, 'the rule is exactly the one class selector').toEqual([
      '.mr-shell--battle',
    ]);
    expect(
      rule.decls.map(([prop]) => prop),
      '.mr-shell--battle sets z-index and nothing else',
    ).toEqual(['z-index']);
    const rawZ = (rule.decls[0] as readonly [string, string])[1];
    expect(rawZ, 'the z-index is a bare integer (no !important, no var())').toMatch(/^\d+$/);
    const battleZ = Number(rawZ);

    const topLevel = (selector: string): Ctl7bCssRule[] =>
      rules.filter((r) => r.at.length === 0 && r.selectors.includes(selector));
    const zOf = (selector: string): number => {
      const declared = topLevel(selector)
        .flatMap((r) => r.decls)
        .filter(([prop]) => prop === 'z-index');
      expect(declared.length, `${selector} declares a z-index`).toBeGreaterThan(0);
      return Number((declared[declared.length - 1] as readonly [string, string])[1]);
    };
    const baseZ = zOf('.mr-shell');
    const topZ = zOf('.mr-shell--top');
    expect(baseZ, 'precondition: the base shell layer').toBe(100);
    expect(topZ, 'precondition: the menu / help layer').toBe(120);
    expect(
      battleZ > baseZ && battleZ < topZ,
      `the battle layer ${battleZ} must sit strictly between the shell (${baseZ}) and the ` +
        `menu / help layer (${topZ})`,
    ).toBe(true);

    const indexOfRule = (r: Ctl7bCssRule): number => rules.indexOf(r);
    const latest = (selector: string): number =>
      Math.max(...topLevel(selector).map((r) => indexOfRule(r)));
    expect(
      indexOfRule(rule),
      '.mr-shell--battle must be declared AFTER .mr-shell--top (same specificity: source order ' +
        'decides which z-index wins on a root carrying both)',
    ).toBeGreaterThan(latest('.mr-shell--top'));
    expect(indexOfRule(rule), 'and after the base .mr-shell rule').toBeGreaterThan(
      latest('.mr-shell'),
    );

    // The cascade of a battle root (.mr-shell, .mr-shell--top and .mr-shell--battle all match):
    // equal specificity, so the last declaration in source order wins.
    let cascaded: number | undefined;
    for (const r of rules) {
      if (r.at.length !== 0) continue;
      if (
        !r.selectors.some((s) => ['.mr-shell', '.mr-shell--top', '.mr-shell--battle'].includes(s))
      ) {
        continue;
      }
      for (const [prop, value] of r.decls) if (prop === 'z-index') cascaded = Number(value);
    }
    expect(
      cascaded,
      'a battle root keeps the layer it always had: above every shell (100), under the menu ' +
        'and help (120)',
    ).toBe(110);
  });

  it('CTL7B-1-FRAME-CSS-ROSTER BITES: no frame or shell selector appears inside an at-rule, and every top-level frame or shell selector is one the sheet already shipped', () => {
    // WRONG IMPLS KILLED (each is a stylesheet route around the inline contract that every other
    // case here would let through): a viewport-conditional shell rule such as
    // `@media (max-width:900px){.mr-shell{bottom:-400px}}` (the box leaves the screen on small
    // viewports only); `@media (prefers-reduced-motion:reduce){.mr-frame{opacity:.5}}` (dims every
    // frame for one user group); `@media (max-height:500px){.mr-frame.mr-shell.mr-shell--top{z-index:90}}`
    // (re-layers the battle on short screens); an unconditional descendant rule such as
    // `.mr-shell > div > div > div{color:#666}` (recolours text the inline walk never sees).
    // The roster is every selector of today's styles.css that names a frame or a shell; the one
    // ctl-7b addition is `.mr-shell--battle` (its own case pins its declarations).
    const css = readFileSync(STYLES_CSS_PATH, 'utf8');
    const rules = ctl7bParseCss(ctl7bStripCssComments(css));
    const names = (s: string): boolean => /mr-(shell|frame)/.test(s);

    const inAtRule = rules
      .filter((r) => r.at.length > 0)
      .flatMap((r) => r.selectors.filter(names).map((s) => `${s} in ${r.at.join(' ')}`));
    expect(
      inAtRule,
      'no frame or shell selector may sit inside an @media / @supports block',
    ).toEqual([]);

    const ROSTER: ReadonlySet<string> = new Set([
      '.mr-frame',
      '.mr-frame--side',
      '.mr-frame--full',
      '.mr-frame--bottom',
      '.mr-frame--small',
      '.mr-frame-titlebar',
      '.mr-frame-title',
      '.mr-frame-breadcrumb',
      '.mr-frame-crumb + .mr-frame-crumb::before',
      '.mr-frame-tabs',
      '.mr-frame-tabs[hidden]',
      '.mr-frame-tabslot::before',
      '.mr-frame-tabstrip',
      '.mr-frame-body',
      '.mr-frame-feedback',
      '.mr-frame-feedback[data-feedback="pending"]::before',
      '.mr-frame-feedback[data-feedback="ok"]::before',
      '.mr-frame-feedback[data-feedback="error"]::before',
      '.mr-frame-layer',
      '.mr-shell',
      '.mr-shell--top',
      '.mr-shell--battle',
      '.mr-frame--prompt',
      '.mr-frame--banner',
    ]);
    const topLevel = rules
      .filter((r) => r.at.length === 0)
      .flatMap((r) => r.selectors.filter(names));
    expect(
      topLevel.length,
      'anti-vacuity: the sheet names well over twenty frame and shell selectors',
    ).toBeGreaterThan(20);
    expect(
      topLevel.filter((s) => !ROSTER.has(s)),
      'every top-level frame or shell selector must be in the shipped roster — a new one is a new ' +
        'way to place, layer or recolour a frame without touching the inline contract',
    ).toEqual([]);
  });
});
