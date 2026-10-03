// ui/battleView.ts — thin DOM shell for the battle screen.
//
// Renders BattleViewModels produced by battleModel.ts into a DOM overlay.
// No game logic, no SDK imports, no store writes — one-way flow only.
// The loop calls refresh() on batch-applied; the user triggers reducer intents
// via callbacks passed at construction (never called directly by this module).
//
// Overlay a11y wiring. This view is a CONSTRUCTED shell:
// its root is `document.createElement`'d here and appended into the shared `#app` MOUNT, so unlike
// the ten static shells S3 wired it ships NO ARIA of its own from `client/index.html` — every
// attribute below comes from `openOverlayA11y`, never from a literal in this file.
//
// THE EDGE, AND WHY IT IS READ FIRST. `wasVisible` is read as the FIRST statement of `show()`,
// before any write. A re-open tears down and re-schedules `openOverlayA11y`'s deferred focus, which
// drags focus off whatever control the player had Tabbed to — invisible to every attribute
// assertion, since a re-open rewrites the same values.
//
// AND WHY THE CLOSE IS DELIBERATELY UNGUARDED. `hide()` calls `closeOverlayA11y` every time, even
// when already hidden. A guarded close reads correct and passes every other assertion while
// permanently leaking a live capture listener, a pending timer and an expiring return target
// whenever a record desynchronises from the DOM; `closeOverlayA11y` with no record is a documented
// pure no-op, so unguarded is the self-healing path. S3's red-team measured the guarded shape
// shipping 62/62 green.
//
// THE OPEN IS THE LAST STATEMENT of the open path, after the display write: in a real browser
// `.focus()` on a `display:none` node is a silent no-op, so an open-before-paint overlay announces
// itself and then never receives focus.
//
// Every player-facing string this view renders is resolved through the i18n
// resolver (`t()`/`tf()`, ui/i18n/resolver.ts) with a `battle.*` key from ui/i18n/catalog.en.ts;
// the English bytes are unchanged (the catalog pins them). Two rows are deliberately NOT keyed:
// the card header `${label}: ${species}` and the bait row `${name} (+${n}‰) ×${count}` are
// glyph-only compounds (tier (e)). Model
// data (affinity, weather label, status, species/skill/item names, the rival's display name) flow
// through as params, never as catalog text. Every `t(`/`tf(` first argument is a string LITERAL —
// a ternary picks between two calls, never between two keys — so S7's dynamic-key scan stays quiet.
//
// Each `#app`-mounted view creates its OWN root under the shared mount, so opening this view
// never closes a sibling (no close-before-open; boxView.test.ts S4-CROSS-VIEW-DISTINCT-ROOTS).
import {
  BATTLE_COMMANDS,
  type BattleCommand,
  type BattleCommandRow,
  type BattleMonsterCardVM,
  type BattlePick,
  type BattleViewModel,
  battleCommands,
  cursorStep,
  resolveBattlePick,
  skillCursor,
} from './battleModel';
import { t, tf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import type { BattleOp, BattleOpsView } from './screens/battleScreen';

/** The lists the battle cursor walks (ctl-8i, ctl-8j): the command list, the list each command
 *  leads to, and the second step of Recruit (Yes / No) and Bag (the target). Every cursor row
 *  carries its list's name in `data-battle-list`; the legacy Flee button is in none. Every row is a
 *  button whose click handler holds the model's id, so no id is ever read back from the DOM (B10). */
type CursorList =
  | 'commands'
  | 'skills'
  | 'recruit'
  | 'swap'
  | 'bag'
  | 'recruitConfirm'
  | 'bagTarget';
const LIST_ATTR = 'data-battle-list';
/** The list a command leads to (Run acts at once). */
const SUBLIST: Readonly<Record<Exclude<BattleCommand, 'run'>, CursorList>> = {
  fight: 'skills',
  recruit: 'recruit',
  swap: 'swap',
  bag: 'bag',
};
/** The visible cue on the cursor row: focus alone is lost to the menu and to <body>. */
const CURSOR_OUTLINE = '2px solid #ffd700';
let runReasonIds = 0;
let promptIds = 0;

/**
 * The five PvE callbacks may return a promise: the view's per-battle in-flight
 * lock is held until that promise settles, so the return type must express it. Typing
 * these `=> void` would let a future implementation type-check cleanly while silently
 * reducing the lock to a one-microtask no-op (a held Enter would fire two attacks).
 * The two PvP callbacks stay `=> void`: their pending lifetime is "until the server
 * advances the turn" and is carried by `vm.pvpPendingSubmit` (RT-PVP-DS-01), not here.
 */
export interface BattleViewCallbacks {
  /** Called when the player selects a skill to attack with (PvE). */
  readonly onAttack: (battleId: bigint, skillId: number) => void | Promise<void>;
  /** Called when the player clicks the Flee button. */
  readonly onFlee: (battleId: bigint) => void | Promise<void>;
  /** Called when the player selects a team member to swap to (PvE). */
  readonly onSwap: (battleId: bigint, teamIndex: number) => void | Promise<void>;
  /**
   * Called on Yes in the Recruit confirm (wild battles only). `baitItemId` is
   * the picked bait's id, or `undefined` for a bare attempt (No bait).
   */
  readonly onRecruit: (battleId: bigint, baitItemId: number | undefined) => void | Promise<void>;
  /** Called when the player picks a cure item and presses its target row (the active monster). */
  readonly onUseItem: (battleId: bigint, itemId: number) => void | Promise<void>;
  /** Called when the player submits a skill attack in a PvP battle. */
  readonly onPvpAttack: (battleId: bigint, skillId: number) => void;
  /** Called when the player submits a swap in a PvP battle. */
  readonly onPvpSwap: (battleId: bigint, teamIndex: number) => void;
}

export class BattleView implements BattleOpsView {
  readonly #root: HTMLDivElement;
  /** The "Battle" heading; its text is resolved in show(), not here (see show()). */
  readonly #titleEl: HTMLHeadingElement;
  readonly #weatherEl: HTMLDivElement;
  readonly #playerCardEl: HTMLDivElement;
  readonly #opponentCardEl: HTMLDivElement;
  readonly #skillsEl: HTMLDivElement;
  readonly #actionsEl: HTMLDivElement;
  /** The command list (ctl-8i): built once, so focus on a row survives every re-render. */
  readonly #commandsEl: HTMLDivElement;
  readonly #commandBtns: ReadonlyMap<BattleCommand, HTMLButtonElement>;
  /** "Waiting for {name}…" over the greyed list while a PvP move waits on the opponent. */
  readonly #waitingEl: HTMLDivElement;
  /** Why Run is greyed in a player battle; Run's aria-describedby. */
  readonly #runReasonEl: HTMLDivElement;
  /** Empty-swap explainer; shown only on an ongoing battle with no swap. */
  readonly #swapHintEl: HTMLDivElement;
  readonly #outcomeEl: HTMLDivElement;
  /** PvP status banner ("Waiting for opponent…" / ""); hidden when not in PvP. */
  readonly #pvpStatusEl: HTMLDivElement;
  /** "Press Enter or Esc to continue" hint; shown only on a terminal outcome. */
  readonly #continueHintEl: HTMLDivElement;
  readonly #callbacks: BattleViewCallbacks;
  /** The pressed bait or cure row awaiting Yes / the target (CTL8J.1); re-resolved on every render
   *  and dropped, never moved to another item, when the model stops offering it. */
  #pick: BattlePick | null = null;
  /** The rows of the last render by model id, so B from the second step lands on the picked item
   *  wherever it now is. */
  #baitRows = new Map<number | undefined, HTMLButtonElement>();
  #cureRows = new Map<number, HTMLButtonElement>();
  /** The id of this view's Recruit question (the confirm's accessible name). */
  readonly #promptId = `battle-recruit-prompt-${++promptIds}`;
  #visible = false;
  // The PvE in-flight lock. ONE lock for the whole battle, not per action: attack,
  // flee, swap, recruit and use-item all spend the same turn, so a second click on ANY of
  // them while the first call is unsettled is the double-fire (`submit_attack` runs a full
  // turn twice; `attempt_recruit` consumes bait twice — the server has no idempotency guard).
  // Promise-gated, not VM-gated like `vm.pvpPendingSubmit`: a PvE call's pending lifetime
  // is exactly "until the reducer promise settles", which the callback returns; PvP's is
  // "until the server advances the turn", which only the store can know.
  // The OBJECT is the generation token: `.finally()` releases only if the lock it stored is
  // still the current one. A bare `battleId` compare would let a stale promise (click →
  // hide() → re-show → click again → FIRST promise settles) release the SECOND click's lock
  // and re-enable the live buttons while that call is still in flight.
  // Keyed by battleId so a refresh() of a different battle renders enabled controls and a
  // late settle for the old battle cannot touch them.
  #pending: { readonly battleId: bigint } | null = null;
  /** The last rendered model: the cursor reads its skills and active monster. */
  #vm: BattleViewModel | null = null;
  /** The command rows of the last render (the lock greys them on top). */
  #commandRows: readonly BattleCommandRow[] = [];
  /** The kept cursor. It outlives focus (the menu, <body>) and a re-render of the same turn. */
  #cursor: { list: CursorList; index: number } = { list: 'commands', index: 0 };
  /** The (battle, turn) of the last render: a new one resets the cursor to Fight (CTL8I.1). */
  #turnKey: { readonly battleId: bigint; readonly turnNumber: number } | null = null;
  /** The skill each monster (by team slot) last used in this battle (CTL8I.2). */
  readonly #lastSkill = new Map<number, number>();

  constructor(parent: HTMLElement, callbacks: BattleViewCallbacks) {
    this.#callbacks = callbacks;

    this.#root = document.createElement('div');
    // ctl-7b: a class-styled frame. `.mr-shell--top` is the fixed layer the menu and help share
    // (encounter-battle.spec E0 pins all three roots as position:fixed) and `.mr-shell--battle`
    // drops it to z-index 110, under them. `safe center`: a battle taller than the frame scrolls
    // from its title instead of clipping it above the scrollport.
    this.#root.className = 'mr-frame mr-shell mr-shell--top mr-shell--battle';
    this.#root.style.cssText = 'display:none;align-items:center;justify-content:safe center;';

    // NO text here — `battle.title` is resolved in show() (see there for why).
    const title = document.createElement('h2');
    // The OVERLAY_A11Y initialFocusSelector anchor for this overlay. `tabindex="-1"`
    // (never "0") makes the heading programmatically focusable WITHOUT adding a permanent tab
    // stop ahead of the overlay's real controls. `setAttribute`, not `dataset` — the selector is
    // frozen in ui/overlayRegistry.ts and the DOM moves to it, never the reverse.
    title.setAttribute('data-testid', 'battle-title');
    title.setAttribute('tabindex', '-1');
    title.style.cssText = 'margin:0 0 16px;color:#fff;';
    this.#titleEl = title;
    this.#root.appendChild(title);

    // Weather banner (field-state banner; hidden by default — shown when weather is active)
    this.#weatherEl = document.createElement('div');
    this.#weatherEl.setAttribute('data-testid', 'weather-banner');
    this.#weatherEl.style.cssText =
      'width:100%;max-width:320px;text-align:center;padding:4px 8px;margin-bottom:8px;' +
      'border-radius:3px;background:#334;color:#aaf;font-size:12px;font-weight:bold;display:none;';
    this.#root.appendChild(this.#weatherEl);

    // The opponent card (top) and the player card (bottom).
    // these two ROLES used to be separated by HUE ALONE — `1px solid #844` against
    // `1px solid #484`, red against green, a classic worst-case pair for protanopia and
    // deuteranopia and only 1.64:1 apart in relative luminance (`#525252` against `#757575`
    // under `filter: grayscale(1)`), far below any threshold at which two 1px lines read as
    // two different lines. That is WCAG 1.4.1 "use of colour", the same failure class that was
    // already fixed in this file for the HP-severity palette. Border
    // STYLE is the hue-free channel: `dashed` against `solid` is perceivable with NO colour
    // vision at all, and it survives Windows forced-colors mode, where both hues are
    // discarded outright but border-style is preserved.
    // #844 HAD to move rather than merely be dashed: it MEASURES 2.34:1 against its own card
    // background #2a1a1a, below the WCAG 1.4.11 3:1 non-text floor, and dashing a
    // sub-threshold border paints materially less of it — the shipped dash period is 6px on,
    // 3px off — so `dashed #844` would have shipped a non-colour cue nobody can see, i.e. the
    // same defect in a new hat. #b66 measures 4.13:1 on that same
    // background and stays in the same red family; the player's #484 on #1a2a1a is already
    // 3.49:1, so it keeps its colour and only widens.
    // BE HONEST ABOUT WHAT THAT COSTS: the pair this slice ships is 1.073:1 in relative
    // luminance, i.e. FLATTER in greyscale than the pair it replaces. That is deliberate —
    // luminance was never the channel here — but it does mean border STYLE is now the single
    // hue-free carrier, which is why battleView.test.ts pins the style pair, the widths, the
    // card's whole declaration roster and border-image rather than just the two literals.
    // This cue is REDUNDANT, not primary — do not overclaim it. In PvE what says WHICH card
    // is whose is the header text #renderMonsterCard writes, `Opponent: <species>` against
    // `You: <species>`; the border style only makes the PAIRING perceivable without hue, and
    // that redundancy is what satisfies 1.4.1. In PvP the opponent header carries the rival's
    // NAME instead of a role word — see the DEFER below.
    // The card BACKGROUNDS (#2a1a1a against #1a2a1a, measured 1.10:1 — near-identical
    // luminance) are deliberately NOT retuned: once the border style carries the distinction
    // hue-free the criterion is met, and the backgrounds are then decoration layered over a
    // channel that already carries the information. Argued dismissal, not an oversight.
    // Dismissed for 1.4.1, and ONLY for 1.4.1: the #844 border on the Flee button and its
    // siblings on the Swap / Submit buttons and the bait, cure, Yes / No and target rows (ctl-8j).
    // On every one the accessible name IS the information, so hue encodes nothing and they
    // keep their 1px solid rule. NONE of these borders has been measured against 1.4.11 — the
    // floor this slice just invoked to move #844; that gap is real and not claimed closed here.
    // DEFERRED, not done (ledger gate X6): in PvP refresh() passes the rival's BARE player
    // name as the opponent label, so the card's ROLE reaches assistive technology only as a
    // player name. The design's clause that every member of this border family "carr[ies] text
    // labels" is technically satisfied — the label just names the RIVAL, not the ROLE, which
    // is the half of A11Y-29 a border cue cannot cover. A leading role word breaks the
    // `startsWith('<name>: ')` parse in e2e/monster-privacy.spec.ts, which the REQUIRED e2e
    // job runs and which is outside this slice's touches:. MEASURED HONESTLY: a trailing
    // ` (Opponent)` suffix would satisfy that parse AND pvp-side-b.spec.ts's substring match
    // without touching either file — it was not taken because a parenthetical after the
    // species name is a weaker announcement than a leading role word, and because the slice
    // was in its landing phase. The successor should pick the spelling on merit.
    // Do NOT re-home these hexes into `:root` custom properties in styles.css. It is a convention, not a gate, and styles.css separately expects a later slice
    // to add :root tokens for OTHER values — the ban is on re-homing THESE border hexes.
    this.#opponentCardEl = document.createElement('div');
    this.#opponentCardEl.style.cssText =
      'border:2px dashed #b66;border-radius:4px;padding:8px;width:100%;max-width:320px;' +
      'background:#2a1a1a;margin-bottom:12px;';
    this.#root.appendChild(this.#opponentCardEl);

    this.#playerCardEl = document.createElement('div');
    this.#playerCardEl.style.cssText =
      'border:2px solid #484;border-radius:4px;padding:8px;width:100%;max-width:320px;' +
      'background:#1a2a1a;margin-bottom:12px;';
    this.#root.appendChild(this.#playerCardEl);

    // The command list (ctl-8i): Fight, Recruit, Swap, Bag, Run. A greyed row is aria-disabled,
    // never `disabled`, so the cursor can rest on it (and Run's reason is read). Labels are
    // resolved per render (see show() for why not here).
    this.#commandsEl = document.createElement('div');
    this.#commandsEl.setAttribute('data-testid', 'battle-commands');
    this.#commandsEl.setAttribute('role', 'group');
    this.#commandsEl.style.cssText =
      'display:flex;flex-wrap:wrap;gap:6px;width:100%;max-width:320px;margin-bottom:12px;';
    this.#waitingEl = document.createElement('div');
    this.#waitingEl.setAttribute('data-testid', 'battle-commands-waiting');
    this.#waitingEl.style.cssText = 'flex-basis:100%;font-size:12px;color:#aab;display:none;';
    this.#commandsEl.appendChild(this.#waitingEl);
    const commandBtns = new Map<BattleCommand, HTMLButtonElement>();
    for (const id of BATTLE_COMMANDS) {
      const btn = document.createElement('button');
      btn.setAttribute('data-testid', `battle-command-${id}`);
      btn.setAttribute(LIST_ATTR, 'commands');
      btn.style.cssText =
        'padding:6px 10px;font-family:monospace;font-size:12px;border:1px solid #666;' +
        'border-radius:3px;background:#2a2a3e;color:#e0e0e0;';
      btn.addEventListener('click', () => this.#chooseCommand(id, btn));
      commandBtns.set(id, btn);
      this.#commandsEl.appendChild(btn);
    }
    this.#commandBtns = commandBtns;
    this.#runReasonEl = document.createElement('div');
    this.#runReasonEl.setAttribute('data-testid', 'battle-run-reason');
    runReasonIds += 1;
    this.#runReasonEl.id = `battle-run-reason-${runReasonIds}`;
    this.#runReasonEl.style.cssText = 'flex-basis:100%;font-size:12px;color:#aab;display:none;';
    this.#commandsEl.appendChild(this.#runReasonEl);
    this.#root.appendChild(this.#commandsEl);
    // A held Enter re-clicks whatever the cursor lands on next (Fight -> a skill -> the next
    // turn's Fight); only the first press is the browser's. Space clicks on keyup, so its
    // repeats are refused too rather than relied on.
    this.#root.addEventListener('keydown', (e) => {
      const activation = e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space';
      if (e.repeat && activation && e.target instanceof HTMLButtonElement) e.preventDefault();
    });

    // Skills grid
    this.#skillsEl = document.createElement('div');
    this.#skillsEl.style.cssText =
      'display:grid;grid-template-columns:1fr 1fr;gap:6px;width:100%;max-width:320px;margin-bottom:12px;';
    this.#root.appendChild(this.#skillsEl);

    // Action buttons (flee/swap)
    this.#actionsEl = document.createElement('div');
    this.#actionsEl.style.cssText = 'display:flex;gap:8px;margin-bottom:12px;';
    this.#root.appendChild(this.#actionsEl);

    // Explains the ABSENCE of a swap control. A SIBLING of #actionsEl — never
    // its child, since #renderActions calls #actionsEl.replaceChildren() before rendering (which
    // would detach it on the next refresh) — and never appended to the caller-supplied `parent`.
    // Copy (catalog key `battle.swap.hint`) is honesty-constrained (dead KeyB, persistent terminal
    // overlay, zone-gated heal, mutable party_slot); teeth in battleView.test.ts H1.
    // The claim is scoped "in this battle" deliberately: party_slot is mutable mid-battle while
    // sideA.team is a snapshot, so an unscoped "no healthy party monster" is falsifiable — keep
    // the scope. The text itself is resolved in show(), not here.
    this.#swapHintEl = document.createElement('div');
    this.#swapHintEl.setAttribute('data-testid', 'battle-swap-hint');
    this.#swapHintEl.style.cssText =
      'width:100%;max-width:320px;text-align:center;margin-bottom:8px;' +
      'font-size:12px;color:#aab;display:none;';
    this.#root.appendChild(this.#swapHintEl);

    // PvP status banner: "Waiting for opponent…" when pvpPendingSubmit; hidden otherwise.
    this.#pvpStatusEl = document.createElement('div');
    this.#pvpStatusEl.setAttribute('data-testid', 'pvp-status');
    this.#pvpStatusEl.style.cssText =
      'width:100%;max-width:320px;text-align:center;padding:4px 8px;margin-bottom:8px;' +
      'border-radius:3px;background:#224;color:#aaf;font-size:13px;display:none;';
    this.#root.appendChild(this.#pvpStatusEl);

    // Outcome banner
    this.#outcomeEl = document.createElement('div');
    this.#outcomeEl.setAttribute('data-testid', 'outcome-text');
    this.#outcomeEl.style.cssText = 'font-size:18px;font-weight:bold;color:#ffd700;display:none;';
    this.#root.appendChild(this.#outcomeEl);

    // The battle-result exit affordance. A SIBLING of #outcomeEl — never its
    // child (#renderOutcome writes #outcomeEl.textContent, which would wipe a child every render)
    // and never merged into its text (three e2e specs use getByText('Victory!', {exact:true})).
    // Its text (`battle.continueHint`) is resolved in show(), not here.
    this.#continueHintEl = document.createElement('div');
    this.#continueHintEl.setAttribute('data-testid', 'battle-continue-hint');
    this.#continueHintEl.style.cssText = 'margin-top:8px;font-size:12px;color:#aab;display:none;';
    this.#root.appendChild(this.#continueHintEl);

    parent.appendChild(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(): void {
    const wasVisible = this.#visible;
    this.#visible = true;
    // the three strings that are set ONCE and never rewritten by a
    // render — the heading, the empty-swap explainer and the Esc hint — are resolved HERE, on
    // every show(), not in the constructor. A constructor-time `t()` would freeze the English
    // unless S6's `setLocale` ran before main.ts constructs this view (deep inside the async
    // connect path) — an unenforced cross-file boot-order invariant. Idempotent by design: the
    // same value is written on every show(), the same per-render pattern every other sink uses.
    // These writes sit AFTER the `wasVisible` read (the header's "first statement" edge) and
    // BEFORE the display write, so the open stays the last statement of the open path.
    this.#titleEl.textContent = t('battle.title');
    this.#swapHintEl.textContent = t('battle.swap.hint');
    this.#continueHintEl.textContent = t('battle.continueHint');
    this.#root.style.display = 'flex';
    if (!wasVisible) openOverlayA11y('battleView', this.#root);
  }

  hide(): void {
    this.#visible = false;
    this.#root.style.display = 'none';
    // Release the in-flight lock (tradeProposeView hide()-time precedent):
    // onReconnect and the battle-end paths hide this overlay, and the SDK never settles
    // an in-flight reducer promise after a link drop — so `.finally()` may never run.
    // Without this reset the next battle's controls would render dead. No node re-enable
    // here: the view is only ever re-shown through refresh(), which rebuilds every control and
    // re-greys the command rows.
    this.#pending = null;
    this.#pick = null;
    closeOverlayA11y('battleView', null);
  }

  refresh(vm: BattleViewModel | null): void {
    if (!vm) {
      this.#weatherEl.style.display = 'none';
      this.#weatherEl.textContent = '';
      this.#pvpStatusEl.style.display = 'none';
      // Reset the hint too, per this branch's weather/pvpStatus precedent.
      this.#continueHintEl.style.display = 'none';
      // Same precedent; defense-only — LIVE reset is #renderActions' 'none' arm.
      this.#swapHintEl.style.display = 'none';
      this.hide();
      return;
    }
    if (!this.#visible) this.show();
    // Read before the rebuild detaches a focused row: a reset takes focus only from the page or
    // from inside this view (never from the menu over it), a same-turn render only re-focuses the
    // cursor row when it had focus. A row focused by Tab or the mouse is the cursor (as in
    // applyBattleOp), so the rebuild hands focus to its replacement.
    // The world canvas counts as the page: a battle that starts while the player walks takes it.
    const active = document.activeElement;
    const focusHere =
      active === null ||
      active === document.body ||
      active instanceof HTMLCanvasElement ||
      this.#root.contains(active);
    const focusedList =
      active instanceof HTMLElement && this.#root.contains(active)
        ? (active.getAttribute(LIST_ATTR) as CursorList | null)
        : null;
    if (focusedList !== null) {
      this.#cursor = {
        list: focusedList,
        index: this.#rows(focusedList).indexOf(active as HTMLElement),
      };
    }
    const onCursor = focusedList !== null;
    const newBattle = this.#turnKey?.battleId !== vm.battleId;
    if (newBattle) this.#lastSkill.clear();
    const newTurn = newBattle || this.#turnKey?.turnNumber !== vm.turnNumber;
    this.#turnKey = { battleId: vm.battleId, turnNumber: vm.turnNumber };
    this.#vm = vm;
    this.#pick = resolveBattlePick(vm, this.#pick);

    this.#renderWeather(vm);
    // Show opponent name for PvP battles so the player knows who they are fighting. The name is
    // model data, rendered raw — no catalog key is requested when it is set.
    const opponentLabel =
      vm.isPvp && vm.pvpOpponentName ? vm.pvpOpponentName : t('battle.card.opponent');
    this.#renderMonsterCard(this.#opponentCardEl, vm.opponentCard, opponentLabel);
    this.#renderMonsterCard(this.#playerCardEl, vm.playerCard, t('battle.card.you'));
    this.#renderPvpStatus(vm);
    this.#renderCommands(vm);
    this.#renderSkills(vm);
    this.#renderActions(vm);
    this.#renderOutcome(vm);
    // re-derive the lock on the rebuilt controls rather than defaulting to enabled —
    // a batch can re-render this battle while its call is still in flight, and a fresh
    // enabled-looking button whose click the lock then swallows is worse than no button.
    if (this.#pending?.battleId === vm.battleId) this.#setActionButtonsDisabled(true);
    // A new turn starts on Fight; so does a PvP wait, whose grid and bench are not rendered.
    const reset = newTurn || vm.pvpPendingSubmit;
    if (reset) this.#cursor = { list: 'commands', index: 0 };
    this.#paintCursor(reset ? focusHere : onCursor);
  }

  /** One cursor op from the battle screen (CTL8I.1-3). With focus off the cursor rows (the
   *  heading, the page, Flee, a confirm's prompt) it only seats the kept cursor: an A must never
   *  press a row the player is not on. On a row the cursor first follows focus (Tab and the mouse
   *  move it too). */
  applyBattleOp(op: BattleOp): void {
    if (!this.#visible || this.#vm?.outcome !== 'Ongoing') return;
    const active = document.activeElement;
    const list =
      active instanceof HTMLElement && this.#root.contains(active)
        ? (active.getAttribute(LIST_ATTR) as CursorList | null)
        : null;
    if (list === null) {
      this.#paintCursor(true);
      return;
    }
    const rows = this.#rows(list);
    this.#cursor = { list, index: rows.indexOf(active as HTMLElement) };
    switch (op.kind) {
      case 'move':
        this.#cursor.index = cursorStep(
          this.#cursor.index,
          rows.length,
          op.dir,
          list === 'skills' ? 2 : 1,
        );
        this.#paintCursor(true);
        return;
      case 'activate':
        this.#paintCursor(false);
        rows[this.#cursor.index]?.click();
        return;
      case 'back': {
        if (list === 'recruitConfirm' || list === 'bagTarget') {
          this.#cancelPick();
          return;
        }
        const command = BATTLE_COMMANDS.find((id) => id !== 'run' && SUBLIST[id] === list);
        if (command !== undefined) {
          this.#cursor = { list: 'commands', index: BATTLE_COMMANDS.indexOf(command) };
        }
        this.#paintCursor(true);
        return;
      }
    }
  }

  /** The rows of `list`, in DOM order. */
  #rows(list: CursorList): HTMLElement[] {
    return [...this.#root.querySelectorAll<HTMLElement>(`[${LIST_ATTR}="${list}"]`)];
  }

  /** Mark the cursor row (one aria-current, with the outline), focusing it when asked. A list
   *  that emptied falls back to Fight; a finished battle has no cursor. */
  #paintCursor(focus: boolean): void {
    for (const el of this.#root.querySelectorAll<HTMLElement>('[aria-current="true"]')) {
      el.removeAttribute('aria-current');
      el.style.outline = '';
    }
    if (this.#vm?.outcome !== 'Ongoing') return;
    let rows = this.#rows(this.#cursor.list);
    if (rows.length === 0) {
      this.#cursor = { list: 'commands', index: 0 };
      rows = this.#rows('commands');
    }
    this.#cursor.index = Math.min(rows.length - 1, Math.max(0, this.#cursor.index));
    const el = rows[this.#cursor.index];
    if (el === undefined) return;
    el.setAttribute('aria-current', 'true');
    el.style.outline = CURSOR_OUTLINE;
    el.style.outlineOffset = '2px';
    // A row the PvE lock disabled cannot take focus in a browser (its settle re-anchors a focus
    // left on <body> to the heading; the next op seats the cursor).
    if (focus && !(el instanceof HTMLButtonElement && el.disabled)) el.focus();
  }

  /** A command row was pressed (a click, native Enter, or the cursor's A). Greyed: nothing. Run
   *  flees under the shared lock; the others move the cursor into their controls, Fight onto the
   *  skill this monster last used in this battle. */
  #chooseCommand(id: BattleCommand, btn: HTMLButtonElement): void {
    const vm = this.#vm;
    if (vm === null || btn.getAttribute('aria-disabled') === 'true') return;
    if (this.#pick !== null) this.#setPick(null);
    if (id === 'run') {
      this.#cursor = { list: 'commands', index: BATTLE_COMMANDS.indexOf('run') };
      this.#paintCursor(false);
      this.#dispatch(vm.battleId, () => this.#callbacks.onFlee(vm.battleId));
      return;
    }
    const index = id === 'fight' ? skillCursor(vm.skills, this.#lastSkill.get(vm.activeIndex)) : 0;
    this.#cursor = { list: SUBLIST[id], index };
    this.#paintCursor(true);
  }

  #renderCommands(vm: BattleViewModel): void {
    this.#commandRows = battleCommands(vm);
    this.#commandsEl.setAttribute('aria-label', t('battle.commands.label'));
    this.#commandsEl.style.display = vm.outcome === 'Ongoing' ? 'flex' : 'none';
    const labels: Record<BattleCommand, string> = {
      fight: t('battle.command.fight'),
      recruit: t('battle.command.recruit'),
      swap: t('battle.command.swap'),
      bag: t('battle.command.bag'),
      run: t('battle.command.run'),
    };
    for (const row of this.#commandRows) {
      const btn = this.#commandBtns.get(row.id);
      if (btn === undefined) continue;
      btn.textContent = labels[row.id];
      this.#greyCommand(btn, !row.enabled);
    }
    const run = this.#commandBtns.get('run');
    if (this.#commandRows.some((row) => row.reason === 'runPvp')) {
      this.#runReasonEl.textContent = t('battle.command.runPvpReason');
      this.#runReasonEl.style.display = 'block';
      run?.setAttribute('aria-describedby', this.#runReasonEl.id);
    } else {
      this.#runReasonEl.textContent = '';
      this.#runReasonEl.style.display = 'none';
      run?.removeAttribute('aria-describedby');
    }
    if (vm.pvpPendingSubmit && vm.outcome === 'Ongoing') {
      // The rival's name is model data; the catalog's role word stands in when it is unknown.
      const name = vm.pvpOpponentName ?? t('battle.card.opponent');
      this.#waitingEl.textContent = tf('battle.commands.waiting', { name });
      this.#waitingEl.style.display = 'block';
    } else {
      this.#waitingEl.textContent = '';
      this.#waitingEl.style.display = 'none';
    }
  }

  /** Grey a command row (focusable still) or make it live. The text stays >= 4.5:1 either way, so
   *  the border style (dashed) carries the difference without relying on luminance. */
  #greyCommand(btn: HTMLButtonElement, greyed: boolean): void {
    btn.setAttribute('aria-disabled', String(greyed));
    btn.style.color = greyed ? '#aab' : '#e0e0e0';
    btn.style.borderStyle = greyed ? 'dashed' : 'solid';
    btn.style.cursor = greyed ? 'default' : 'pointer';
  }

  /**
   * Every PvE click routes through here. No-op while THIS battle has a call in
   * flight; otherwise take the lock, disable every PvE control, and release in
   * `.finally()` on BOTH arms — a rejected or short-circuited call must never leave a
   * dead control. `new Promise((resolve) => resolve(run()))` calls `run` synchronously
   * (the callback fires inside the click, as before) and converts a synchronous throw
   * into a rejection instead of stranding the lock; `.catch` sits AFTER `.finally` so a
   * rejecting callback does not surface as an unhandled rejection (feedback is main.ts's
   * job — sendGuarded already reported it).
   */
  #dispatch(battleId: bigint, run: () => void | Promise<void>): void {
    if (this.#pending?.battleId === battleId) return;
    const lock = { battleId };
    this.#pending = lock;
    // Any action spends this turn, so an open Yes / target must not outlive it (#setPick re-renders
    // the actions row under the lock just taken).
    if (this.#pick !== null) this.#setPick(null);
    this.#setActionButtonsDisabled(true);
    void new Promise<void>((resolve) => resolve(run()))
      .finally(() => {
        if (this.#pending !== lock) return;
        this.#pending = null;
        // Re-enable whichever buttons are on screen NOW: a refresh() during the call
        // replaced the clicked node, and re-enabling the detached one would strand the
        // live ones disabled until the next batch.
        this.#setActionButtonsDisabled(false);
        this.#reanchorStrandedFocus();
      })
      .catch((err: unknown) => {
        console.error('battle action handler error', err);
      });
  }

  /** A lock-owning release that finds focus stranded on `<body>` re-asserts the
   *  dialog; the idempotent re-open re-installs the trap and defers focus to the registry anchor.
   *  `#visible` is load-bearing: re-opening a hidden view would CREATE an open record. */
  #reanchorStrandedFocus(): void {
    if (this.#visible && document.activeElement === document.body) {
      openOverlayA11y('battleView', this.#root);
    }
  }

  /** The skills grid and the actions row ARE the live-button registry (no per-button map).
   *  In a PvP battle this also covers the swap rows — the PvP Submit buttons are
   *  never rendered while `vm.pvpPendingSubmit` (RT-PVP-DS-01), so the two locks never overlap. */
  #setActionButtonsDisabled(disabled: boolean): void {
    for (const el of [this.#skillsEl, this.#actionsEl]) {
      for (const btn of el.querySelectorAll('button')) btn.disabled = disabled;
    }
    // The command rows grey with them (a locked Run or Fight is a second action in this turn),
    // and fall back to their own availability on release.
    for (const row of this.#commandRows) {
      const btn = this.#commandBtns.get(row.id);
      if (btn !== undefined) this.#greyCommand(btn, disabled || !row.enabled);
    }
  }

  #renderPvpStatus(vm: BattleViewModel): void {
    if (!vm.isPvp || vm.outcome !== 'Ongoing') {
      this.#pvpStatusEl.style.display = 'none';
      return;
    }
    if (vm.pvpPendingSubmit) {
      this.#pvpStatusEl.style.display = 'block';
      this.#pvpStatusEl.textContent = t('battle.pvp.waiting');
    } else {
      this.#pvpStatusEl.style.display = 'none';
    }
  }

  #renderWeather(vm: BattleViewModel): void {
    const w = vm.weather;
    if (w == null) {
      this.#weatherEl.style.display = 'none';
      this.#weatherEl.textContent = '';
      return;
    }
    this.#weatherEl.style.display = 'block';
    this.#weatherEl.textContent = tf('battle.weather.banner', {
      label: w.label,
      turns: w.turnsRemaining,
    });
  }

  #renderMonsterCard(el: HTMLDivElement, card: BattleMonsterCardVM, label: string): void {
    el.replaceChildren();
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;';
    const nameSpan = document.createElement('span');
    nameSpan.style.fontWeight = 'bold';
    nameSpan.textContent = `${label}: ${card.speciesName}`;
    header.appendChild(nameSpan);
    const lvSpan = document.createElement('span');
    lvSpan.textContent = tf('battle.card.level', { level: card.level });
    header.appendChild(lvSpan);
    el.appendChild(header);

    const hpBar = document.createElement('div');
    hpBar.style.cssText =
      'margin-top:4px;background:#333;border-radius:2px;height:12px;overflow:hidden;';
    const hpFill = document.createElement('div');
    // this class is the ONLY handle a stylesheet has on an element built by
    // `createElement`, and the width animation lives on `.hp-fill` in
    // `client/src/styles.css` precisely so the reduced-motion media query there can
    // neutralise it. An inline animation declaration wins over every stylesheet rule at
    // every specificity, so re-adding one here — in any spelling, including
    // `el.animate(...)` or `cssText +=` — silently defeats that guard. Gated by the
    // `RM3-HP-FILL` tooth below.
    // `width` and `background` stay inline: both are computed per render.
    hpFill.className = 'hp-fill';
    const pct = card.hpPercent;
    // M23 §2.6 / escalation §8.1 default (a): a colour-blind-SAFE DEFAULT
    // palette, not an opt-in theme. The old trio was #4a4 / #aa4 / #a44 — a red/green
    // pair whose healthy and wounded bands differ by only 1.21:1 in relative
    // luminance, i.e. indistinguishable without hue. This blue -> amber -> pale-yellow
    // axis survives all three dichromacies and is strictly monotone in luminance with
    // severity, so the band is readable in greyscale. Gated by the palette cases
    // in battleView.test.ts, which recompute the ratios from the rendered DOM rather
    // than pinning these literals. The bar track above is deliberately NOT retuned:
    // darkening it would satisfy the contrast clause with the hostile trio intact.
    const color = pct > 50 ? '#4a90d9' : pct > 20 ? '#f0aa44' : '#ffe680';
    hpFill.style.cssText = `width:${pct}%;height:100%;background:${color};`;
    hpBar.appendChild(hpFill);
    el.appendChild(hpBar);

    const hpText = document.createElement('div');
    hpText.style.cssText = 'font-size:11px;margin-top:2px;color:#aaa;';
    hpText.textContent = tf('battle.card.hpLine', {
      current: card.currentHp,
      max: card.maxHp,
      affinity: card.affinity,
    });
    el.appendChild(hpText);

    if (card.status) {
      const statusEl = document.createElement('div');
      statusEl.style.cssText =
        'display:inline-block;margin-top:4px;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:bold;background:#553;color:#ff9;';
      statusEl.textContent = card.status;
      el.appendChild(statusEl);
    }
  }

  #renderSkills(vm: BattleViewModel): void {
    this.#skillsEl.replaceChildren();
    const ongoing = vm.outcome === 'Ongoing';
    // Hide skill buttons when pending a PvP submission (waiting for opponent — no double-send).
    if (!ongoing || vm.skills.length === 0 || vm.pvpPendingSubmit) return;

    for (const skill of vm.skills) {
      const btn = document.createElement('button');
      btn.style.cssText =
        'padding:6px 8px;cursor:pointer;font-family:monospace;font-size:12px;' +
        'border:1px solid #666;border-radius:3px;background:#2a2a3e;color:#e0e0e0;';
      // The affinity label (closing the hover-only-title residual):
      // the affinity is a PERSISTENT VISIBLE label, not a
      // hover-only `title`; no-hover, touch and screen-reader users never see a tooltip.
      // Mirrors the monster card's own `HP x/y · Affinity` line in #renderMonsterCard.
      // Rendered VERBATIM, NOT as a short A11Y_TOKENS token: `game-core/src/content.rs`
      // records that the eight affinity token rows are DELIBERATELY unconsumed
      // BECAUSE this client renders the affinity name as text; a client-side token map
      // would be a second SSOT with no parity oracle. APPEND only — never prepend or
      // infix: `e2e/pvp-side-b.spec.ts` matches `/^Submit: /` (start-anchored),
      // `e2e/my-battle-privacy.spec.ts` and `e2e/recruit.spec.ts` match
      // `button:has-text("(")`, and this file's own test filters on `startsWith('Submit:')`.
      // PvP still says "Submit:" to distinguish it from PvE "use now" semantics.
      // The two label shapes live in ui/i18n/catalog.en.ts (`battle.skill.pvpSubmit` /
      // `battle.skill.pveLabel`) — the ordering constraint above now binds THOSE entries.
      // ctl-8i (R-rb-56-FOLLOWUP-ACC): the cell gives power and accuracy too, in both modes; the
      // hover-only accuracy title is gone.
      const label = {
        name: skill.name,
        power: skill.power,
        affinity: skill.affinity,
        accuracy: skill.accuracy,
      };
      btn.textContent = vm.isPvp
        ? tf('battle.skill.pvpSubmit', label)
        : tf('battle.skill.pveLabel', label);
      btn.setAttribute(LIST_ATTR, 'skills');
      // A press is remembered for this monster only once it is accepted (PvE: the lock taken).
      const used = (): void => {
        this.#lastSkill.set(vm.activeIndex, skill.id);
      };
      if (vm.isPvp) {
        btn.addEventListener('click', () => {
          used();
          this.#callbacks.onPvpAttack(vm.battleId, skill.id);
        });
      } else {
        btn.addEventListener('click', () =>
          this.#dispatch(vm.battleId, () => {
            used();
            return this.#callbacks.onAttack(vm.battleId, skill.id);
          }),
        );
      }
      this.#skillsEl.appendChild(btn);
    }
  }

  #renderActions(vm: BattleViewModel): void {
    this.#actionsEl.replaceChildren();
    if (vm.canFlee) {
      const fleeBtn = document.createElement('button');
      fleeBtn.style.cssText =
        'padding:6px 12px;cursor:pointer;font-family:monospace;background:#3a2a2a;' +
        'color:#e0e0e0;border:1px solid #844;border-radius:3px;';
      fleeBtn.textContent = t('battle.action.flee');
      fleeBtn.addEventListener('click', () =>
        this.#dispatch(vm.battleId, () => this.#callbacks.onFlee(vm.battleId)),
      );
      this.#actionsEl.appendChild(fleeBtn);
    }
    if (vm.canSwap) {
      this.#renderSwapButtons(vm);
    }
    // Toggled inline so the hint and the swap buttons read the SAME `vm.canSwap`
    // in the SAME method. The `Ongoing` conjunct is required — canSwap is false on EVERY terminal
    // outcome, so without it the hint would sit beside "Victory!". No isPvp branch.
    this.#swapHintEl.style.display = vm.outcome === 'Ongoing' && !vm.canSwap ? 'block' : 'none';
    // Recruit is wild-only (canRecruit); cure items are offered in any ongoing PvE battle
    // (cureItems is [] otherwise, so length is the sole render condition).
    this.#baitRows = new Map();
    if (vm.canRecruit) this.#renderRecruit(vm);
    this.#cureRows = new Map();
    if (vm.cureItems.length > 0) this.#renderCureItems(vm);
  }

  /** Re-render the actions row for a pick change, keeping the PvE lock on the new nodes. */
  #setPick(pick: BattlePick | null): void {
    this.#pick = pick;
    const vm = this.#vm;
    if (vm === null) return;
    this.#renderActions(vm);
    if (this.#pending?.battleId === vm.battleId) this.#setActionButtonsDisabled(true);
  }

  /** A bait or cure row was pressed: open its second step with the cursor on Yes / the target. */
  #choosePick(pick: BattlePick): void {
    this.#setPick(pick);
    this.#cursor = {
      list: pick.kind === 'recruitConfirm' ? 'recruitConfirm' : 'bagTarget',
      index: 0,
    };
    this.#paintCursor(true);
  }

  /** No, or B in the second step: close it and put the cursor back on the picked row (by its id,
   *  so a row that moved is still found; one that vanished sends the cursor to Fight). */
  #cancelPick(): void {
    const pick = this.#pick;
    this.#setPick(null);
    this.#seatOnPickedRow(pick);
    this.#paintCursor(true);
  }

  #seatOnPickedRow(pick: BattlePick | null): void {
    this.#cursor = { list: 'commands', index: 0 };
    if (pick === null) return;
    const list: CursorList = pick.kind === 'cureTarget' ? 'bag' : 'recruit';
    const row =
      pick.kind === 'cureTarget'
        ? this.#cureRows.get(pick.itemId)
        : this.#baitRows.get(pick.baitItemId);
    const index = row === undefined ? -1 : this.#rows(list).indexOf(row);
    if (index >= 0) this.#cursor = { list, index };
  }

  /** Yes / the target was pressed: spend the pick (read now, never from the pressed node) under the
   *  shared PvE lock. A node left from a closed or replaced step finds no pick and does nothing. */
  #commitPick(kind: BattlePick['kind']): void {
    const vm = this.#vm;
    const pick = this.#pick; // resolved against #vm by every refresh
    if (vm === null || pick?.kind !== kind) return;
    this.#setPick(null);
    this.#seatOnPickedRow(pick);
    this.#paintCursor(true);
    this.#dispatch(vm.battleId, () =>
      pick.kind === 'recruitConfirm'
        ? this.#callbacks.onRecruit(vm.battleId, pick.baitItemId)
        : this.#callbacks.onUseItem(vm.battleId, pick.itemId),
    );
  }

  /** A list root: a labelled group of rows (never a <select>, which would own the arrow keys). */
  #listRoot(testId: string, label: string): HTMLDivElement {
    const list = document.createElement('div');
    list.setAttribute('data-testid', testId);
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', label);
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    this.#actionsEl.appendChild(list);
    return list;
  }

  /** One cursor row in `list`, appended to `parent`. */
  #row(
    parent: HTMLElement,
    list: CursorList,
    text: string,
    border: string,
    onPress: () => void,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.setAttribute(LIST_ATTR, list);
    btn.style.cssText =
      'padding:6px 8px;cursor:pointer;font-family:monospace;font-size:12px;background:#222;' +
      `color:#e0e0e0;border:1px solid ${border};border-radius:3px;text-align:left;`;
    btn.textContent = text;
    btn.addEventListener('click', onPress);
    parent.appendChild(btn);
    return btn;
  }

  #renderRecruit(vm: BattleViewModel): void {
    // The bait list: No bait first (a bare attempt), then one row per bait, classified by data —
    // each bait row carries its recruit_bonus on a data attribute (the e2e contract surface).
    const list = this.#listRoot('bait-selector', t('battle.recruit.listLabel'));
    const pickBait = (baitItemId: number | undefined) => () =>
      this.#choosePick({
        kind: 'recruitConfirm',
        battleId: vm.battleId,
        turnNumber: vm.turnNumber,
        baitItemId,
      });
    const none = this.#row(
      list,
      'recruit',
      t('battle.recruit.noBait'),
      '#686',
      pickBait(undefined),
    );
    none.setAttribute('data-testid', 'bait-option-none');
    this.#baitRows.set(undefined, none);
    for (const bait of vm.baitOptions) {
      const text = `${bait.name} (+${bait.recruitBonus}‰) ×${bait.count}`;
      const row = this.#row(list, 'recruit', text, '#686', pickBait(bait.itemId));
      row.setAttribute('data-recruit-bonus', String(bait.recruitBonus));
      this.#baitRows.set(bait.itemId, row);
    }
    const pick = this.#pick;
    if (pick?.kind === 'recruitConfirm') this.#renderRecruitConfirm(vm, pick.baitItemId);
  }

  /** The Recruit question (design §5: Recruit is harmless, so Yes is the default), a group named
   *  by its question so a screen reader announces it with Yes. */
  #renderRecruitConfirm(vm: BattleViewModel, baitItemId: number | undefined): void {
    const confirm = document.createElement('div');
    confirm.setAttribute('data-testid', 'recruit-confirm');
    confirm.setAttribute('role', 'group');
    confirm.setAttribute('aria-labelledby', this.#promptId);
    confirm.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const prompt = document.createElement('div');
    prompt.id = this.#promptId;
    const bait = vm.baitOptions.find((b) => b.itemId === baitItemId);
    prompt.textContent =
      bait === undefined
        ? t('battle.recruit.confirmNoBait')
        : tf('battle.recruit.confirm', { bait: bait.name });
    confirm.appendChild(prompt);
    const yes = this.#row(confirm, 'recruitConfirm', t('battle.recruit.yes'), '#6a6', () =>
      this.#commitPick('recruitConfirm'),
    );
    yes.setAttribute('data-testid', 'recruit-action');
    const no = this.#row(confirm, 'recruitConfirm', t('battle.recruit.no'), '#686', () =>
      this.#cancelPick(),
    );
    no.setAttribute('data-testid', 'recruit-cancel');
    this.#actionsEl.appendChild(confirm);
  }

  #renderCureItems(vm: BattleViewModel): void {
    // The cure list, classified by data — each row carries data-cure-status.
    const list = this.#listRoot('cure-item-selector', t('battle.cure.listLabel'));
    for (const item of vm.cureItems) {
      const text = tf('battle.cure.option', {
        name: item.name,
        cureStatus: item.cureStatus,
        count: item.count,
      });
      const row = this.#row(list, 'bag', text, '#886', () =>
        this.#choosePick({
          kind: 'cureTarget',
          battleId: vm.battleId,
          turnNumber: vm.turnNumber,
          itemId: item.itemId,
        }),
      );
      row.setAttribute('data-cure-status', item.cureStatus);
      this.#cureRows.set(item.itemId, row);
    }
    if (this.#pick?.kind === 'cureTarget') this.#renderCureTarget(vm);
  }

  /** The Bag target: use_battle_item cures the ACTIVE monster, so it is the one row. */
  #renderCureTarget(vm: BattleViewModel): void {
    const target = document.createElement('div');
    target.setAttribute('data-testid', 'cure-target');
    target.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const use = this.#row(
      target,
      'bagTarget',
      tf('battle.cure.target', { species: vm.playerCard.speciesName }),
      '#886',
      () => this.#commitPick('cureTarget'),
    );
    use.setAttribute('data-testid', 'use-item-action');
    this.#actionsEl.appendChild(target);
  }

  #renderSwapButtons(vm: BattleViewModel): void {
    // PvP swap: skip when pvpPendingSubmit (waiting for opponent — no double-send).
    if (vm.isPvp && vm.pvpPendingSubmit) return;
    for (const member of vm.bench) {
      const btn = document.createElement('button');
      btn.setAttribute(LIST_ATTR, 'swap');
      btn.style.cssText =
        'padding:6px 12px;cursor:pointer;font-family:monospace;background:#2a2a3a;' +
        'color:#e0e0e0;border:1px solid #448;border-radius:3px;';
      btn.textContent = vm.isPvp
        ? tf('battle.swap.pvpSubmit', { species: member.speciesName })
        : tf('battle.swap.pveLabel', {
            species: member.speciesName,
            current: member.currentHp,
            max: member.maxHp,
          });
      if (vm.isPvp) {
        btn.addEventListener('click', () =>
          this.#callbacks.onPvpSwap(vm.battleId, member.teamIndex),
        );
      } else {
        btn.addEventListener('click', () =>
          this.#dispatch(vm.battleId, () => this.#callbacks.onSwap(vm.battleId, member.teamIndex)),
        );
      }
      this.#actionsEl.appendChild(btn);
    }
  }

  #renderOutcome(vm: BattleViewModel): void {
    if (vm.outcome === 'Ongoing') {
      this.#outcomeEl.style.display = 'none';
      this.#continueHintEl.style.display = 'none';
      return;
    }
    this.#outcomeEl.style.display = 'block';
    // Rides this existing predicate; no isPvp branch — the Escape-dismiss
    // branch (main.ts, gated only on battleView?.visible) is battle-kind-agnostic.
    this.#continueHintEl.style.display = 'block';
    let text: string;
    switch (vm.outcome) {
      case 'SideAWins':
        text = t('battle.outcome.victory');
        break;
      case 'SideBWins':
        text = t('battle.outcome.defeat');
        break;
      case 'Fled':
        text = t('battle.outcome.fled');
        break;
      default: {
        // Exhaustiveness check: vm.outcome is BattleOutcomeTag, so the union is
        // fully covered above. This arm is genuinely unreachable — unknown outcomes
        // are rejected by buildBattleViewModel (null return) before reaching the view.
        const _exhaustive: never = vm.outcome;
        text = '';
        void _exhaustive;
      }
    }
    this.#outcomeEl.textContent = text;
  }
}
