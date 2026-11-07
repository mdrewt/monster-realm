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

// uif-3 (UIF3.1, UIF3.2, UIF3.3, UIF3.5): the kit's CSS. Named intentional change: CTL7B-1-FRAME-CSS-ROSTER
// above is NOT edited, because every new kit selector is named outside the `mr-frame` / `mr-shell`
// family (`.mr-tabbar`, `.mr-sheet`, `.mr-scroll`, `.mr-empty`, `.mr-card`, `.mr-nav-tab.is-selected`).
// These pins read declarations off the real sheet; the first Chromium proof of the geometry is uif-6.
describe('styles.css uif-3: the kit rules', () => {
  const css = readFileSync(STYLES_CSS_PATH, 'utf8');
  const rules = ctl7bParseCss(ctl7bStripCssComments(css));
  const topRules = (selector: string): Ctl7bCssRule[] =>
    rules.filter((r) => r.at.length === 0 && r.selectors.includes(selector));
  /** The last value of `prop` across the top-level rules naming exactly `selector`. */
  const eff = (selector: string, prop: string): string | undefined => {
    let value: string | undefined;
    for (const r of topRules(selector)) for (const [p, v] of r.decls) if (p === prop) value = v;
    return value;
  };
  const squash = (v: string | undefined): string => (v ?? '').replace(/\s+/g, '');
  const borderText = (selector: string): string =>
    topRules(selector)
      .flatMap((r) => r.decls)
      .filter(([p]) => p.startsWith('border') || p === 'outline')
      .map(([, v]) => v)
      .join(' ');
  const KIT = /\.mr-(tabbar|sheet|scroll|empty|card)(?![\w])|\.mr-nav-tab\.is-selected/;
  const kitRules = rules.filter((r) => r.selectors.some((s) => KIT.test(s)));

  it('UIF3.1 the tab bar rules: a fixed-height row, fixed-width chips on the frame border token, a full-width strip, tabs that share it evenly', () => {
    // WRONG IMPLS KILLED: no rule for the kit classes (the bar would be the bare titlebar row); a
    // height that follows content (UIF.1 wants a uniform fixed height); a chip with no border or a
    // px colour literal; a strip that does not fill the row; tabs that do not share the strip.
    expect(topRules('.mr-tabbar').length, '.mr-tabbar rule').toBeGreaterThan(0);
    expect(eff('.mr-tabbar', 'height')).toBe('2rem');
    expect(eff('.mr-tabbar', 'flex')).toBe('none');
    expect(topRules('.mr-tabbar-chip').length, '.mr-tabbar-chip rule').toBeGreaterThan(0);
    expect(eff('.mr-tabbar-chip', 'width')).toBe('3.25rem');
    expect(eff('.mr-tabbar-chip', 'flex')).toBe('none');
    const chipBorder = borderText('.mr-tabbar-chip');
    expect(chipBorder).toContain('var(--mr-frame-border)');
    expect(chipBorder).toContain('var(--mr-border-thin)');
    expect(eff('.mr-tabbar-strip', 'width')).toBe('100%');
    expect(eff('.mr-tabbar-strip > .mr-nav-tab', 'flex')).toBe('0 1 7.5rem');
    expect(eff('.mr-tabbar-strip > .mr-nav-tab', 'text-align')).toBe('center');
  });

  it('UIF3.2 the selected tab rule: panel fill, bold, a frame-border outline, and never the inverted fill of the row cursor', () => {
    // WRONG IMPLS KILLED: no .is-selected rule (a selected tab with no visible cue beyond aria);
    // the shipped inverted fill (--mr-frame-fg background, --mr-frame-bg text) reused for the
    // selected tab (the wireframe: never the inverted fill, so selected differs from focused);
    // a colour-only cue with no outline or weight (needs at least two cues).
    expect(topRules('.mr-nav-tab.is-selected').length, 'the rule exists').toBe(1);
    const bg = eff('.mr-nav-tab.is-selected', 'background');
    expect(bg).toBe('var(--mr-panel-bg)');
    expect(bg).not.toContain('--mr-frame-fg');
    expect(eff('.mr-nav-tab.is-selected', 'color')).not.toBe('var(--mr-frame-bg)');
    expect(['bold', 'var(--mr-font-header-weight)']).toContain(
      eff('.mr-nav-tab.is-selected', 'font-weight') ?? '',
    );
    expect(eff('.mr-nav-tab.is-selected', 'outline') ?? '').toContain('var(--mr-frame-border)');
    expect(eff('.mr-nav-tab.is-selected', 'text-decoration')).not.toBe('underline');
  });

  it('UIF3.3 .mr-sheet: absolutely positioned, min(18rem, 45%) wide, bordered with the frame border token, and [hidden] collapses it', () => {
    // WRONG IMPLS KILLED: a fixed 18rem width (WF1-A2 caps it at 45% of the body); a static or
    // fixed position (the sheet must anchor in the body); no border; a display rule that beats the
    // hidden attribute (a closed sheet would still paint).
    expect(topRules('.mr-sheet').length, '.mr-sheet rule').toBeGreaterThan(0);
    expect(squash(eff('.mr-sheet', 'width'))).toBe('min(18rem,45%)');
    expect(eff('.mr-sheet', 'position')).toBe('absolute');
    const border = borderText('.mr-sheet');
    expect(border).toContain('var(--mr-frame-border)');
    expect(border).toContain('var(--mr-border-width)');
    expect(eff('.mr-sheet[hidden]', 'display')).toBe('none');
  });

  it('UIF3.3 .mr-sheet--detail: centred at min(40rem, 90%), declared after every .mr-sheet rule so it wins at equal specificity', () => {
    // WRONG IMPLS KILLED: a detail rule above .mr-sheet (the 18rem width wins and the prose sheet
    // is narrow: equal specificity, source order decides); a transform-centred box (fractional
    // pixels blur the text); a missing width or margin.
    expect(topRules('.mr-sheet--detail').length).toBeGreaterThan(0);
    expect(squash(eff('.mr-sheet--detail', 'width'))).toBe('min(40rem,90%)');
    expect(eff('.mr-sheet--detail', 'margin')).toBe('auto');
    expect(eff('.mr-sheet--detail', 'inset')).toBe('0');
    expect(eff('.mr-sheet--detail', 'transform')).toBeUndefined();
    const idx = (selector: string): number[] =>
      rules
        .map((r, i) => (r.at.length === 0 && r.selectors.includes(selector) ? i : -1))
        .filter((i) => i >= 0);
    const base = idx('.mr-sheet');
    const detail = idx('.mr-sheet--detail');
    expect(base.length).toBeGreaterThan(0);
    expect(Math.min(...detail)).toBeGreaterThan(Math.max(...base));
  });

  it('UIF3.3 .mr-frame-body declares position: relative (the sheet containing block) and keeps its touch-action rule as it was', () => {
    // WRONG IMPLS KILLED: no containing block (the absolute sheet anchors to the page or shell and
    // placement lands in the wrong place); the touch-action rule edited or dropped (ctl-15).
    expect(eff('.mr-frame-body', 'position')).toBe('relative');
    const touch = topRules('.mr-frame-body').filter((r) =>
      r.decls.some(([p]) => p === 'touch-action'),
    );
    expect(touch.length).toBe(1);
    expect(touch[0]?.decls).toEqual([['touch-action', 'pan-y']]);
  });

  it('UIF3.3 .mr-scroll is the qf-16 Rankings rule generalised: ONE rule whose selector list is the readonly list plus .mr-scroll, holding the four layers and the scroll behaviour', () => {
    // WRONG IMPLS KILLED: a copied second rule (uif-9 cannot edit styles.css and only adds the
    // class: the cue must come from the shared rule); .mr-scroll in a second rule; the layers cut
    // down to fewer than the four qf-16 ones; overflow or flex lost in the join.
    const hits = rules.filter((r) => r.selectors.some((s) => /\.mr-scroll(?![\w-])/.test(s)));
    expect(hits.length, '.mr-scroll appears in exactly one rule').toBe(1);
    const rule = hits[0] as Ctl7bCssRule;
    expect(rule.at).toEqual([]);
    expect(rule.selectors).toEqual(['.mr-nav-list[aria-readonly="true"]', '.mr-scroll']);
    const get = (p: string): string =>
      rule.decls
        .filter(([k]) => k === p)
        .map(([, v]) => v)
        .at(-1) ?? '';
    expect(get('background').split('gradient(').length - 1, 'four background layers').toBe(4);
    expect(get('overflow-y')).toBe('auto');
    expect(get('flex')).toBe('1 1 auto');
    expect(get('min-height')).toBe('0');
    const readonlyAlone = rules.filter(
      (r) => r.selectors.length === 1 && r.selectors[0] === '.mr-nav-list[aria-readonly="true"]',
    );
    expect(readonlyAlone.length, 'no second readonly rule re-declaring the layers').toBe(0);
  });

  it('UIF3.3 every kit rule sits before @media (prefers-contrast: more), which stays the last block; kit rules use tokens only and no !important', () => {
    // WRONG IMPLS KILLED: kit rules appended after the contrast block (it must stay LAST: the
    // m23s9 X2 pin and the override order); a kit rule inside an at-rule; a hex colour or an
    // !important in a kit rule; a kit selector that joined the frame / shell roster.
    expect(kitRules.length, 'anti-vacuity: the kit rules exist').toBeGreaterThan(10);
    const contrast = '@media (prefers-contrast: more)';
    const firstContrast = rules.findIndex((r) => r.at[0] === contrast);
    expect(firstContrast, 'the contrast block exists').toBeGreaterThan(0);
    for (let i = firstContrast; i < rules.length; i += 1) {
      expect(rules[i]?.at[0], `rule ${i} after the contrast block starts is inside it`).toBe(
        contrast,
      );
    }
    for (const r of kitRules) {
      expect(r.at, r.selectors.join(', ')).toEqual([]);
      expect(rules.indexOf(r), r.selectors.join(', ')).toBeLessThan(firstContrast);
      for (const [p, v] of r.decls) {
        expect(v, `${r.selectors.join(', ')} ${p}`).not.toMatch(/!important|#[0-9a-f]{3,8}\b/i);
      }
      for (const s of r.selectors)
        expect(s, 'not in the frame / shell roster family').not.toMatch(/^\.mr-(frame|shell)/);
    }
    expect(ctl7bStripCssComments(css)).not.toContain('!important');
  });

  it('UIF3.5 the empty-state rules exist, with the cue muted by the token', () => {
    // WRONG IMPLS KILLED: unstyled parts (the reason, cue and next step run together); a cue in a
    // literal grey (it must follow the contrast tier through --mr-text-muted).
    for (const s of ['.mr-empty', '.mr-empty-reason', '.mr-empty-cue', '.mr-empty-next']) {
      expect(topRules(s).length, s).toBeGreaterThan(0);
    }
    expect(eff('.mr-empty-cue', 'color')).toBe('var(--mr-text-muted)');
  });

  it('UIF3.5 .mr-card: a separator-bordered panel that is inline-block and full width, and the active row clears its fill', () => {
    // WRONG IMPLS KILLED: a block card (the active row's ::before arrow would push it to a new
    // line and shift the row); a border not drawn from the separator and thin tokens; no
    // active-row rule (inverted row text on a panel-bg card is dark on dark); a rule that keeps the
    // card background.
    expect(eff('.mr-card', 'display')).toBe('inline-block');
    expect(eff('.mr-card', 'width')).toBe('100%');
    const border = borderText('.mr-card');
    expect(border).toContain('var(--mr-separator)');
    expect(border).toContain('var(--mr-border-thin)');
    const active = '.mr-nav-item.is-active > .mr-card';
    expect(topRules(active).length, 'the active-row card rule').toBe(1);
    const bg = eff(active, 'background') ?? eff(active, 'background-color') ?? '';
    expect(['none', 'transparent']).toContain(bg);
  });
});
