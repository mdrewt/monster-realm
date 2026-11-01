// @vitest-environment happy-dom
// tactics/boardRender.test.ts — bt-10 RED tests for the DOM board painter (BT10.1: grid placement,
// ONE shared background, health bars, CSS-cropped sprites, pointer; BT10.4: overlay classes and
// intent chips) and for the board's CSS contract in styles.css.
//
// SOURCE OF TRUTH: spec `### bt-10` BT10.1 / BT10.4 and the plan's DOM contract (API freeze
// block + REV 2 A7/A13). `renderBoard(parent, vm, onTile)` paints a hand-built BoardVM, so this
// file proves the painter alone: it never calls buildBoard.
//
// DOM CONTRACT PINNED HERE BEYOND THE FREEZE TEXT (each follows an existing frozen name's
// convention; the implementer reads them from this file): `.tactics-unit--active` on the unit whose
// `active` flag is set; `.tactics-hp--high|mid|low` on the `.tactics-hp` bar from `hpBand`;
// `.tactics-intent` chip inside the unit with the `tactics.intent.*` text.
//
// RED REASON: renderBoard throws `bt-10: not implemented`; the CSS tests red on the missing
// `.tactics-*` rules in styles.css.
//
// Strings are asserted THROUGH the catalog (CATALOG_EN), never as pasted English. Do NOT edit these
// tests to match a buggy implementation; correct them from the spec only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import type { BoardVM, IntentKind, OverlayKind, UnitVM } from './boardModel';
import { renderBoard } from './boardRender';

const EN = CATALOG_EN as unknown as Record<string, unknown>;

/** The English text of a catalog key, params applied. */
function en(key: string, params: Record<string, unknown> = {}): string {
  const value = EN[key];
  if (typeof value === 'function') return (value as (p: Record<string, unknown>) => string)(params);
  if (typeof value !== 'string') throw new Error(`catalog key missing: ${key}`);
  return value;
}

function uvm(o: Partial<UnitVM> & { readonly unitId: number }): UnitVM {
  return {
    x: 0,
    y: 0,
    side: 'A',
    mine: true,
    speciesName: 'Sprigg',
    spriteSlug: 'sprigg',
    hpPermille: 1000,
    hpBand: 'high',
    active: false,
    intent: null,
    ...o,
  };
}

interface VmOpts {
  readonly cursor?: { readonly x: number; readonly y: number } | null;
  readonly overlays?: ReadonlyMap<string, readonly OverlayKind[]>;
}

/** A BoardVM built by hand: row-major tiles, overlays looked up by "x,y". */
function vmOf(width: number, height: number, units: readonly UnitVM[], opts: VmOpts = {}): BoardVM {
  const tiles = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        overlays: opts.overlays?.get(`${x},${y}`) ?? [],
        cursor: opts.cursor?.x === x && opts.cursor?.y === y,
      });
    }
  }
  return { width, height, tiles, units };
}

function mount(): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return parent;
}

function q<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector);
  if (found === null) throw new Error(`no element matches ${selector}`);
  return found;
}

/** An inline style value read either way (a typed accessor or the kebab-case property). */
function css(el: HTMLElement, camel: string, kebab: string): string {
  const direct = (el.style as unknown as Record<string, unknown>)[camel];
  if (typeof direct === 'string' && direct !== '') return direct;
  return el.style.getPropertyValue(kebab);
}

const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('renderBoard: the grid and the units (BT10.1)', () => {
  it('BT10-1-RENDER-GRID: a 7x5 board paints 35 tiles row-major with data-x/data-y, units placed by grid column x+1 and row y+1, and ONE shared background', () => {
    // WRONG IMPL KILLED: x and y swapped in data-x/data-y or in the grid column/row (a unit at
    // x=5,y=1 lands on column 2 row 6, outside a 5-row grid); column-major tile order; a background
    // per tile or per unit instead of one shared; zero-based grid lines (CSS grid lines start at 1).
    const parent = mount();
    const vm = vmOf(7, 5, [uvm({ unitId: 1, x: 5, y: 1 }), uvm({ unitId: 2, x: 0, y: 4 })]);
    renderBoard(parent, vm, () => undefined);

    expect(parent.querySelectorAll('.tactics-bg'), 'exactly one shared background').toHaveLength(1);
    const tiles = [...parent.querySelectorAll<HTMLElement>('.tactics-tile')];
    expect(tiles, 'width*height tiles').toHaveLength(35);
    for (const [i, tile] of tiles.entries()) {
      expect(tile.getAttribute('data-x'), `tile ${i} data-x`).toBe(String(i % 7));
      expect(tile.getAttribute('data-y'), `tile ${i} data-y`).toBe(String(Math.floor(i / 7)));
    }
    expect(
      parent.querySelectorAll('.tactics-tile[data-x="5"][data-y="1"]'),
      'the (5,1) tile exists once',
    ).toHaveLength(1);
    expect(
      parent.querySelectorAll('.tactics-tile[data-x="1"][data-y="5"]'),
      'the transposed (1,5) tile does not exist',
    ).toHaveLength(0);

    const u1 = q(parent, '.tactics-unit[data-unit-id="1"]');
    expect(css(u1, 'gridColumn', 'grid-column'), 'unit 1 column is x+1').toBe('6');
    expect(css(u1, 'gridRow', 'grid-row'), 'unit 1 row is y+1').toBe('2');
    const u2 = q(parent, '.tactics-unit[data-unit-id="2"]');
    expect(css(u2, 'gridColumn', 'grid-column'), 'unit 2 column').toBe('1');
    expect(css(u2, 'gridRow', 'grid-row'), 'unit 2 row').toBe('5');
    expect(parent.querySelectorAll('.tactics-grid'), 'one grid').toHaveLength(1);
  });

  it('BT10-1-RENDER-UNITS: one unit element per view-model unit, the active flag is a class on exactly that unit, and the hp bar width is permille/10 percent', () => {
    // WRONG IMPL KILLED: an element for a unit the model dropped (a Fainted sprite on the board);
    // the highlight on every unit or none; a width in permille ("666%") or rounded ("67%"); a
    // width not driven by the unit's own permille (all bars equal); the fill outside the bar.
    const parent = mount();
    const permilles = [666, 333, 999, 0, 1000];
    const units = permilles.map((hp, i) =>
      uvm({ unitId: i + 1, x: i, y: 0, hpPermille: hp, active: i === 2 }),
    );
    renderBoard(parent, vmOf(7, 5, units), () => undefined);

    const els = [...parent.querySelectorAll<HTMLElement>('.tactics-unit')];
    expect(
      els.map((e) => e.getAttribute('data-unit-id')),
      'one element per unit, in order',
    ).toEqual(['1', '2', '3', '4', '5']);
    expect(
      els
        .filter((e) => e.classList.contains('tactics-unit--active'))
        .map((e) => e.getAttribute('data-unit-id')),
      'only the active unit is highlighted',
    ).toEqual(['3']);

    const widths = els.map((e) => css(q(e, '.tactics-hp .tactics-hp-fill'), 'width', 'width'));
    expect(widths, 'permille/10 percent per unit').toEqual([
      '66.6%',
      '33.3%',
      '99.9%',
      '0%',
      '100%',
    ]);
    for (const e of els) {
      expect(e.querySelectorAll('.tactics-hp'), 'one bar per unit').toHaveLength(1);
      expect(e.querySelectorAll('.tactics-hp-fill'), 'one fill per unit').toHaveLength(1);
    }
  });

  it('BT10-1-RENDER-HPBAND: the hp bar carries tactics-hp--<band> from the view-model and no other band class', () => {
    // WRONG IMPL KILLED: every bar green (the band never reaching the DOM); the band computed
    // again from the width (a second source of truth that drifts at 500/200); two band classes.
    const parent = mount();
    const units = [
      uvm({ unitId: 1, x: 0, y: 0, hpPermille: 900, hpBand: 'high' }),
      uvm({ unitId: 2, x: 1, y: 0, hpPermille: 400, hpBand: 'mid' }),
      uvm({ unitId: 3, x: 2, y: 0, hpPermille: 100, hpBand: 'low' }),
      // A band that disagrees with the permille proves the DOM follows the view-model.
      uvm({ unitId: 4, x: 3, y: 0, hpPermille: 900, hpBand: 'low' }),
    ];
    renderBoard(parent, vmOf(7, 5, units), () => undefined);
    const bands = ['high', 'mid', 'low'] as const;
    const read = (id: number): string[] => {
      const bar = q(parent, `.tactics-unit[data-unit-id="${id}"] .tactics-hp`);
      return bands.filter((b) => bar.classList.contains(`tactics-hp--${b}`));
    };
    expect(read(1), 'unit 1').toEqual(['high']);
    expect(read(2), 'unit 2').toEqual(['mid']);
    expect(read(3), 'unit 3').toEqual(['low']);
    expect(read(4), 'unit 4 follows hpBand, not the width').toEqual(['low']);
  });

  it('BT10-1-RENDER-SPRITE: a slug paints the CSS-cropped sheet exactly as assets/monster-<slug>.png on a div, and a null slug paints tactics-sprite--none with no background image', () => {
    // WRONG IMPL KILLED: an <img> or an Image() loader (the plan says no loader: frame 0 is a CSS
    // crop); a hard-coded sprite for every unit; a slug-less unit that still requests a
    // monster-null.png; the none class missing (the unit is invisible with no placeholder); a
    // wrong directory or extension.
    const probe = document.createElement('div');
    const forms = (slug: string): Set<string> => {
      const raw = [
        `url("assets/monster-${slug}.png")`,
        `url(assets/monster-${slug}.png)`,
        `url('assets/monster-${slug}.png')`,
      ];
      const out = new Set<string>(raw);
      for (const form of raw) {
        probe.style.backgroundImage = form;
        const back = probe.style.backgroundImage;
        if (back !== '') out.add(back);
      }
      return out;
    };
    const parent = mount();
    const units = [
      uvm({ unitId: 1, x: 0, y: 0, spriteSlug: 'sprigg' }),
      uvm({ unitId: 2, x: 1, y: 0, spriteSlug: 'cindertail' }),
      uvm({ unitId: 3, x: 2, y: 0, spriteSlug: null, speciesName: 'Mon2' }),
    ];
    renderBoard(parent, vmOf(7, 5, units), () => undefined);

    for (const [id, slug] of [
      [1, 'sprigg'],
      [2, 'cindertail'],
    ] as const) {
      const sprite = q(parent, `.tactics-unit[data-unit-id="${id}"] .tactics-sprite`);
      const actual = sprite.style.backgroundImage;
      expect(
        forms(slug).has(actual),
        `unit ${id} background-image ${JSON.stringify(actual)} is the monster-${slug}.png url`,
      ).toBe(true);
      expect(actual.includes(`assets/monster-${slug}.png`), `${actual} names the asset`).toBe(true);
      expect(sprite.tagName, 'a div crop, not an <img>').not.toBe('IMG');
      expect(sprite.classList.contains('tactics-sprite--none'), `unit ${id} has a sprite`).toBe(
        false,
      );
    }
    const none = q(parent, '.tactics-unit[data-unit-id="3"] .tactics-sprite');
    expect(none.classList.contains('tactics-sprite--none'), 'null slug -> the none class').toBe(
      true,
    );
    expect(none.style.backgroundImage, 'null slug -> no background image').toBe('');
    expect(parent.querySelectorAll('img'), 'no <img> anywhere on the board').toHaveLength(0);
  });

  it('BT10-1-RENDER-SINK: a hostile species name never becomes markup', () => {
    // WRONG IMPL KILLED: a name written through an HTML sink (innerHTML/insertAdjacentHTML) — the
    // <img onerror> below would become a live element; a name concatenated into a style or an
    // attribute without escaping.
    const parent = mount();
    const hostile = '<img src=x onerror=alert(1)>';
    const script = '<script>window.__bt10Pwned = 1</script>';
    renderBoard(
      parent,
      vmOf(7, 5, [
        uvm({ unitId: 1, x: 1, y: 1, speciesName: hostile, spriteSlug: null }),
        uvm({ unitId: 2, x: 2, y: 1, speciesName: script, spriteSlug: null }),
      ]),
      () => undefined,
    );
    expect(parent.querySelectorAll('img'), 'no img element was created').toHaveLength(0);
    expect(parent.querySelectorAll('script'), 'no script element was created').toHaveLength(0);
    expect(parent.querySelectorAll('[onerror]'), 'no onerror attribute').toHaveLength(0);
    expect(parent.innerHTML.includes('<img'), 'no <img markup in the painted tree').toBe(false);
    expect(parent.innerHTML.includes('<script'), 'no <script markup in the painted tree').toBe(
      false,
    );
    expect(
      (window as unknown as Record<string, unknown>).__bt10Pwned,
      'no script ran',
    ).toBeUndefined();
  });

  it('BT10-1-RENDER-IDEMPOTENT: rendering twice paints once (one background, no duplicated tiles or units), and a smaller second view-model replaces the first completely', () => {
    // WRONG IMPL KILLED: append-without-clear (35 -> 70 tiles, two backgrounds); stale unit
    // elements left after the unit left the model; a resized board keeping the old tile count.
    const parent = mount();
    const vm = vmOf(7, 5, [uvm({ unitId: 1, x: 1, y: 1 }), uvm({ unitId: 2, x: 2, y: 2 })]);
    renderBoard(parent, vm, () => undefined);
    renderBoard(parent, vm, () => undefined);
    expect(parent.querySelectorAll('.tactics-bg'), 'one background after two renders').toHaveLength(
      1,
    );
    expect(parent.querySelectorAll('.tactics-tile'), 'tile count stable').toHaveLength(35);
    expect(parent.querySelectorAll('.tactics-unit'), 'unit count stable').toHaveLength(2);
    expect(parent.querySelectorAll('.tactics-grid'), 'one grid').toHaveLength(1);

    renderBoard(parent, vmOf(4, 4, [uvm({ unitId: 3, x: 3, y: 3 })]), () => undefined);
    expect(parent.querySelectorAll('.tactics-bg'), 'still one background').toHaveLength(1);
    expect(parent.querySelectorAll('.tactics-tile'), '4x4 tiles').toHaveLength(16);
    expect(
      [...parent.querySelectorAll('.tactics-unit')].map((e) => e.getAttribute('data-unit-id')),
      'only unit 3 remains',
    ).toEqual(['3']);
  });

  it("BT10-1-RENDER-POINTER: a click on a tile, on a sprite inside a unit, or on its health bar calls onTile ONCE with that unit's or tile's coordinates, and the cursor class follows the view-model", () => {
    // WRONG IMPL KILLED: a handler only on the tile (the unit element sits above it and swallows
    // the click: clicking a sprite does nothing); a handler on both the unit and the tile (two
    // calls per click); coordinates read as (y, x); the cursor class on every tile or none; the
    // click moving the cursor by itself (the painter is stateless; the shell owns the cursor).
    const parent = mount();
    const onTile = vi.fn();
    const vm = vmOf(7, 5, [uvm({ unitId: 1, x: 5, y: 1 })], { cursor: { x: 2, y: 3 } });
    renderBoard(parent, vm, onTile);

    click(q(parent, '.tactics-tile[data-x="3"][data-y="2"]'));
    expect(onTile.mock.calls, 'a tile click').toEqual([[{ x: 3, y: 2 }]]);
    onTile.mockClear();

    click(q(parent, '.tactics-unit[data-unit-id="1"] .tactics-sprite'));
    expect(onTile.mock.calls, 'a sprite click targets the unit tile, once').toEqual([
      [{ x: 5, y: 1 }],
    ]);
    onTile.mockClear();

    click(q(parent, '.tactics-unit[data-unit-id="1"] .tactics-hp-fill'));
    expect(onTile.mock.calls, 'a health-bar click targets the unit tile, once').toEqual([
      [{ x: 5, y: 1 }],
    ]);
    onTile.mockClear();

    click(q(parent, '.tactics-tile[data-x="6"][data-y="4"]'));
    expect(onTile.mock.calls, 'the far corner is (6,4)').toEqual([[{ x: 6, y: 4 }]]);

    const cursorTiles = [...parent.querySelectorAll('.tactics-tile--cursor')];
    expect(cursorTiles, 'exactly one cursor tile').toHaveLength(1);
    expect(cursorTiles[0].getAttribute('data-x'), 'cursor x').toBe('2');
    expect(cursorTiles[0].getAttribute('data-y'), 'cursor y').toBe('3');
  });
});

describe('renderBoard: the overlay layer (BT10.4, deferred gate — the tests still ship)', () => {
  it('BT10-4-RENDER-OVERLAYS: every overlay kind is a tactics-tile--<kind> class on exactly its tiles, an untouched tile has none, and an intent chip shows the tactics.intent.* text', () => {
    // WRONG IMPL KILLED: one shared class for every kind (the four colours collapse); a class for
    // a kind the tile does not carry; the cursor class replacing the overlay classes on its tile;
    // an intent chip for a unit with none; hold rendered as "no chip"; the chip text hard-coded.
    const overlays = new Map<string, readonly OverlayKind[]>([
      ['0,0', ['reach1']],
      ['1,0', ['reach2']],
      ['2,0', ['range']],
      ['3,0', ['aoe']],
      ['4,0', ['danger']],
      ['5,0', ['shield']],
      ['0,1', ['reach1', 'range', 'shield']],
    ]);
    const parent = mount();
    const intents: readonly [number, IntentKind | null][] = [
      [1, 'attack'],
      [2, 'move'],
      [3, 'hold'],
      [4, null],
    ];
    const units = intents.map(([id, intent]) => uvm({ unitId: id, x: id, y: 2, intent }));
    renderBoard(parent, vmOf(7, 5, units, { overlays, cursor: { x: 0, y: 1 } }), () => undefined);

    const kinds: readonly OverlayKind[] = ['reach1', 'reach2', 'range', 'aoe', 'danger', 'shield'];
    const carried = (x: number, y: number): string[] => {
      const tile = q(parent, `.tactics-tile[data-x="${x}"][data-y="${y}"]`);
      return kinds.filter((k) => tile.classList.contains(`tactics-tile--${k}`));
    };
    expect(carried(0, 0), '(0,0)').toEqual(['reach1']);
    expect(carried(1, 0), '(1,0)').toEqual(['reach2']);
    expect(carried(2, 0), '(2,0)').toEqual(['range']);
    expect(carried(3, 0), '(3,0)').toEqual(['aoe']);
    expect(carried(4, 0), '(4,0)').toEqual(['danger']);
    expect(carried(5, 0), '(5,0)').toEqual(['shield']);
    expect(carried(0, 1), 'a stacked tile keeps all three, cursor or not').toEqual([
      'reach1',
      'range',
      'shield',
    ]);
    expect(carried(6, 4), 'an untouched tile').toEqual([]);

    const chip = (id: number): HTMLElement | null =>
      parent.querySelector<HTMLElement>(`.tactics-unit[data-unit-id="${id}"] .tactics-intent`);
    expect(chip(1)?.textContent, 'attack chip').toBe(en('tactics.intent.attack'));
    expect(chip(2)?.textContent, 'move chip').toBe(en('tactics.intent.move'));
    expect(chip(3)?.textContent, 'hold chip is rendered').toBe(en('tactics.intent.hold'));
    expect(chip(4), 'no intent -> no chip').toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// styles.css contract (BT10.1 layout, A7 scope, BT10.5 reduced motion)
// ---------------------------------------------------------------------------------------------

const STYLES_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css');

/** Remove CSS block comments only (the shared stripper also eats `//`, which a url() may carry). */
function stripCssComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('/*', i);
    if (open === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, open);
    const close = src.indexOf('*/', open + 2);
    if (close === -1) break;
    i = close + 2;
  }
  return out;
}

interface CssRule {
  readonly order: number;
  readonly selectors: readonly string[];
  readonly decls: ReadonlyMap<string, string>;
  /** The whitespace-free `@media` head, or null outside any media block. */
  readonly media: string | null;
}

function parseDecls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    out.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
  }
  return out;
}

function parseCss(source: string): CssRule[] {
  const rules: CssRule[] = [];
  let order = 0;
  const walk = (src: string, media: string | null): void => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open === -1) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        j += 1;
      }
      const inner = src.slice(open + 1, j - 1);
      if (head.startsWith('@media') || head.startsWith('@supports')) {
        walk(inner, head.replace(/\s+/g, ''));
      } else if (!head.startsWith('@')) {
        rules.push({
          order: order++,
          selectors: head
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== ''),
          decls: parseDecls(inner),
          media,
        });
      }
      i = j;
    }
  };
  // Brace-less at-rules (`@import`, `@charset`, `@namespace`) would otherwise glue onto the next
  // selector and hide its rule.
  walk(stripCssComments(source).replace(/@(?:import|charset|namespace)[^;]*;/g, ''), null);
  return rules;
}

const STYLES = readFileSync(STYLES_PATH, 'utf8');
const RULES = parseCss(STYLES);

/** The merged declarations of every rule outside a media block whose selector list contains `sel`. */
function declsOf(sel: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of RULES) {
    if (rule.media !== null || !rule.selectors.includes(sel)) continue;
    for (const [k, v] of rule.decls) merged.set(k, v);
  }
  return merged;
}

/** Mean relative luminance of every #rgb / #rrggbb colour in `value`, or null when there is none. */
function meanLuminance(value: string): number | null {
  const lums: number[] = [];
  for (const m of value.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/g)) {
    let hex = m[1];
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    lums.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  if (lums.length === 0) return null;
  return lums.reduce((a, b) => a + b, 0) / lums.length;
}

describe('styles.css: the tactical board layout (BT10.1, A7)', () => {
  it('BT10-1-CSS-LAYOUT: the field is 70% high, the dock is a bordered darker band, the shared background and the CSS-cropped sprite are authored', () => {
    // WRONG IMPL KILLED: a field with no height rule (the board and dock split 50/50 or overflow);
    // a dock with no border or the same value as the field (not "visually separated"); a dock
    // background lighter than the field's; no shared-background rule (the grid on a blank page);
    // a sprite that is not the 64x64 crop of the 96x128 sheet's frame 0 (192x256 scaled sheet,
    // origin 0 0, pixelated).
    const field = declsOf('.tactics-field');
    expect(field.get('height'), '.tactics-field height').toBe('70%');

    const dock = declsOf('.tactics-dock');
    const borderTop = dock.get('border-top');
    expect(borderTop, '.tactics-dock declares border-top').toBeDefined();
    expect(
      borderTop !== undefined && borderTop !== 'none' && borderTop !== '0',
      `.tactics-dock border-top is a real border (${borderTop})`,
    ).toBe(true);
    const dockBg = dock.get('background') ?? dock.get('background-color');
    expect(dockBg, '.tactics-dock declares a background').toBeDefined();

    const bg = declsOf('.tactics-bg');
    const bgValue =
      bg.get('background') ?? bg.get('background-image') ?? bg.get('background-color');
    expect(bgValue, '.tactics-bg declares a background').toBeDefined();
    const dockLum = meanLuminance(dockBg ?? '');
    const bgLum = meanLuminance(bgValue ?? '');
    expect(
      dockLum,
      'the dock background uses hex colours (so "darker" is checkable)',
    ).not.toBeNull();
    expect(
      bgLum,
      'the field background uses hex colours (so "darker" is checkable)',
    ).not.toBeNull();
    expect(
      (dockLum ?? 255) < (bgLum ?? 0),
      `the dock (${dockLum}) is darker than the field background (${bgLum})`,
    ).toBe(true);

    const sprite = declsOf('.tactics-sprite');
    expect(sprite.get('width'), 'sprite width').toBe('64px');
    expect(sprite.get('height'), 'sprite height').toBe('64px');
    expect(sprite.get('background-size'), 'sprite background-size (96x128 sheet at 2x)').toBe(
      '192px 256px',
    );
    expect(
      ['0 0', '0px 0px', '0 0px', '0px 0'],
      'sprite background-position is the origin',
    ).toContain(sprite.get('background-position') ?? '');
    expect(sprite.get('image-rendering'), 'sprite image-rendering').toBe('pixelated');
  });

  it('BT10-1-CSS-SCOPE: no selector that mentions tactics also names mr-shell or mr-frame, and the board rules exist', () => {
    // WRONG IMPL KILLED: restyling the shared frame classes from a tactics rule (the battleView
    // roster pins mr-shell/mr-frame selectors; a `.tactics-battle.mr-shell` rule would restyle
    // every overlay shell or break that roster); an empty stylesheet that passes a "none found"
    // scan (the required selectors below make absence red).
    const tacticsSelectors = RULES.flatMap((r) => r.selectors).filter((s) => s.includes('tactics'));
    for (const needed of [
      '.tactics-battle',
      '.tactics-field',
      '.tactics-bg',
      '.tactics-grid',
      '.tactics-tile',
      '.tactics-unit',
      '.tactics-sprite',
      '.tactics-hp',
      '.tactics-hp-fill',
      '.tactics-dock',
      '.tactics-ticker',
      '.tactics-turnbar',
    ]) {
      expect(
        RULES.some((r) => r.selectors.includes(needed)),
        `a rule exists for ${needed}`,
      ).toBe(true);
    }
    for (const sel of tacticsSelectors) {
      expect(sel.includes('mr-shell'), `selector "${sel}" must not name mr-shell`).toBe(false);
      expect(sel.includes('mr-frame'), `selector "${sel}" must not name mr-frame`).toBe(false);
    }
  });

  it('BT10-5-CSS-REDUCED: under prefers-reduced-motion and under .tactics--reduced the blink animation and the hp transition are off, after the base rules', () => {
    // WRONG IMPL KILLED: a blink with no reduced-motion guard (drafted pips flash for a player who
    // asked for no motion); the guard placed BEFORE the base rule (the later base animation wins);
    // a guard that sets animation to something other than none; the hp-bar transition left on;
    // only the media query or only the class (the shell's boolean and the OS preference are two
    // channels); no base blink animation at all (the guard would be vacuous).
    const base = RULES.find((r) => r.media === null && r.selectors.includes('.tactics-blink'));
    expect(base, 'a base .tactics-blink rule exists').toBeDefined();
    const baseAnim = base?.decls.get('animation') ?? base?.decls.get('animation-name');
    expect(baseAnim, 'the base blink declares an animation').toBeDefined();
    expect(baseAnim === 'none', 'the base blink animation is a real animation').toBe(false);
    expect(STYLES.includes('@keyframes'), 'a @keyframes block exists for the blink').toBe(true);

    const reducedMedia = RULES.filter(
      (r) => r.media !== null && r.media.includes('prefers-reduced-motion:reduce'),
    );
    const blinkOff = reducedMedia.find((r) =>
      r.selectors.some((s) => s.includes('.tactics-blink')),
    );
    expect(blinkOff, 'the reduced-motion media block mentions .tactics-blink').toBeDefined();
    expect(
      blinkOff?.decls.get('animation') ?? blinkOff?.decls.get('animation-name'),
      'blink animation is none under reduced motion',
    ).toBe('none');
    expect(
      (blinkOff?.order ?? -1) > (base?.order ?? Number.POSITIVE_INFINITY),
      'the guard follows the base blink rule',
    ).toBe(true);

    const hpOff = reducedMedia.find((r) => r.selectors.some((s) => s.includes('.tactics-hp-fill')));
    expect(hpOff, 'the reduced-motion media block mentions .tactics-hp-fill').toBeDefined();
    expect(hpOff?.decls.get('transition'), 'hp transition is none under reduced motion').toBe(
      'none',
    );

    const classOff = RULES.find(
      (r) =>
        r.media === null &&
        r.selectors.some((s) => s.includes('.tactics--reduced') && s.includes('.tactics-blink')),
    );
    expect(classOff, 'a .tactics--reduced .tactics-blink rule exists').toBeDefined();
    expect(
      classOff?.decls.get('animation') ?? classOff?.decls.get('animation-name'),
      'blink animation is none under .tactics--reduced',
    ).toBe('none');
  });
});
