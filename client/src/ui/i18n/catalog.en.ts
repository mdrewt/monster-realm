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
// S1 SEEDED `chrome.*` and migrated zero call sites: those cited literals stay in `main.ts` and
// `index.html` until S5/S6 swap them for `t()`/`tf()`. S3 (ADR-0259) ADDED `battle.*` and `pvp.*`
// and MIGRATED their call sites: `battleView.ts` and `pvpView.ts` now resolve every one of these
// through `t()`/`tf()`, so the `battleView.ts:NNN` / `pvpView.ts:NNN` citations name where the
// string is rendered (pre-migration line numbers, kept as the translator's "where"). Every value
// is byte-identical to the literal it replaced — including `’` U+2019 and `…` U+2026 — because
// catalog.test.ts pins the English bytes and several e2e specs match them. Still no plural key:
// `(${turns} turns)` keeps its pre-existing English plural defect on purpose — fixing it is a
// reword, which takes a FRESH key and the first `oneOther` use (ADR-0259 alternatives).
// Model data (affinities, weather labels, species/skill/item/player names, counts) are PARAMS,
// interpolated verbatim, never catalogued (M24 §2.5).

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
  // @desc: Heading of the battle overlay; the first thing announced when a PvE or PvP battle opens.
  // One word, fits a 320px-wide column.
  // battleView.ts:110 (resolved in show())
  'battle.title': 'Battle',
  // @desc: Exit hint shown under the outcome banner once a battle has ended; "Esc" is the keyboard
  // key name and must stay recognisable as such. One short line.
  // battleView.ts:243 (resolved in show())
  'battle.continueHint': 'Press Esc to continue',
  // @desc: Explainer shown in place of the swap buttons when the player has no healthy bench
  // monster in this battle; the second sentence tells them how to reach the party screen afterwards
  // ("Esc" and "B" are keyboard key names; "Party & Box" is that screen's title). Two sentences,
  // wraps freely in a 320px-wide column.
  // battleView.ts:216-218 (resolved in show())
  'battle.swap.hint':
    'No healthy party monster in this battle to swap in. When this battle ends, press Esc, then B for Party & Box.',
  // @desc: PvP status banner shown after the player has submitted their move, while the opponent's
  // move is still outstanding; carries a typographic apostrophe and an ellipsis. One line.
  // battleView.ts:347
  'battle.pvp.waiting': 'Waiting for opponent’s action…',
  // @desc: Field-weather banner above the two monster cards; {label} is the weather name (e.g.
  // "Rain") and {turns} the number of turns it has left. One centred line, about 40 characters
  // wide.
  // battleView.ts:361
  'battle.weather.banner': (p) => `${p.label} (${p.turns} turns)`,
  // @desc: Role word prefixed to the player's own monster card header, rendered as "You:
  // <species>". Very short — shares one line with the species name and the level.
  // battleView.ts:291
  'battle.card.you': 'You',
  // @desc: Role word prefixed to the opposing monster card header, rendered as "Opponent:
  // <species>"; in PvP the rival's display name replaces it when known. Very short — shares one
  // line with the species name and the level.
  // battleView.ts:289
  'battle.card.opponent': 'Opponent',
  // @desc: Level badge on the right of a monster card header; {level} is the monster's level and
  // "Lv" abbreviates "Level". Very short — shares one line with the card's name.
  // battleView.ts:373
  'battle.card.level': (p) => `Lv${p.level}`,
  // @desc: Small line under a monster card's health bar; {current}/{max} are hit points and
  // {affinity} is the monster's elemental type name (e.g. "Fire"). One line, small text.
  // battleView.ts:407
  'battle.card.hpLine': (p) => `HP ${p.current}/${p.max} · ${p.affinity}`,
  // @desc: PvP skill button: submits the move rather than using it at once, hence the leading
  // "Submit:"; {name} is the skill name, {affinity} its elemental type. Keep {affinity} LAST and
  // keep the "Submit:" prefix first (tests match the start of the text). Fits a half-width button.
  // battleView.ts:443
  'battle.skill.pvpSubmit': (p) => `Submit: ${p.name} · ${p.affinity}`,
  // @desc: PvE skill button, used at once; {name} is the skill name, {power} its damage value and
  // {affinity} its elemental type. Keep {affinity} LAST (tests match the start of the text). Fits a
  // half-width button.
  // battleView.ts:444
  'battle.skill.pveLabel': (p) => `${p.name} (${p.power}) · ${p.affinity}`,
  // @desc: Hover tooltip on a skill button giving its hit chance; {accuracy} is a percentage and
  // "Acc" abbreviates "Accuracy". Very short.
  // battleView.ts:445
  'battle.skill.accuracy': (p) => `Acc ${p.accuracy}%`,
  // @desc: Button label to run from an ongoing PvE battle. Short verb, fits a narrow button.
  // battleView.ts:470
  'battle.action.flee': 'Flee',
  // @desc: First option of the bait selector shown in a wild battle: attempt recruitment with no
  // bait item. Short, fits a narrow dropdown.
  // battleView.ts:522
  'battle.recruit.noBait': 'No bait',
  // @desc: Button label to attempt recruiting the wild monster with the selected bait. Short verb,
  // fits a narrow button.
  // battleView.ts:541
  'battle.recruit.submit': 'Recruit',
  // @desc: Placeholder option of the cure-item selector before the player picks an item. Short,
  // fits a narrow dropdown.
  // battleView.ts:562
  'battle.cure.placeholder': 'Select item',
  // @desc: One option of the cure-item selector; {name} is the item name, {cureStatus} the ailment
  // it removes (e.g. "Poison") and {count} how many the player carries. One line in a narrow
  // dropdown.
  // battleView.ts:568
  'battle.cure.option': (p) => `${p.name} (cures ${p.cureStatus}) ×${p.count}`,
  // @desc: Button label to use the selected cure item on the player's monster. Short, fits a narrow
  // button.
  // battleView.ts:580
  'battle.cure.submit': 'Use Item',
  // @desc: PvP swap button: submits a switch to the bench monster {species} rather than swapping at
  // once. Fits a narrow button.
  // battleView.ts:601
  'battle.swap.pvpSubmit': (p) => `Submit Swap: ${p.species}`,
  // @desc: PvE swap button: switches at once to the bench monster {species}, whose hit points are
  // {current}/{max}. Fits a narrow button.
  // battleView.ts:602
  'battle.swap.pveLabel': (p) => `Swap: ${p.species} (${p.current}/${p.max})`,
  // @desc: Outcome banner when the player's side wins the battle. Large bold text, one or two
  // words.
  // battleView.ts:629
  'battle.outcome.victory': 'Victory!',
  // @desc: Outcome banner when the player's side loses the battle. Large bold text, one or two
  // words.
  // battleView.ts:632
  'battle.outcome.defeat': 'Defeat...',
  // @desc: Outcome banner when the player successfully flees a wild battle. Large bold text, one
  // short phrase.
  // battleView.ts:635
  'battle.outcome.fled': 'Got away safely!',
  // @desc: Title of the PvP challenge overlay when the player has no incoming or outgoing
  // challenge; "PvP" is the player-versus-player abbreviation. One word.
  // pvpView.ts:135
  'pvp.title.idle': 'PvP',
  // @desc: Title of the PvP challenge overlay while an incoming or outgoing challenge exists. Two
  // words, one line.
  // pvpView.ts:142
  'pvp.title.challenge': 'PvP Challenge',
  // @desc: Announcement in the PvP overlay that another player wants to fight; {challenger} is that
  // player's display name. One line, above the Accept/Decline buttons.
  // pvpView.ts:190
  'pvp.incoming.label': (p) => `${p.challenger} has challenged you!`,
  // @desc: Button label to accept an incoming PvP challenge. Short verb, fits a narrow button.
  // pvpView.ts:198
  'pvp.incoming.accept': 'Accept',
  // @desc: Button label to decline an incoming PvP challenge. Short verb, fits a narrow button.
  // pvpView.ts:206
  'pvp.incoming.decline': 'Decline',
  // @desc: Status line while the player's own challenge is pending; {target} is the challenged
  // player's display name; carries a spaced em dash and an ellipsis. One line, above the Cancel
  // button.
  // pvpView.ts:221
  'pvp.outgoing.label': (p) => `Challenge sent to ${p.target} — waiting…`,
  // @desc: Button label to withdraw the challenge the player has sent. Two words, fits a button.
  // pvpView.ts:226
  'pvp.outgoing.cancel': 'Cancel Challenge',
  // @desc: Empty-state line over the challengeable-player list when nobody else is online. One
  // line.
  // pvpView.ts:241
  'pvp.players.none': 'No players online to challenge',
  // @desc: Heading over the list of online players the player may challenge; each list entry below
  // it is a player's name. One word plus colon.
  // pvpView.ts:241
  'pvp.players.heading': 'Challenge:',
} satisfies Catalog);
