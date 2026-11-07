// @vitest-environment happy-dom
/**
 * rowCard.test.ts: the RowCard kit primitive (uif-3, UIF3.5).
 *
 * `createRowCard(doc, { title, lines? })` returns one `.mr-card` holding a `.mr-card-title` and one
 * `.mr-card-line` per line, written as text. A screen writes ONE card into each nav row through
 * `renderNav`'s `fill`, so renderNav owns the row (and its `is-active` class) and the card is its
 * content: the active-row CSS (`.mr-nav-item.is-active > .mr-card`) needs the card to be a direct
 * child of the row.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { NavLayout, NavState } from './nav';
import { renderNav } from './navRender';
import { createRowCard } from './rowCard';

const itm = (key: string) => ({ key, enabled: true });
const listL = (keys: readonly string[]): NavLayout => ({ kind: 'list', items: keys.map(itm) });
const state = (item: string | null): NavState => ({ tab: null, item, perTab: {} });

describe('createRowCard', () => {
  it('UIF3.5 builds one .mr-card with the title first, then one .mr-card-line per line, in order', () => {
    // WRONG IMPLS KILLED: lines joined into one element (no per-line separation); the title after
    // the lines; a card per line; duplicate lines collapsed; the title written into a line.
    const card = createRowCard(document, { title: 'Sparky', lines: ['Lv 5', 'HP 20/20', 'Lv 5'] });
    expect(card.classList.contains('mr-card')).toBe(true);
    expect(Array.from(card.children).map((c) => c.className)).toEqual([
      'mr-card-title',
      'mr-card-line',
      'mr-card-line',
      'mr-card-line',
    ]);
    expect(Array.from(card.children).map((c) => c.textContent)).toEqual([
      'Sparky',
      'Lv 5',
      'HP 20/20',
      'Lv 5',
    ]);
    expect(card.querySelectorAll('.mr-card-title').length).toBe(1);
  });

  it('UIF3.5 a card with no lines, or an empty lines list, holds only the title; each call is a new element', () => {
    // WRONG IMPLS KILLED: an empty placeholder line element; a shared singleton card.
    for (const input of [{ title: 'T' }, { title: 'T', lines: [] }]) {
      const card = createRowCard(document, input);
      expect(card.children.length).toBe(1);
      expect(card.querySelector('.mr-card-line')).toBeNull();
      expect(card.querySelector('.mr-card-title')?.textContent).toBe('T');
    }
    const a = createRowCard(document, { title: 'A' });
    const b = createRowCard(document, { title: 'B' });
    expect(a).not.toBe(b);
    expect(a.textContent).toBe('A');
  });

  it('UIF3.5 writes the title and every line as text, never markup', () => {
    // WRONG IMPLS KILLED: innerHTML for the title or a line (a monster nickname is player text).
    const bad = '<img src=x onerror=alert(1)><i>i</i>';
    const card = createRowCard(document, { title: bad, lines: [bad, '<b>x</b>'] });
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('i')).toBeNull();
    expect(card.querySelector('b')).toBeNull();
    for (const part of Array.from(card.children)) expect(part.childElementCount).toBe(0);
    expect(card.querySelector('.mr-card-title')?.textContent).toBe(bad);
    expect(Array.from(card.querySelectorAll('.mr-card-line')).map((l) => l.textContent)).toEqual([
      bad,
      '<b>x</b>',
    ]);
  });

  it('UIF3.5 through renderNav fill: N entries give N rows each holding exactly one card, and the active row matches .mr-nav-item.is-active > .mr-card on a real node', () => {
    // WRONG IMPLS KILLED: a card that is not the row's direct child (the active-row selector would
    // match nothing and the card would be dark on dark); a card appended again on every render (the
    // rows would grow); a fill that is shared across rows (one card moved between rows).
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 7 }), (n, at) => {
        const keys = Array.from({ length: n }, (_, k) => `k${k}`);
        const container = document.createElement('div');
        document.body.appendChild(container);
        const fill = (el: HTMLElement, item: { key: string }): void => {
          el.appendChild(createRowCard(document, { title: `T ${item.key}`, lines: ['line'] }));
        };
        const activeKey = keys[at % n] as string;
        renderNav(container, listL(keys), state(activeKey), { frame: 'cards', fill });
        const nextKey = keys[(at + 1) % n] as string;
        renderNav(container, listL(keys), state(nextKey), { frame: 'cards', fill });

        const rows = Array.from(container.children) as HTMLElement[];
        expect(rows.length).toBe(n);
        for (const row of rows) {
          expect(row.querySelectorAll('.mr-card').length).toBe(1);
          expect(row.firstElementChild?.classList.contains('mr-card')).toBe(true);
          expect(row.children.length).toBe(1);
        }
        const activeRows = rows.filter((r) => r.matches('.mr-nav-item.is-active'));
        expect(activeRows.length).toBe(1);
        expect(activeRows[0]?.dataset.navKey).toBe(nextKey);
        const hit = container.querySelectorAll('.mr-nav-item.is-active > .mr-card');
        expect(hit.length).toBe(1);
        expect((hit[0] as HTMLElement).parentElement).toBe(activeRows[0] as HTMLElement);
        expect((hit[0] as HTMLElement).querySelector('.mr-card-title')?.textContent).toBe(
          `T ${nextKey}`,
        );
        container.remove();
      }),
      { numRuns: 60 },
    );
  });
});
