// ui/healView.ts — DOM shell for the heal overlay.
// DOM shell — coverage-excluded
//
// THE SECOND WIRING MECHANISM. This overlay has NO `show()`: it is opened and closed by
// `render(vm | null)`, driven every store batch from `main.ts`. So the a11y open/close cannot hang
// off `show()`/`hide()` the way the other seven views' do; it hangs off the null<->non-null EDGE of
// the vm, detected against `this.visible` BEFORE the display write.
//
// WHY THE EDGE IS DERIVED FROM `visible` AND NOT FROM A `#lastVmWasNull` FIELD. A field updated
// inside `render()` never sees `hide()` -- and for THIS view that is not hypothetical, since it is
// opened by `render(vm)` (`main.ts:545-547`) but closed by `hide()` (`main.ts:1382`, `:364`), so after a hide the field still reads
// "was non-null", the next `render(vm)` is not a field transition, and the re-opened overlay ships
// no role, no label, no focus and no trap -- while passing every single-cycle test. `visible` is the
// one fact both paths already write, so it cannot drift from itself.
//
// THE CLOSE GUARDS ARE ASYMMETRIC ON PURPOSE. The `render(null)` branch IS guarded: A11Y-34 forbids
// invoking the helper "on a repeat render at the same nullity", and a guarded branch costs nothing. `hide()` is NOT
// guarded -- see the reasoning in `ui/pvpView.ts`'s `hide()`: an unguarded close is the self-healing
// path, and `closeOverlayA11y` with no open record is a documented no-op.
//
// The strings this view owns are resolved through the i18n resolver (ui/i18n/resolver.ts): the
// location row (`tf('heal.location', { cost })`), the question (`tf('heal.prompt.question',
// { cost })`), its Yes / No and the disabled reason; `cost` is `formatHealCostLine(loc)`'s text —
// model-owned copy (healModel.ts), interpolated verbatim.
//
// THE QUESTION AND THE D-PAD (ctl-8a, CTL8A.3). "Heal party for N?" with Yes / No sits OUTSIDE
// `#heal-list` (HL-01 / HL-02 pin that list to its rows), in elements this view creates. The heal
// screen (ui/screens/healScreen.ts) paints the cursor and the cost; the frame opens from a keydown
// with no store batch, so the hidden→visible edge draws the opening state (Yes, the first row's
// cost) itself, and the kept paint is re-applied after every batch `render(vm)`.
//
// THE TITLE AND THE KEPT ROWS. The frame opens with a title bar (`.mr-frame-titlebar`, the first
// child of `#heal-overlay`) holding `#heal-title`, built here with no text; its `heal.title` text is
// resolved on every `render(vm)`, so a locale switch applies. A batch `render(vm)` whose locations
// and locale are what `#heal-list` already shows keeps its rows: a store batch arrives several times
// a second, and a rebuilt row drops a pointer press that spans it.

import { formatHealCostLine, type HealViewModel } from './healModel';
import { currentLocale, t, tf } from './i18n/resolver';
import { list } from './nav';
import { renderNav } from './navRender';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';

/** The Yes / No option labels by nav key, as thunks (resolved per render; ids stay literals). */
const OPTION_LABELS: Readonly<Record<string, () => string>> = {
  yes: () => t('prompt.yes'),
  no: () => t('prompt.no'),
};

/** What the heal screen paints: the cursor, and the cost line (null: no bound location, Heal
 *  disabled with a reason). */
export interface HealPaint {
  readonly active: 'yes' | 'no';
  readonly cost: string | null;
}

/** Locate-or-create `#id` right after `after` (a second view against the same document creates
 *  nothing). */
function part(after: Element, id: string, tag: 'p' | 'div'): HTMLElement {
  const existing = document.getElementById(id);
  if (existing !== null) return existing;
  const el = document.createElement(tag);
  el.id = id;
  after.insertAdjacentElement('afterend', el);
  return el;
}

/** The rows' render key: the locations and the locale their text resolves in. JSON, with bigints
 *  as decimal strings. */
const rowsKey = (vm: HealViewModel): string =>
  JSON.stringify([currentLocale(), vm.locations], (_, v: unknown) =>
    typeof v === 'bigint' ? `${v}` : v,
  );

export class HealView {
  private overlay: HTMLElement;
  private list: HTMLElement;
  readonly #title: HTMLElement;
  /** What `#heal-list` shows (`rowsKey`); null until the first render. */
  #shownRows: string | null = null;
  readonly #question: HTMLElement;
  readonly #reason: HTMLElement;
  readonly #options: HTMLElement;
  #paint: HealPaint = { active: 'yes', cost: null };

  constructor() {
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.overlay = document.getElementById('heal-overlay')!;
    // biome-ignore lint/style/noNonNullAssertion: elements are required in index.html
    this.list = document.getElementById('heal-list')!;
    // The title bar, first in the frame (uif-10 frame anatomy). Located before it is created.
    const title = document.getElementById('heal-title');
    if (title !== null) {
      this.#title = title;
    } else {
      this.#title = document.createElement('h2');
      this.#title.id = 'heal-title';
      this.#title.className = 'mr-frame-title';
      const bar = document.createElement('div');
      bar.className = 'mr-frame-titlebar';
      bar.append(this.#title);
      this.overlay.prepend(bar);
    }
    // Token spacing (uif-10, UIF10.3): no UA list indent, so the header line starts at the frame's
    // content edge like every other screen's first row.
    this.list.style.margin = '0';
    this.list.style.padding = '0';
    // The prompt, after and outside the list. No strings here: text is written per render.
    this.#question = part(this.list, 'heal-question', 'p');
    this.#reason = part(this.#question, 'heal-reason', 'p');
    this.#options = part(this.#reason, 'heal-options', 'div');
  }

  render(vm: HealViewModel | null): void {
    const wasVisible = this.visible;
    if (!vm) {
      this.overlay.style.display = 'none';
      if (wasVisible) closeOverlayA11y('healView', null);
      return;
    }
    this.overlay.style.display = 'block';
    if (!wasVisible) {
      // The opening state, from the same facts the screen's `init` reads: at the open the legacy vm
      // is the bound location's (one row, or none when its id is unknown).
      const first = vm.locations[0];
      this.#paint = { active: 'yes', cost: first === undefined ? null : formatHealCostLine(first) };
    }
    this.#title.textContent = t('heal.title');
    const key = rowsKey(vm);
    if (key !== this.#shownRows) {
      this.#shownRows = null;
      this.list.replaceChildren();
      vm.locations.forEach((loc) => {
        const li = document.createElement('li');
        const cost = formatHealCostLine(loc);
        li.textContent = tf('heal.location', { cost });
        li.dataset.locationId = String(loc.locationId);
        this.list.appendChild(li);
      });
      this.#shownRows = key;
    }
    this.#apply(this.#paint);
    // The null->non-null EDGE, and only the edge -- paint first, then claim the
    // overlay (D7: openOverlayA11y is the LAST statement, so its deferred focus resolves
    // `initialFocusSelector` against a fully-painted root).
    if (!wasVisible) openOverlayA11y('healView', this.overlay);
  }

  get visible(): boolean {
    return this.overlay.style.display !== 'none' && this.overlay.style.display !== '';
  }

  /** The screen's paint: kept, so the next batch render re-applies it. */
  paint(p: HealPaint): void {
    this.#paint = p;
    this.#apply(p);
  }

  #apply(p: HealPaint): void {
    const enabled = p.cost !== null;
    this.#question.textContent =
      p.cost === null ? '' : tf('heal.prompt.question', { cost: p.cost });
    this.#question.hidden = !enabled;
    this.#reason.textContent = enabled ? '' : t('heal.prompt.unavailable');
    this.#reason.hidden = enabled;
    renderNav(
      this.#options,
      list([
        { key: 'yes', enabled },
        { key: 'no', enabled: true },
      ]),
      { tab: null, item: p.active, perTab: {} },
      {
        frame: 'heal',
        labelledBy: enabled ? 'heal-question' : 'heal-reason',
        fill: (el, item) => {
          el.textContent = OPTION_LABELS[item.key]?.() ?? '';
        },
      },
    );
  }

  hide(): void {
    this.overlay.style.display = 'none';
    // Deliberately UNGUARDED (rationale in ui/pvpView.ts's hide()).
    closeOverlayA11y('healView', null);
  }
}
