// tactics/boardRender.ts — the DOM painter for a BoardVM (BT10.1 grid / units / health bars /
// CSS-cropped sprites / pointer; BT10.4 overlay classes and intent chips).
//
// Stateless: it paints a view-model into `parent` and replaces whatever a previous call painted;
// the shell owns the cursor. createElement + textContent + setAttribute only (a species name is
// data, never markup), and every word comes from tactics/strings.ts.
//
// Layout: ONE `.tactics-bg` (the shared CSS background) holds ONE `.tactics-grid`. Tiles and units
// both sit on explicit grid lines (CSS grid lines start at 1) so an explicitly placed unit never
// pushes the auto-placed tiles around it.
import type { BoardVM, Tile, UnitVM } from './boardModel';
import * as s from './strings';

function placeOnGrid(el: HTMLElement, x: number, y: number): void {
  el.style.setProperty('grid-column', String(x + 1));
  el.style.setProperty('grid-row', String(y + 1));
}

function paintTile(vm: BoardVM['tiles'][number], onTile: (tile: Tile) => void): HTMLElement {
  const tile = document.createElement('div');
  tile.className = 'tactics-tile';
  for (const kind of vm.overlays) tile.classList.add(`tactics-tile--${kind}`);
  if (vm.cursor) tile.classList.add('tactics-tile--cursor');
  tile.setAttribute('data-x', String(vm.x));
  tile.setAttribute('data-y', String(vm.y));
  placeOnGrid(tile, vm.x, vm.y);
  tile.addEventListener('click', () => onTile({ x: vm.x, y: vm.y }));
  return tile;
}

function paintUnit(vm: UnitVM, onTile: (tile: Tile) => void): HTMLElement {
  const unit = document.createElement('div');
  unit.className = `tactics-unit tactics-unit--${vm.side === 'A' ? 'side-a' : 'side-b'}`;
  if (vm.mine) unit.classList.add('tactics-unit--mine');
  if (vm.active) unit.classList.add('tactics-unit--active');
  unit.setAttribute('data-unit-id', String(vm.unitId));
  placeOnGrid(unit, vm.x, vm.y);
  // The unit element sits above its tile and would swallow the click: it targets its own tile.
  unit.addEventListener('click', () => onTile({ x: vm.x, y: vm.y }));

  const sprite = document.createElement('div');
  sprite.className = 'tactics-sprite';
  if (vm.spriteSlug === null) sprite.classList.add('tactics-sprite--none');
  else sprite.style.backgroundImage = `url("assets/monster-${vm.spriteSlug}.png")`;
  unit.appendChild(sprite);

  const hp = document.createElement('div');
  hp.className = `tactics-hp tactics-hp--${vm.hpBand}`;
  const fill = document.createElement('div');
  fill.className = 'tactics-hp-fill';
  fill.style.width = `${vm.hpPermille / 10}%`;
  hp.appendChild(fill);
  unit.appendChild(hp);

  // The name is TEXT (escaped on serialisation), never an attribute value.
  const name = document.createElement('div');
  name.className = 'tactics-unit-name';
  name.textContent = vm.speciesName;
  unit.appendChild(name);

  if (vm.intent !== null) {
    const chip = document.createElement('div');
    chip.className = `tactics-intent tactics-intent--${vm.intent}`;
    chip.textContent = s.intentLabel(vm.intent);
    unit.appendChild(chip);
  }
  return unit;
}

/** Paints `vm` into `parent` (replacing what a previous call painted). `onTile` fires when the
 *  pointer clicks a tile (or anything inside it, including the unit standing on it). */
export function renderBoard(parent: HTMLElement, vm: BoardVM, onTile: (tile: Tile) => void): void {
  const grid = document.createElement('div');
  grid.className = 'tactics-grid';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', s.boardLabel());
  grid.style.setProperty('grid-template-columns', `repeat(${vm.width}, 1fr)`);
  grid.style.setProperty('grid-template-rows', `repeat(${vm.height}, 1fr)`);
  grid.style.setProperty('aspect-ratio', `${vm.width} / ${vm.height}`);
  for (const tile of vm.tiles) grid.appendChild(paintTile(tile, onTile));
  for (const unit of vm.units) grid.appendChild(paintUnit(unit, onTile));

  const bg = document.createElement('div');
  bg.className = 'tactics-bg';
  bg.appendChild(grid);
  parent.replaceChildren(bg);
}
