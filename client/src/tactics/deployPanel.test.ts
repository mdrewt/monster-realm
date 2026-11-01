// @vitest-environment happy-dom
/**
 * tactics/deployPanel.test.ts — bt-12 RED tests for the wild pack >= 2 confirm screen and its
 * formation editor (BT12.2), the remembered-formation rule (BT12.3), the panel's text (BT12.6) and
 * the battle-frame switch's shared a11y record (BT12.1).
 *
 * SOURCE OF TRUTH: spec `### bt-12` BT12.1 / BT12.2 / BT12.3 / BT12.6; plan
 * memory/projects/monster-realm-bt-12-plan.md §3.4 (deployPanel API + input model), §3.8 (DOM), as
 * amended by REV 2 A3 (BT12-1-VIEW-SWITCH-A11Y), A4 (resolveFormation: the DEFAULT examples and ONE
 * property), A6 (CONFIRM mode: Start is NOT a send; EDIT mode: Start sends; `mode` getter), A11 (a
 * rejected deploy leaves the editor usable) and REV 2b B2 (deployVM READS the remembered formation;
 * slotCount is the map's, never 3; picksOf keeps sparse slot numbers) and B5 (the lock is a TOKEN: a
 * settle after hide() touches neither the DOM nor the overlay record).
 *
 * DOM CONTRACT (plan §3.8, ids `tactics-deploy-row-<key>`): the root is
 * `div.mr-frame.mr-shell.mr-shell--top.mr-shell--battle.tactics-deploy` (display none until shown)
 * holding `h2.tactics-title[data-testid=battle-title][tabindex=-1]`; in CONFIRM mode
 * `ul.tactics-deploy-formation[aria-label]` > `li.tactics-deploy-slot[data-slot=i]` >
 * `span.tactics-deploy-slot-label` + (`span.tactics-deploy-name` / `-level` / `-hp` | `-empty`); in
 * EDIT mode `div.tactics-deploy-candidate[role=group][aria-label]` > `button.tactics-deploy-prev`,
 * the candidate's name / level / hp spans, `button.tactics-deploy-next`; then
 * `div.tactics-menu[role=listbox][tabindex=0][aria-label][aria-activedescendant]` >
 * `button.tactics-menu-row[role=option][data-row][aria-selected]#tactics-deploy-row-<key>` >
 * `span.tactics-menu-label` (rows `deploy`, `edit`; or `slot-<i>` (+ the occupant's spans),
 * `confirm`, `back`); while sending `p.tactics-deploy-status` and `aria-disabled="true"` on every row.
 *
 * Every fixture monster id sits past 2^53; every number read back is a distinct prime. A fake
 * `onDeploy` records each send and either settles at once or hands the test its resolve / reject.
 * Strings are read from CATALOG_EN / CATALOG_FR (the resolver's locale cell is switched per case).
 *
 * RED REASON: every export of tactics/deployPanel.ts throws `bt-12: not implemented` on the API-freeze
 * stub (the DeployPanel constructor included), `hideOtherBattleViews` throws, and the 14 + 4
 * `tactics.deploy.*` catalog keys are absent.
 *
 * Do NOT edit these tests to match a buggy implementation; correct them from the spec only.
 */
import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeployPick } from '../module_bindings/types';
import { type BattleViewLike, hideOtherBattleViews } from '../ui/battlePolicy';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import { CATALOG_FR } from '../ui/i18n/catalog.fr';
import { setLocale } from '../ui/i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from '../ui/overlayA11y';
import type { BattleOp } from '../ui/screens/battleScreen';
import {
  type DeployInput,
  type DeployMonster,
  DeployPanel,
  type DeployVM,
  deployVM,
  type PartyMember,
  picksOf,
  resolveFormation,
} from './deployPanel';
import { ResultsPanel, type ResultsVM } from './results';

// --- fixtures -----------------------------------------------------------------------------------

const BATTLE = 9_007_199_254_740_993n;
const NEXT_BATTLE = 9_007_199_254_741_011n;

const mon = (
  monsterId: bigint,
  name: string,
  level: number,
  hp: number,
  maxHp: number,
): DeployMonster => ({ monsterId, name, level, hp, maxHp });

const M1 = mon(9_007_199_254_740_995n, 'Sprigg', 7, 23, 29);
const M2 = mon(9_007_199_254_740_997n, 'Cindertail', 11, 31, 37);
const M3 = mon(9_007_199_254_740_999n, 'Mossback', 13, 41, 43);
/** Fainted (0 HP): never a candidate, never deployed. */
const DOWN_MON = mon(9_007_199_254_741_001n, 'Kip', 17, 0, 47);
/** A remembered id that is not in the party (boxed or traded away). */
const STRANGER = 9_007_199_254_741_003n;

/** Three conscious monsters, the formation in party order. */
const VM3: DeployVM = { battleId: BATTLE, candidates: [M1, M2, M3], formation: [M1, M2, M3] };

const UP: BattleOp = { kind: 'move', dir: 'Up' };
const DOWN: BattleOp = { kind: 'move', dir: 'Down' };
const LEFT: BattleOp = { kind: 'move', dir: 'Left' };
const RIGHT: BattleOp = { kind: 'move', dir: 'Right' };
const A: BattleOp = { kind: 'activate' };
const B: BattleOp = { kind: 'back' };
const X: BattleOp = { kind: 'danger' };
const LB: BattleOp = { kind: 'cycle', dir: -1 };
const RB: BattleOp = { kind: 'cycle', dir: 1 };
const START: BattleOp = { kind: 'start' };

const pick = (m: DeployMonster, slot: number): DeployPick => ({ monsterId: m.monsterId, slot });

interface Send {
  readonly battleId: bigint;
  readonly picks: DeployPick[];
}
interface Settle {
  readonly resolve: () => void;
  readonly reject: (err: unknown) => void;
}
interface Mounted {
  readonly panel: DeployPanel;
  readonly host: HTMLElement;
  readonly sends: Send[];
  readonly pending: Settle[];
  readonly root: () => HTMLElement;
}

/** A DeployPanel on a fresh host under document.body, rendered and shown with `vm` (unless null).
 *  `settle: 'now'` resolves every send at once; `'manual'` hands the test each resolve / reject. */
function mount(vm: DeployVM | null, settle: 'now' | 'manual' = 'now'): Mounted {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const sends: Send[] = [];
  const pending: Settle[] = [];
  const panel = new DeployPanel(host, {
    onDeploy: (battleId, picks) => {
      sends.push({ battleId, picks: picks.map((p) => ({ monsterId: p.monsterId, slot: p.slot })) });
      if (settle === 'now') return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  });
  if (vm !== null) {
    panel.render(vm);
    panel.show();
  }
  const root = (): HTMLElement => {
    const r = host.querySelector<HTMLElement>('.tactics-deploy');
    if (r === null) throw new Error('the panel built no .tactics-deploy root under its parent');
    return r;
  };
  return { panel, host, sends, pending, root };
}

const ops = (panel: DeployPanel, ...list: readonly BattleOp[]): void => {
  for (const op of list) panel.applyBattleOp(op);
};

/** The menu rows' keys, in order. */
const rowKeys = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('.tactics-menu [role="option"]')].map(
    (el) => el.getAttribute('data-row') ?? '',
  );
/** The key of the row the cursor is on (`aria-selected="true"`). */
const cursorKey = (root: HTMLElement): string | null =>
  root
    .querySelector('.tactics-menu [role="option"][aria-selected="true"]')
    ?.getAttribute('data-row') ?? null;
/** The confirm screen's slot occupants by name, null for an empty slot. */
const formationNames = (root: HTMLElement): (string | null)[] =>
  [...root.querySelectorAll('.tactics-deploy-formation .tactics-deploy-slot')].map(
    (li) => li.querySelector('.tactics-deploy-name')?.textContent ?? null,
  );
/** The editor's slot rows' occupants by name, null for an empty slot. */
const editorNames = (root: HTMLElement): (string | null)[] =>
  [...root.querySelectorAll('.tactics-menu [role="option"]')]
    .filter((el) => (el.getAttribute('data-row') ?? '').startsWith('slot-'))
    .map((el) => el.querySelector('.tactics-deploy-name')?.textContent ?? null);
/** The editor's candidate, by name. */
const candidateName = (root: HTMLElement): string | null =>
  root.querySelector('.tactics-deploy-candidate .tactics-deploy-name')?.textContent ?? null;
const statusLine = (root: HTMLElement): Element | null =>
  root.querySelector('p.tactics-deploy-status');
const disabledRows = (root: HTMLElement): number =>
  root.querySelectorAll('.tactics-menu [role="option"][aria-disabled="true"]').length;

/** A real macrotask: every settled promise's continuation has run. */
const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

function click(el: Element | null, what: string): void {
  expect(el, `precondition: ${what} is painted`).not.toBeNull();
  (el as Element).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

type Catalog = Record<string, unknown>;
const EN = CATALOG_EN as unknown as Catalog;
const FR = CATALOG_FR as unknown as Catalog;

/** A catalog value (a closure called with `params`); a missing key fails loudly by name. */
function cat(catalog: Catalog, key: string, params: Record<string, unknown> = {}): string {
  const value = catalog[key];
  if (typeof value === 'function') return (value as (p: Record<string, unknown>) => string)(params);
  if (typeof value !== 'string') throw new Error(`catalog key missing: ${key}`);
  return value;
}

/** Every non-blank text node under `root`, trimmed. */
function textsOf(root: HTMLElement): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    if (text !== '') out.push(text);
  }
  return out;
}

afterEach(() => {
  closeOverlayA11y('helpView', null);
  closeOverlayA11y('battleView', null);
  document.body.replaceChildren();
  setLocale('en');
});

// --- BT12.2: the view model and the confirm screen -------------------------------------------------

describe('deploy panel: the view model and the confirm screen (bt-12, BT12.2)', () => {
  it('deployVM lists only conscious monsters as candidates, in party order, and fills the formation from the remembered ids that are conscious party members, in remembered order, then the rest of the conscious party, up to the map`s slot count [BT12-2-DEPLOY-VM]', () => {
    // WRONG IMPL KILLED (REV 2b B2): a VM that ignores `remembered` (party order every time: the
    // fixture's remembered order Mossback, Sprigg differs from it); a fainted monster listed as a
    // candidate or deployed (it is remembered first here); a remembered stranger kept; a hard-coded
    // 3 slots (the slotCount-2 and slotCount-5 fixtures); `hp >= 0` as the consciousness gate (0 HP
    // is fainted) or `hp > 1` (1 HP is conscious); a candidate list in remembered order.
    const input: DeployInput = {
      battleId: BATTLE,
      party: [M1, M2, M3, DOWN_MON],
      remembered: [M3.monsterId, DOWN_MON.monsterId, STRANGER, M1.monsterId],
      slotCount: 3,
    };
    const vm = deployVM(input);
    expect(vm.battleId, 'the battle id, past 2^53, exactly').toBe(BATTLE);
    expect(vm.candidates, 'the conscious party, in party order; the fainted Kip never').toEqual([
      M1,
      M2,
      M3,
    ]);
    expect(
      vm.formation,
      'remembered conscious ids first (Mossback, Sprigg), then the party (Cindertail)',
    ).toEqual([M3, M1, M2]);
    expect(deployVM({ ...input, slotCount: 2 }).formation, 'two spawn cells: two slots').toEqual([
      M3,
      M1,
    ]);
    expect(
      deployVM({ ...input, slotCount: 5 }).formation,
      'five slots for three conscious monsters: the rest stay empty',
    ).toEqual([M3, M1, M2, null, null]);
    expect(deployVM({ ...input, remembered: [] }).formation, 'no memory: party order').toEqual([
      M1,
      M2,
      M3,
    ]);
    const firstDown = deployVM({
      battleId: BATTLE,
      party: [DOWN_MON, M2, M1],
      remembered: [],
      slotCount: 3,
    });
    expect(firstDown.candidates, 'a fainted lead is skipped, the order kept').toEqual([M2, M1]);
    expect(firstDown.formation, 'and the third slot stays empty').toEqual([M2, M1, null]);
    const oneHp = mon(9_007_199_254_741_005n, 'Pip', 19, 1, 53);
    expect(
      deployVM({ battleId: BATTLE, party: [oneHp], remembered: [], slotCount: 3 }).candidates,
      '1 HP is conscious',
    ).toEqual([oneHp]);
    const allDown = deployVM({
      battleId: BATTLE,
      party: [DOWN_MON],
      remembered: [DOWN_MON.monsterId],
      slotCount: 3,
    });
    expect(allDown.candidates, 'an all-fainted party offers nobody').toEqual([]);
    expect(allDown.formation, 'and deploys nobody').toEqual([null, null, null]);
  });

  it('picksOf keeps each filled slot`s own number (a sparse assignment is never renumbered); the shown confirm screen sends the formation`s picks exactly once on A over Deploy, its cursor wraps between Deploy and Edit formation, Left / Right do nothing, and Start is not a send [BT12-2-DEPLOY-A-SENDS]', () => {
    // WRONG IMPL KILLED: picks numbered by FILLED index (the sparse [null, Cindertail, Mossback]
    // would send slots 0 and 1 for spawn cells 1 and 2); A that sends nothing, sends twice, or sends
    // the candidates instead of the formation; a confirm-mode Start that sends (A6: Start at the
    // confirm screen opens the main menu through main.ts); a cursor that does not wrap or that
    // Left / Right move; a panel visible (or not display:none) before show().
    expect(picksOf([M3, M1, M2]), 'every slot filled').toEqual([
      pick(M3, 0),
      pick(M1, 1),
      pick(M2, 2),
    ]);
    expect(picksOf([null, M2, M3]), 'a sparse assignment keeps slots 1 and 2').toEqual([
      pick(M2, 1),
      pick(M3, 2),
    ]);
    expect(picksOf([M1, null]), 'a trailing gap is dropped').toEqual([pick(M1, 0)]);
    expect(picksOf([null, null]), 'nothing filled, nothing picked').toEqual([]);

    const m = mount(null);
    const root = m.root();
    for (const cls of ['mr-frame', 'mr-shell', 'mr-shell--top', 'mr-shell--battle']) {
      expect(root.classList.contains(cls), `the root is a battle-frame shell: .${cls}`).toBe(true);
    }
    expect(m.panel.visible, 'not visible before show()').toBe(false);
    expect(root.style.display, 'display none before show()').toBe('none');
    m.panel.render(VM3);
    m.panel.show();
    expect(m.panel.visible, 'visible once shown').toBe(true);
    expect(root.style.display, 'displayed once shown').not.toBe('none');
    expect(m.panel.mode, 'the confirm screen first').toBe('confirm');
    expect(rowKeys(root), 'its two rows').toEqual(['deploy', 'edit']);
    expect(cursorKey(root), 'the cursor starts on Deploy').toBe('deploy');
    expect(
      root.querySelector('.tactics-menu')?.getAttribute('aria-activedescendant'),
      'the listbox names the cursor row',
    ).toBe('tactics-deploy-row-deploy');
    expect(formationNames(root), 'the formation, slot by slot').toEqual([
      'Sprigg',
      'Cindertail',
      'Mossback',
    ]);

    ops(m.panel, START);
    expect(m.sends, 'Start on the confirm screen sends nothing').toEqual([]);
    expect(m.panel.mode, 'and opens no editor').toBe('confirm');
    ops(m.panel, DOWN);
    expect(cursorKey(root), 'Down: Edit formation').toBe('edit');
    ops(m.panel, DOWN);
    expect(cursorKey(root), 'Down again wraps to Deploy').toBe('deploy');
    ops(m.panel, UP);
    expect(cursorKey(root), 'Up wraps to Edit formation').toBe('edit');
    ops(m.panel, LEFT, RIGHT);
    expect(cursorKey(root), 'Left / Right do nothing').toBe('edit');
    expect(m.sends, 'no move sends').toEqual([]);
    ops(m.panel, UP, A);
    expect(m.sends, 'A on Deploy sends the formation`s picks, once').toEqual([
      { battleId: BATTLE, picks: [pick(M1, 0), pick(M2, 1), pick(M3, 2)] },
    ]);

    const sparse = mount({ battleId: BATTLE, candidates: [M2, M3], formation: [null, M2, M3] });
    ops(sparse.panel, A);
    expect(sparse.sends, 'a sparse formation sends slots 1 and 2').toEqual([
      { battleId: BATTLE, picks: [pick(M2, 1), pick(M3, 2)] },
    ]);
  });

  it('X opens the formation editor on the first slot with that slot`s monster as candidate; LB / RB cycle the conscious candidates with wrap, the D-pad picks a slot, A assigns (a monster already placed swaps places), and Confirm or Start sends the edited picks; the Edit formation row opens it too, and the cursor and candidate follow identity across a re-render [BT12-2-DEPLOY-EDITOR]', () => {
    // WRONG IMPL KILLED: X ignored (the editor unreachable from the controller once the router
    // routes X, R-bt-11-ROUTERX); a candidate starting at index 0 instead of the slot's monster; a
    // cycle without wrap, or LB and RB swapped; an assignment that duplicates a monster instead of
    // swapping (the server refuses duplicate picks); Confirm or editor Start sending the ORIGINAL
    // formation; a moved monster renumbered to slot 0; the cursor or candidate held by index (a
    // re-render with the candidates reordered jumps to another monster); a candidate no longer
    // offered kept anyway.
    const m = mount(VM3);
    const root = m.root();
    ops(m.panel, X);
    expect(m.panel.mode, 'X opens the editor').toBe('edit');
    expect(rowKeys(root), 'a row per slot, then Confirm and Back').toEqual([
      'slot-0',
      'slot-1',
      'slot-2',
      'confirm',
      'back',
    ]);
    expect(cursorKey(root), 'the cursor on the first slot').toBe('slot-0');
    expect(candidateName(root), 'the candidate is the first slot`s monster').toBe('Sprigg');
    expect(editorNames(root), 'the assignment starts as the formation').toEqual([
      'Sprigg',
      'Cindertail',
      'Mossback',
    ]);
    expect(
      root.querySelector('.tactics-deploy-formation'),
      'the confirm list is not shown in the editor',
    ).toBeNull();
    ops(m.panel, RB);
    expect(candidateName(root), 'RB: the next conscious monster').toBe('Cindertail');
    ops(m.panel, RB);
    expect(candidateName(root), 'RB again').toBe('Mossback');
    ops(m.panel, RB);
    expect(candidateName(root), 'RB wraps to the first').toBe('Sprigg');
    ops(m.panel, LB);
    expect(candidateName(root), 'LB wraps back to the last').toBe('Mossback');
    ops(m.panel, LEFT, RIGHT);
    expect(cursorKey(root), 'Left / Right do not move the cursor').toBe('slot-0');
    expect(candidateName(root), 'nor the candidate').toBe('Mossback');
    ops(m.panel, DOWN, A);
    expect(
      editorNames(root),
      'A on slot 2 places Mossback there, and the slot it left takes Cindertail (a swap)',
    ).toEqual(['Sprigg', 'Mossback', 'Cindertail']);
    expect(m.sends, 'assigning sends nothing').toEqual([]);
    expect(m.panel.hint(), 'the hint bar`s verbs for the editor').toEqual({
      start: 'submit',
      undo: false,
    });
    ops(m.panel, DOWN, DOWN);
    expect(cursorKey(root), 'down to Confirm').toBe('confirm');
    ops(m.panel, A);
    expect(m.sends, 'Confirm sends the EDITED picks, once').toEqual([
      { battleId: BATTLE, picks: [pick(M1, 0), pick(M3, 1), pick(M2, 2)] },
    ]);

    const viaRow = mount(VM3);
    ops(viaRow.panel, DOWN, A);
    expect(viaRow.panel.mode, 'A on Edit formation opens the editor').toBe('edit');
    expect(cursorKey(viaRow.root()), 'on the first slot').toBe('slot-0');
    ops(viaRow.panel, RB, A, START);
    expect(viaRow.sends, 'Start in the editor sends the assignment').toEqual([
      { battleId: BATTLE, picks: [pick(M2, 0), pick(M1, 1), pick(M3, 2)] },
    ]);

    const sparse = mount({ battleId: BATTLE, candidates: [M1], formation: [M1, null, null] });
    ops(sparse.panel, X, DOWN, DOWN);
    expect(cursorKey(sparse.root()), 'the third slot').toBe('slot-2');
    ops(sparse.panel, A);
    expect(editorNames(sparse.root()), 'Sprigg moved to the third slot').toEqual([
      null,
      null,
      'Sprigg',
    ]);
    ops(sparse.panel, START);
    expect(sparse.sends, 'the moved monster keeps its slot number').toEqual([
      { battleId: BATTLE, picks: [pick(M1, 2)] },
    ]);

    const held = mount(VM3);
    ops(held.panel, X, RB, RB, DOWN, DOWN, DOWN);
    expect(cursorKey(held.root()), 'fixture: the cursor on Confirm').toBe('confirm');
    expect(candidateName(held.root()), 'fixture: Mossback is the candidate').toBe('Mossback');
    held.panel.render({ battleId: BATTLE, candidates: [M3, M1, M2], formation: [M1, M2, M3] });
    expect(cursorKey(held.root()), 'a re-render keeps the cursor on its row').toBe('confirm');
    expect(candidateName(held.root()), 'and the candidate by monster id, not by index').toBe(
      'Mossback',
    );
    held.panel.render({ battleId: BATTLE, candidates: [M1, M2], formation: [M1, M2, null] });
    expect(
      candidateName(held.root()),
      'a candidate no longer offered falls back to the first one offered',
    ).toBe('Sprigg');
  });

  it('there is no back-out: B on the confirm screen does nothing and sends nothing, and in the editor B (or its Back row) returns to the confirm screen on Edit formation with the edits discarded, which A on Deploy then sends unedited [BT12-2-DEPLOY-NO-BACKOUT]', () => {
    // WRONG IMPL KILLED: B on the confirm screen hiding the panel, sending an empty deploy or
    // fleeing (the spec: no back-out); the confirm screen reacting to LB / RB; a Back that keeps the
    // edits (the confirm screen and A then deploy what the player discarded); a Back that lands the
    // cursor on Deploy (one more A would deploy at once); X in the editor doing anything.
    const m = mount(VM3);
    const root = m.root();
    ops(m.panel, B);
    expect(m.sends, 'B at the confirm screen sends nothing').toEqual([]);
    expect(m.panel.mode, 'and stays there').toBe('confirm');
    expect(m.panel.visible, 'the panel stays shown').toBe(true);
    expect(root.style.display, 'and displayed').not.toBe('none');
    expect(cursorKey(root), 'the cursor unmoved').toBe('deploy');
    ops(m.panel, LB, RB);
    expect(m.sends, 'LB / RB at the confirm screen send nothing').toEqual([]);
    expect(m.panel.mode, 'and open nothing').toBe('confirm');

    ops(m.panel, X, RB, A);
    expect(editorNames(root), 'fixture: an edit (Cindertail into the first slot)').toEqual([
      'Cindertail',
      'Sprigg',
      'Mossback',
    ]);
    ops(m.panel, X);
    expect(m.panel.mode, 'X in the editor does nothing').toBe('edit');
    expect(editorNames(root), 'and changes nothing').toEqual(['Cindertail', 'Sprigg', 'Mossback']);
    ops(m.panel, B);
    expect(m.panel.mode, 'B leaves the editor').toBe('confirm');
    expect(cursorKey(root), 'onto Edit formation').toBe('edit');
    expect(formationNames(root), 'the edits are discarded').toEqual([
      'Sprigg',
      'Cindertail',
      'Mossback',
    ]);
    ops(m.panel, X);
    expect(editorNames(root), 'reopened, the editor starts from the formation again').toEqual([
      'Sprigg',
      'Cindertail',
      'Mossback',
    ]);
    ops(m.panel, DOWN, DOWN, DOWN, DOWN);
    expect(cursorKey(root), 'down to Back').toBe('back');
    ops(m.panel, A);
    expect(m.panel.mode, 'A on Back leaves the editor too').toBe('confirm');
    expect(cursorKey(root), 'onto Edit formation').toBe('edit');
    expect(m.sends, 'nothing sent on the way').toEqual([]);
    ops(m.panel, UP, A);
    expect(m.sends, 'A on Deploy then sends the unedited formation').toEqual([
      { battleId: BATTLE, picks: [pick(M1, 0), pick(M2, 1), pick(M3, 2)] },
    ]);
  });

  it('a send locks the panel until the deploy promise settles: a status line, every row aria-disabled, no second send and no other op but a move; a resolve or a REJECTION unlocks it with the editor usable, hide() releases it too, a settle after hide() touches neither the DOM nor the overlay record, and a new battle starts unlocked [BT12-2-DEPLOY-LOCK]', async () => {
    // WRONG IMPL KILLED: no lock (a double A sends deploy_units twice); a lock released on the SEND
    // instead of the settle; a lock released only in a `.then` (a REJECTED deploy — a party monster
    // in an open trade — strands the panel locked: A11); a lock never released by hide() (a dropped
    // link's promise never settles: R10); a settle that re-shows, re-opens or closes the overlay
    // record or writes a status line after hide() (the shown root's dialog role torn down: B5's
    // token); a lock that survives into the next battle; X, Start, B or LB / RB acting while sending.
    const m = mount(VM3, 'manual');
    const root = m.root();
    ops(m.panel, A);
    expect(m.sends, 'the first A sends').toHaveLength(1);
    expect(statusLine(root)?.textContent, 'the sending line shows').toBe(
      cat(EN, 'tactics.deploy.sending'),
    );
    expect(disabledRows(root), 'every row is aria-disabled').toBe(rowKeys(root).length);
    expect(rowKeys(root).length, 'fixture: rows exist').toBeGreaterThan(0);
    ops(m.panel, A, START, X, B, LB, RB);
    expect(m.sends, 'no second send while the first is in flight').toHaveLength(1);
    expect(m.panel.mode, 'and no editor opens').toBe('confirm');
    ops(m.panel, DOWN);
    expect(cursorKey(root), 'a move still moves').toBe('edit');
    ops(m.panel, A);
    expect(m.panel.mode, 'but A on Edit formation does nothing while sending').toBe('confirm');
    m.pending[0]?.resolve();
    await tick();
    expect(statusLine(root), 'a resolved deploy removes the sending line').toBeNull();
    expect(disabledRows(root), 'and every aria-disabled').toBe(0);
    ops(m.panel, UP, A);
    expect(m.sends, 'unlocked: A sends again').toHaveLength(2);

    const r = mount(VM3, 'manual');
    ops(r.panel, A);
    r.pending[0]?.reject(new Error('deploy_units: monster 9007199254740995 is in an open trade'));
    await tick();
    expect(statusLine(r.root()), 'a REJECTED deploy removes the sending line').toBeNull();
    expect(disabledRows(r.root()), 'and every aria-disabled').toBe(0);
    ops(r.panel, X);
    expect(r.panel.mode, 'the editor is usable again').toBe('edit');
    ops(r.panel, START);
    expect(r.sends, 'and its Start sends').toEqual([
      { battleId: BATTLE, picks: [pick(M1, 0), pick(M2, 1), pick(M3, 2)] },
      { battleId: BATTLE, picks: [pick(M1, 0), pick(M2, 1), pick(M3, 2)] },
    ]);

    const h = mount(VM3, 'manual');
    ops(h.panel, A);
    h.panel.hide();
    h.panel.render(VM3);
    h.panel.show();
    ops(h.panel, A);
    expect(h.sends, 'hide() released the lock: the first promise never settled').toHaveLength(2);

    for (const outcome of ['resolve', 'reject'] as const) {
      const t = mount(VM3, 'manual');
      ops(t.panel, A);
      t.panel.hide();
      const other = document.createElement('div');
      document.body.appendChild(other);
      openOverlayA11y('battleView', other);
      if (outcome === 'resolve') t.pending[0]?.resolve();
      else t.pending[0]?.reject(new Error('settled late'));
      await tick();
      expect(
        other.getAttribute('role'),
        `${outcome} after hide(): the record now open is another root's, untouched`,
      ).toBe('dialog');
      expect(other.getAttribute('aria-modal'), `${outcome}: still aria-modal`).toBe('true');
      expect(t.root().getAttribute('role'), `${outcome}: the hidden deploy root has no role`).toBe(
        null,
      );
      expect(t.root().style.display, `${outcome}: and stays hidden`).toBe('none');
      expect(statusLine(t.root()), `${outcome}: no status line written while hidden`).toBeNull();
      closeOverlayA11y('battleView', null);
    }

    const n = mount(VM3, 'manual');
    ops(n.panel, A);
    n.panel.render({ ...VM3, battleId: NEXT_BATTLE });
    ops(n.panel, A);
    expect(
      n.sends.map((send) => send.battleId),
      'a new battle id starts unlocked',
    ).toEqual([BATTLE, NEXT_BATTLE]);
  });

  it('a pointer click on a row moves the cursor there and activates it, and a click on the editor`s previous / next buttons cycles the candidate: the same picks as the D-pad, A and LB / RB [BT12-2-DEPLOY-POINTER]', () => {
    // WRONG IMPL KILLED: rows with no click route (a pointer player cannot deploy or edit); a click
    // that only moves the cursor (a second click needed) or activates the OLD cursor row; prev /
    // next swapped or inert; a click path that diverges from the op path (the same sequence must
    // send the same picks).
    const m = mount(VM3);
    const root = m.root();
    click(root.querySelector('#tactics-deploy-row-edit'), 'the Edit formation row');
    expect(m.panel.mode, 'a click on Edit formation opens the editor').toBe('edit');
    click(root.querySelector('.tactics-deploy-next'), 'the next button');
    expect(candidateName(root), 'next: the following candidate').toBe('Cindertail');
    click(root.querySelector('.tactics-deploy-prev'), 'the previous button');
    expect(candidateName(root), 'previous: back').toBe('Sprigg');
    click(root.querySelector('.tactics-deploy-prev'), 'the previous button');
    expect(candidateName(root), 'previous wraps').toBe('Mossback');
    click(root.querySelector('#tactics-deploy-row-slot-1'), 'the second slot row');
    expect(cursorKey(root), 'the click moved the cursor to the second slot').toBe('slot-1');
    expect(editorNames(root), 'and assigned the candidate there').toEqual([
      'Sprigg',
      'Mossback',
      'Cindertail',
    ]);
    expect(m.sends, 'no send yet').toEqual([]);
    click(root.querySelector('#tactics-deploy-row-back'), 'the Back row');
    expect(m.panel.mode, 'a click on Back leaves the editor').toBe('confirm');
    expect(formationNames(root), 'discarding the edit').toEqual([
      'Sprigg',
      'Cindertail',
      'Mossback',
    ]);
    click(root.querySelector('#tactics-deploy-row-edit'), 'the Edit formation row');
    click(root.querySelector('.tactics-deploy-next'), 'the next button');
    click(root.querySelector('#tactics-deploy-row-slot-0'), 'the first slot row');
    click(root.querySelector('#tactics-deploy-row-confirm'), 'the Confirm row');
    expect(m.sends, 'a click on Confirm sends the edited picks').toEqual([
      { battleId: BATTLE, picks: [pick(M2, 0), pick(M1, 1), pick(M3, 2)] },
    ]);

    const viaOps = mount(VM3);
    ops(viaOps.panel, X, RB, A, DOWN, DOWN, DOWN, A);
    expect(viaOps.sends, 'the D-pad, LB / RB and A send the same picks').toEqual(m.sends);

    const d = mount(VM3);
    click(d.root().querySelector('#tactics-deploy-row-deploy'), 'the Deploy row');
    expect(d.sends, 'a click on Deploy sends the formation').toEqual([
      { battleId: BATTLE, picks: [pick(M1, 0), pick(M2, 1), pick(M3, 2)] },
    ]);
  });
});

// --- BT12.3: the remembered formation rule ---------------------------------------------------------

describe('deploy panel: resolveFormation (bt-12, BT12.3)', () => {
  it('resolveFormation keeps the server`s cases: no memory deploys the first conscious members in party order, a fainted or traded-away remembered id is replaced from party order, never a duplicate, capped at the spawn count, an all-fainted party deploys nobody [BT12-3-RESOLVE-DEFAULT]', () => {
    // The examples of server-module/src/tactics_tests.rs `resolve_formation_keeps_remembered_
    // conscious_party_ids_then_fills_from_party_order_bt8_2` (the ids 101-104, 109, 777 are the
    // server's), plus cap 0. WRONG IMPL KILLED: the default of the spec ("the first 3 conscious party
    // members") broken by a fainted second member; a fainted or stranger id kept; a duplicate
    // remembered id deployed twice; the cap ignored; an all-fainted party padded with the fainted.
    const [ma, mb, mc, md, down, stranger] = [101n, 102n, 103n, 104n, 109n, 777n];
    const member = (monsterId: bigint, conscious: boolean): PartyMember => ({
      monsterId,
      conscious,
    });
    const party = [member(ma, true), member(mb, true), member(mc, true), member(down, false)];
    expect(
      resolveFormation([ma, down, mb], party, 3),
      'a fainted remembered id is skipped and the gap filled from party order',
    ).toEqual([ma, mb, mc]);
    expect(
      resolveFormation([stranger, mb], party, 3),
      'a remembered id outside the party (boxed, traded away) is dropped',
    ).toEqual([mb, ma, mc]);
    expect(
      resolveFormation(
        [],
        [
          member(ma, true),
          member(down, false),
          member(mb, true),
          member(mc, true),
          member(md, true),
        ],
        3,
      ),
      'no memory: the first three conscious members in party order',
    ).toEqual([ma, mb, mc]);
    expect(resolveFormation([mb, mb, ma], party, 3), 'never a duplicate').toEqual([mb, ma, mc]);
    expect(resolveFormation([mc, mb, ma], party, 2), 'capped at the spawn count').toEqual([mc, mb]);
    expect(
      resolveFormation([ma], [member(ma, false), member(down, false)], 3),
      'an all-fainted party deploys nobody',
    ).toEqual([]);
    expect(resolveFormation([ma, mb], party, 0), 'cap 0 deploys nobody').toEqual([]);
  });

  it('for any remembered list (duplicates and strangers included), any party and any cap from 0 to 5, resolveFormation returns distinct conscious party ids, min(cap, conscious) of them: the remembered conscious ones first in remembered order, then the rest in party order, with ids 2^53 and 2^53 + 1 kept apart [BT12-3-RESOLVE-PROPERTY]', () => {
    // WRONG IMPL KILLED (REV 2 A4, REV 2b B7): an id outside the conscious party returned (i); a
    // dedupe that keys on Number(id) — 2^53 and 2^53 + 1 collide and one is lost (ii / iii / iv);
    // the cap ignored or off by one, cap 0 included (iii); the remembered order replaced by party
    // order (iv); the fill taken from remembered order, from fainted members or out of party
    // order (v).
    const COLLIDE_A = 9_007_199_254_740_992n;
    const COLLIDE_B = 9_007_199_254_740_993n;
    const idArb = fc.oneof(fc.constantFrom(COLLIDE_A, COLLIDE_B), fc.bigInt({ min: 1n, max: 12n }));
    const partyArb = fc.uniqueArray(fc.record({ monsterId: idArb, conscious: fc.boolean() }), {
      selector: (m) => m.monsterId,
      maxLength: 7,
    });
    let capZero = 0;
    let collidingPair = 0;
    fc.assert(
      fc.property(
        fc.array(idArb, { maxLength: 9 }),
        partyArb,
        fc.integer({ min: 0, max: 5 }),
        (remembered, party, cap) => {
          const out = resolveFormation(remembered, party, cap);
          const conscious = party.filter((m) => m.conscious).map((m) => m.monsterId);
          expect(
            out.filter((id) => !conscious.includes(id)),
            '(i) every id is a conscious party member',
          ).toEqual([]);
          expect(new Set(out).size, '(ii) no id twice').toBe(out.length);
          expect(out.length, '(iii) min(cap, conscious) ids').toBe(Math.min(cap, conscious.length));
          const fromMemory: bigint[] = [];
          for (const id of remembered) {
            if (conscious.includes(id) && !fromMemory.includes(id)) fromMemory.push(id);
          }
          const head = fromMemory.slice(0, cap);
          expect(
            out.slice(0, head.length),
            '(iv) first the remembered conscious ids, deduplicated, in remembered order',
          ).toEqual(head);
          const rest = conscious.filter((id) => !fromMemory.includes(id));
          expect(
            out.slice(head.length),
            '(v) then the rest of the conscious party in party order',
          ).toEqual(rest.slice(0, Math.max(0, cap - head.length)));
          if (cap === 0) capZero += 1;
          if (
            conscious.includes(COLLIDE_A) &&
            conscious.includes(COLLIDE_B) &&
            Math.min(cap, conscious.length) >= 2
          ) {
            collidingPair += 1;
          }
        },
      ),
      {
        numRuns: 400,
        examples: [
          [
            [COLLIDE_B, COLLIDE_A],
            [
              { monsterId: COLLIDE_A, conscious: true },
              { monsterId: COLLIDE_B, conscious: true },
            ],
            2,
          ],
          [[COLLIDE_A], [{ monsterId: COLLIDE_A, conscious: true }], 0],
        ],
      },
    );
    expect(capZero, 'ANTI-VACUITY: cap 0 was exercised').toBeGreaterThan(0);
    expect(
      collidingPair,
      'ANTI-VACUITY: 2^53 and 2^53 + 1 were both deployable together',
    ).toBeGreaterThan(0);
    expect(
      resolveFormation(
        [COLLIDE_B, COLLIDE_A],
        [
          { monsterId: COLLIDE_A, conscious: true },
          { monsterId: COLLIDE_B, conscious: true },
        ],
        2,
      ),
      'the two ids past 2^53 are two monsters, in remembered order',
    ).toEqual([COLLIDE_B, COLLIDE_A]);
  });
});

// --- BT12.6: the panel's text ----------------------------------------------------------------------

describe('deploy panel: every string from the catalog (bt-12, BT12.6)', () => {
  it('every text and accessible name the deploy panel paints is exactly its catalog value or model data, in English and in French: the deploy title (never the battle frame`s title), the formation label, the slot labels, level and HP lines, the empty slot, the rows, the editor`s title, candidate group and buttons, and the sending line [BT12-6-DEPLOY-TEXT-FROM-CATALOG]', () => {
    // WRONG IMPL KILLED: a literal English word in the panel (a French boot shows English: the
    // sweep finds it); the deploy title taken from `battle.title` (the 1v1 view's "Battle"); a slot
    // label 0-based or without its number; the level / HP lines built by string concatenation; the
    // empty slot left blank; the prev / next buttons with a visible glyph or word instead of a CSS
    // glyph and a catalog aria-label; the sending line hard-coded; a live region on the panel.
    const PANEL_KEYS = [
      'tactics.deploy.title',
      'tactics.deploy.label',
      'tactics.deploy.empty',
      'tactics.deploy.deploy',
      'tactics.deploy.edit',
      'tactics.deploy.sending',
      'tactics.deploy.candidateLabel',
      'tactics.deploy.prevMonster',
      'tactics.deploy.nextMonster',
      'tactics.deploy.confirm',
      'tactics.deploy.back',
    ];
    for (const key of PANEL_KEYS) {
      expect(cat(FR, key), `${key}: the French is a translation`).not.toBe(cat(EN, key));
    }
    for (const [locale, C] of [
      ['en', EN],
      ['fr', FR],
    ] as const) {
      setLocale(locale);
      const m = mount(
        { battleId: BATTLE, candidates: [M1, M2], formation: [M1, M2, null] },
        'manual',
      );
      const root = m.root();
      const title = root.querySelector('h2.tactics-title');
      expect(title?.getAttribute('data-testid'), `${locale}: the title is the frame anchor`).toBe(
        'battle-title',
      );
      expect(title?.getAttribute('tabindex'), `${locale}: focusable by script only`).toBe('-1');
      expect(title?.textContent, `${locale}: the title is tactics.deploy.title`).toBe(
        cat(C, 'tactics.deploy.title'),
      );
      expect(title?.textContent, `${locale}: never the 1v1 view's battle.title`).not.toBe(
        cat(C, 'battle.title'),
      );
      expect(
        root.querySelector('ul.tactics-deploy-formation')?.getAttribute('aria-label'),
        `${locale}: the formation list's name`,
      ).toBe(cat(C, 'tactics.deploy.label'));
      const slots = [...root.querySelectorAll('li.tactics-deploy-slot')];
      expect(
        slots.map((li) => li.getAttribute('data-slot')),
        `${locale}: one item per slot`,
      ).toEqual(['0', '1', '2']);
      const span = (cls: string): (string | null)[] =>
        slots.map((li) => li.querySelector(`.${cls}`)?.textContent ?? null);
      expect(span('tactics-deploy-slot-label'), `${locale}: the slot labels, 1-based`).toEqual([
        cat(C, 'tactics.deploy.slot', { n: 1 }),
        cat(C, 'tactics.deploy.slot', { n: 2 }),
        cat(C, 'tactics.deploy.slot', { n: 3 }),
      ]);
      expect(span('tactics-deploy-name'), `${locale}: the names are data`).toEqual([
        'Sprigg',
        'Cindertail',
        null,
      ]);
      expect(span('tactics-deploy-level'), `${locale}: the level lines`).toEqual([
        cat(C, 'tactics.hud.level', { level: 7 }),
        cat(C, 'tactics.hud.level', { level: 11 }),
        null,
      ]);
      expect(span('tactics-deploy-hp'), `${locale}: the HP lines`).toEqual([
        cat(C, 'tactics.hud.hp', { hp: 23, max: 29 }),
        cat(C, 'tactics.hud.hp', { hp: 31, max: 37 }),
        null,
      ]);
      expect(span('tactics-deploy-empty'), `${locale}: the empty slot`).toEqual([
        null,
        null,
        cat(C, 'tactics.deploy.empty'),
      ]);
      const menu = root.querySelector('.tactics-menu');
      expect(menu?.getAttribute('role'), `${locale}: the menu is a listbox`).toBe('listbox');
      expect(menu?.getAttribute('tabindex'), `${locale}: a tab stop`).toBe('0');
      expect(menu?.getAttribute('aria-label'), `${locale}: named by tactics.menu.label`).toBe(
        cat(C, 'tactics.menu.label'),
      );
      const labels = (): string[] =>
        [...root.querySelectorAll('.tactics-menu [role="option"] .tactics-menu-label')].map(
          (el) => el.textContent ?? '',
        );
      expect(labels(), `${locale}: the confirm rows`).toEqual([
        cat(C, 'tactics.deploy.deploy'),
        cat(C, 'tactics.deploy.edit'),
      ]);
      const confirmTexts = new Set([
        cat(C, 'tactics.deploy.title'),
        cat(C, 'tactics.deploy.slot', { n: 1 }),
        cat(C, 'tactics.deploy.slot', { n: 2 }),
        cat(C, 'tactics.deploy.slot', { n: 3 }),
        'Sprigg',
        'Cindertail',
        cat(C, 'tactics.hud.level', { level: 7 }),
        cat(C, 'tactics.hud.level', { level: 11 }),
        cat(C, 'tactics.hud.hp', { hp: 23, max: 29 }),
        cat(C, 'tactics.hud.hp', { hp: 31, max: 37 }),
        cat(C, 'tactics.deploy.empty'),
        cat(C, 'tactics.deploy.deploy'),
        cat(C, 'tactics.deploy.edit'),
      ]);
      expect(
        textsOf(root).filter((text) => !confirmTexts.has(text)),
        `${locale}: the confirm screen paints no other text`,
      ).toEqual([]);

      ops(m.panel, X);
      expect(
        root.querySelector('h2.tactics-title')?.textContent,
        `${locale}: the editor's title`,
      ).toBe(cat(C, 'tactics.deploy.edit'));
      const group = root.querySelector('.tactics-deploy-candidate');
      expect(group?.getAttribute('role'), `${locale}: the candidate is a group`).toBe('group');
      expect(group?.getAttribute('aria-label'), `${locale}: named`).toBe(
        cat(C, 'tactics.deploy.candidateLabel'),
      );
      for (const [cls, key] of [
        ['tactics-deploy-prev', 'tactics.deploy.prevMonster'],
        ['tactics-deploy-next', 'tactics.deploy.nextMonster'],
      ] as const) {
        const button = root.querySelector(`button.${cls}`);
        expect(button?.getAttribute('type'), `${locale}: .${cls} is a plain button`).toBe('button');
        expect(button?.getAttribute('aria-label'), `${locale}: .${cls} is named`).toBe(cat(C, key));
        expect(button?.textContent, `${locale}: .${cls} paints no text (the glyph is CSS)`).toBe(
          '',
        );
      }
      expect(
        [
          ...root.querySelectorAll(
            '.tactics-menu [data-row="confirm"] .tactics-menu-label, .tactics-menu [data-row="back"] .tactics-menu-label',
          ),
        ].map((el) => el.textContent),
        `${locale}: the Confirm and Back rows`,
      ).toEqual([cat(C, 'tactics.deploy.confirm'), cat(C, 'tactics.deploy.back')]);
      const slotRows = [...root.querySelectorAll('.tactics-menu [role="option"]')].filter((el) =>
        (el.getAttribute('data-row') ?? '').startsWith('slot-'),
      );
      expect(
        slotRows.map((el, i) =>
          (el.textContent ?? '').includes(cat(C, 'tactics.deploy.slot', { n: i + 1 })),
        ),
        `${locale}: each slot row names its slot`,
      ).toEqual([true, true, true]);
      const editTexts = new Set([
        ...confirmTexts,
        cat(C, 'tactics.deploy.edit'),
        cat(C, 'tactics.deploy.confirm'),
        cat(C, 'tactics.deploy.back'),
      ]);
      expect(
        textsOf(root).filter((text) => !editTexts.has(text)),
        `${locale}: the editor paints no other text`,
      ).toEqual([]);
      expect(
        [...root.querySelectorAll('[aria-label]')]
          .map((el) => el.getAttribute('aria-label') ?? '')
          .filter(
            (label) =>
              ![
                cat(C, 'tactics.menu.label'),
                cat(C, 'tactics.deploy.candidateLabel'),
                cat(C, 'tactics.deploy.prevMonster'),
                cat(C, 'tactics.deploy.nextMonster'),
                cat(C, 'tactics.deploy.label'),
              ].includes(label),
          ),
        `${locale}: every accessible name inside the panel is a catalog value`,
      ).toEqual([]);

      ops(m.panel, START);
      expect(statusLine(root)?.textContent, `${locale}: the sending line`).toBe(
        cat(C, 'tactics.deploy.sending'),
      );
      expect(
        textsOf(root).filter(
          (text) => !editTexts.has(text) && text !== cat(C, 'tactics.deploy.sending'),
        ),
        `${locale}: sending paints no other text`,
      ).toEqual([]);
      expect(root.querySelector('[aria-live]'), `${locale}: no live region inside`).toBeNull();
      expect(root.hasAttribute('aria-live'), `${locale}: nor on the root`).toBe(false);
      m.panel.hide();
    }
  });
});

// --- BT12.6: the cursor is heard (focus follows the menu) -------------------------------------------

describe('deploy panel: focus (bt-12, BT12.6)', () => {
  it('the deploy panel`s cursor is heard: once the shown panel`s deferred focus has landed, a D-pad move leaves focus on the menu listbox whose aria-activedescendant names the cursor row, opening the editor and cycling keep it there, a pointer click on a row or on next never strands focus on the page body, a hidden panel holds none, and a panel never shown takes no focus from outside [BT12-6-DEPLOY-FOCUS]', async () => {
    // SOURCE: spec BT12.6 (the reachability sweep covers every new panel and row) and plan §3.8 (the
    // menu is `div.tactics-menu[role=listbox][tabindex=0][aria-activedescendant]`, the
    // tacticsBattle.ts pattern: the listbox holds focus and names the cursor row), as corrected by
    // the implementation review. WRONG IMPL KILLED: a cursor that moves with no focus move (focus
    // stays on the title, so a screen reader never hears the new row); a rebuild that destroys the
    // focused listbox or row and strands focus on <body> inside an aria-modal dialog (a click on a
    // row, or on next, rebuilds the menu); an aria-activedescendant that names a stale or missing
    // row; a hidden panel that keeps focus; a panel never shown that grabs focus on a render.
    const m = mount(VM3);
    await tick();
    const root = m.root();
    const listbox = (): HTMLElement | null => root.querySelector<HTMLElement>('.tactics-menu');
    ops(m.panel, DOWN);
    expect(cursorKey(root), 'fixture: the cursor is on Edit formation').toBe('edit');
    expect(listbox()?.getAttribute('role'), 'the menu is a listbox').toBe('listbox');
    expect(listbox()?.getAttribute('tabindex'), 'a tab stop').toBe('0');
    expect(document.activeElement, 'a D-pad move leaves focus on the menu listbox').toBe(listbox());
    expect(listbox()?.getAttribute('aria-activedescendant'), 'which names the cursor row').toBe(
      'tactics-deploy-row-edit',
    );
    expect(
      root.querySelector('#tactics-deploy-row-edit'),
      'and that row is in the panel',
    ).not.toBeNull();

    ops(m.panel, X);
    expect(m.panel.mode, 'fixture: the editor is open').toBe('edit');
    expect(document.activeElement, 'opening the editor keeps focus on the listbox').toBe(listbox());
    expect(listbox()?.getAttribute('aria-activedescendant'), 'naming the editor`s cursor row').toBe(
      'tactics-deploy-row-slot-0',
    );
    ops(m.panel, RB);
    expect(document.activeElement, 'cycling the candidate keeps focus on the listbox').toBe(
      listbox(),
    );

    ops(m.panel, B);
    expect(m.panel.mode, 'fixture: back on the confirm screen').toBe('confirm');
    click(root.querySelector('#tactics-deploy-row-edit'), 'the Edit formation row');
    expect(m.panel.mode, 'fixture: the click opened the editor').toBe('edit');
    expect(document.activeElement, 'a click on a row never strands focus on <body>').not.toBe(
      document.body,
    );
    expect(document.activeElement, 'focus stays on the panel`s listbox').toBe(listbox());
    click(root.querySelector('.tactics-deploy-next'), 'the next button');
    expect(document.activeElement, 'a click on next never strands focus on <body>').not.toBe(
      document.body,
    );
    expect(
      root.contains(document.activeElement),
      'focus stays inside the panel root after a click on next',
    ).toBe(true);

    m.panel.hide();
    expect(root.contains(document.activeElement), 'a hidden panel holds no focus').toBe(false);

    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement, 'fixture: an outside control has focus').toBe(outside);
    const quiet = mount(null);
    quiet.panel.render(VM3);
    quiet.panel.render({ battleId: BATTLE, candidates: [M1, M2, M3], formation: [M2, M1, M3] });
    await tick();
    expect(
      document.activeElement,
      'a panel never shown takes no focus from outside on a render',
    ).toBe(outside);
  });
});

// --- BT12.1: the battle frame switch keeps one dialog record --------------------------------------

/** A faithful stand-in for the 1v1 BattleView's show / hide a11y behaviour (battleView.ts:402-415):
 *  show() opens the shared `battleView` record on its edge, hide() closes it UNGUARDED. */
interface FakeLegacy {
  visible: boolean;
  hides: number;
  readonly root: HTMLElement;
  show(): void;
  hide(): void;
}

function fakeLegacy(host: HTMLElement): FakeLegacy {
  const root = document.createElement('div');
  root.style.display = 'none';
  const title = document.createElement('h2');
  title.setAttribute('data-testid', 'battle-title');
  title.setAttribute('tabindex', '-1');
  root.appendChild(title);
  host.appendChild(root);
  const view: FakeLegacy = {
    visible: false,
    hides: 0,
    root,
    show() {
      const was = view.visible;
      root.style.display = 'flex';
      view.visible = true;
      if (!was) openOverlayA11y('battleView', root);
    },
    hide() {
      view.hides += 1;
      root.style.display = 'none';
      view.visible = false;
      closeOverlayA11y('battleView', null);
    },
  };
  return view;
}

describe('the battle frame switch (bt-12, BT12.1)', () => {
  it('switching the battle frame between the 1v1 view, the deploy panel and the results panel hides only the visible view, so the shown root alone holds the dialog role and aria-modal, a hidden view`s hide never runs, a view not yet built is skipped, and a frame opened on top is not the switch`s to close [BT12-1-VIEW-SWITCH-A11Y]', () => {
    // WRONG IMPL KILLED (REV 2 A3, R1): a switch that hides EVERY other view (the hidden 1v1 view's
    // unguarded close tears the shown deploy root's dialog role and trap down — the record is keyed
    // by id, not by root); a switch that hides nothing (two roots shown, the 1v1 record stale); the
    // returned list wrong or out of order; an undefined (not yet constructed) panel dereferenced; a
    // switch that also closes a Help frame opened over the battle (A2 is main.ts's popToBase, not
    // this helper's).
    const host = document.createElement('div');
    document.body.appendChild(host);
    const legacy = fakeLegacy(host);
    const deploy = new DeployPanel(host, { onDeploy: () => Promise.resolve() });
    const results = new ResultsPanel(host, { onContinue: () => {} });
    const deployRoot = host.querySelector<HTMLElement>('.tactics-deploy');
    const resultsRoot = host.querySelector<HTMLElement>('.tactics-results');
    expect(deployRoot, 'precondition: the deploy root is under the host').not.toBeNull();
    expect(resultsRoot, 'precondition: the results root is under the host').not.toBeNull();
    const deployHide = vi.spyOn(deploy, 'hide');
    const resultsHide = vi.spyOn(results, 'hide');
    const views: (BattleViewLike | undefined)[] = [legacy, deploy, results];
    const nameOf = (v: BattleViewLike): string =>
      v === legacy ? 'legacy' : v === deploy ? 'deploy' : v === results ? 'results' : 'other';
    const switchTo = (keep: BattleViewLike): string[] =>
      hideOtherBattleViews(views, keep).map(nameOf);
    const roles = (): string[] =>
      [legacy.root, deployRoot, resultsRoot].map(
        (r) => `${r?.getAttribute('role') ?? 'none'}/${r?.getAttribute('aria-modal') ?? 'none'}`,
      );
    const RESULTS_VM: ResultsVM = {
      battleId: BATTLE,
      outcome: 'won',
      monsters: [],
      recruits: [],
      currency: 0n,
    };

    expect(switchTo(deploy), 'to the deploy panel: nothing is visible, nothing hidden').toEqual([]);
    deploy.render(VM3);
    deploy.show();
    expect(roles(), 'the deploy root alone is the dialog').toEqual([
      'none/none',
      'dialog/true',
      'none/none',
    ]);
    expect(legacy.hides, 'the hidden 1v1 view`s hide never ran').toBe(0);
    expect(resultsHide, 'the hidden results panel`s hide never ran').not.toHaveBeenCalled();

    expect(switchTo(deploy), 'the same switch again (an identical batch) hides nothing').toEqual(
      [],
    );
    expect(deployHide, 'the shown panel is kept').not.toHaveBeenCalled();
    expect(roles(), 'the deploy root keeps the dialog').toEqual([
      'none/none',
      'dialog/true',
      'none/none',
    ]);

    expect(switchTo(legacy), 'to the 1v1 view: the deploy panel alone is hidden').toEqual([
      'deploy',
    ]);
    legacy.show();
    expect(roles(), 'the 1v1 root alone is the dialog').toEqual([
      'dialog/true',
      'none/none',
      'none/none',
    ]);
    expect(resultsHide, 'still never the hidden results panel').not.toHaveBeenCalled();

    expect(switchTo(results), 'to the results panel: the 1v1 view alone is hidden').toEqual([
      'legacy',
    ]);
    results.render(RESULTS_VM);
    results.show();
    expect(roles(), 'the results root alone is the dialog').toEqual([
      'none/none',
      'none/none',
      'dialog/true',
    ]);
    expect(deployHide, 'the hidden deploy panel was not hidden again').toHaveBeenCalledTimes(1);

    expect(switchTo(deploy), 'back to the deploy panel: the results panel alone').toEqual([
      'results',
    ]);
    deploy.render(VM3);
    deploy.show();
    expect(roles(), 'the deploy root alone is the dialog again').toEqual([
      'none/none',
      'dialog/true',
      'none/none',
    ]);
    expect(legacy.hides, 'the 1v1 view was hidden once, when it was shown').toBe(1);

    expect(
      hideOtherBattleViews([legacy, undefined, undefined], legacy).map(nameOf),
      'panels not yet built are skipped',
    ).toEqual([]);

    const help = document.createElement('div');
    document.body.appendChild(help);
    openOverlayA11y('helpView', help);
    expect(switchTo(legacy), 'with Help on top: the deploy panel alone is hidden').toEqual([
      'deploy',
    ]);
    legacy.show();
    expect(help.getAttribute('role'), 'Help is not the switch`s to close').toBe('dialog');
    expect(roles()[0], 'the 1v1 root opened its record').toBe('dialog/true');
    expect(roles()[1], 'the deploy root holds none').toBe('none/none');
  });
});
