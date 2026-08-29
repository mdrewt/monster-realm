// rb-13 gating teeth for evals/keyboard-operable-rows.eval.mjs (M23 spec 5.4).
//
// WRITTEN BY THE TESTER. The implementer supplies the matcher namespace `M`; this file
// defines the CONTRACT and must not be edited to fit a buggy implementation.
//
// ---------------------------------------------------------------------------------------
// MATCHER CONTRACT (exactly these entry points, no others)
// ---------------------------------------------------------------------------------------
//   M.stripTsComments(src) -> string
//       Removes line and block comments. Must NOT remove code, and must NOT strip inside
//       string literals (the innerHTML teeth depend on literal text surviving).
//
//   M.findClickSites(stripped)   -> [{ line, receiver, handlerText, spelling }]
//   M.findKeydownSites(stripped) -> [{ line, receiver, handlerText, spelling }]
//       `spelling` is 'addEventListener' or 'property' (for `el.onclick = fn`).
//       `receiver` is a SCOPE-QUALIFIED key: two registrations whose receiver text is
//       identical but whose binding is not the same binding (different class, rebound
//       `let`) MUST NOT produce equal `receiver` values.
//       `handlerText` is the RESOLVED handler body. A named function reference
//       (`root.addEventListener('keydown', onKeydown, true)`) must be resolved to its
//       in-file definition's body, not reported as unparseable.
//
//   M.classify(stripped, site) -> { arm, reason }
//       arm 'native'    -> receiver is provably a native <button>/<a>. PASSES outright.
//       arm 'delegated' -> receiver is provably NOT native. Identity rules then apply.
//       arm null        -> undecidable (must then be reported by M.scanFailLoud).
//       `reason` must be a non-empty string.
//       ARM PRECEDENCE IS LOAD-BEARING (reviewer blocker B1): 'native' is resolved FIRST
//       and short-circuits; identity is consulted ONLY for the 'delegated' arm.
//       Native evidence requires an argument list that is EXACTLY ONE string literal
//       (a ternary or a `.replace()` is forged evidence, not native), and it is
//       RECEIVER-scoped: a `createElement('button')` elsewhere in the file is not
//       evidence about THIS receiver.
//
//   M.identityOk(stripped, clickSite, keydownSite) -> { ok, shared, reason }
//       `shared` MUST list only callees the keydown handler actually INVOKES on a
//       REACHABLE path, intersected with the callees the click body invokes. Token
//       presence is explicitly NOT invocation: a dead branch, a never-called nested
//       arrow, an unreachable catch, a locally shadowed object, or a statement after an
//       unconditional `return` contributes NOTHING to `shared`. JS keywords and builtins
//       (`if`, `for`, `Boolean`, `Math.max`) are never callbacks and never make ok true.
//
//   M.findTabindexWrites(stripped) -> [{ line, receiver, value, spelling }]
//       spelling is one of 'property' | 'setAttribute' | 'setAttributeNS' |
//       'objectAssign' | 'innerHTML'. `value` is the literal text written ('-1', '5',
//       'auto', '0.5'). Attribute names are matched case-INSENSITIVELY.
//
//   M.tabindexVerdict(stripped, write) -> { tag, reason }   tag is the tag it VIOLATES.
//       '[A11Y-T3]' negative tabindex on a receiver that itself carries a click/keydown
//                   binding; '[A11Y-T5]' value > 0 or non-integer; null when fine.
//
//   M.scanFailLoud(stripped) -> string[]
//       Reasons the source cannot be decided; [] when fully decidable. Each reason MUST
//       name the receiver / binding it could not decide, so a fail-loud tooth can assert
//       WHICH construct defeated the scanner rather than that "something" did.
//
// ---------------------------------------------------------------------------------------
// THE VERDICT COMPOSITION runTeeth() DRIVES (this is the decision procedure under test)
// ---------------------------------------------------------------------------------------
//   classify(click).arm === 'native'    -> PASS (null verdict), keydown irrelevant.
//   classify(click).arm === 'delegated' -> keydown sites whose `receiver` equals the
//       click's `receiver` are the candidate pairs.
//         no candidate            -> '[A11Y-12]'
//         candidate, none with identityOk().ok === true -> '[A11Y-13]'
//         some candidate ok       -> PASS (null verdict)
//
// ---------------------------------------------------------------------------------------
// AUTHORING RULES OBEYED HERE (mechanically re-checked at run time)
// ---------------------------------------------------------------------------------------
//   * No `main` guard, no process.exit: evals/run.mjs imports this beside the eval.
//   * No dynamic `new RegExp` anywhere (Semgrep detect-non-literal-regexp is remote-only).
//   * No raw backtick and no block-comment opener inside any fixture string; the two
//     forbidden characters are composed via String.fromCharCode so this file cannot
//     corrupt itself, and EVERY fixture is asserted clean before it is used. A GOOD
//     fixture that accidentally contained a block-comment opener was MEASURED to pass
//     vacuously at zero matched sites -- hence the structural-before-behavioural rule.

const BACKTICK = String.fromCharCode(96);
const SLASHSTAR = String.fromCharCode(47, 42);
const Q = String.fromCharCode(39);
const DQ = String.fromCharCode(34);

/** Wrap `s` in single quotes, so fixtures never need an escaped quote. */
function q(s) {
  return Q + s + Q;
}

function L(lines) {
  return lines.join('\n');
}

function ael(recv, ev) {
  return recv + '.addEventListener(' + q(ev) + ', ';
}

// ---------------------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------------------

const CLICK_BODY = ['callbacks.onInput({ kind: ' + q('click') + ' });'];
const CB_CALL_KEY = 'callbacks.onInput({ kind: ' + q('key') + ' });';

/** The shipped menuView shape: a delegated, non-native #rowsEl carrying click + keydown. */
function rowsFixture(clickLines, keyLines) {
  const out = [
    'export class V {',
    '  readonly #rowsEl: HTMLElement;',
    '  constructor(callbacks: MenuViewCallbacks) {',
    '    this.#rowsEl = document.getElementById(' + q('menu-rows') + ') as HTMLElement;',
    '    ' + ael('this.#rowsEl', 'click') + '(e) => {',
  ];
  for (const line of clickLines) out.push('      ' + line);
  out.push('    });');
  out.push('    ' + ael('this.#rowsEl', 'keydown') + '(e) => {');
  for (const line of keyLines) out.push('      ' + line);
  out.push('    });');
  out.push('  }');
  out.push('}');
  return L(out);
}

/** A BAD [A11Y-13] record whose keydown MENTIONS the callback but never invokes it. */
function inert13(id, keyLines, why) {
  return {
    id,
    tag: '[A11Y-13]',
    polarity: 'BAD',
    src: rowsFixture(CLICK_BODY, keyLines),
    expect: {
      needles: ['callbacks.onInput', 'keydown'],
      clicks: 1,
      keydowns: 1,
      clickSpelling: 'addEventListener',
      keydownSpelling: 'addEventListener',
      arm: 'delegated',
      verdict: '[A11Y-13]',
      sharedExcludes: ['callbacks.onInput'],
    },
    why,
  };
}

/** A BAD [A11Y-13] record whose keydown shares only a keyword/builtin with the click. */
function sharedToken13(id, clickLines, keyLines, token, why) {
  return {
    id,
    tag: '[A11Y-13]',
    polarity: 'BAD',
    src: rowsFixture(clickLines, keyLines),
    expect: {
      needles: ['callbacks.onInput', token],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: '[A11Y-13]',
      sharedExcludes: ['callbacks.onInput'],
    },
    why,
  };
}

/** A single tabindex write in a file with no listeners at all. */
function bareTabindexFixture(writeLine) {
  return L([
    'export function decorate(panel: HTMLElement): void {',
    '  ' + writeLine,
    '}',
  ]);
}

/** A tabindex write on a native button that DOES carry a click listener. */
function interactiveTabindexFixture(writeLine) {
  return L([
    'export function mount(root: HTMLElement): void {',
    '  const btn = document.createElement(' + q('button') + ');',
    '  ' + ael('btn', 'click') + '() => {',
    '    doIt();',
    '  });',
    '  ' + writeLine,
    '  root.appendChild(btn);',
    '}',
  ]);
}

function tabindexTooth(id, tag, polarity, src, spelling, value, verdictTag, needles, why, extra) {
  const expect = {
    needles,
    tabindexWrites: 1,
    tabindexSpelling: spelling,
    tabindexValue: value,
    tabindexTag: verdictTag,
  };
  if (extra) {
    for (const k of Object.keys(extra)) expect[k] = extra[k];
  }
  return { id, tag, polarity, src, expect, why };
}

function failLoudTooth(id, src, mentions, needles, why) {
  return {
    id,
    tag: '[FAIL-LOUD]',
    polarity: 'FAILLOUD',
    src,
    expect: { needles, loudAtLeast: 1, loudMentions: mentions },
    why,
  };
}

// ---------------------------------------------------------------------------------------
// TEETH
// ---------------------------------------------------------------------------------------

export const TEETH = [
  // ---- [A11Y-13] inert keydown handlers that a token-presence check passes ----------
  inert13(
    'A13-INERT-DEAD-BRANCH',
    ['if (false) {', '  ' + CB_CALL_KEY, '}'],
    'Kills a presence-check: the callback token is in the keydown body but sits behind a ' +
      'statically false branch, so no key press ever reaches it.',
  ),
  inert13(
    'A13-INERT-NESTED-ARROW',
    ['const dead = () => ' + CB_CALL_KEY.slice(0, -1) + ';'],
    'Kills a presence-check AND a naive "callee appears at any depth" walker: the arrow ' +
      'that would invoke the callback is defined and never called.',
  ),
  inert13(
    'A13-INERT-MOUSE-ONLY-GUARD',
    ['if (e.button === 0) {', '  ' + CB_CALL_KEY, '}'],
    'A KeyboardEvent has no .button, so the guard is never true for a keydown. Kills an ' +
      'impl that accepts any conditional invocation without reading the condition.',
  ),
  inert13(
    'A13-INERT-UNREACHABLE-CATCH',
    ['try {', '  const n = 1;', '} catch (err) {', '  ' + CB_CALL_KEY, '}'],
    'The try body cannot throw, so the catch is dead. Kills an impl that treats every ' +
      'block in the handler as reachable.',
  ),
  inert13(
    'A13-INERT-EARLY-RETURN',
    ['return;', CB_CALL_KEY],
    'An unconditional return precedes the call. Kills an impl that scans the whole body ' +
      'without tracking control flow.',
  ),
  inert13(
    'A13-INERT-LOCAL-SHADOW',
    [
      'const callbacks = { onInput(x: MenuInput) {} };',
      CB_CALL_KEY,
    ],
    'The call really executes -- on a locally shadowed no-op object, not the constructor ' +
      "parameter. Kills every text-keyed identity check: the callee spelling is identical.",
  ),
  inert13(
    'A13-INERT-WRONG-EVENT-TYPE',
    ['if (e.type === ' + q('click') + ') {', '  ' + CB_CALL_KEY, '}'],
    'A keydown listener can never see e.type === click. Kills an impl that reads the ' +
      'condition syntactically but not its relation to the registered event type.',
  ),
  inert13(
    'A13-INERT-TYPEOF-GUARD',
    ['if (typeof callbacks.onInput === ' + q('string') + ') {', '  ' + CB_CALL_KEY, '}'],
    'A function is never typeof "string". Kills an impl that whitelists typeof guards as ' +
      '"probably fine".',
  ),

  // ---- [A11Y-13] shared token but no shared CALLBACK --------------------------------
  sharedToken13(
    'A13-SHARED-KEYWORD-IF',
    ['if (e.target !== null) {', '  ' + CLICK_BODY[0], '}'],
    ['if (e.repeat) {', '  return;', '}'],
    'if',
    'The shipped menuView pair intersects to ["callbacks.onInput","if"]; a non-empty ' +
      'intersection therefore proves nothing. This fixture leaves ONLY "if" shared, so an ' +
      'impl that accepts a non-empty intersection goes green on a keydown that calls nothing.',
  ),
  sharedToken13(
    'A13-SHARED-KEYWORD-FOR',
    ['for (const r of rows) {', '  ' + CLICK_BODY[0], '}'],
    ['for (const r of rows) {', '  total += 1;', '}'],
    'for',
    'Same defect as the "if" tooth via a second keyword, so a one-off keyword blacklist ' +
      'containing only "if" does not survive.',
  ),
  sharedToken13(
    'A13-SHARED-BUILTIN-BOOLEAN',
    ['if (Boolean(e.target)) {', '  ' + CLICK_BODY[0], '}'],
    ['const b = Boolean(e.repeat);'],
    'Boolean',
    'Boolean is a real CALL, not a keyword, so a keyword-only blacklist accepts it as a ' +
      'shared callee. Kills that: a global builtin is never the view callback.',
  ),
  sharedToken13(
    'A13-SHARED-BUILTIN-MATH-MAX',
    ['callbacks.onInput({ kind: ' + q('click') + ', i: Math.max(0, idx) });'],
    ['const m = Math.max(2, 3);'],
    'Math.max',
    'A shared MEMBER-expression builtin. Kills a blacklist that only rejects bare ' +
      'identifiers and lets any dotted callee through as "a callback".',
  ),

  // ---- [A11Y-13] GOOD: must PASS ----------------------------------------------------
  {
    id: 'A13-GOOD-MENUVIEW-REAL-SHAPE',
    tag: '[A11Y-13]',
    polarity: 'GOOD',
    src: L([
      'export class MenuView {',
      '  readonly #rowsEl: HTMLElement;',
      '  constructor(callbacks: MenuViewCallbacks) {',
      '    this.#rowsEl = document.getElementById(' + q('menu-rows') + ') as HTMLElement;',
      '    ' + ael('this.#rowsEl', 'click') + '(e) => {',
      '      const index = this.#indexOfEventTarget(e.target);',
      '      if (index !== undefined) callbacks.onInput({ kind: ' + q('click') + ', index });',
      '    });',
      '    ' + ael('this.#rowsEl', 'mouseover') + '(e) => {',
      '      const index = this.#indexOfEventTarget(e.target);',
      '      if (index !== undefined) callbacks.onInput({ kind: ' + q('hover') + ', index });',
      '    });',
      '    ' + ael('this.#rowsEl', 'keydown') + '(e) => {',
      '      if (!this.visible) return;',
      '      if (e.repeat) return;',
      '      const input = menuKeyInput(e.code);',
      '      if (input === undefined) return;',
      '      e.preventDefault();',
      '      e.stopPropagation();',
      '      callbacks.onInput(input);',
      '    });',
      '  }',
      '}',
    ]),
    expect: {
      needles: ['callbacks.onInput(input)', 'mouseover'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: null,
      sharedIncludes: ['callbacks.onInput'],
    },
    why:
      'The LIVE menuView.ts shape. Three defects die here at once: (a) counting the ' +
      'mouseover listener as a click site (clicks must be exactly 1); (b) keying identity ' +
      'on a BARE identifier -- the spec text guessed `handleMenuInput`, but the shipped ' +
      'callee is the member expression `callbacks.onInput`, so a bare-identifier design ' +
      "false-REDs the spec's own GOOD fixture; (c) returning ok on an empty intersection -- " +
      'sharedIncludes pins the actual callee, so an empty-shared pass cannot fake it.',
  },
  {
    id: 'A13-GOOD-CALLEE-STARTSWITH-PARAM',
    tag: '[A11Y-13]',
    polarity: 'GOOD',
    src: L([
      'import { eventRing } from ' + q('./eventRing') + ';',
      'export function wireRow(row: HTMLLIElement): void {',
      '  ' + ael('row', 'click') + '(e) => {',
      '    eventRing.push({ kind: ' + q('boxOpen') + ' });',
      '  });',
      '  ' + ael('row', 'keydown') + '(e) => {',
      '    if (e.code === ' + q('Enter') + ') eventRing.push({ kind: ' + q('boxOpen') + ' });',
      '  });',
      '}',
    ]),
    expect: {
      needles: ['eventRing.push'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: null,
      sharedIncludes: ['eventRing.push'],
    },
    why:
      'client/src/ui/eventRing.ts is a real module. The handler parameter is `e` and the ' +
      'shared callee `eventRing.push` merely STARTS WITH `e`. A noise filter written as ' +
      'callee.startsWith(param) deletes the only shared callee and false-REDs a correct ' +
      'pair. This tooth kills that filter.',
  },

  // ---- [A11Y-12] BAD ----------------------------------------------------------------
  {
    id: 'A12-BAD-BARE-LI-CLICK',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(list: HTMLElement): void {',
      '  const li = document.createElement(' + q('li') + ');',
      '  ' + ael('li', 'click') + '() => {',
      '    pick(1);',
      '  });',
      '  list.appendChild(li);',
      '}',
    ]),
    expect: {
      needles: ['createElement(' + q('li') + ')'],
      clicks: 1,
      keydowns: 0,
      clickSpelling: 'addEventListener',
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why: 'The baseline violation: a non-native receiver with a click and no keydown at all.',
  },
  {
    id: 'A12-BAD-EMPTY-PAIRED-KEYDOWN',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(list: HTMLElement): void {',
      '  const li = document.createElement(' + q('li') + ');',
      '  ' + ael('li', 'click') + '() => {',
      '    pick(1);',
      '  });',
      '  ' + ael('li', 'keydown') + '() => {});',
      '  list.appendChild(li);',
      '}',
    ]),
    expect: {
      needles: ['keydown'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdictAnyOf: ['[A11Y-12]', '[A11Y-13]'],
      sharedExcludes: ['pick'],
    },
    why:
      "The spec's fixture 13: an empty keydown bought purely to satisfy a pairing check. " +
      'SPEC AMBIGUITY, DELIBERATELY NOT GUESSED: the handoff files this under [A11Y-12] ' +
      '("no VALID paired keydown") while the composition that the eight inert teeth pin ' +
      'yields [A11Y-13] (a pair exists, identity fails). Both readings agree it must FAIL, ' +
      'so this record pins the failing SET and excludes PASS / T3 / T5. Whoever settles the ' +
      'tag must edit the SPEC and then this record -- never the record alone.',
  },
  {
    id: 'A12-BAD-FILE-MENTION-ANTI-ARM',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(panel: HTMLElement): void {',
      '  const closeBtn = document.createElement(' + q('button') + ');',
      '  closeBtn.textContent = ' + q('Close') + ';',
      '  panel.appendChild(closeBtn);',
      '  const li = document.createElement(' + q('li') + ');',
      '  ' + ael('li', 'click') + '() => {',
      '    pick(2);',
      '  });',
      '}',
    ]),
    expect: {
      needles: ['createElement(' + q('button') + ')', 'createElement(' + q('li') + ')'],
      clicks: 1,
      keydowns: 0,
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why:
      'The file-mention anti-arm. An impl that arms "native" from a FILE-level ' +
      "src.includes(\"createElement('button')\") goes green here, because the button exists " +
      'but belongs to a different element that carries no listener. Native evidence must be ' +
      'RECEIVER-scoped.',
  },
  {
    id: 'A12-BAD-ONCLICK-PROPERTY-SPELLING',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(list: HTMLElement): void {',
      '  const li = document.createElement(' + q('li') + ');',
      '  li.onclick = () => {',
      '    pick(3);',
      '  };',
      '  list.appendChild(li);',
      '}',
    ]),
    expect: {
      needles: ['li.onclick ='],
      clicks: 1,
      keydowns: 0,
      clickSpelling: 'property',
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why:
      'Red-team measured this ENTIRE class invisible: an addEventListener-only scanner ' +
      'reports zero sites here and the eval is green on a keyboard-dead row. Pinning ' +
      "clickSpelling === 'property' means the site cannot be found by accident.",
  },
  {
    id: 'A12-BAD-FORGED-NATIVE-TERNARY',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(tag: string): void {',
      '  const el = document.createElement(' + q('button') + ' === tag ? ' + q('button') + ' : ' + q('li') + ');',
      '  ' + ael('el', 'click') + '() => {',
      '    pick(4);',
      '  });',
      '}',
    ]),
    expect: {
      needles: ['? ' + q('button') + ' : ' + q('li')],
      clicks: 1,
      keydowns: 0,
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why:
      'Forged native evidence. A regex that finds createElement( followed by a button ' +
      'literal anywhere in the argument list arms "native" and passes an <li>. Native ' +
      'evidence requires an argument list of EXACTLY ONE string literal.',
  },
  {
    id: 'A12-BAD-FORGED-NATIVE-REPLACE',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(): void {',
      '  const el = document.createElement(' + q('button') + '.replace(' + q('button') + ', ' + q('li') + '));',
      '  ' + ael('el', 'click') + '() => {',
      '    pick(5);',
      '  });',
      '}',
    ]),
    expect: {
      needles: ['.replace('],
      clicks: 1,
      keydowns: 0,
      arm: 'delegated',
      verdict: '[A11Y-12]',
    },
    why:
      'A second forgery whose first argument STARTS with the button literal, so a ' +
      '"first argument begins with a native literal" relaxation of the ternary fix still ' +
      'dies here.',
  },

  // ---- [A11Y-12] GOOD: LIVE shapes that must PASS ------------------------------------
  {
    id: 'A12-GOOD-NATIVE-CREATEELEMENT-NO-KEYDOWN',
    tag: '[A11Y-12]',
    polarity: 'GOOD',
    src: L([
      'export function wire(root: HTMLElement): void {',
      '  const btn = document.createElement(' + q('button') + ');',
      '  btn.textContent = ' + q('Buy') + ';',
      '  ' + ael('btn', 'click') + '() => {',
      '    doBuy();',
      '  });',
      '  root.appendChild(btn);',
      '}',
    ]),
    expect: {
      needles: ['createElement(' + q('button') + ')'],
      clicks: 1,
      keydowns: 0,
      arm: 'native',
      verdict: null,
    },
    why:
      '21 shipped sites have exactly this shape. A design that demands a paired keydown ' +
      'for every click site false-REDs the whole tree; a native <button> is keyboard ' +
      'operable by the platform.',
  },
  {
    id: 'A12-GOOD-NATIVE-ENSUREELEMENT-ZERO-ARG-ARROW',
    tag: '[A11Y-12]',
    polarity: 'GOOD',
    src: L([
      'export function wire(): void {',
      '  const btn = ensureElement(' + q('save-btn') + ', ' + q('button') + ');',
      '  ' + ael('btn', 'click') + '() => handler());',
      '}',
    ]),
    expect: {
      needles: ['ensureElement('],
      clicks: 1,
      keydowns: 0,
      arm: 'native',
      verdict: null,
    },
    why:
      'Two shipped sites. Second evidence SPELLING (a helper, not document.createElement) ' +
      'plus an EXPRESSION-body zero-arg arrow, which a handler parser expecting a brace ' +
      'block truncates to the empty string.',
  },
  {
    id: 'A12-GOOD-NATIVE-TYPED-FIELD-EMPTY-INTERSECTION',
    tag: '[A11Y-12]',
    polarity: 'GOOD',
    src: L([
      'export class RenameView {',
      '  readonly #submitBtn: HTMLButtonElement;',
      '  constructor(cbs: RenameCallbacks) {',
      '    this.#submitBtn = document.getElementById(' + q('rename-submit') + ') as HTMLButtonElement;',
      '    ' + ael('this.#submitBtn', 'keydown') + '(e) => {',
      '      e.stopPropagation();',
      '    });',
      '    ' + ael('this.#submitBtn', 'click') + '() => {',
      '      this.#submit();',
      '    });',
      '  }',
      '}',
    ]),
    expect: {
      needles: ['HTMLButtonElement', 'this.#submit()'],
      clicks: 1,
      keydowns: 1,
      arm: 'native',
      verdict: null,
      identityWouldFail: true,
    },
    why:
      'REVIEWER BLOCKER B1, pinned. Shipped at renameView.ts:84-90 and ' +
      'tradeProposeView.ts:112-117. The click body invokes this.#submit(); the keydown body ' +
      'invokes only e.stopPropagation() -- the identity intersection is EMPTY. It must ' +
      'still PASS, because the receiver is native. identityWouldFail additionally asserts ' +
      'that identityOk() really does return ok:false with an empty shared set here, so the ' +
      'PASS is proven to come from ARM PRECEDENCE (native resolved first, identity consulted ' +
      'only for delegated) and not from an identity check that accidentally passes.',
  },
  {
    id: 'A12-GOOD-LISTENER-FREE-NEGATIVE-TABINDEX',
    tag: '[A11Y-T3]',
    polarity: 'GOOD',
    src: L([
      'export function wire(root: HTMLElement): void {',
      '  const btn = document.createElement(' + q('button') + ');',
      '  ' + ael('btn', 'click') + '() => {',
      '    doIt();',
      '  });',
      '  const label = document.createElement(' + q('span') + ');',
      '  label.setAttribute(' + q('tabindex') + ', ' + q('-1') + ');',
      '  root.append(btn, label);',
      '}',
    ]),
    expect: {
      needles: ['setAttribute(' + q('tabindex') + ', ' + q('-1') + ')'],
      clicks: 1,
      keydowns: 0,
      arm: 'native',
      verdict: null,
      tabindexWrites: 1,
      tabindexSpelling: 'setAttribute',
      tabindexValue: '-1',
      tabindexTag: null,
    },
    why:
      'Four shipped sites: a programmatically focusable, NON-interactive element in a file ' +
      'that does have listeners on a sibling. T3 is about a negative tabindex on a receiver ' +
      'that ITSELF carries a binding; a file-level "has listeners + has tabindex -1" check ' +
      'false-REDs this shipped shape.',
  },

  // ---- [A11Y-T3] / [A11Y-T5] BAD ----------------------------------------------------
  tabindexTooth(
    'T3-BAD-PROPERTY-NEGATIVE-INTERACTIVE',
    '[A11Y-T3]',
    'BAD',
    interactiveTabindexFixture('btn.tabIndex = -1;'),
    'property',
    '-1',
    '[A11Y-T3]',
    ['btn.tabIndex = -1'],
    'The canonical NEGATIVE_TABINDEX_INTERACTIVE shape: an element that handles clicks is ' +
      'removed from the tab order, so it is mouse-only. Property spelling, which an ' +
      'attribute-only scanner never sees.',
    { clicks: 1, arm: 'native', verdict: null },
  ),
  tabindexTooth(
    'T3-BAD-SETATTR-NEGATIVE-INTERACTIVE',
    '[A11Y-T3]',
    'BAD',
    interactiveTabindexFixture('btn.setAttribute(' + q('tabindex') + ', ' + q('-1') + ');'),
    'setAttribute',
    '-1',
    '[A11Y-T3]',
    ['setAttribute(' + q('tabindex') + ', ' + q('-1') + ')'],
    'The same T3 defect through the attribute spelling. Kills a T3 rule implemented only ' +
      'over the .tabIndex property, and together with the listener-free GOOD tooth it pins ' +
      'that T3 turns on the RECEIVER carrying a binding, not on the spelling.',
    { clicks: 1, arm: 'native', verdict: null },
  ),
  tabindexTooth(
    'T5-BAD-PROPERTY-POSITIVE',
    '[A11Y-T5]',
    'BAD',
    interactiveTabindexFixture('btn.tabIndex = 5;'),
    'property',
    '5',
    '[A11Y-T5]',
    ['btn.tabIndex = 5'],
    'A positive tabindex hijacks document tab order globally. Property spelling again, and ' +
      'the value is an unquoted NUMBER, which a string-literal-only value parser misses.',
    { clicks: 1, arm: 'native', verdict: null },
  ),
  tabindexTooth(
    'T5-BAD-OBJECT-ASSIGN',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('Object.assign(panel, { tabIndex: 3 });'),
    'objectAssign',
    '3',
    '[A11Y-T5]',
    ['Object.assign(panel, { tabIndex: 3 })'],
    'A third write spelling with no assignment operator and no setAttribute call at all. ' +
      'Also proves T5 does not require the file to contain any listener.',
  ),
  tabindexTooth(
    'T5-BAD-SETATTR-POSITIVE',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttribute(' + q('tabindex') + ', ' + q('1') + ');'),
    'setAttribute',
    '1',
    '[A11Y-T5]',
    ['setAttribute(' + q('tabindex') + ', ' + q('1') + ')'],
    'The plain positive attribute write -- the control for the exotic spellings below.',
  ),
  tabindexTooth(
    'T5-BAD-NON-INTEGER-AUTO',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttribute(' + q('tabindex') + ', ' + q('auto') + ');'),
    'setAttribute',
    'auto',
    '[A11Y-T5]',
    ['setAttribute(' + q('tabindex') + ', ' + q('auto') + ')'],
    'parseInt("auto") is NaN, and `NaN > 0` is false -- so a parseInt-only check silently ' +
      'accepts a value that is not a valid tabindex at all.',
  ),
  tabindexTooth(
    'T5-BAD-NON-INTEGER-FRACTION',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttribute(' + q('tabindex') + ', ' + q('0.5') + ');'),
    'setAttribute',
    '0.5',
    '[A11Y-T5]',
    ['setAttribute(' + q('tabindex') + ', ' + q('0.5') + ')'],
    'The nastier parseInt hole: parseInt("0.5") is 0, which passes a `> 0` test outright. ' +
      'Only an integer-shape check catches it.',
  ),
  tabindexTooth(
    'T5-BAD-MIXED-CASE-ATTR-NAME',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttribute(' + q('TabIndex') + ', ' + q('2') + ');'),
    'setAttribute',
    '2',
    '[A11Y-T5]',
    ['setAttribute(' + q('TabIndex') + ', ' + q('2') + ')'],
    'HTML attribute names are case-insensitive, so this really does set tabindex. A ' +
      'case-sensitive literal match reports zero writes.',
  ),
  tabindexTooth(
    'T5-BAD-SETATTRIBUTENS',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture('panel.setAttributeNS(null, ' + q('tabindex') + ', ' + q('4') + ');'),
    'setAttributeNS',
    '4',
    '[A11Y-T5]',
    ['setAttributeNS(null'],
    'The namespaced sibling API, whose value is the THIRD argument. A scanner keyed on ' +
      'setAttribute( with the value in argument two mis-reads or skips it.',
  ),
  tabindexTooth(
    'T5-BAD-INNERHTML-LITERAL',
    '[A11Y-T5]',
    'BAD',
    bareTabindexFixture(
      'panel.innerHTML = ' + q('<li tabindex=' + DQ + '1' + DQ + '>row</li>') + ';',
    ),
    'innerHTML',
    '1',
    '[A11Y-T5]',
    ['tabindex=' + DQ + '1' + DQ],
    'A positive tabindex smuggled through markup in a string literal. Kills a scanner that ' +
      'only ever inspects DOM API call arguments, and simultaneously pins that ' +
      'stripTsComments does NOT reach inside string literals.',
  ),

  // ---- comment stripping ------------------------------------------------------------
  {
    id: 'STRIP-LINE-COMMENT-DECOY',
    tag: '[A11Y-T5]',
    polarity: 'GOOD',
    src: L([
      'export function wire(root: HTMLElement): void {',
      '  const btn = document.createElement(' + q('button') + ');',
      '  // legacy shape, deleted in m20: btn.tabIndex = 5; and li.onclick = bad;',
      '  ' + ael('btn', 'click') + '() => {',
      '    doIt();',
      '  });',
      '  root.appendChild(btn);',
      '}',
    ]),
    expect: {
      needles: ['createElement(' + q('button') + ')'],
      absentNeedles: ['legacy shape', 'btn.tabIndex = 5', 'li.onclick'],
      clicks: 1,
      keydowns: 0,
      tabindexWrites: 0,
      arm: 'native',
      verdict: null,
    },
    why:
      'A raw-text scanner reports a phantom [A11Y-T5] and a phantom property click site ' +
      'from a comment describing code that no longer exists. absentNeedles proves the ' +
      'stripper really removed the text rather than the counters happening to be zero.',
  },

  // ---- FAIL-LOUD: undecidable constructs must be REPORTED ----------------------------
  failLoudTooth(
    'FL-BOUND-HANDLER-REFERENCE',
    L([
      'export function wire(list: HTMLElement): void {',
      '  const bindEl = document.createElement(' + q('li') + ');',
      '  ' + ael('bindEl', 'click') + 'handler.bind(this));',
      '  list.appendChild(bindEl);',
      '}',
    ]),
    ['bindEl'],
    ['.bind(this)'],
    'A .bind() expression has no in-file body to resolve, so identity is undecidable. ' +
      'Silently skipping it is a hole an author can drive every violation through.',
  ),
  failLoudTooth(
    'FL-SPLIT-ATTRIBUTE-NAME',
    bareTabindexFixture(
      'splitEl.setAttribute(' + q('tab') + ' + ' + q('index') + ', ' + q('1') + ');',
    ),
    ['splitEl'],
    [q('tab') + ' + ' + q('index')],
    'A concatenated attribute name defeats every literal name match. The scanner must say ' +
      'so, not report zero tabindex writes.',
  ),
  failLoudTooth(
    'FL-ATTRIBUTE-NAME-FROM-CONST',
    L([
      'const ATTR_NAME = ' + q('tabindex') + ';',
      'export function decorate(constNameEl: HTMLElement): void {',
      '  constNameEl.setAttribute(ATTR_NAME, ' + q('1') + ');',
      '}',
    ]),
    ['constNameEl'],
    ['ATTR_NAME'],
    'An indirected attribute name. Distinct from the split-name tooth: there IS a single ' +
      'token in argument one, it just is not a literal.',
  ),
  failLoudTooth(
    'FL-TABINDEX-VALUE-FROM-VARIABLE',
    L([
      'export function decorate(varValEl: HTMLElement, depth: number): void {',
      '  varValEl.setAttribute(' + q('tabindex') + ', String(depth));',
      '}',
    ]),
    ['varValEl'],
    ['String(depth)'],
    'The name is decidable but the VALUE is not, so neither T3 nor T5 can be evaluated. ' +
      'An impl that only fails loud on unknown NAMES reports a clean pass here.',
  ),
  failLoudTooth(
    'FL-COMPUTED-MEMBER-REGISTRATION',
    L([
      'export function wire(list: HTMLElement): void {',
      '  const computedEl = document.createElement(' + q('li') + ');',
      '  computedEl[' + q('addEventListener') + '](' + q('click') + ', () => {',
      '    pick(9);',
      '  });',
      '}',
    ]),
    ['computedEl'],
    ['[' + q('addEventListener') + ']'],
    'Computed member access registers a real listener that a `.addEventListener(` text ' +
      'match never sees. Fail-loud is the only honest answer.',
  ),
  failLoudTooth(
    'FL-CONCATENATED-SELECTOR-RECEIVER',
    L([
      'export function wire(id: number): void {',
      '  const concatEl = document.querySelector(' + q('#row-') + ' + id);',
      '  ' + ael('concatEl', 'click') + '() => {',
      '    pick(10);',
      '  });',
      '}',
    ]),
    ['concatEl'],
    [q('#row-') + ' + id'],
    'The receiver element type cannot be established from a computed selector, so the ' +
      'native/delegated arm is unknowable. Guessing "delegated" would false-RED and ' +
      'guessing "native" would false-GREEN; the scanner must say it cannot tell.',
  ),

  // ---- MUST NOT fail loud: named references that DO resolve --------------------------
  {
    id: 'NL-FOCUSTRAP-NAMED-KEYDOWN-CAPTURE',
    tag: '[FAIL-LOUD]',
    polarity: 'GOOD',
    src: L([
      'export function installTrap(root: HTMLElement): () => void {',
      '  const onKeydown = (e: KeyboardEvent): void => {',
      '    if (e.key !== ' + q('Tab') + ') return;',
      '    if (e.ctrlKey || e.altKey || e.metaKey) return;',
      '    e.preventDefault();',
      '    target.focus();',
      '  };',
      '  ' + ael('root', 'keydown') + 'onKeydown, true);',
      '  return () => {',
      '    root.removeEventListener(' + q('keydown') + ', onKeydown, true);',
      '  };',
      '}',
    ]),
    expect: {
      needles: ['onKeydown, true'],
      clicks: 0,
      keydowns: 1,
      loud: 0,
      keydownHandlerIncludes: ['e.preventDefault()'],
      keydownSpelling: 'addEventListener',
    },
    why:
      'Ships today at ui/focusTrap.ts:150, with a third capture-phase argument. A named ' +
      'function reference must be RESOLVED to its in-file definition, not declared ' +
      'unparseable: keydownHandlerIncludes asserts the resolved body really is the arrow, ' +
      'so an impl returning an empty handlerText and a clean loud list cannot pass.',
  },
  {
    id: 'NL-RESIZE-NON-INTERACTIVE-LISTENER',
    tag: '[FAIL-LOUD]',
    polarity: 'GOOD',
    src: L([
      'export function installResizeHandler(renderer: Resizable, win: ResizeWindow): void {',
      '  const syncSize = () => renderer.resize(win.innerWidth, win.innerHeight, win.devicePixelRatio);',
      '  syncSize();',
      '  ' + ael('win', 'resize') + 'syncSize);',
      '}',
    ]),
    expect: {
      needles: ['addEventListener(' + q('resize') + ', syncSize)'],
      clicks: 0,
      keydowns: 0,
      tabindexWrites: 0,
      loud: 0,
    },
    why:
      'Ships today at render/resizeWiring.ts:33. An event this eval does not govern, bound ' +
      'by a named reference. An impl that fails loud on every non-arrow handler reds the ' +
      'shipped tree from a file that has no click, no keydown and no tabindex.',
  },

  // ---- named-reference resolution decides the verdict --------------------------------
  {
    id: 'NAMEDREF-GOOD-RESOLVES-TO-INVOCATION',
    tag: '[A11Y-13]',
    polarity: 'GOOD',
    src: L([
      'export function wireRow(row: HTMLLIElement, callbacks: MenuViewCallbacks): void {',
      '  const onKey = (e: KeyboardEvent): void => {',
      '    if (e.code === ' + q('Enter') + ') callbacks.onInput({ kind: ' + q('enter') + ' });',
      '  };',
      '  ' + ael('row', 'click') + '() => {',
      '    callbacks.onInput({ kind: ' + q('click') + ' });',
      '  });',
      '  ' + ael('row', 'keydown') + 'onKey);',
      '}',
    ]),
    expect: {
      needles: ['const onKey ='],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: null,
      sharedIncludes: ['callbacks.onInput'],
      keydownHandlerIncludes: ['callbacks.onInput'],
    },
    why:
      'The PASS half of named-reference resolution: the resolved body does invoke the ' +
      'shared callback. An impl that only inspects inline arrows finds an empty handler ' +
      'body and false-REDs a correct pair.',
  },
  {
    id: 'NAMEDREF-BAD-RESOLVES-TO-NOOP',
    tag: '[A11Y-13]',
    polarity: 'BAD',
    src: L([
      'export function wireRow(row: HTMLLIElement, callbacks: MenuViewCallbacks): void {',
      '  const onKey = (e: KeyboardEvent): void => {',
      '    e.stopPropagation();',
      '  };',
      '  ' + ael('row', 'click') + '() => {',
      '    callbacks.onInput({ kind: ' + q('click') + ' });',
      '  });',
      '  ' + ael('row', 'keydown') + 'onKey);',
      '}',
    ]),
    expect: {
      needles: ['const onKey ='],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: '[A11Y-13]',
      sharedExcludes: ['callbacks.onInput'],
    },
    why:
      'The FAIL half, byte-identical in shape to the tooth above except for the resolved ' +
      'body. Together they prove the resolution is REAL: an impl that "resolves" by ' +
      'assuming any named reference is fine passes the GOOD tooth and dies here; one that ' +
      'refuses to resolve dies on the GOOD tooth.',
  },

  // ---- receiver keying ---------------------------------------------------------------
  {
    id: 'RK-BAD-CROSS-CLASS-SAME-RECEIVER-TEXT',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export class RowsView {',
      '  readonly #el: HTMLElement;',
      '  constructor(callbacks: MenuViewCallbacks) {',
      '    this.#el = document.getElementById(' + q('rows') + ') as HTMLElement;',
      '    ' + ael('this.#el', 'click') + '() => {',
      '      callbacks.onInput({ kind: ' + q('click') + ' });',
      '    });',
      '  }',
      '}',
      'export class HintView {',
      '  readonly #el: HTMLElement;',
      '  constructor(callbacks: MenuViewCallbacks) {',
      '    this.#el = document.getElementById(' + q('hint') + ') as HTMLElement;',
      '    ' + ael('this.#el', 'keydown') + '(e) => {',
      '      callbacks.onInput({ kind: ' + q('key') + ' });',
      '    });',
      '  }',
      '}',
    ]),
    expect: {
      needles: ['class RowsView', 'class HintView'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: '[A11Y-12]',
      receiversDiffer: true,
    },
    why:
      'Two DIFFERENT elements spelled `this.#el` in one file. A text-keyed pairing marries ' +
      "RowsView's click to HintView's keydown and passes a keyboard-dead row. " +
      'receiversDiffer asserts the scope qualification directly, so the [A11Y-12] verdict ' +
      'cannot come from some unrelated accident.',
  },
  {
    id: 'RK-BAD-LET-REBOUND-BETWEEN-REGISTRATIONS',
    tag: '[A11Y-12]',
    polarity: 'BAD',
    src: L([
      'export function wire(list: HTMLElement, callbacks: MenuViewCallbacks): void {',
      '  let el = document.createElement(' + q('li') + ');',
      '  ' + ael('el', 'click') + '() => {',
      '    callbacks.onInput({ kind: ' + q('click') + ' });',
      '  });',
      '  list.appendChild(el);',
      '  el = document.createElement(' + q('li') + ');',
      '  ' + ael('el', 'keydown') + '(e) => {',
      '    callbacks.onInput({ kind: ' + q('key') + ' });',
      '  });',
      '  list.appendChild(el);',
      '}',
    ]),
    expect: {
      needles: ['let el =', 'el = document.createElement'],
      clicks: 1,
      keydowns: 1,
      arm: 'delegated',
      verdict: '[A11Y-12]',
      receiversDiffer: true,
    },
    why:
      'One NAME, two elements: the first <li> takes the click and is never given a keydown. ' +
      'Same false pairing as the cross-class tooth but within a single function, so a fix ' +
      'that only qualifies by enclosing class does not survive.',
  },
  failLoudTooth(
    'RK-ALIAS-MUST-FAIL-LOUD-NOT-BE-MISSED',
    L([
      'export class MenuView {',
      '  readonly #rowsEl: HTMLElement;',
      '  constructor(callbacks: MenuViewCallbacks) {',
      '    this.#rowsEl = document.getElementById(' + q('menu-rows') + ') as HTMLElement;',
      '    ' + ael('this.#rowsEl', 'click') + '() => {',
      '      callbacks.onInput({ kind: ' + q('click') + ' });',
      '    });',
      '    const rowsAlias = this.#rowsEl;',
      '    ' + ael('rowsAlias', 'keydown') + '(e) => {',
      '      callbacks.onInput({ kind: ' + q('key') + ' });',
      '    });',
      '  }',
      '}',
    ]),
    ['rowsAlias'],
    ['const rowsAlias = this.#rowsEl'],
    'The inverse of the two teeth above: a LEGITIMATE alias of one element under two ' +
      'names. A purely text-keyed receiver design finds no pair and emits a FALSE RED on ' +
      'correct code. Fail-loud is the required answer -- an alias the scanner cannot follow ' +
      'must be reported, never silently tagged and never silently passed.',
  ),
];

// ---------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------

function callMatcher(M, name, args) {
  const fn = M === null || M === undefined ? undefined : M[name];
  if (typeof fn !== 'function') throw new Error('matcher M.' + name + ' is missing');
  return fn.apply(M, args);
}

function isSiteArray(v) {
  if (!Array.isArray(v)) return false;
  for (const s of v) {
    if (s === null || typeof s !== 'object') return false;
    if (typeof s.receiver !== 'string' || s.receiver.length === 0) return false;
    if (typeof s.handlerText !== 'string') return false;
    if (s.spelling !== 'addEventListener' && s.spelling !== 'property') return false;
    if (typeof s.line !== 'number') return false;
  }
  return true;
}

function isTabWriteArray(v) {
  if (!Array.isArray(v)) return false;
  for (const w of v) {
    if (w === null || typeof w !== 'object') return false;
    if (typeof w.receiver !== 'string') return false;
    if (typeof w.value !== 'string') return false;
    if (typeof w.spelling !== 'string' || w.spelling.length === 0) return false;
    if (typeof w.line !== 'number') return false;
  }
  return true;
}

function checkIdentityShape(res) {
  if (res === null || typeof res !== 'object') throw new Error('identityOk did not return an object');
  if (typeof res.ok !== 'boolean') throw new Error('identityOk.ok is not a boolean');
  if (!Array.isArray(res.shared)) throw new Error('identityOk.shared is not an array');
  if (typeof res.reason !== 'string' || res.reason.length === 0) {
    throw new Error('identityOk.reason is not a non-empty string');
  }
  return res;
}

function checkClassifyShape(res) {
  if (res === null || typeof res !== 'object') throw new Error('classify did not return an object');
  if (res.arm !== 'native' && res.arm !== 'delegated' && res.arm !== null) {
    throw new Error('classify.arm is not one of native | delegated | null');
  }
  if (typeof res.reason !== 'string' || res.reason.length === 0) {
    throw new Error('classify.reason is not a non-empty string');
  }
  return res;
}

/** The composed decision procedure the eval must implement. */
function computeVerdict(M, stripped, click, keydowns) {
  const cls = checkClassifyShape(callMatcher(M, 'classify', [stripped, click]));
  if (cls.arm === 'native') return { tag: null, arm: 'native', identity: null };
  if (cls.arm === null) return { tag: null, arm: null, identity: null };
  const pairs = keydowns.filter((k) => k.receiver === click.receiver);
  if (pairs.length === 0) return { tag: '[A11Y-12]', arm: 'delegated', identity: null };
  let first = null;
  for (const k of pairs) {
    const res = checkIdentityShape(callMatcher(M, 'identityOk', [stripped, click, k]));
    if (first === null) first = res;
    if (res.ok === true) return { tag: null, arm: 'delegated', identity: res };
  }
  return { tag: '[A11Y-13]', arm: 'delegated', identity: first };
}

function runOne(M, rec) {
  const fails = [];
  const add = (msg) => {
    fails.push(rec.id + ' ' + rec.tag + ' [' + rec.polarity + ']: ' + msg);
  };
  const e = rec.expect || {};

  try {
    // ---- 0. record self-consistency -------------------------------------------------
    if (typeof rec.src !== 'string' || rec.src.length === 0) {
      add('fixture src is not a non-empty string');
      return fails;
    }
    if (rec.src.indexOf(BACKTICK) !== -1) {
      add('fixture contains a backtick (forbidden: corrupts template-literal authoring)');
      return fails;
    }
    if (rec.src.indexOf(SLASHSTAR) !== -1) {
      add('fixture contains a block-comment opener (forbidden: measured vacuous-green cause)');
      return fails;
    }
    if (!Array.isArray(e.needles) || e.needles.length === 0) {
      add('record declares no structural needles');
      return fails;
    }

    // ---- 1. STRUCTURAL, before any behaviour ----------------------------------------
    const stripped = callMatcher(M, 'stripTsComments', [rec.src]);
    if (typeof stripped !== 'string' || stripped.length === 0) {
      add('stripTsComments did not return a non-empty string');
      return fails;
    }
    for (const n of e.needles) {
      if (stripped.indexOf(n) === -1) {
        add('stripper destroyed load-bearing text ' + JSON.stringify(n) + ' (fixture is vacuous)');
      }
    }
    if (Array.isArray(e.absentNeedles)) {
      for (const n of e.absentNeedles) {
        if (stripped.indexOf(n) !== -1) {
          add('stripper left comment text ' + JSON.stringify(n) + ' in the source');
        }
      }
    }
    if (fails.length > 0) return fails;

    const clicks = callMatcher(M, 'findClickSites', [stripped]);
    const keydowns = callMatcher(M, 'findKeydownSites', [stripped]);
    const tabs = callMatcher(M, 'findTabindexWrites', [stripped]);
    const loud = callMatcher(M, 'scanFailLoud', [stripped]);

    if (!isSiteArray(clicks)) {
      add('findClickSites did not return well-formed {line,receiver,handlerText,spelling} records');
      return fails;
    }
    if (!isSiteArray(keydowns)) {
      add('findKeydownSites did not return well-formed {line,receiver,handlerText,spelling} records');
      return fails;
    }
    if (!isTabWriteArray(tabs)) {
      add('findTabindexWrites did not return well-formed {line,receiver,value,spelling} records');
      return fails;
    }
    if (!Array.isArray(loud)) {
      add('scanFailLoud did not return an array');
      return fails;
    }
    for (const r of loud) {
      if (typeof r !== 'string' || r.length === 0) {
        add('scanFailLoud returned a non-string / empty reason');
        return fails;
      }
    }

    if (typeof e.clicks === 'number' && clicks.length !== e.clicks) {
      add('expected ' + e.clicks + ' click site(s), found ' + clicks.length);
    }
    if (typeof e.keydowns === 'number' && keydowns.length !== e.keydowns) {
      add('expected ' + e.keydowns + ' keydown site(s), found ' + keydowns.length);
    }
    if (typeof e.tabindexWrites === 'number' && tabs.length !== e.tabindexWrites) {
      add('expected ' + e.tabindexWrites + ' tabindex write(s), found ' + tabs.length);
    }
    if (fails.length > 0) return fails;

    // ---- 2. fail-loud posture --------------------------------------------------------
    if (rec.polarity === 'FAILLOUD') {
      const min = typeof e.loudAtLeast === 'number' ? e.loudAtLeast : 1;
      if (loud.length < min) {
        add('expected at least ' + min + ' fail-loud reason(s), found ' + loud.length +
          ' -- an undecidable construct was silently skipped');
        return fails;
      }
      for (const mention of e.loudMentions || []) {
        let hit = false;
        for (const r of loud) {
          if (r.indexOf(mention) !== -1) hit = true;
        }
        if (!hit) {
          add('no fail-loud reason names ' + JSON.stringify(mention) +
            ' (got: ' + JSON.stringify(loud) + ') -- the scanner failed loud for some OTHER reason');
        }
      }
      return fails;
    }

    const expectedLoud = typeof e.loud === 'number' ? e.loud : 0;
    if (loud.length !== expectedLoud) {
      add('expected ' + expectedLoud + ' fail-loud reason(s), found ' + loud.length +
        ' (' + JSON.stringify(loud) + ') -- a decidable fixture must be decided');
      return fails;
    }

    // ---- 3. BEHAVIOURAL --------------------------------------------------------------
    if (typeof e.clickSpelling === 'string') {
      if (clicks.length !== 1) add('clickSpelling assertion needs exactly 1 click site');
      else if (clicks[0].spelling !== e.clickSpelling) {
        add('click spelling was ' + JSON.stringify(clicks[0].spelling) + ', expected ' +
          JSON.stringify(e.clickSpelling));
      }
    }
    if (typeof e.keydownSpelling === 'string') {
      if (keydowns.length !== 1) add('keydownSpelling assertion needs exactly 1 keydown site');
      else if (keydowns[0].spelling !== e.keydownSpelling) {
        add('keydown spelling was ' + JSON.stringify(keydowns[0].spelling) + ', expected ' +
          JSON.stringify(e.keydownSpelling));
      }
    }
    if (Array.isArray(e.keydownHandlerIncludes)) {
      if (keydowns.length !== 1) add('keydownHandlerIncludes needs exactly 1 keydown site');
      else {
        for (const n of e.keydownHandlerIncludes) {
          if (keydowns[0].handlerText.indexOf(n) === -1) {
            add('resolved keydown handler text is missing ' + JSON.stringify(n) +
              ' -- the named reference was not resolved to its in-file definition');
          }
        }
      }
    }
    if (e.receiversDiffer === true) {
      if (clicks.length !== 1 || keydowns.length !== 1) {
        add('receiversDiffer needs exactly 1 click and 1 keydown site');
      } else if (clicks[0].receiver === keydowns[0].receiver) {
        add('click and keydown receivers are the SAME key (' + JSON.stringify(clicks[0].receiver) +
          ') -- two distinct bindings were merged by receiver TEXT');
      }
    }

    let verdict = null;
    const wantsVerdict = Object.prototype.hasOwnProperty.call(e, 'verdict') ||
      Array.isArray(e.verdictAnyOf) ||
      typeof e.arm === 'string' ||
      Array.isArray(e.sharedIncludes) ||
      Array.isArray(e.sharedExcludes);
    if (wantsVerdict) {
      if (clicks.length !== 1) {
        add('verdict/arm assertions need exactly 1 click site, found ' + clicks.length);
        return fails;
      }
      verdict = computeVerdict(M, stripped, clicks[0], keydowns);
    }

    if (typeof e.arm === 'string' && verdict !== null && verdict.arm !== e.arm) {
      add('classify arm was ' + JSON.stringify(verdict.arm) + ', expected ' + JSON.stringify(e.arm));
    }
    if (Object.prototype.hasOwnProperty.call(e, 'verdict') && verdict !== null) {
      if (verdict.tag !== e.verdict) {
        add('verdict was ' + JSON.stringify(verdict.tag) + ', expected ' + JSON.stringify(e.verdict));
      }
    }
    if (Array.isArray(e.verdictAnyOf) && verdict !== null) {
      if (e.verdictAnyOf.indexOf(verdict.tag) === -1) {
        add('verdict was ' + JSON.stringify(verdict.tag) + ', expected one of ' +
          JSON.stringify(e.verdictAnyOf));
      }
    }
    if ((Array.isArray(e.sharedIncludes) || Array.isArray(e.sharedExcludes)) && verdict !== null) {
      let idres = verdict.identity;
      if (idres === null && keydowns.length === 1) {
        idres = checkIdentityShape(callMatcher(M, 'identityOk', [stripped, clicks[0], keydowns[0]]));
      }
      if (idres === null) {
        add('shared-set assertion has no identityOk result to inspect');
      } else {
        for (const n of e.sharedIncludes || []) {
          if (idres.shared.indexOf(n) === -1) {
            add('identityOk.shared is missing ' + JSON.stringify(n) + ' (got ' +
              JSON.stringify(idres.shared) + ') -- a PASS here would rest on an empty intersection');
          }
        }
        for (const n of e.sharedExcludes || []) {
          if (idres.shared.indexOf(n) !== -1) {
            add('identityOk.shared wrongly contains ' + JSON.stringify(n) + ' (got ' +
              JSON.stringify(idres.shared) + ') -- token PRESENCE was counted as INVOCATION');
          }
        }
      }
    }
    if (e.identityWouldFail === true) {
      if (clicks.length !== 1 || keydowns.length !== 1) {
        add('identityWouldFail needs exactly 1 click and 1 keydown site');
      } else {
        const idres = checkIdentityShape(
          callMatcher(M, 'identityOk', [stripped, clicks[0], keydowns[0]]),
        );
        if (idres.ok !== false) {
          add('identityOk returned ok:true on an EMPTY intersection -- the native PASS is not ' +
            'proven to come from arm precedence');
        }
        if (idres.shared.length !== 0) {
          add('identityOk.shared should be empty here, got ' + JSON.stringify(idres.shared));
        }
      }
    }

    // ---- 4. tabindex -----------------------------------------------------------------
    const wantsTab = Object.prototype.hasOwnProperty.call(e, 'tabindexTag') ||
      typeof e.tabindexSpelling === 'string' ||
      typeof e.tabindexValue === 'string';
    if (wantsTab) {
      if (tabs.length !== 1) {
        add('tabindex assertions need exactly 1 tabindex write, found ' + tabs.length);
        return fails;
      }
      const w = tabs[0];
      if (typeof e.tabindexSpelling === 'string' && w.spelling !== e.tabindexSpelling) {
        add('tabindex write spelling was ' + JSON.stringify(w.spelling) + ', expected ' +
          JSON.stringify(e.tabindexSpelling));
      }
      if (typeof e.tabindexValue === 'string' && w.value !== e.tabindexValue) {
        add('tabindex write value was ' + JSON.stringify(w.value) + ', expected ' +
          JSON.stringify(e.tabindexValue));
      }
      const v = callMatcher(M, 'tabindexVerdict', [stripped, w]);
      if (v === null || typeof v !== 'object') {
        add('tabindexVerdict did not return an object');
      } else {
        if (v.tag !== '[A11Y-T3]' && v.tag !== '[A11Y-T5]' && v.tag !== null) {
          add('tabindexVerdict.tag is not one of [A11Y-T3] | [A11Y-T5] | null');
        }
        if (typeof v.reason !== 'string' || v.reason.length === 0) {
          add('tabindexVerdict.reason is not a non-empty string');
        }
        if (v.tag !== e.tabindexTag) {
          add('tabindex verdict was ' + JSON.stringify(v.tag) + ', expected ' +
            JSON.stringify(e.tabindexTag));
        }
      }
    }
  } catch (err) {
    add('threw: ' + (err && err.message ? err.message : String(err)));
  }
  return fails;
}

/**
 * Run every tooth against the matcher namespace `M`.
 * @returns {{teeth:number, teethTotal:number, failures:string[]}}
 */
export function runTeeth(M) {
  const failures = [];

  // Corpus self-checks (do not count toward teeth).
  const seen = Object.create(null);
  for (const rec of TEETH) {
    if (seen[rec.id] === true) failures.push('__corpus__: duplicate tooth id ' + rec.id);
    seen[rec.id] = true;
    if (rec.polarity !== 'BAD' && rec.polarity !== 'GOOD' && rec.polarity !== 'FAILLOUD') {
      failures.push('__corpus__: ' + rec.id + ' has an unknown polarity ' + String(rec.polarity));
    }
    if (typeof rec.why !== 'string' || rec.why.length < 40) {
      failures.push('__corpus__: ' + rec.id + ' does not state which wrong impl it kills');
    }
  }
  if (TEETH.length < 24) {
    failures.push('__corpus__: ' + TEETH.length + ' teeth is below the ledger floor of 24');
  }

  let teeth = 0;
  for (const rec of TEETH) {
    const fails = runOne(M, rec);
    if (fails.length === 0) teeth += 1;
    else for (const f of fails) failures.push(f);
  }

  return { teeth, teethTotal: TEETH.length, failures };
}
