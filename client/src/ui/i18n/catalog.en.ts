// ui/i18n/catalog.en.ts — the English (source-locale) catalog (m24-s1, ADR-0256 D2).
//
// ONE ENTRY PER `MessageId`, and the type makes that total: `satisfies Catalog` is load-bearing
// (ADR-0256 D2) — `Object.freeze<T>` is generic, so without it a stowaway key would be swallowed
// into `T`; `satisfies` restores the excess-property check, and the mapped type reports an
// omitted key by name (TS2741). Frozen for the same reason `a11yCopy` is: the type annotation is
// erased at runtime, and a caller that casts it away must not be able to rewrite the shared
// singleton for every later importer.
//
// THE `// @desc:` CONVENTION (M24 §2.3). The contiguous `//` block directly above every entry
// carries one `// @desc:` line — a translator note (≥10 non-whitespace chars) saying WHAT the
// string is, WHERE the player sees it, and any width constraint. S8 exports it to the TMS as the
// ICU `description` field, so it is written for a translator, not for us; the `main.ts:NNN` /
// `index.html:NNN` citations are the S5/S6 migration targets, for the engineer.
//
// S1 SEEDS `chrome.*` ONLY and migrates zero call sites: the cited literals stay in `main.ts` and
// `index.html` until S5/S6 swap them for `t()`/`tf()`. No plural key yet — no chrome string
// carries a count (honest minimum; `oneOther`/`selectPlural` are proven in plural.test.ts).

import type { Catalog } from './messageIds';

export const CATALOG_EN: Catalog = Object.freeze({
  // @desc: Menu-launcher button pinned to the bottom-left of the world view, telling the player
  // how to open help and the menu. One line, at most 47 characters (fits a 320px-wide viewport).
  // index.html:143
  'chrome.helpHint': 'Press ? for help · click or M for menu',
  // @desc: Heading of the help overlay listing keyboard controls and game goals.
  // index.html:94
  'chrome.help.title': 'Controls & Goals',
  // @desc: Submit button of the profile-rename dialog; short verb, fits a narrow button.
  // index.html:60
  'chrome.rename.submit': 'Rename',
  // @desc: Submit button of the trade-proposal dialog; the player offers a trade to another
  // player. Short verb, fits a narrow button.
  // index.html:80
  'chrome.tradePropose.submit': 'Offer',
  // @desc: Status-strip error shown when the browser blocked the account data-export download.
  // main.ts:582
  'chrome.status.exportBlocked': 'data export: download blocked by the browser',
  // @desc: Status-strip error shown when the player opens the privacy overlay while another
  // overlay is already open.
  // main.ts:651
  'chrome.status.privacyOverlayBusy': 'privacy: close the other overlay first',
  // @desc: Status-strip error shown when an action failed because the connection dropped;
  // {where} is the name of the action or view that was in progress (e.g. "shop").
  // main.ts:961
  'chrome.status.disconnected': (p) => `${p.where}: disconnected — try again`,
  // @desc: Status-strip error shown when the loaded game content is older than the server's and
  // the page must be reloaded.
  // main.ts:1040
  'chrome.status.contentStale': 'content out of date — reload',
  // @desc: Status-strip error shown when the browser blocked the bug-report bundle download; the
  // bundle is still printed to the developer console.
  // main.ts:2442
  'chrome.status.bugBundleBlocked': 'bug bundle: download blocked — copy from console',
  // @desc: Status-strip error shown when the player asks to heal but no heal location is
  // available in the current zone.
  // main.ts:2524
  'chrome.status.healUnavailable': 'heal: no heal location available',
} satisfies Catalog);
