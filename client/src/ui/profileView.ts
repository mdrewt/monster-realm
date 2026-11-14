// ui/profileView.ts — the Profile screen (uif-16b, #586 D3): ONE dialog whose three sections are the
// rename form (Name), the claim prompt (Account) and the privacy surface (Privacy), then Close.
//
// This view owns what makes the screen one overlay: the frame root (`#profile-overlay`), its title,
// the Close row, the a11y open and close (role, label, the one focus trap, the deferred anchor) and
// the one column of rows the D-pad walks. The three sections (`renameView.ts`, `claimView.ts`,
// `privacyView.ts`) keep their own controls, labels, models and element ids; they hold no a11y of
// their own and are shown and hidden only through this frame, so a section is never up alone.
//
// THE SHELL IS CONSTRUCTED (the claimView / privacyView route): the root is built here, in the
// frame layer, as the kit's frame anatomy: the title bar, then a body that grows and scrolls
// (`.mr-frame-body`). The section roots are moved into that body in column order, the Close row
// last: three sections are taller than a 720-px window, so the body scrolls under the fixed title
// and a focused row scrolls into view. The body does NOT wear the list cue `.mr-scroll`: its
// gradients would sit behind running text, where contrast can no longer be measured. Separators
// and spacing between sections are inline token styles (`styles.css` holds class and `:root`
// rules only).
//
// FOCUS. The OPEN edge is `overlayA11y.ts`'s: its deferred anchor is the name field
// (`OVERLAY_A11Y.profileView`), so an open on Name lands there one macrotask later and the opening
// key is not typed into the field. An open on Account or Privacy seats that section's default row
// at once, which the deferred anchor then leaves alone (it never pulls focus that is already inside
// the frame). On an already-open frame `show()` moves no focus: only the row tokens (`applyRowOp`),
// `focusSection` and the sections' own confirm edges do.
import { t } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import {
  type ProfileSection,
  type RowOp,
  type RowSection,
  type RowsView,
  walkSection,
} from './screens/profileScreen';

/** A section as the frame drives it: its rows, and its own show and hide (labels, display and
 *  whatever a close resets or disarms). */
export interface ProfileSectionView extends RowSection {
  show(): void;
  hide(): void;
}

/** The sections in column order. */
const SECTION_ORDER: readonly ProfileSection[] = ['name', 'account', 'privacy'];

/** A new element with `id` and `className`. */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  id: string,
  className: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.id = id;
  el.className = className;
  return el;
}

/** Draw the separator above `el` from the tokens, with room on both sides of the line. Written
 *  as longhands: a `var()` inside the `border-top` shorthand does not survive every CSSOM. */
function separate(el: HTMLElement): void {
  el.style.borderTopWidth = 'var(--mr-border-thin)';
  el.style.borderTopStyle = 'solid';
  el.style.borderTopColor = 'var(--mr-separator)';
  el.style.marginTop = 'var(--mr-space-3)';
  el.style.paddingTop = 'var(--mr-space-3)';
}

export class ProfileView implements RowsView, RowSection {
  readonly #root: HTMLElement;
  readonly #title: HTMLElement;
  readonly #closeBtn: HTMLButtonElement;
  /** The scrolling body holding the sections and the Close row. */
  readonly #body: HTMLElement;
  readonly #sections: Readonly<Record<ProfileSection, ProfileSectionView>>;
  // The last row token applied: a token is applied once (ui/screens/profileScreen.ts).
  #lastOp: RowOp | null = null;

  constructor(sections: Readonly<Record<ProfileSection, ProfileSectionView>>) {
    this.#sections = sections;
    // The frame goes where its sections were built (the frame layer): read before it takes them.
    const anchor = sections.name.sectionRoot.parentElement ?? document.body;
    this.#root = element('div', 'profile-overlay', 'mr-frame mr-shell');
    this.#root.style.display = 'none';
    const bar = element('div', 'profile-titlebar', 'mr-frame-titlebar');
    this.#title = element('div', 'profile-title', 'mr-frame-title');
    bar.appendChild(this.#title);
    this.#root.appendChild(bar);
    const body = element('div', 'profile-body', 'mr-frame-body');
    this.#body = body;
    this.#root.appendChild(body);
    for (const [i, key] of SECTION_ORDER.entries()) {
      const section = sections[key].sectionRoot;
      if (i > 0) separate(section);
      body.appendChild(section);
    }
    const closeRow = element('div', 'profile-close-row', 'mr-button-rows');
    separate(closeRow);
    this.#closeBtn = element('button', 'profile-close-btn', '');
    this.#closeBtn.type = 'button';
    this.#closeBtn.addEventListener('click', () => this.hide());
    closeRow.appendChild(this.#closeBtn);
    body.appendChild(closeRow);
    anchor.appendChild(this.#root);
  }

  /** Shown as a flex column (`.mr-frame`'s own layout, restated inline over the hidden state):
   *  that is what gives the body the height left under the title bar, so the body scrolls and the
   *  shell does not. */
  get visible(): boolean {
    return this.#root.style.display === 'flex';
  }

  /** Show the frame with all three sections. Only the hidden->visible edge opens the dialog and
   *  places focus: on Name the deferred anchor does (header), on Account or Privacy that section's
   *  default row is seated at once. A repeat show() repaints the labels and moves nothing. */
  show(section: ProfileSection = 'name'): void {
    const wasVisible = this.visible;
    // Resolved on EVERY show(): the locale may be negotiated after this view is constructed.
    this.#title.textContent = t('menu.profile.title');
    this.#closeBtn.textContent = t('privacy.close');
    for (const key of SECTION_ORDER) this.#sections[key].show();
    this.#root.style.display = 'flex';
    if (wasVisible) return;
    // Every open reads from the top: the body keeps no scroll offset from the last open.
    this.#body.scrollTop = 0;
    // LAST, after every write above, so the anchor resolves against a painted root.
    openOverlayA11y('profileView', this.#root);
    if (section !== 'name') this.focusSection(section);
  }

  /** Hide the frame and every section: each section's own hide runs its reset (the rename draft
   *  and lock, both two-step confirms), so no close path leaves one armed. */
  hide(): void {
    this.#root.style.display = 'none';
    for (const key of SECTION_ORDER) this.#sections[key].hide();
    // DELIBERATELY UNGUARDED (see pvpView.ts's header): with no open record it is a no-op.
    closeOverlayA11y('profileView', null);
  }

  /** Move focus to `section`: its default row, or Close when it has no row to offer (a privacy
   *  phase with every control refused). */
  focusSection(section: ProfileSection): void {
    (this.#sections[section].defaultRow() ?? this.#closeBtn).focus();
  }

  /** The section holding `el`, if any (Close and the page are in none). */
  sectionOf(el: Element | null): ProfileSection | undefined {
    if (el === null) return undefined;
    return SECTION_ORDER.find((key) => this.#sections[key].sectionRoot.contains(el));
  }

  /** The Close row: always shown, never disabled. */
  get closeRow(): HTMLButtonElement {
    return this.#closeBtn;
  }

  /** The frame root. */
  get sectionRoot(): HTMLElement {
    return this.#root;
  }

  /** The one column: each section's rows in order, then Close. */
  sectionRows(): readonly HTMLElement[] {
    return [...SECTION_ORDER.flatMap((key) => this.#sections[key].sectionRows()), this.#closeBtn];
  }

  /** Whether either two-step confirm is armed. */
  get armed(): boolean {
    return SECTION_ORDER.some((key) => this.#sections[key].armed);
  }

  /** With no row focused: an armed confirm's No (the deletion's before the decline's), else the
   *  first row of the column. */
  defaultRow(): HTMLElement | undefined {
    const armed = [...SECTION_ORDER].reverse().find((key) => this.#sections[key].armed);
    return armed === undefined ? this.sectionRows()[0] : this.#sections[armed].defaultRow();
  }

  /** One press on the column. The cursor is DOM focus; with no row focused it only seats the
   *  default row, so an A never confirms anything nobody chose. A move that ENTERS a section whose
   *  confirm is armed lands on that confirm's No, not on the row nearest the section it left (the
   *  confirm's Yes sits first): a confirm defaults to No however the cursor reaches it. A on the
   *  name field presses nothing (the field's own Enter commits); on a button it clicks, so every
   *  handler's own gate holds. */
  applyRowOp(op: RowOp): void {
    if (op === this.#lastOp) return;
    this.#lastOp = op;
    const from = this.sectionOf(document.activeElement);
    const press = walkSection(this, document.activeElement, op);
    const entered = this.sectionOf(document.activeElement);
    if (entered !== undefined && entered !== from && this.#sections[entered].armed) {
      this.#sections[entered].defaultRow()?.focus();
    }
    if (press instanceof HTMLButtonElement) press.click();
  }
}
