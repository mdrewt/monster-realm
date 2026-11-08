// ui/hintBarModel.ts — the live hint bar (ctl-13, CTL13.1): which button chips show for the context
// on top, each as the button, its live keycap and its verb. Pure over its arguments (the verbs are
// read from the catalog per call, so a locale switch shows at the next render, and the keycap from
// the bindings handed in, so a remap does). `hintBar.ts` paints the chips.
import type { Bindings } from '../input/bindings';
import type { VButton } from '../input/buttons';
import { glyph } from '../input/glyphs';
import type { Stack } from './contextStack';
import { t } from './i18n/resolver';
import type { Notice } from './noticeModel';

export interface HintChip {
  readonly button: VButton;
  /** The primary key's glyph; '' when the button is unbound. */
  readonly keycap: string;
  readonly verb: string;
  /** Only Start's: a request waits for an answer. */
  readonly badge: boolean;
}

/** What only the shell knows about the world base. */
export interface HintWorld {
  /** A's verb for what the character faces, localised by the shell; null when nothing is faced. */
  readonly target: string | null;
  /** Whether a world sheet (interact or request) is open. */
  readonly sheetOpen: boolean;
  /** Whether that sheet is a multi-row entity × action picker (not its Challenge confirm, not the
   *  request sheet): A chooses a row there (uif-12, UIF12.3). */
  readonly picker?: boolean;
  /** Whether a trade or challenge request waits for the viewer, dismissed or not. */
  readonly requestWaiting: boolean;
}

const NO_WORLD: HintWorld = { target: null, sheetOpen: false, requestWaiting: false };

/** Start's verb in a tactical battle (a literal `switch`: catalog keys are never built). */
function startVerb(start: HintBattle['start']): string {
  switch (start) {
    case 'endTurn':
      return t('chrome.chip.endTurn');
    case 'guard':
      return t('chrome.chip.guard');
    case 'submit':
      return t('chrome.chip.submit');
    default:
      return start satisfies never;
  }
}

/** What only the tactical battle shell knows (bt-11, BT11.6): what Start does for the selected unit
 *  and whether B undoes a drafted chip. Absent at a legacy battle. */
export interface HintBattle {
  readonly start: 'endTurn' | 'guard' | 'submit';
  readonly undo: boolean;
}

/** What only the deploy panel knows (bt-12, BT12.2 / R-bt-12-DEPLOYHINT): which of its two screens is
 *  up. `confirm`: A deploys, X opens the editor, Start opens the menu; `edit`: A assigns, B backs out,
 *  LB / RB cycle the candidates, Start submits. */
export interface HintDeploy {
  readonly deploy: 'confirm' | 'edit';
}

export function hintBar(
  stack: Stack,
  bindings: Bindings,
  notices: readonly Notice[],
  world: HintWorld = NO_WORLD,
  battleOrDeploy?: HintBattle | HintDeploy,
): readonly HintChip[] {
  const deploy =
    battleOrDeploy !== undefined && 'deploy' in battleOrDeploy ? battleOrDeploy : undefined;
  const battle =
    battleOrDeploy !== undefined && !('deploy' in battleOrDeploy) ? battleOrDeploy : undefined;
  const chip = (button: VButton, verb: string, badge = false): HintChip => {
    const code = bindings.buttons[button][0];
    return { button, keycap: code === undefined ? '' : glyph(code), verb, badge };
  };
  const start = () => chip('Start', t('chrome.chip.menu'), world.requestWaiting);
  const select = () => chip('Select', t('chrome.chip.help'));
  const top = stack[stack.length - 1];
  switch (top.kind) {
    case 'world': {
      // uif-12 (UIF12.3): what the buttons do over a world sheet — Start closes it (unbadged), Select
      // closes it and opens Help (worldButton), and A chooses a row of a multi-row picker.
      if (world.sheetOpen)
        return [
          chip('A', world.picker === true ? t('interact.chip.choose') : t('chrome.chip.ok')),
          chip('B', t('chrome.chip.back')),
          chip('Start', t('chrome.chip.close')),
          select(),
        ];
      const chips: HintChip[] = [];
      if (world.target !== null) chips.push(chip('A', world.target));
      else {
        if (world.requestWaiting) chips.push(chip('Y', t('chrome.chip.view')));
        if (notices.length > 0) chips.push(chip('B', t('chrome.chip.dismiss')));
      }
      chips.push(start(), select());
      return chips;
    }
    case 'battle':
      // bt-12 (BT12.2): the deploy panel's two screens. The confirm screen: A deploys, X opens the
      // editor, Start still opens the menu (badged by a waiting request); no B (there is no
      // back-out). The editor: A assigns, B backs out, LB / RB cycle the candidates, Start submits.
      if (deploy !== undefined) {
        if (deploy.deploy === 'confirm') {
          return [
            chip('A', t('chrome.chip.deploy')),
            chip('X', t('chrome.chip.editFormation')),
            start(),
            select(),
          ];
        }
        return [
          chip('A', t('chrome.chip.assign')),
          chip('B', t('chrome.chip.back')),
          chip('LB', t('chrome.chip.prevMonster')),
          chip('RB', t('chrome.chip.nextMonster')),
          chip('Start', t('chrome.chip.submit')),
          select(),
        ];
      }
      // bt-11 (BT11.6): the tactical shell's map — B undoes a drafted chip or backs out, X toggles
      // the danger overlay, LB / RB cycle own units, Start ends the turn / guards / submits.
      if (battle !== undefined) {
        return [
          chip('A', t('chrome.chip.ok')),
          chip('B', battle.undo ? t('chrome.chip.undo') : t('chrome.chip.back')),
          chip('X', t('chrome.chip.danger')),
          chip('LB', t('chrome.chip.prevUnit')),
          chip('RB', t('chrome.chip.nextUnit')),
          chip('Start', startVerb(battle.start)),
          select(),
        ];
      }
      return [chip('A', t('chrome.chip.ok')), start(), select()];
    case 'screen':
    case 'prompt':
      return [
        chip('A', t('chrome.chip.ok')),
        chip('B', t('chrome.chip.back')),
        chip('Start', t('chrome.chip.close')),
        select(),
      ];
    case 'textEntry':
      return [chip('A', t('chrome.chip.ok')), chip('Start', t('chrome.chip.done'))];
  }
}
