// ui/contextSheet.ts — the bordered mini-menu of a frame (uif-3, UIF3.3-UIF3.4; wireframes "Verdict: sheet
// placement"). One `[data-context-sheet]` root per frame, reused across its list, confirm and detail
// variants, so a sub-list replaces rows rather than stacking. Sheets are adapter phases, not stack
// frames: closing is B through the adapter, and the caller then calls `closeContextSheet` and moves focus.
//
// Call `renderContextSheet`, mount `root` in the frame body, then `placeContextSheet`; place again after
// any content swap or resize, because the row count sizes the sheet. The detail variant is centered by
// CSS over the list it keeps behind it and never anchored.
//
// The kit writes only caller text, through `textContent`; rows come from `renderNav`.
import type { NavItem, NavLayout, NavState } from './nav';
import { checkFrameId, renderNav } from './navRender';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface AnchorResult {
  readonly corner: 'bl' | 'br' | 'tl' | 'tr';
  readonly rect: Rect;
  /** The sheet is shorter than its content, so its rows scroll. */
  readonly scrolls: boolean;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Where a sheet goes (WF1-A1): the corner horizontally away from the slot's center, the bottom one
 *  first with the sheet growing upward, then the top one if the bottom one would touch the slot, else
 *  capped to the taller free band. `reserve` is the height kept free at the foot of `area` for the
 *  feedback strip. Total for any positive area and sheet: the rect stays inside `area`, its height is
 *  positive and never above the sheet's own, on tiny bodies because `reserve` and `inset` give way. */
export function anchorSheet(input: {
  readonly area: Rect;
  readonly slot: Rect;
  readonly sheet: { readonly w: number; readonly h: number };
  readonly inset: number;
  readonly reserve?: number;
  readonly minHeight?: number;
}): AnchorResult {
  const { area, slot, sheet } = input;
  const reserve = Math.min(input.reserve ?? 0, area.h / 2);
  const usable = area.h - reserve;
  const inset = Math.min(input.inset, Math.min(area.w, usable) / 4);
  const h0 = Math.min(sheet.h, usable - 2 * inset);
  const w = Math.min(sheet.w, area.w - 2 * inset);
  const side = slot.x + slot.w / 2 < area.x + area.w / 2 ? 'r' : 'l';
  const at = (v: 't' | 'b', h: number): AnchorResult => ({
    corner: `${v}${side}`,
    rect: {
      x: side === 'r' ? area.x + area.w - w - inset : area.x + inset,
      y: v === 't' ? area.y + inset : area.y + usable - h - inset,
      w,
      h,
    },
    scrolls: h < sheet.h,
  });
  const bottom = at('b', h0);
  if (!overlaps(bottom.rect, slot)) return bottom;
  const top = at('t', h0);
  if (!overlaps(top.rect, slot)) return top;
  const above = slot.y - area.y;
  const below = area.y + usable - (slot.y + slot.h);
  const floor = Math.min(Math.max(1, input.minHeight ?? 4 * inset), h0);
  return at(above >= below ? 't' : 'b', Math.max(floor, Math.max(above, below) - 2 * inset));
}

export interface ContextSheet {
  /** The frame id prefixing the row ids. */
  readonly frame: string;
  readonly root: HTMLElement;
  /** The title or the confirm question; `hidden` when there is none. */
  readonly heading: HTMLElement;
  /** The detail variant's text; `hidden` otherwise. */
  readonly prose: HTMLElement;
  /** The nav container: the sheet's one tab stop. */
  readonly rows: HTMLElement;
}

interface SheetRows {
  readonly layout: NavLayout;
  readonly state: NavState;
  readonly fill: (el: HTMLElement, item: NavItem) => void;
}

export type ContextSheetContent = SheetRows &
  (
    | { readonly variant: 'list'; readonly title?: string }
    | { readonly variant: 'confirm'; readonly question: string }
    | { readonly variant: 'detail'; readonly title?: string; readonly prose: string }
  );

function part(doc: Document, root: HTMLElement, className: string): HTMLElement {
  const el = doc.createElement('div');
  el.className = className;
  root.appendChild(el);
  return el;
}

export function createContextSheet(doc: Document, opts: { readonly frame: string }): ContextSheet {
  checkFrameId(opts.frame);
  const root = doc.createElement('div');
  root.className = 'mr-sheet';
  root.setAttribute('data-context-sheet', '');
  root.hidden = true;
  const heading = part(doc, root, 'mr-sheet-title');
  heading.id = `${opts.frame}-sheet-title`;
  heading.hidden = true;
  const prose = part(doc, root, 'mr-sheet-prose');
  prose.hidden = true;
  const rows = part(doc, root, 'mr-sheet-rows mr-nav-list mr-scroll');
  return { frame: opts.frame, root, heading, prose, rows };
}

function clearPlacement(sheet: ContextSheet): void {
  sheet.root.style.left = '';
  sheet.root.style.top = '';
  sheet.root.style.height = '';
}

function writeText(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.hidden = text === '';
}

/** Shows the sheet with this content. Never writes a height: the row count sizes the sheet. */
export function renderContextSheet(sheet: ContextSheet, content: ContextSheetContent): void {
  const heading = content.variant === 'confirm' ? content.question : (content.title ?? '');
  const isDetail = content.variant === 'detail';
  sheet.root.dataset.sheetVariant = content.variant;
  sheet.root.classList.toggle('mr-sheet--detail', isDetail);
  if (isDetail) clearPlacement(sheet);
  writeText(sheet.heading, heading);
  writeText(sheet.prose, isDetail ? content.prose : '');
  renderNav(sheet.rows, content.layout, content.state, {
    frame: sheet.frame,
    fill: content.fill,
    ...(heading === '' ? {} : { labelledBy: sheet.heading.id }),
  });
  sheet.root.hidden = false;
}

/** Hides the sheet and empties it, so nothing it named stays in the document. */
export function closeContextSheet(sheet: ContextSheet): void {
  sheet.root.hidden = true;
  writeText(sheet.heading, '');
  writeText(sheet.prose, '');
  renderNav(
    sheet.rows,
    { kind: 'list', items: [] },
    { tab: null, item: null, perTab: {} },
    { frame: sheet.frame, fill: () => {} },
  );
}

/** Inset from the body's edges, and the feedback strip kept free at its foot (wireframes, geometry). */
const SHEET_INSET_REM = 0.75;
const FEEDBACK_STRIP_REM = 1.75;

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** Anchors a shown, mounted sheet away from `slot`; `body` is its containing block. Returns null for
 *  the detail variant, which CSS centers. */
export function placeContextSheet(
  sheet: ContextSheet,
  body: HTMLElement,
  slot: Element,
): AnchorResult | null {
  clearPlacement(sheet);
  if (sheet.root.dataset.sheetVariant === 'detail') return null;
  const rem = Number.parseFloat(
    getComputedStyle(sheet.root.ownerDocument.documentElement).fontSize,
  );
  const area = rectOf(body);
  const own = rectOf(sheet.root);
  const placed = anchorSheet({
    area,
    slot: rectOf(slot),
    sheet: { w: own.w, h: own.h },
    inset: SHEET_INSET_REM * rem,
    reserve: FEEDBACK_STRIP_REM * rem,
  });
  sheet.root.style.left = `${placed.rect.x - area.x}px`;
  sheet.root.style.top = `${placed.rect.y - area.y + body.scrollTop}px`;
  if (placed.scrolls) sheet.root.style.height = `${placed.rect.h}px`;
  return placed;
}
