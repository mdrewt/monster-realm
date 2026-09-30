// ui/privacyBanner.ts — the PURE copy layer for the PRIVACY SURFACE.
//
// FUNCTIONAL CORE. No DOM, no SDK, no store, NO CLOCK: the inputs are the `DeletionCountdown`
// that `ui/privacyModel.ts` already derived, its model state and the export assembly. The one
// ambient read is the i18n locale cell (set once at boot) behind `t()`/`tf()`: every player-facing
// line is resolved at render time, never at module load, which would freeze English. `main.ts`
// owns the element and the frame tick; this module owns what the player reads. Splitting it this
// way is what makes the wording exact-string testable — `main.ts` is excluded from the coverage
// denominator (`vite.config.ts`), so copy composed inline in the frame body would be untested by
// construction.
//
// WHY THE GRACE WINDOW IS NOWHERE IN THIS FILE. The window's single source of truth is
// `game_core::DELETION_GRACE_MS_DEFAULT`, reached from the client through the
// `deletion_grace_ms_default()` wasm accessor. This module never sees it: it formats
// the `remainingMs` it is handed. A hard-coded duration here — "7 days" in prose just as much as
// a number — would desync the moment an operator retunes the real constant.
//
// WHY THE LABEL ALWAYS RUNS DOWN TO SECONDS. PRV1-1 asks for a TICKING countdown. A formatter
// that renders the two largest units ("6d 23h") stands still for an hour at a time at the top of
// a week-long window, which reads as a broken clock rather than a deadline.
//
// THREE OUTCOMES, THREE SENTENCES — the broke-vs-dark discipline the model is built
// around. A COMPUTED remaining time gets the countdown; a computed ZERO gets `due` (the reaper may
// fire at any moment, so a number that keeps counting nothing would be misleading); a DARK window
// — pending, but the remaining time is unknown — says so in words. Fabricating "0s" there would
// claim an irreversible deadline had arrived.

import type { ExportAssembly } from './exportAssembly';
import { t, tf } from './i18n/resolver';
import type { DeletionCountdown, PrivacyModelState, PrivacyNotice } from './privacyModel';

// Unit sizes are DERIVED from each other rather than written out. Every constant below is a small
// ratio, so no expression in this file is a numeric duplicate of any tunable window.
const MS_PER_SECOND = 1_000n;
const SECONDS_PER_MINUTE = 60n;
const MINUTES_PER_HOUR = 60n;
const HOURS_PER_DAY = 24n;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

/**
 * `remainingMs` as `Xd Yh Zm Ws` (each group's unit text comes from the catalog, so a locale may
 * space or spell its units differently), truncated to whole seconds and starting at the largest
 * non-zero unit. Every group from that unit down to seconds is present even when zero, so the
 * seconds group — the one that moves every tick — is never dropped. Groups are joined by a plain
 * space, the one non-translatable character in the line.
 *
 * Truncation, never rounding: inside the final second the honest reading is `0s`, not `1s`.
 */
function formatDuration(remainingMs: bigint): string {
  // Clamped rather than signed. The model already clamps at `0n`, so a negative here means a
  // wiring slip subtracted in the wrong direction — rendering `-5s` would advertise the bug to
  // the player instead of degrading to the last honest value.
  const clamped = remainingMs > 0n ? remainingMs : 0n;
  const totalSeconds = clamped / MS_PER_SECOND;
  const days = totalSeconds / SECONDS_PER_DAY;
  const hours = (totalSeconds / SECONDS_PER_HOUR) % HOURS_PER_DAY;
  const minutes = (totalSeconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const groups: string[] = [];
  if (days > 0n) groups.push(tf('privacy.countdown.days', { n: days }));
  if (groups.length > 0 || hours > 0n) groups.push(tf('privacy.countdown.hours', { n: hours }));
  if (groups.length > 0 || minutes > 0n) {
    groups.push(tf('privacy.countdown.minutes', { n: minutes }));
  }
  groups.push(tf('privacy.countdown.seconds', { n: seconds }));
  return groups.join(' ');
}

/**
 * What the countdown banner should say, or `null` when there is nothing to say.
 *
 * TOTAL: never throws, for any input. The caller writes this from a per-frame rAF tick, so a
 * throw here would not merely blank the banner — it would take the render loop's whole frame body
 * down with it.
 *
 * KEYED ON THE PHASE, never on `remainingMs` alone: an `active` account carrying a stale
 * timestamp, and a `terminal` one that is already permanently deleted, must both stay silent.
 */
export function privacyBannerLabel(countdown: DeletionCountdown): string | null {
  switch (countdown.phase) {
    case 'active':
    case 'unknown':
    case 'terminal':
      return null;
    case 'due':
      return t('privacy.countdown.due');
    case 'grace':
      // A non-bigint reaches here only from a wiring slip (the model degrades the NUMBER, never
      // the phase — `privacyModel.ts`). Dark is the honest reading of "we cannot compute it".
      return typeof countdown.remainingMs === 'bigint'
        ? tf('privacy.countdown.grace', { duration: formatDuration(countdown.remainingMs) })
        : t('privacy.countdown.dark');
  }
}

// ===========================================================================
// The delete / cancel / export surface's copy and view model.
// ===========================================================================

/**
 * M22 §9 residual 1's REQUIRED EXACT LANGUAGE, verbatim — BACKTICKS INCLUDED.
 *
 * The backticks around `Identity` are kept rather than stripped for display. "Verbatim" is the
 * spec's own word, and mandated compliance language is precisely where "we tidied it slightly for
 * the UI" is the wrong call; keeping them also makes the gate a plain equality against a second
 * source with no transform in the middle, which is the shape a bad transcription cannot survive.
 *
 * The spec's instruction is "to be used verbatim in the ADR, commit messages, and any UI copy —
 * the word 'erasure' must never be used for this". Note the sentence ITSELF ends in "not
 * erasure": a blanket "must not contain 'erasure'" gate would fail correct code. The honest gate,
 * which `privacyBanner.test.ts` ships, is that this constant equals
 * `evals/account-e2e.eval.mjs`'s already-exported `PIN_PSEUDONYMIZATION` (a SECOND source, so one
 * bad transcription cannot be copied into both the pin and the implementation), and that the word
 * occurs exactly once, inside this literal.
 */
export const PRIVACY_PSEUDONYMIZATION_DISCLOSURE =
  'Direct name/display fields are severed on deletion. The `Identity` key and its associated ' +
  'timestamps/behavioral history are not purged from multi-user or historical rows; this is a ' +
  'documented, accepted pseudonymization limitation, not erasure.';

/** The download filename, composed from data the caller already has (A3-D11).
 *
 *  CLOCK-FREE: `capturedAtMs` is an INPUT, so this module stays pure and the same inputs always
 *  produce the same name.
 *
 *  Both components are run through `bugBundleFilename`'s character-class strip. `requestId` is a
 *  `bigint` by type and would stringify to digits only — but `rowConvert` is a documented pure
 *  pass-through with no validation, so a drifted binding could deliver something whose `String()`
 *  carries a path separator, and a filename is handed straight to the OS.
 *
 *  An ABSENT request id renders a stable token rather than the string `undefined`: the filename
 *  is the only part of this feature the player sees before opening the file, and
 *  `mr-export-undefined-....json` reads as a broken client on the one artifact they are handed
 *  as their legal data export. */
export function exportBundleFilename(requestId: bigint | undefined, capturedAtMs: number): string {
  const id = requestId === undefined ? 'request' : safeFilenamePart(String(requestId));
  const at = safeFilenamePart(String(capturedAtMs));
  return `mr-export-${id === '' ? 'request' : id}-${at === '' ? 'at' : at}.json`;
}

/** Keep only characters that are safe in a filename on every OS this client runs on. A
 *  character-class strip, never an escape: there is no separator, colon or whitespace that has a
 *  meaningful rendering here, so dropping them is lossless for every legitimate input. */
function safeFilenamePart(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const ok =
      (ch >= '0' && ch <= '9') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      ch === '_';
    if (ok) out += ch;
  }
  return out;
}

/**
 * Which notice the surface is showing.
 *
 * `'terminal-row'` is the route E1 turns on and the one a `state.notice`-keyed implementation
 * MISSES: `privacyStep`'s `account-changed` arm writes `countdown`, `confirm` and `inFlight` — it
 * never writes `notice`. So `notice: 'permanently-deleted'` is only ever reached by a CLICK, while
 * the criterion says the notice is rendered "once terminal_at_ms is Some", i.e. on OPEN, with no
 * interaction. Both routes render the same sentence; they are separate CODES so a test can prove
 * each one independently rather than passing on whichever it happens to reach.
 */
export type PrivacyNoticeKind = PrivacyNotice | 'terminal-row';

export interface PrivacyViewModel {
  readonly statusLabel: string;
  readonly deleteLabel: string;
  readonly cancelLabel: string;
  readonly exportLabel: string;
  readonly deleteEnabled: boolean;
  readonly cancelEnabled: boolean;
  readonly exportEnabled: boolean;
  /** Step two of the two-step confirmation, or `undefined` when nothing is armed. */
  readonly confirmPrompt: string | undefined;
  readonly noticeKind: PrivacyNoticeKind;
  readonly noticeLabel: string | undefined;
  /** What the surface says about the data export, or `undefined` when NO assembly has
   *  been computed yet — which the shell renders by hiding the line entirely. That is a
   *  different state from a computed `'none'`, which has something to say. */
  readonly exportStatusLabel: string | undefined;
  /** ALWAYS present. The control is painted in every state and only ever `disabled` (A3-D4). */
  readonly downloadLabel: string;
  /** True IFF the assembly is `complete` — i.e. iff there is an artifact. */
  readonly downloadEnabled: boolean;
}

/** The export sentence — ONE per `ExportAssemblyStatus`. Reads ONLY the assembly: the deletion
 *  lattice does not gate it, because `exportPermitted` governs asking the server for a NEW export,
 *  never reading one that has already been delivered to this client.
 *
 *  `inconsistent` carries NO NUMBER, deliberately: the core reports `totalChunks: undefined` for
 *  that status because the delivered rows disagree, so any figure rendered here would be
 *  fabricated — or `receivedChunks` masquerading as a total.
 *
 *  `incomplete` does NOT promise arrival. The client cannot distinguish "still streaming" from a
 *  partial server-side removal (the TTL reaper deletes a bounded number of rows per tick, oldest
 *  first, so it can cut across one owner's request), and telling a player to wait for chunks that
 *  will never come is worse than telling them what is true. */
function exportStatusLabelFor(assembly: ExportAssembly | undefined): string | undefined {
  if (assembly === undefined) return undefined;
  switch (assembly.status) {
    case 'none':
      return t('privacy.export.none');
    case 'incomplete':
      return assembly.totalChunks === undefined
        ? t('privacy.export.incompleteDark')
        : tf('privacy.export.incomplete', {
            received: assembly.receivedChunks,
            total: assembly.totalChunks,
          });
    case 'inconsistent':
      return t('privacy.export.inconsistent');
    case 'complete':
      return tf('privacy.export.complete', { received: assembly.receivedChunks });
  }
}

/**
 * The phase sentence. `grace`/`due`/dark DELEGATE to `privacyBannerLabel` so the countdown has ONE
 * copy source; only the three phases that render no banner get their own wording here.
 *
 * Delegating is what keeps the "no authored duration" property true for this surface too: the
 * grace sentence is FORMATTED from the `remainingMs` the model computed, never written out.
 */
function statusLabelFor(countdown: DeletionCountdown): string {
  const banner = privacyBannerLabel(countdown);
  if (banner !== null) return banner;
  if (countdown.phase === 'terminal') return t('privacy.status.terminal');
  return countdown.phase === 'active' ? t('privacy.status.active') : t('privacy.status.unknown');
}

/** The notice CODE, terminal-first. The ROW outranks `state.notice` so an already-erased account
 *  says so the moment the surface opens, whatever the last request did. */
function noticeKindFor(state: PrivacyModelState): PrivacyNoticeKind {
  if (state.countdown.phase === 'terminal') return 'terminal-row';
  return state.notice;
}

/** The notice sentence. `disconnected` is the model's own code — the click was never delivered —
 *  and must not read like a server rejection. Both terminal routes render PRV1-4's DISTINCT,
 *  non-generic outcome: a player whose account is already gone is told THAT, never "your request
 *  was rejected". */
function noticeLabelFor(kind: PrivacyNoticeKind, rejectMessage: string | undefined) {
  switch (kind) {
    case 'none':
      return undefined;
    case 'disconnected':
      return t('privacy.notice.disconnected');
    case 'terminal-row':
    case 'permanently-deleted':
      return t('privacy.notice.terminal');
    case 'request-rejected':
      // The server's message, VERBATIM — `privacyModel.ts` carries it precisely so the shell does
      // not paraphrase a rejection into something the server never said.
      return rejectMessage;
  }
}

/**
 * The whole surface's copy, derived from the model state. PURE and TOTAL: no DOM, no clock, no
 * SDK, never throws. Every label is resolved here, at render time, through the i18n resolver.
 *
 * Every `*Enabled` flag mirrors the model's permission rather than re-deriving it — a second
 * permission rule here would be a second SSOT, and the one that renders is the one the player
 * believes.
 */
export function buildPrivacyViewModel(
  state: PrivacyModelState,
  exportAssembly?: ExportAssembly,
): PrivacyViewModel {
  const kind = noticeKindFor(state);
  return {
    statusLabel: statusLabelFor(state.countdown),
    deleteLabel: t('privacy.action.delete'),
    cancelLabel: t('privacy.action.cancel'),
    exportLabel: t('privacy.action.export'),
    // A request in flight disables its own control AND the others: `privacyStep`'s `begin` refuses
    // a second request while one is outstanding, and a control that looks live but is refused
    // teaches the player the client is broken.
    deleteEnabled: state.countdown.deletePermitted && state.inFlight === 'none',
    cancelEnabled: state.countdown.cancelPermitted && state.inFlight === 'none',
    exportEnabled: state.countdown.exportPermitted && state.inFlight === 'none',
    confirmPrompt: state.confirm === 'delete-armed' ? t('privacy.confirm.prompt') : undefined,
    noticeKind: kind,
    noticeLabel: noticeLabelFor(kind, state.rejectMessage),
    exportStatusLabel: exportStatusLabelFor(exportAssembly),
    // DISTINCT from the export label on purpose: the two controls sit side by side and do
    // completely different things — one asks the server to BUILD an export, the other saves the
    // one that has already arrived. A shared name would make the second look like a duplicate.
    downloadLabel: t('privacy.action.download'),
    // The artifact is present IFF the status is `complete` (exportAssembly.ts's own contract),
    // so this is the ONE fact the control needs. Enabling on `incomplete` would hand the player
    // a truncated personal-data file and call it their export.
    downloadEnabled: exportAssembly?.status === 'complete',
  };
}
