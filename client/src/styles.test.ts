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

// uif-4 (UIF4.2, UIF4.3, UIF4.5): the toast layer, the overlay strip and the world line's layer.
// Named intentional change: CTL7B-1-FRAME-CSS-ROSTER above is NOT edited; no new `.mr-frame*` /
// `.mr-shell*` selector is allowed (it already fails any new one), so the strip and the reserves are
// declarations on existing rules, and the toast is `.mr-toast` (outside the frame family).
describe('styles.css uif-4: toast layer, overlay strip, world line layer', () => {
  const css = readFileSync(STYLES_CSS_PATH, 'utf8');
  const rules = ctl7bParseCss(ctl7bStripCssComments(css));
  const topRules = (selector: string): Ctl7bCssRule[] =>
    rules.filter((r) => r.at.length === 0 && r.selectors.includes(selector));
  const eff = (selector: string, prop: string): string | undefined => {
    let value: string | undefined;
    for (const r of topRules(selector)) for (const [p, v] of r.decls) if (p === prop) value = v;
    return value;
  };
  const num = (selector: string, prop: string): number => Number(eff(selector, prop));
  const remOf = (v: string | undefined): number => {
    const m = /^(-?\d*\.?\d+)rem$/.exec(v ?? '');
    return m === null ? Number.NaN : Number(m[1]);
  };
  /** The effective padding-bottom of `selector`: the last of `padding-bottom` / the `padding`
   *  shorthand (1 to 4 values), in source order. */
  const paddingBottom = (selector: string): string | undefined => {
    let value: string | undefined;
    for (const r of topRules(selector)) {
      for (const [p, v] of r.decls) {
        if (p === 'padding-bottom') value = v;
        else if (p === 'padding') {
          const t = v.split(' ');
          value = t.length === 1 ? t[0] : t.length === 2 ? t[0] : t[2];
        }
      }
    }
    return value;
  };
  const shellZs = (): number[] => {
    const out: number[] = [];
    for (const r of rules) {
      if (r.at.length !== 0) continue;
      if (!r.selectors.some((s) => /^\.mr-shell(--\w+)?$/.test(s))) continue;
      for (const [p, v] of r.decls) if (p === 'z-index') out.push(Number(v));
    }
    return out;
  };

  it('UIF4.2 .mr-toast is absolutely positioned and click-through, outside any at-rule', () => {
    // WRONG IMPL KILLED: a toast in flow (it moves the frame under it), one that catches the
    // pointer (it blocks the row beneath), one only styled inside an @media block.
    expect(topRules('.mr-toast').length, 'a top-level .mr-toast rule').toBeGreaterThan(0);
    expect(
      rules.filter((r) => r.at.length > 0 && r.selectors.some((s) => s.includes('mr-toast'))),
      'no .mr-toast rule inside an at-rule',
    ).toEqual([]);
    expect(eff('.mr-toast', 'position')).toBe('absolute');
    expect(eff('.mr-toast', 'pointer-events')).toBe('none');
  });

  it('UIF4.2 .mr-toast z-index is a number above .mr-shell--top (read from the sheet)', () => {
    // WRONG IMPL KILLED: a toast under the menu or battle layer (a statusEl-style rejection
    // landing beneath the frame), a non-numeric z-index.
    const toastZ = num('.mr-toast', 'z-index');
    const topZ = num('.mr-shell--top', 'z-index');
    expect(Number.isFinite(toastZ), 'a numeric z-index').toBe(true);
    expect(Number.isFinite(topZ), 'the shell layer reads').toBe(true);
    expect(toastZ).toBeGreaterThan(topZ);
    for (const z of shellZs()) expect(toastZ).toBeGreaterThan(z);
  });

  it('UIF4.2 .mr-toast declares no display and a max-content width', () => {
    // WRONG IMPL KILLED: a `display` declaration (it beats the UA [hidden] rule, so a hidden toast
    // still paints); a toast that shrink-wraps to a sliver at left: 50% (no max-content width).
    expect(eff('.mr-toast', 'display')).toBeUndefined();
    expect(eff('.mr-toast', 'width')).toBe('max-content');
  });

  it('UIF4.2 .mr-toast is declared before the prefers-contrast block, which stays the last block', () => {
    // WRONG IMPL KILLED: a toast rule appended after the contrast block (the m23s9 X2 pin: it must
    // stay LAST) or only inside it.
    const first = rules.findIndex((r) => r.at[0] === '@media (prefers-contrast: more)');
    const toast = rules.findIndex((r) => r.at.length === 0 && r.selectors.includes('.mr-toast'));
    expect(toast).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(toast);
  });

  it('UIF4.3 .mr-frame-feedback is a sticky overlay whose height and negative margin cancel', () => {
    // WRONG IMPL KILLED: the shipped static strip (it takes layout height, so showing it moves the
    // body); margin-top mode (the strip lands under the content); a sticky bottom of 0 (the last
    // row would sit under the strip in Chromium); a catch-pointer strip.
    const s = '.mr-frame-feedback';
    expect(eff(s, 'position')).toBe('sticky');
    expect(remOf(eff(s, 'height'))).toBeGreaterThan(0);
    expect(remOf(eff(s, 'height')) + remOf(eff(s, 'margin-bottom'))).toBe(0);
    expect(eff(s, 'margin-top')).toBeUndefined();
    expect(remOf(eff(s, 'bottom'))).toBe(-remOf(eff(s, 'height')));
    expect(eff(s, 'order')).toBe('1');
    expect(eff(s, 'pointer-events')).toBe('none');
    expect(eff(s, 'min-height')).toBeUndefined();
  });

  it('UIF4.3 .mr-frame-feedback declares no display, so the hidden attribute still collapses it', () => {
    // WRONG IMPL KILLED: `display: block|flex` on the strip (QF12.1: an empty strip would paint).
    for (const r of rules.filter((r) => r.selectors.some((s) => s.includes('mr-frame-feedback')))) {
      expect(
        r.decls.map(([p]) => p),
        r.selectors.join(', '),
      ).not.toContain('display');
    }
  });

  it('UIF4.3 .mr-frame reserves a 2rem bottom padding for the strip', () => {
    // WRONG IMPL KILLED: no reserve (the strip covers the last row of the kit frame body at
    // scroll end); a reserve that does not match the strip height.
    expect(paddingBottom('.mr-frame')).toBe('2rem');
    expect(remOf(paddingBottom('.mr-frame'))).toBe(remOf(eff('.mr-frame-feedback', 'height')));
  });

  // uif-4 UIF4.3 (named intentional change, retargeted from an unconditional `.mr-shell` 2rem bottom
  // padding): the reserve applies ONLY to shells that are frames, so wf-1's menu geometry (UIF1.5:
  // the side frame stays 648 tall) does not move. `.mr-frame` declares the reserve as a custom
  // property and `.mr-shell` reads it with a 0px fallback, so a plain shell keeps its 0.75rem.
  it('UIF4.3 .mr-frame declares the strip reserve --mr-strip-reserve as 2rem', () => {
    // WRONG IMPL KILLED: no reserve declared (a frame shell's last row sits under the strip), a
    // reserve that differs from the strip's 2rem height.
    expect(eff('.mr-frame', '--mr-strip-reserve')).toBe('2rem');
    expect(remOf(eff('.mr-frame', '--mr-strip-reserve'))).toBe(
      remOf(eff('.mr-frame-feedback', 'height')),
    );
  });

  it('UIF4.3 .mr-shell padding bottom is exactly max(var(--mr-space-3), var(--mr-strip-reserve, 0px))', () => {
    // WRONG IMPL KILLED: an unconditional 2rem on every shell (the plain menu shell shrinks and the
    // UIF1.5 geometry moves), a reserve with no fallback, no max() against the base padding (a
    // reserve of 0 would drop the 0.75rem), or a shell that never reads the reserve.
    const padding = eff('.mr-shell', 'padding') ?? '';
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of padding) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ' ' && depth === 0) {
        if (cur !== '') parts.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur !== '') parts.push(cur);
    expect(parts, `the shell padding is a 3-value shorthand (${padding})`).toHaveLength(3);
    expect(parts[2]).toBe('max(var(--mr-space-3), var(--mr-strip-reserve, 0px))');
  });

  it('UIF4.3 no frame or shell selector was added: the roster is the shipped set plus nothing', () => {
    // WRONG IMPL KILLED: a new `.mr-frame-feedback--overlay` / `.mr-shell--strip` selector as the
    // route to the overlay (CTL7B-1-FRAME-CSS-ROSTER is the full gate; this pins the count of
    // distinct feedback selectors so the strip stays one class).
    const names = new Set(
      rules
        .filter((r) => r.at.length === 0)
        .flatMap((r) => r.selectors)
        .filter((s) => /mr-frame-feedback/.test(s)),
    );
    expect([...names].sort()).toEqual([
      '.mr-frame-feedback',
      '.mr-frame-feedback[data-feedback="error"]::before',
      '.mr-frame-feedback[data-feedback="ok"]::before',
      '.mr-frame-feedback[data-feedback="pending"]::before',
    ]);
  });

  // (uif-11 gating cases follow this describe, in their own describe below.)
  it('UIF4.5 .mr-status z-index is above every .mr-shell layer and below .mr-toast', () => {
    // WRONG IMPL KILLED: the shipped 45 (a persistent hint on the world line hides under any open
    // frame); a status line above the toast (a toast would paint under it).
    const statusZ = num('.mr-status', 'z-index');
    expect(Number.isFinite(statusZ), 'a numeric z-index').toBe(true);
    const zs = shellZs();
    expect(zs.length, 'anti-vacuity: the shell layers read').toBeGreaterThanOrEqual(3);
    for (const z of zs) expect(statusZ).toBeGreaterThan(z);
    expect(statusZ).toBeLessThan(num('.mr-toast', 'z-index'));
  });
});

// uif-11 (UIF11.1, UIF11.2, UIF11.3): the tactical screens on the kit. The sheet is parsed as text;
// the first Chromium proof of the geometry is e2e/ui-tactics.spec.ts. BOARD ART (tile overlays, the
// unit base mark, the sprite, the HP track, the ghost, the background, the grid and the sr-only title)
// keeps its px: boardRender.test.ts (outside this slice's touches) pins those literals. Every other
// rule whose selector names `tactics` is CHROME and must scale with the root rem.
describe('styles.css uif-11: tactical chrome on the tokens, the one scale and the nav-row treatment', () => {
  const css = readFileSync(STYLES_CSS_PATH, 'utf8');
  const rules = ctl7bParseCss(ctl7bStripCssComments(css));

  const ART_EXACT: ReadonlySet<string> = new Set([
    '.tactics-unit',
    '.tactics-unit::before',
    '.tactics-unit--mine::before',
    '.tactics-hp',
    '.tactics-bg',
    '.tactics-grid',
    '.tactics-title',
  ]);
  const ART_PREFIX = ['.tactics-tile', '.tactics-sprite', '.tactics-ghost'];
  const isArtSelector = (s: string): boolean =>
    ART_EXACT.has(s) || ART_PREFIX.some((p) => s.startsWith(p));
  const tacticsRules = rules.filter((r) => r.selectors.some((s) => s.includes('tactics')));
  const artRules = tacticsRules.filter((r) => r.selectors.every(isArtSelector));
  const chromeRules = tacticsRules.filter((r) => !r.selectors.every(isArtSelector));
  const label = (r: Ctl7bCssRule): string =>
    `${r.at.length > 0 ? `${r.at.join(' ')} ` : ''}${r.selectors.join(', ')}`;

  /** The last value of `prop` across the rules naming exactly `selector` (any depth), source order. */
  const eff = (selector: string, prop: string): string | undefined => {
    let value: string | undefined;
    for (const r of rules) {
      if (!r.selectors.includes(selector)) continue;
      for (const [p, v] of r.decls) if (p === prop) value = v;
    }
    return value;
  };

  const PX = /\d*\.?\d+px\b/i;
  const SCALED_PROP =
    /^(font-size|line-height|font|padding(-.+)?|margin(-.+)?|gap|row-gap|column-gap|min-width|min-height|width|height|top|bottom|left|right)$/;

  it('UIF11.1 no tactical chrome rule declares a px length in a size, spacing or offset property, outside the pinned board-art allowlist', () => {
    // WRONG IMPL KILLED: a chrome rule left on px (`font-size: 12px`, `padding: 4px 8px`, `gap: 6px`,
    // `min-height: 56px`, a 12px clock ring, a 10px pip) so the one root scale never reaches it and the
    // tactical screen stays at x1 when the window is x1.5; a px literal moved into a media block; a
    // px chrome selector grouped into an art rule (a rule is exempt only when EVERY selector is art);
    // the allowlist widened to a prefix that swallows chrome (`.tactics-unit-name` / `.tactics-intent`
    // are chrome, not `.tactics-unit`).
    expect(
      chromeRules.length,
      'anti-vacuity: the sheet has many tactical chrome rules',
    ).toBeGreaterThan(40);
    expect(artRules.length, 'anti-vacuity: the board-art allowlist matched rules').toBeGreaterThan(
      8,
    );
    expect(
      artRules.some((r) => r.selectors.includes('.tactics-sprite')),
      'anti-vacuity: the sprite rule is art',
    ).toBe(true);
    expect(
      chromeRules.some((r) => r.selectors.includes('.tactics-unit-name')),
      'the unit name label is chrome, not board art',
    ).toBe(true);
    const violations: string[] = [];
    for (const r of chromeRules) {
      for (const [p, v] of r.decls) {
        if (SCALED_PROP.test(p) && PX.test(v)) violations.push(`${label(r)} { ${p}: ${v} }`);
      }
    }
    expect(violations, 'tactical chrome is rem / token sized, never px').toEqual([]);
  });

  it('UIF11.1 no tactics rule reads --mr-ui-scale, declares zoom or transforms with scale(), and every tactics font-size is a type-scale token or inherit', () => {
    // WRONG IMPL KILLED: a battle-only scale (a second copy of the scale applied through `zoom`, a
    // `transform: scale(var(--mr-ui-scale))` or a calc over --mr-ui-scale in a tactics rule) that
    // would double-scale beside the root rem; a font-size left as a raw rem/px literal or an
    // off-scale token (`--mr-font-title` is allowed only through the four named tokens).
    const ALLOWED_FONT = new Set([
      'var(--mr-font-small)',
      'var(--mr-font-body)',
      'var(--mr-font-header)',
      'var(--mr-font-title)',
      'inherit',
    ]);
    const scaleHits: string[] = [];
    const fontHits: string[] = [];
    let fontSizes = 0;
    for (const r of tacticsRules) {
      for (const s of r.selectors)
        if (s.includes('--mr-ui-scale')) scaleHits.push(`${label(r)} (selector)`);
      for (const [p, v] of r.decls) {
        if (p.includes('--mr-ui-scale') || v.includes('--mr-ui-scale'))
          scaleHits.push(`${label(r)} { ${p}: ${v} }`);
        if (p === 'zoom') scaleHits.push(`${label(r)} { ${p}: ${v} }`);
        if (/scale[a-z0-9]*\(/i.test(v)) scaleHits.push(`${label(r)} { ${p}: ${v} }`);
        if (p === 'font-size') {
          fontSizes += 1;
          if (!ALLOWED_FONT.has(v)) fontHits.push(`${label(r)} { ${p}: ${v} }`);
        }
      }
    }
    expect(scaleHits, 'the only scale is the root rem (:root[style*="--mr-ui-scale"])').toEqual([]);
    expect(fontSizes, 'anti-vacuity: the tactical sheet declares font sizes').toBeGreaterThan(8);
    expect(fontHits, 'every tactics font-size is a type-scale token').toEqual([]);
  });

  it('UIF11.2 the HP bands and the clock bands draw from the state tokens (ok / warn / error) and the clock fill still reads --clock-color', () => {
    // WRONG IMPL KILLED: the shipped hex bands (#4c4 / #ec3 / #e44, #3c9 / #fc6 / #f66) left in
    // place; the tokens assigned in the wrong order (a green low band, a red full bar); a clock whose
    // default or amber / red band is the token of another meaning; the conic fill rewritten to a
    // literal so the band custom property is no longer what colours the ring (the meaning is lost).
    const bg = (s: string): string | undefined =>
      eff(s, 'background') ?? eff(s, 'background-color');
    expect(bg('.tactics-hp--high .tactics-hp-fill'), 'HP high').toBe('var(--mr-state-ok)');
    expect(bg('.tactics-hp--mid .tactics-hp-fill'), 'HP mid').toBe('var(--mr-state-warn)');
    expect(bg('.tactics-hp--low .tactics-hp-fill'), 'HP low').toBe('var(--mr-state-error)');
    expect(eff('.tactics-clock-ring', '--clock-color'), 'clock default (green)').toBe(
      'var(--mr-state-ok)',
    );
    expect(eff('.tactics-clock-ring[data-band="amber"]', '--clock-color'), 'clock amber').toBe(
      'var(--mr-state-warn)',
    );
    expect(eff('.tactics-clock-ring[data-band="red"]', '--clock-color'), 'clock red').toBe(
      'var(--mr-state-error)',
    );
    expect(
      eff('.tactics-clock-ring', 'background') ?? '',
      'the ring is filled from --clock-color',
    ).toContain('var(--clock-color)');
  });

  it('UIF11.2 no tactical chrome rule colours a text or border with a hex / rgb / hsl literal', () => {
    // WRONG IMPL KILLED: a chrome colour left as a literal (`color: #eee`, `border: 1px solid #556`,
    // `border-left: 3px solid #3c3`, `color: #fc6`) so it ignores the --mr-* tokens and the contrast
    // tier (prefers-contrast: more) re-colours the kit but not the battle; a literal hidden in a border
    // shorthand instead of `color`. Board art keeps its literals (allowlisted).
    const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
    const COLOURED = /^(color|border(-(top|right|bottom|left))?(-color)?)$/;
    const hits: string[] = [];
    for (const r of chromeRules) {
      for (const [p, v] of r.decls) {
        if (COLOURED.test(p) && LITERAL.test(v)) hits.push(`${label(r)} { ${p}: ${v} }`);
      }
    }
    expect(hits, 'chrome colours are tokens').toEqual([]);
  });

  it('UIF11.3 the shared nav-row rules carry the tactical selector in the SAME rule: padding, cursor, ▶, disabled, active+disabled (compound) and the hover cue', () => {
    // WRONG IMPL KILLED: a copied treatment (a second `.tactics-menu-row[aria-selected="true"]` rule
    // beside the shared one, which drifts the moment the kit changes); a tactical selector in a
    // separate rule that merely repeats today's values; the active+disabled pair written as a
    // descendant selector instead of the COMPOUND `[aria-selected="true"][aria-disabled="true"]`
    // (specificity (0,3,0), equal to the shared pair's, so the grey cursor row stays readable); the
    // hover cue left off the tactical row; a shared rule stripped of its declarations.
    const top = rules.filter((r) => r.at.length === 0);
    const only = (shared: string): Ctl7bCssRule => {
      const hits = top.filter((r) => r.selectors.includes(shared));
      expect(hits.length, `exactly one top-level rule lists ${shared}`).toBe(1);
      return hits[0] as Ctl7bCssRule;
    };
    const PAIRS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
      ['.mr-nav-item', '.tactics-menu-row', ['padding']],
      [
        '.mr-nav-item.is-active',
        '.tactics-menu-row[aria-selected="true"]',
        ['background', 'color', 'outline', 'outline-offset'],
      ],
      [
        '.mr-nav-item.is-active::before',
        '.tactics-menu-row[aria-selected="true"]::before',
        ['content', 'margin-left', 'width', 'display'],
      ],
      ['.mr-nav-item.is-disabled', '.tactics-menu-row[aria-disabled="true"]', ['color']],
      [
        '.mr-nav-item.is-active.is-disabled',
        '.tactics-menu-row[aria-selected="true"][aria-disabled="true"]',
        ['color'],
      ],
      [
        '.mr-pointer-hover .mr-nav-item:hover',
        '.mr-pointer-hover .tactics-menu-row:hover',
        ['text-decoration'],
      ],
    ];
    for (const [shared, tactical, props] of PAIRS) {
      const rule = only(shared);
      expect(rule.selectors, `the rule listing ${shared} also lists ${tactical}`).toContain(
        tactical,
      );
      const declared = rule.decls.map(([p]) => p);
      for (const p of props) expect(declared, `${shared} still declares ${p}`).toContain(p);
    }
  });

  it('UIF11.3 no other rule for a .tactics-menu-row selector declares the treatment: state rules declare no fill, colour, outline or padding, and the base row only resets the button', () => {
    // WRONG IMPL KILLED: a tactical-only treatment kept beside the shared one (`.tactics-menu-row
    // [aria-selected="true"] { background: #44445a; border-color: #fff }`, `[aria-disabled="true"]
    // { color: #889 }`, `.tactics-menu-row { padding: 2px 6px; color: #eee }`); a row that pins
    // `justify-content: space-between` (the label would move when the cursor adds the ▶). The base row
    // may reset the UA button look (`background: transparent`, `color: inherit`) and nothing more.
    const FORBIDDEN = /^(background(-color)?|color|outline(-.+)?|padding(-.+)?)$/;
    const mine = rules.filter(
      (r) =>
        r.selectors.some((s) => s.includes('.tactics-menu-row')) &&
        !r.selectors.some((s) => s.includes('.mr-nav-item')),
    );
    expect(mine.length, 'anti-vacuity: the tactical row has its own layout rule').toBeGreaterThan(
      0,
    );
    const hits: string[] = [];
    for (const r of mine) {
      const stateful = r.selectors.some((s) => s.includes('[aria-') || s.includes(':hover'));
      for (const [p, v] of r.decls) {
        if (!FORBIDDEN.test(p)) continue;
        const resetOk =
          !stateful &&
          ((/^background(-color)?$/.test(p) && (v === 'transparent' || v === 'none')) ||
            (p === 'color' && v === 'inherit') ||
            (p === 'outline' && v === 'none'));
        if (!resetOk) hits.push(`${label(r)} { ${p}: ${v} }`);
      }
    }
    expect(hits, 'the only treatment is the shared nav-row rules').toEqual([]);
    expect(
      eff('.tactics-menu-row', 'justify-content'),
      'the label stays put between cursor and non-cursor rows',
    ).not.toBe('space-between');
  });
});
