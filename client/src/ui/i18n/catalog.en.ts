// ui/i18n/catalog.en.ts — the English (source-locale) catalog.
//
// ONE ENTRY PER `MessageId`, and the type makes that total: `satisfies Catalog` is load-bearing
// — `Object.freeze<T>` is generic, so without it a stowaway key would be swallowed
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
// The `<view>.ts:NNN` citations on entries name where each string is rendered
// (pre-migration line numbers, kept as the translator's "where").
// Every value is byte-identical to the literal it replaced — including `’` U+2019 and `…`
// U+2026, the `—` U+2014 / `→` / `★` / `✓` / `•` / `·` U+00B7 glyphs, the `×` U+00D7 in
// `shop.sell.*` versus the ASCII `x` in `raising.*`, the TRAILING SPACE in `shop.buy.row` /
// `shop.sell.row` (the Buy/Sell button follows the text) and the LEADING SPACE in
// `leaderboard.row` (the player's display name is NOT a param, I18N-21, but a sibling `<bdi>`
// element that the catalog text follows) — because catalog.test.ts pins the English bytes and
// several e2e specs match them. Still no plural key: `(${turns} turns)` keeps its pre-existing
// English plural defect on purpose — fixing it is a reword, which takes a FRESH key and the
// first `oneOther` use; likewise `Slot ${slot}` (0-based) and
// `(x${count})` keep their pre-existing shape. Model data (affinities,
// weather labels, species/skill/item/player names, tiers, stats, counts, prices) are PARAMS,
// interpolated verbatim, never catalogued (M24 §2.5).

import type { Catalog } from './messageIds';

export const CATALOG_EN: Catalog = Object.freeze({
  // @desc: Verb on the Start button chip in the hint bar at the bottom of the game screen; the
  // button name "Start" is drawn beside it. One short word (at most 12 characters).
  // index.html #chip-start (written by main.ts at boot)
  'chrome.chip.menu': 'Menu',
  // @desc: Verb on the Select button chip in the hint bar at the bottom of the game screen; the
  // button name "Select" is drawn beside it. Opens the help screen. One short word (at most 12
  // characters). index.html #chip-select (written by main.ts at boot)
  'chrome.chip.help': 'Help',
  // @desc: Heading of the help overlay listing keyboard controls and game goals.
  // index.html:94 (literal removed from index.html; resolved in HelpView show())
  'chrome.help.title': 'Controls & Goals',
  // @desc: Submit button of the profile-rename dialog; short verb, fits a narrow button.
  // index.html:60 (literal removed from index.html; resolved in RenameView show())
  'chrome.rename.submit': 'Rename',
  // @desc: Submit button of the trade-proposal dialog; the player offers a trade to another
  // player. Short verb, fits a narrow button.
  // index.html:80 (literal removed from index.html; resolved in TradeProposeView show())
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
  // @desc: Status-strip error shown when the player moves a monster from the box to the party
  // but every party slot is taken; nothing is moved.
  'chrome.status.partyFull': 'party is full — move a monster to the box first',
  // @desc: Feedback line inside an overlay (shop, trade, trade offer, rename, care, session) when
  // the player acted while the connection was down, so nothing was sent. Same wording as
  // chrome.status.disconnected without its {where} prefix.
  // careAction.ts:72 (performCare, for care + main.ts's 8 overlay-feedback sites), sessionModel.ts:31
  'chrome.feedback.disconnected': 'disconnected — try again',
  // @desc: Feedback line in the profile-rename dialog after the new display name was saved.
  // main.ts:2801
  'chrome.rename.updated': 'Name updated!',
  // @desc: Heading of the session overlay shown when the player's sign-in has expired.
  // sessionModel.ts:124
  'chrome.session.expired.title': 'Session expired',
  // @desc: Body text of the session-expired overlay; offers signing in again or continuing as a guest
  // on this device.
  // sessionModel.ts:125
  'chrome.session.expired.body':
    'Your sign-in has expired. Sign in again to keep saving progress across your devices, or continue as a guest on this one.',
  // @desc: Heading of the session overlay shown when the sign-in service cannot be reached.
  // sessionModel.ts:127
  'chrome.session.unreachable.title': 'Sign-in service unavailable',
  // @desc: Body text of the sign-in-unavailable overlay; reassures the player and offers continuing as
  // a guest meanwhile.
  // sessionModel.ts:128
  'chrome.session.unreachable.body':
    'We could not reach the sign-in service. Your account is safe — the game keeps retrying in the background, or you can continue as a guest for now.',
  // @desc: Button on the session overlay that starts continuing as a guest (a confirmation step
  // follows). Short, fits a button.
  // sessionModel.ts:130
  'chrome.session.continue': 'Continue as guest',
  // @desc: Confirmation question on the session overlay; must name the irreversible consequence
  // (the account session on this tab is given up) before the player confirms.
  // sessionModel.ts:133
  'chrome.session.confirmPrompt':
    'Continuing as a guest gives up this account session on this tab and cannot be undone. Continue as a guest?',
  // @desc: Heading of the battle overlay; the first thing announced when a PvE or PvP battle opens.
  // One word, fits a 320px-wide column.
  // battleView.ts:110 (resolved in show())
  'battle.title': 'Battle',
  // @desc: Exit hint shown under the outcome banner once a battle has ended; "Enter" and "Esc" are
  // keyboard key names and must stay recognisable as such. One short line.
  // battleView.ts:243 (resolved in show())
  'battle.continueHint': 'Press Enter or Esc to continue',
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
  // @desc: Heading of the evolution overlay, listing every party monster's evolution paths.
  // One word, fits a 320px-wide column.
  // evolutionView.ts:102 (resolved in show())
  'evolution.title': 'Evolution',
  // @desc: Explainer paragraph under the evolution heading telling the player how to read the
  // path cards and that they pick a path only when several are ready at once. Two sentences,
  // wraps freely up to 700px wide.
  // evolutionView.ts:113-115 (resolved in show())
  'evolution.hint':
    'Each path lists what it needs and how close this monster is. When two or more paths are ready at once, you choose which one to take.',
  // @desc: Empty-state line of the evolution overlay when the player owns no monster yet. One
  // short line.
  // evolutionView.ts:162
  'evolution.monsters.empty': 'No monsters yet.',
  // @desc: Stats line under a monster's name on its evolution card; {level} is the level ("Lv"
  // abbreviates "Level"), {stage} the evolution stage number, {trust} the trust tier name (e.g.
  // "Devoted"), {qualityTime} the quality-time tier number and {nutrition} a percentage. One
  // line of small text, about 60 characters wide.
  // evolutionView.ts:187-189
  'evolution.card.stats': (p) =>
    `Lv.${p.level} · Stage ${p.stage} · Trust ${p.trust} · Quality time ${p.qualityTime} · Nutrition ${p.nutrition}%`,
  // @desc: Line on a monster's evolution card when the species has no evolution path at all; also
  // the reason after the Monsters sheet's disabled Evolve… row. One short line of small text.
  // evolutionView.ts:195, boxView.ts (the Monsters frame)
  'evolution.card.noPaths': 'No evolution paths.',
  // @desc: Informational note on a monster's card when exactly one path is ready: the server
  // evolves it automatically on the player's next action; {species} is the species it becomes.
  // One line; carries a spaced em dash.
  // evolutionView.ts:207
  'evolution.card.ready': (p) => `Ready — evolves into ${p.species} on your next action.`,
  // @desc: Prompt above the choice buttons when two or more paths are ready and the player must
  // pick one; ends with a colon because the buttons follow. One line; carries a spaced em dash.
  // evolutionView.ts:215
  'evolution.card.choosePrompt': 'Two or more paths are ready — pick one:',
  // @desc: Heading of one evolution path row; {species} is the species this path leads to and
  // the leading arrow means "evolves into". Very short, one line.
  // evolutionView.ts:242
  'evolution.path.heading': (p) => `→ ${p.species}`,
  // @desc: Status line of an evolution path row when every requirement is satisfied (the
  // unsatisfied case shows a model-supplied reason instead). One short line of small text.
  // evolutionView.ts:248
  'evolution.path.allMet': 'All requirements met.',
  // @desc: One requirement row of an evolution path that IS satisfied: a check mark, then
  // {label} (the requirement name, e.g. "Level"), the monster's {current} value and the
  // {required} value. Same shape as evolution.gate.unmetRow with a different leading mark. One
  // line of small text.
  // evolutionView.ts:264
  'evolution.gate.metRow': (p) => `✓ ${p.label}: ${p.current} / ${p.required}`,
  // @desc: One requirement row of an evolution path that is NOT yet satisfied: a bullet, then
  // {label} (the requirement name), the monster's {current} value and the {required} value. Same
  // shape as evolution.gate.metRow with a different leading mark. One line of small text.
  // evolutionView.ts:264
  'evolution.gate.unmetRow': (p) => `• ${p.label}: ${p.current} / ${p.required}`,
  // @desc: Button label to choose one of several ready evolution paths; {species} is the species
  // the monster becomes. Fits a narrow button.
  // evolutionView.ts:272
  'evolution.choice.evolve': (p) => `Evolve into ${p.species}`,
  // @desc: Heading of the raising overlay, which shows the party monsters' stats with Care/Train
  // buttons and the player's inventory. One short line.
  // raisingView.ts:104 (resolved in show())
  'raising.title': 'Raising & Inventory',
  // @desc: Section heading above the monster cards in the raising overlay. One word.
  // raisingView.ts:124 (resolved in show())
  'raising.monsters.heading': 'Monsters',
  // @desc: Section heading above the item cards in the raising overlay. One word.
  // raisingView.ts:134 (resolved in show())
  'raising.inventory.heading': 'Inventory',
  // @desc: Empty-state line of the raising overlay's monster section when the player owns no
  // monster. One short line.
  // raisingView.ts:193
  'raising.monsters.empty': 'No monsters.',
  // @desc: Status line under a monster's name on its raising card; {level} is the level ("Lv"
  // abbreviates "Level"), {trust} the trust tier name (e.g. "Friendly") and {current}/{max} its
  // hit points. One line of small text.
  // raisingView.ts:209
  'raising.card.status': (p) => `Lv${p.level} · Trust ${p.trust} · HP ${p.current}/${p.max}`,
  // @desc: Battle-stat line on a monster's raising card; the five numbers are {attack},
  // {defense}, {speed}, {spAttack} (special attack) and {spDefense} (special defense), each
  // prefixed by its abbreviation. One line of small text, about 50 characters wide.
  // raisingView.ts:214-216
  'raising.card.stats': (p) =>
    `ATK ${p.attack} · DEF ${p.defense} · SPD ${p.speed} · SP.ATK ${p.spAttack} · SP.DEF ${p.spDefense}`,
  // @desc: Button label to care for (tend to) a monster, raising its trust. Short verb, fits a
  // very narrow button.
  // raisingView.ts:224
  'raising.card.care': 'Care',
  // @desc: Button label to feed a training item to a monster; {name} is the item name and
  // {count} how many the player carries (the "x" is a plain letter x, not a multiplication
  // sign). Fits a narrow button.
  // raisingView.ts:269
  'raising.card.train': (p) => `Train: ${p.name} (x${p.count})`,
  // @desc: Empty-state line of the raising overlay's inventory section when the player carries
  // nothing. One short line.
  // raisingView.ts:308
  'raising.inventory.empty': 'No items.',
  // @desc: Name line of an inventory card; {name} is the item name and {count} how many the
  // player carries (the "x" is a plain letter x). Bold, one line.
  // raisingView.ts:318
  'raising.inventory.item': (p) => `${p.name} (x${p.count})`,
  // @desc: Feedback line in the raising overlay after the server accepted a Care action on a
  // monster. One short line.
  // main.ts:2615 (onCare adapter; pre-migration careAction.ts CARED_MESSAGE)
  'raising.feedback.cared': 'Cared!',
  // @desc: Heading of the party & box overlay, where the player arranges which monsters are in
  // the active party and which stay in storage. One short line.
  // boxView.ts:69 (resolved in show())
  'box.title': 'Party & Box',
  // @desc: Button beside the party & box heading that fully heals every party monster. Two
  // words, fits a narrow button.
  // boxView.ts:79 (resolved in show())
  'box.heal': 'Heal Party',
  // @desc: Explainer under the heading telling the player that only Party monsters battle and
  // that new recruits land in the Box; the quoted "To Party" must match the box.card.toParty
  // button label exactly. Two sentences, wraps freely up to 600px wide; carries a spaced em
  // dash.
  // boxView.ts:94-96 (resolved in show())
  'box.hint':
    'Only monsters in your Party can battle or be swapped in. New recruits arrive in your Box — each box monster has a "To Party" button that moves it into an open party slot.',
  // @desc: Section heading above the six party slots. One word.
  // boxView.ts:101 (resolved in show())
  'box.section.party': 'Party',
  // @desc: Section heading above the stored (box) monsters. One word.
  // boxView.ts:111 (resolved in show())
  'box.section.box': 'Box',
  // @desc: Placeholder text of an unoccupied party slot; {slot} is the slot index as shown today
  // (counted from 0). One short line, dimmed.
  // boxView.ts:160
  'box.party.emptySlot': (p) => `Slot ${p.slot}: (empty)`,
  // @desc: Empty-state line of the box section when no monster is in storage. One short line,
  // dimmed.
  // boxView.ts:173
  'box.box.empty': 'No monsters in box.',
  // @desc: Info line on a monster card in the party or box; {species} is the species name,
  // {level} the level ("Lv" abbreviates "Level"), {current}/{max} its hit points and {percent}
  // the same as a percentage. Keep the "HP {current}/{max}" shape — tests read it. One line of
  // small text.
  // boxView.ts:205
  'box.card.stats': (p) => `${p.species} · Lv${p.level} · HP ${p.current}/${p.max} (${p.percent}%)`,
  // @desc: Badge on a monster card when the monster can evolve but the player must choose a path
  // on the evolution screen first. One short line; carries a leading star and a spaced em dash.
  // boxView.ts:216
  'box.card.evolveBadge': '★ Ready to evolve — choose a path',
  // @desc: Button on a party monster's card that moves it into the box (storage). Two words,
  // fits a very narrow button.
  // boxView.ts:227
  'box.card.toBox': 'To Box',
  // @desc: Button on a box monster's card that moves it into an open party slot; quoted verbatim
  // inside box.hint, so the two must stay identical. Two words, fits a very narrow button.
  // boxView.ts:235
  'box.card.toParty': 'To Party',
  // @desc: Label of the in-frame text field asking for a monster's new nickname; the current name
  // is pre-filled. Short, ends with a colon.
  // boxView.ts (the Monsters nickname row)
  'box.rename.prompt': 'New nickname:',
  // @desc: Tab of the Monsters screen listing the party (up to six monsters). One word.
  // boxView.ts (the Monsters frame)
  'box.tab.party': 'Party',
  // @desc: Tab of the Monsters screen listing the monsters kept in storage (the box). One word.
  // boxView.ts (the Monsters frame)
  'box.tab.storage': 'Storage',
  // @desc: Action on a monster's action sheet that shows its details. One word.
  // boxView.ts (the Monsters frame)
  'box.sheet.summary': 'Summary',
  // @desc: Action on a monster's action sheet that opens a text field to rename it. One word.
  // boxView.ts (the Monsters frame)
  'box.sheet.nickname': 'Nickname',
  // @desc: Action on a monster's action sheet that moves it between the party and storage.
  // One word.
  // boxView.ts (the Monsters frame)
  'box.sheet.move': 'Move',
  // @desc: Confirmation line after a monster moved from storage into the party; the screen draws a
  // check mark before it. Short phrase.
  // boxView.ts (the Monsters frame)
  'box.feedback.movedToParty': 'Moved to party',
  // @desc: Confirmation line after a monster moved from the party into storage; the screen draws a
  // check mark before it. Short phrase.
  // boxView.ts (the Monsters frame)
  'box.feedback.movedToBox': 'Moved to storage',
  // @desc: Action on a monster's action sheet that sends it a care visit (the raising screen's Care
  // action, on a server cooldown). One word.
  // boxView.ts (the Monsters frame)
  'box.sheet.care': 'Care',
  // @desc: Action on a monster's action sheet that opens the list of foods to feed it; the
  // trailing ellipsis (one character) marks a row that opens a list. One word plus the ellipsis.
  // boxView.ts (the Monsters frame)
  'box.sheet.feed': 'Feed…',
  // @desc: Action on a monster's action sheet that opens the list of its evolution paths; the
  // trailing ellipsis (one character) marks a row that opens a list. One word plus the ellipsis.
  // boxView.ts (the Monsters frame)
  'box.sheet.evolve': 'Evolve…',
  // @desc: Reason shown after the disabled Feed… row when the player holds no food. Two words.
  // boxView.ts (the Monsters frame)
  'box.sheet.feedNone': 'No food',
  // @desc: One row of the food list under a monster's action sheet; {name} is the item's name and
  // {count} how many the player holds. Keep the "(x{count})" shape. One short line.
  // boxView.ts (the Monsters frame)
  'box.feed.item': (p) => `${p.name} (x${p.count})`,
  // @desc: Question of the Yes / No confirm before evolving a monster; {name} is the monster's
  // nickname or species and {species} the species it would become. One question, ends with "?".
  // boxView.ts (the Monsters frame)
  'box.evolve.confirm': (p) => `Evolve ${p.name} into ${p.species}?`,
  // @desc: Confirmation line after a monster was fed; {name} is the monster's nickname or species;
  // the screen draws a check mark before it. Short phrase.
  // boxView.ts (the Monsters frame)
  'box.feedback.fed': (p) => `Fed ${p.name}`,
  // @desc: Status line of the trade overlay when the player is in no trade. One short line.
  // tradeView.ts:93
  'trade.status.none': 'No active trade',
  // @desc: Heading of the trade overlay's left column listing what the player gives away. Two
  // words, one line.
  // tradeView.ts:111 (#renderSide heading argument)
  'trade.side.offer': 'You offer',
  // @desc: Heading of the trade overlay's right column listing what the player gets. Two words,
  // one line.
  // tradeView.ts:112 (#renderSide heading argument)
  'trade.side.receive': 'You receive',
  // @desc: One monster row on a trade side; {nickname} is the monster's nickname, {species} its
  // species name, {level} its level ("Lv" abbreviates "Level") and {current}/{max} its hit
  // points. One line.
  // tradeView.ts:133
  'trade.side.card': (p) => `${p.nickname} (${p.species}) Lv.${p.level} HP:${p.current}/${p.max}`,
  // @desc: Currency row on a trade side; {amount} is the number of gold coins offered. Very
  // short, one line.
  // tradeView.ts:153
  'trade.side.currency': (p) => `${p.amount} gold`,
  // @desc: Placeholder row on a trade side that offers no monster, item or gold. One word in
  // parentheses.
  // tradeView.ts:159
  'trade.side.nothing': '(nothing)',
  // @desc: Button label to accept the trade offered to the player. Short verb, fits a narrow
  // button.
  // tradeView.ts:193 (#actionLabel return)
  'trade.action.accept': 'Accept',
  // @desc: Button label to reject the trade offered to the player. Short verb, fits a narrow
  // button.
  // tradeView.ts:195 (#actionLabel return)
  'trade.action.reject': 'Reject',
  // @desc: Button label for the second confirmation step that completes an accepted trade. Two
  // words, fits a button.
  // tradeView.ts:197 (#actionLabel return)
  'trade.action.confirm': 'Confirm Trade',
  // @desc: Button label to withdraw from a trade the player proposed or accepted. Short verb,
  // fits a narrow button.
  // tradeView.ts:199 (#actionLabel return)
  'trade.action.cancel': 'Cancel',
  // @desc: Feedback line in the live-trade overlay after the player accepted the offer.
  // main.ts:2668
  'trade.feedback.accepted': 'Trade accepted!',
  // @desc: Feedback line in the live-trade overlay after the player rejected the offer.
  // main.ts:2675
  'trade.feedback.rejected': 'Trade rejected.',
  // @desc: Feedback line in the live-trade overlay after the player confirmed and the trade went through.
  // main.ts:2682
  'trade.feedback.completed': 'Trade complete!',
  // @desc: Feedback line in the live-trade overlay after the player cancelled the trade.
  // main.ts:2689
  'trade.feedback.cancelled': 'Trade cancelled.',
  // @desc: Fallback heading of the shop overlay when no shop is nearby (a real shop shows its
  // own name instead). One word.
  // shopView.ts:124
  'shop.title': 'Shop',
  // @desc: Only row of the for-sale list when the player is not standing at a shop. One short
  // line.
  // shopView.ts:125
  'shop.noShop': 'No shop available.',
  // @desc: Only row of the for-sale list when the shop stocks nothing. One short line.
  // shopView.ts:136
  'shop.forSale.empty': 'Nothing for sale.',
  // @desc: Only row of the sell list when the player carries nothing a shop would take. One
  // short line.
  // shopView.ts:144
  'shop.inventory.empty': 'No items to sell.',
  // @desc: Text of one for-sale row, followed on the same line by the Buy button; {name} is the
  // item name and {price} its cost in gold. Carries a spaced em dash and MUST END WITH A SPACE —
  // it separates the text from the button. One line.
  // shopView.ts:155
  'shop.buy.row': (p) => `${p.name} — ${p.price} gold `,
  // @desc: Button label to buy one unit of the item in its row. Short verb, fits a very narrow
  // button.
  // shopView.ts:157
  'shop.buy.submit': 'Buy',
  // @desc: Text of one sellable inventory row, followed on the same line by the Sell button;
  // {name} is the item name, {count} how many the player carries (after a multiplication sign)
  // and {price} what the shop pays in gold. Carries a spaced em dash and MUST END WITH A SPACE —
  // it separates the text from the button. One line.
  // shopView.ts:175
  'shop.sell.row': (p) => `${p.name} (×${p.count}) — ${p.price} gold `,
  // @desc: Button label to sell one unit of the item in its row. Short verb, fits a very narrow
  // button.
  // shopView.ts:177
  'shop.sell.submit': 'Sell',
  // @desc: Text of one inventory row for an item the shop will not buy (no button follows);
  // {name} is the item name and {count} how many the player carries (after a multiplication
  // sign). Carries a spaced em dash. One line.
  // shopView.ts:190
  'shop.sell.unsellable': (p) => `${p.name} (×${p.count}) — Cannot sell`,
  // @desc: Feedback line in the shop overlay after a purchase succeeded; {qty} is how many were
  // bought, {name} the item name and {gold} the total gold spent, after a minus sign (U+2212).
  // Starts with a check mark. One line.
  // main.ts (dispatch, buy)
  'shop.feedback.buy.item': (p) => `✓ Bought ${p.qty} ${p.name} (−${p.gold}g)`,
  // @desc: Feedback line in the shop overlay after a purchase succeeded while the item or its
  // price is not loaded; {qty} is how many were bought, after a multiplication sign. Starts with
  // a check mark. One short line.
  // main.ts (dispatch, buy)
  'shop.feedback.buy.count': (p) => `✓ Bought ×${p.qty}`,
  // @desc: Feedback line in the shop overlay after a sale succeeded; {qty} is how many were
  // sold, {name} the item name and {gold} the total gold received, after a plus sign. Starts
  // with a check mark. One line.
  // main.ts (dispatch, sell)
  'shop.feedback.sell.item': (p) => `✓ Sold ${p.qty} ${p.name} (+${p.gold}g)`,
  // @desc: Feedback line in the shop overlay after a sale succeeded while the item is not
  // loaded; {qty} is how many were sold, after a multiplication sign. Starts with a check mark.
  // One short line.
  // main.ts (dispatch, sell)
  'shop.feedback.sell.count': (p) => `✓ Sold ×${p.qty}`,
  // @desc: Label of the shop's Buy tab (the tab strip under the title; the frame opens on it).
  // One short word.
  // shopView.ts (paint, the tab strip)
  'shop.tab.buy': 'Buy',
  // @desc: Label of the shop's Sell tab, beside the Buy tab. One short word.
  // shopView.ts (paint, the tab strip)
  'shop.tab.sell': 'Sell',
  // @desc: The description slot's text when the item under the cursor has no description, shown
  // after Y. A single em dash (U+2014), a "nothing here" mark.
  // shopView.ts (paint, the description slot)
  'shop.description.none': '—',
  // @desc: The quantity row under the Buy tab after A on an item; {name} is the item, {qty} the
  // quantity the D-pad is changing, after a multiplication sign. One short line.
  // shopView.ts (paint, the prompt)
  'shop.qty.buy': (p) => `Buy how many ${p.name}? ×${p.qty}`,
  // @desc: The quantity row under the Sell tab; {name} is the item, {qty} the quantity the D-pad
  // is changing, after a multiplication sign. One short line.
  // shopView.ts (paint, the prompt)
  'shop.qty.sell': (p) => `Sell how many ${p.name}? ×${p.qty}`,
  // @desc: The Yes / No question before a purchase; {qty} items named {name} for {gold} gold in
  // total. One short line, a question.
  // shopView.ts (paint, the prompt)
  'shop.confirm.buy': (p) => `Buy ${p.qty} ${p.name} for ${p.gold} gold?`,
  // @desc: The Yes / No question before a sale; {qty} items named {name} for {gold} gold in
  // total. One short line, a question.
  // shopView.ts (paint, the prompt)
  'shop.confirm.sell': (p) => `Sell ${p.qty} ${p.name} for ${p.gold} gold?`,
  // @desc: The affirmative option of a Yes / No confirm (the shop's buy and sell, the heal
  // question, the Monsters sheet's Evolve confirm). One short word.
  // shopView.ts, healView.ts, boxView.ts (the confirm options)
  'prompt.yes': 'Yes',
  // @desc: The negative option of a Yes / No confirm, beside Yes. One short word.
  // shopView.ts, healView.ts, boxView.ts (the confirm options)
  'prompt.no': 'No',
  // @desc: Tab of the Social screen that will list the players online. One word, fits a narrow tab.
  // tradeView.ts (the Social tab strip)
  'social.tab.players': 'Players',
  // @desc: Tab of the Social screen showing the trade offered to or by the player. One word, fits a
  // narrow tab.
  // tradeView.ts (the Social tab strip)
  'social.tab.trades': 'Trades',
  // @desc: Tab of the Social screen showing PvP challenges sent to or by the player. One word, fits
  // a narrow tab.
  // tradeView.ts (the Social tab strip)
  'social.tab.challenges': 'Challenges',
  // @desc: Tab of the Social screen showing the ranked leaderboard. One word, fits a narrow tab.
  // tradeView.ts (the Social tab strip)
  'social.tab.rankings': 'Rankings',
  // @desc: Line shown on the Social screen's Players tab while the player list is not built yet. One
  // short sentence.
  // tradeView.ts (the Players tab)
  'social.players.placeholder': 'The player list is not available yet.',
  // @desc: Row of the action sheet opened on a trade offer or a PvP challenge: accept it. One short
  // verb.
  // tradeView.ts (the Social action sheet)
  'social.action.accept': 'Accept',
  // @desc: Row of the action sheet opened on a trade offer or a PvP challenge: decline it (a Yes /
  // No question follows). One short verb.
  // tradeView.ts (the Social action sheet)
  'social.action.decline': 'Decline',
  // @desc: Row of the action sheet opened on an accepted trade: complete it (a Yes / No question
  // follows). One short verb.
  // tradeView.ts (the Social action sheet)
  'social.action.confirm': 'Confirm',
  // @desc: Row of the action sheet opened on the player's own trade offer or challenge: withdraw it.
  // One short verb.
  // tradeView.ts (the Social action sheet)
  'social.action.cancel': 'Cancel',
  // @desc: The Yes / No question before a trade offer is declined; No is the default answer.
  // tradeView.ts (the Social prompt)
  'social.confirm.declineTrade': 'Decline this trade?',
  // @desc: The Yes / No question before an accepted trade is completed, which cannot be reversed; No
  // is the default answer.
  // tradeView.ts (the Social prompt)
  'social.confirm.confirmTrade': 'Complete this trade? It cannot be undone.',
  // @desc: The Yes / No question before a PvP challenge is declined; No is the default answer.
  // tradeView.ts (the Social prompt)
  'social.confirm.declineChallenge': 'Decline this challenge?',
  // @desc: Placeholder option of the trade-proposal dialog's target selector, shown before the
  // player picks another player to trade with; ends with an ellipsis. Short, fits a narrow
  // dropdown.
  // tradeProposeView.ts:168
  'tradePropose.target.placeholder': 'Select a player…',
  // @desc: Feedback line in the trade-proposal dialog after the offer was sent to the other player.
  // main.ts:2828
  'tradePropose.feedback.sent': 'Offer sent!',
  // @desc: Button in the NPC dialogue overlay that opens the shop this NPC runs; shown only when
  // the NPC has one. One word, fits a narrow button.
  // dialogueView.ts:72
  'dialogue.action.shop': 'Shop',
  // @desc: Button on the guest-claim overlay that opens the privacy & account-data surface
  // (account deletion, data export). Same English as privacy.title today, but a different key:
  // this is a BUTTON label. One short line.
  // claimView.ts:96 (resolved in show() and render())
  'claim.privacyButton': 'Privacy & Account Data',
  // @desc: Button on the guest-claim overlay that starts sign-in so guest progress can be claimed onto an account. Short verb phrase.
  'claim.signInButton': 'Sign in',
  // @desc: Button on the guest-claim overlay that returns to the game once the claim is settled or declined. Short phrase.
  'claim.joinButton': 'Continue playing',
  // @desc: Button on the guest-claim overlay: first step of declining the claim (a confirmation follows). One word.
  'claim.declineButton': 'Decline',
  // @desc: Button confirming the decline: permanently deletes the claim code. Short phrase.
  'claim.declineConfirmButton': 'Yes, decline',
  // @desc: Button cancelling the decline: keeps the claim code. Short phrase.
  'claim.declineCancelButton': 'Keep my code',
  // @desc: Feedback line on the guest-claim overlay, above its buttons, when the player tries to
  // rejoin the game while a claim code is still pending — the join is refused until the claim is
  // finished or declined. One line.
  // claimModel.ts:96 (resolved in claimStep)
  'claim.feedback.veto': 'Finish or decline the pending claim before rejoining.',
  // @desc: First-run notice on the guest-claim overlay: guest progress can only be claimed from
  // the device it was made on. One line.
  // claimModel.ts:320 (resolved in buildClaimViewModel)
  'claim.nudge': 'Guest progress transfers only from the device you claim it on.',
  // @desc: Confirmation prompt shown after the player asks to decline the claim; it names the
  // irreversible consequence (the claim code is deleted for good) and asks again. Two sentences.
  // claimModel.ts:321-322 (resolved in buildClaimViewModel)
  'claim.decline.confirmPrompt':
    'Declining permanently deletes this claim code — your guest progress cannot be undone once ' +
    'the code is gone. Decline and continue as a guest?',
  // @desc: Heading of the guest-claim overlay while a claim code is pending (also the initial
  // prompt). One short line.
  // claimModel.ts:324 (resolved in buildClaimViewModel)
  'claim.pending.title': 'Keep your guest progress',
  // @desc: Body of the guest-claim overlay while a claim code is pending: sign in to claim the
  // guest progress, or decline and stay a guest on this device. One sentence, two clauses.
  // claimModel.ts:325-326
  'claim.pending.body':
    'Sign in to claim the progress you made as a guest, or decline to keep playing as a guest ' +
    'on this device.',
  // @desc: Heading of the guest-claim overlay after sign-in while the account is still being
  // prepared. One short line.
  // claimModel.ts:327
  'claim.awaiting.title': 'Finishing your claim',
  // @desc: Body of the guest-claim overlay while waiting for the account to be ready before the
  // guest progress can transfer. One sentence.
  // claimModel.ts:328-329
  'claim.awaiting.body':
    'Waiting for your account to be ready before your guest progress can transfer.',
  // @desc: Heading of the guest-claim overlay once the guest progress is attached to the account.
  // One short line.
  // claimModel.ts:330
  'claim.claimed.title': 'Progress claimed',
  // @desc: Body of the guest-claim overlay once the claim succeeded. One sentence.
  // claimModel.ts:331
  'claim.claimed.body': 'Your guest progress is now attached to your account.',
  // @desc: Heading of the guest-claim overlay after a sign-in attempt failed. One short line.
  // claimModel.ts:381
  'claim.signInFailed.title': 'Sign-in did not finish',
  // @desc: Body of the guest-claim overlay when the sign-in provider rejected the attempt; invites
  // another try. Two short sentences.
  // claimModel.ts:353 (resolved in buildClaimViewModel)
  'claim.signInFailed.rejected': 'Sign-in was rejected. Please try signing in again.',
  // @desc: Body of the guest-claim overlay when the sign-in link had expired. Two short sentences.
  // claimModel.ts:354
  'claim.signInFailed.expired': 'That sign-in link expired. Please try signing in again.',
  // @desc: Body of the guest-claim overlay when the player cancelled the sign-in themselves. Two
  // short sentences.
  // claimModel.ts:355
  'claim.signInFailed.declined': 'Sign-in was cancelled. You can try again whenever you are ready.',
  // @desc: Body of the guest-claim overlay when the sign-in service could not be reached;
  // reassures that guest progress is kept. Two sentences.
  // claimModel.ts:356-357
  'claim.signInFailed.unreachable':
    'We could not reach the sign-in service. Please try again in a moment — your guest ' +
    'progress is safe.',
  // @desc: Body of the guest-claim overlay for any other sign-in failure; reassures that guest
  // progress is kept. Two sentences.
  // claimModel.ts:363
  'claim.signInFailed.fallback':
    'Sign-in did not complete. Please try again — your guest progress is safe.',
  // @desc: Heading of the guest-claim overlay when the server refused the claim because the code
  // is invalid, already used or expired. One short line.
  // claimModel.ts:335 (resolved in buildClaimViewModel)
  'claim.reject.unusable.title': 'That claim code is no longer usable',
  // @desc: Body for the unusable-code refusal: the code is spent, and the player keeps playing on
  // this device. Two sentences.
  // claimModel.ts:336
  'claim.reject.unusable.body':
    'This claim code has already been used or has expired. You can keep playing on this ' +
    'device.',
  // @desc: Heading when the signed-in account already has its own game data and cannot take the
  // guest progress. One short line.
  // claimModel.ts:339
  'claim.reject.destination.title': 'This account cannot take that progress',
  // @desc: Body for that refusal: why the progress cannot move, and that the code still works on
  // another account. Two sentences.
  // claimModel.ts:340
  'claim.reject.destination.body':
    'This account already has game data, so the guest progress cannot be moved onto it. The ' +
    'claim code is still valid on another account.',
  // @desc: Heading when the claim is refused for a momentary reason (another tab open, a battle
  // in progress). One short line.
  // claimModel.ts:343
  'claim.reject.transient.title': 'Not ready to claim yet',
  // @desc: Body for the momentary refusal: close the other tab or finish the battle, then retry.
  // One sentence.
  // claimModel.ts:344
  'claim.reject.transient.body':
    'The claim could not complete right now — close your other tab or finish your current ' +
    'battle, then try again.',
  // @desc: Heading for any other claim refusal (e.g. not signed in). One short line.
  // claimModel.ts:347
  'claim.reject.generic.title': 'Could not complete the claim',
  // @desc: Body for the other refusals: sign-in is required first; guest progress is kept. Two
  // sentences.
  // claimModel.ts:348
  'claim.reject.generic.body':
    'Signing in is required before this progress can be claimed. Your guest progress is safe.',
  // @desc: Only row of the ranked leaderboard when no player has a rating yet (ratings exist
  // only after a decisive ranked battle). One short line.
  // leaderboardView.ts:60
  'leaderboard.empty': 'No ranked players yet',
  // @desc: Text that FOLLOWS a player's name on one leaderboard row: {rating} is the ranked
  // rating number, {wins}/{losses} the win and loss counts ("W" and "L" abbreviate them). MUST
  // START WITH A SPACE and a spaced em dash — the name is rendered just before this text in its
  // own element and is not a placeholder. One line.
  // leaderboardView.ts:69
  'leaderboard.row': (p) => ` — ${p.rating} (W${p.wins}/L${p.losses})`,
  // @desc: Footer of the diagnostic error overlay naming its two keyboard shortcuts: F8 closes
  // it, F9 downloads a bug report; "F8"/"F9" are key names. One short line, small text.
  // errorOverlayView.ts:81 (resolved in show())
  'errorOverlay.footer': 'F8 dismiss · F9 bug report',
  // @desc: One row of the quest log; {name} is the quest's content identifier (e.g.
  // "quest_001", not player text) and {step} the current step number counted from 0. One line.
  // questLogView.ts:45
  'questLog.entry': (p) => `${p.name} (step ${p.step})`,
  // @desc: One row of the heal overlay offering a heal at this location; {cost} is the price
  // text the heal model produces (e.g. "Free" or "25 gold"). One short line.
  // healView.ts:47
  'heal.location': (p) => `Heal here (${p.cost})`,
  // @desc: The heal frame's Yes / No question; {cost} is the price text the heal model produces
  // (e.g. "Free" or "25 gold"), carried verbatim. One short line, a question.
  // healView.ts (paint, the question)
  'heal.prompt.question': (p) => `Heal party for ${p.cost}?`,
  // @desc: Why the heal frame's Yes is disabled: no healer is bound (the frame was left open
  // across a reconnect). One short sentence.
  // healView.ts (paint, the reason)
  'heal.prompt.unavailable': 'No healer in reach. Healing is unavailable.',
  // @desc: Heading of the privacy & account-data overlay (account deletion, data export). Same
  // English as claim.privacyButton today, but a different key: this is a HEADING. One short line.
  // privacyView.ts:145 (resolved in show())
  'privacy.title': 'Privacy & Account Data',
  // @desc: Button that closes the privacy & account-data overlay; it is the first control and
  // always enabled. Short verb, fits a very narrow button.
  // privacyView.ts:151 (resolved in show())
  'privacy.close': 'Close',
  // @desc: Second-step button that confirms the player's account deletion request, shown only
  // after they asked to delete. Two words, fits a narrow button.
  // privacyView.ts:187 (#paintButton label argument)
  'privacy.confirm.delete': 'Confirm deletion',
  // @desc: Second-step button that backs out of a pending account deletion request, shown
  // beside privacy.confirm.delete. Short phrase, fits a narrow button.
  // privacyView.ts:188 (#paintButton label argument)
  'privacy.confirm.keep': 'Keep my account',
  // @desc: Countdown banner in the HUD and the privacy overlay's status line while account
  // deletion is pending but the remaining time could not be computed. One line.
  // privacyBanner.ts:31 (resolved in privacyBannerLabel)
  'privacy.countdown.dark': 'Account deletion pending — time remaining unavailable',
  // @desc: Countdown banner / status line once the deletion deadline has passed and the account
  // may be deleted at any moment. One short line.
  // privacyBanner.ts:32 (resolved in privacyBannerLabel)
  'privacy.countdown.due': 'Account deletion is due now',
  // @desc: Ticking countdown banner / status line while deletion is pending; {duration} is the
  // remaining time already formatted from privacy.countdown.days/hours/minutes/seconds (e.g.
  // "6d 23h 59m 58s"). One line.
  // privacyBanner.ts:33 (resolved in privacyBannerLabel)
  'privacy.countdown.grace': (p) => `Account deletion in ${p.duration}`,
  // @desc: One group of the countdown duration: {n} whole days followed by the day unit symbol
  // (no space in English). Very short.
  // privacyBanner.ts:62 (resolved in formatDuration)
  'privacy.countdown.days': (p) => `${p.n}d`,
  // @desc: One group of the countdown duration: {n} hours (0-23) and the hour unit symbol. Very
  // short.
  // privacyBanner.ts:63 (resolved in formatDuration)
  'privacy.countdown.hours': (p) => `${p.n}h`,
  // @desc: One group of the countdown duration: {n} minutes (0-59) and the minute unit symbol.
  // Very short.
  // privacyBanner.ts:64 (resolved in formatDuration)
  'privacy.countdown.minutes': (p) => `${p.n}m`,
  // @desc: One group of the countdown duration: {n} seconds (0-59) and the second unit symbol;
  // this group is always present and ticks every second. Very short.
  // privacyBanner.ts:65 (resolved in formatDuration)
  'privacy.countdown.seconds': (p) => `${p.n}s`,
  // @desc: Notice on the privacy overlay when the account has already been permanently deleted
  // (shown on open, and after a refused cancel). Must not read like a generic rejection. Two
  // sentences.
  // privacyBanner.ts:126-127 (resolved in buildPrivacyViewModel)
  'privacy.notice.terminal':
    'This account has already been permanently deleted. It cannot be restored.',
  // @desc: Notice on the privacy overlay when a delete / cancel / export click could not be sent
  // because the connection is down; it is NOT a server rejection. Two short sentences.
  // privacyBanner.ts:131 (resolved in buildPrivacyViewModel)
  'privacy.notice.disconnected': 'Not connected — your request was not sent. Try again.',
  // @desc: Status line of the privacy overlay for an account with no deletion pending. One short
  // sentence.
  // privacyBanner.ts:133 (resolved in buildPrivacyViewModel)
  'privacy.status.active': 'This account is active.',
  // @desc: Status line of the privacy overlay before the account row has arrived. One short
  // sentence.
  // privacyBanner.ts:134
  'privacy.status.unknown': 'Account status unavailable.',
  // @desc: Status line of the privacy overlay for an account that has been permanently deleted.
  // One short sentence.
  // privacyBanner.ts:135
  'privacy.status.terminal': 'This account has been permanently deleted.',
  // @desc: Data-export line of the privacy overlay when no export has been delivered to this
  // device. One sentence.
  // privacyBanner.ts:147 (resolved in buildPrivacyViewModel)
  'privacy.export.none': 'No data export has arrived on this device yet.',
  // @desc: Data-export line while chunks are still missing; {received} chunks of {total} have
  // arrived (both counts). Deliberately does not promise the rest will arrive. One sentence.
  // privacyBanner.ts:148-149
  'privacy.export.incomplete': (p) =>
    `Data export incomplete — ${p.received} of ${p.total} chunks delivered.`,
  // @desc: Data-export line while chunks are missing and the total is unknown; deliberately no
  // number. One sentence.
  // privacyBanner.ts:150
  'privacy.export.incompleteDark': 'Data export incomplete — some chunks are missing.',
  // @desc: Data-export line when the delivered chunks contradict each other and the export must
  // be requested again; deliberately no number. Two sentences.
  // privacyBanner.ts:151-153
  'privacy.export.inconsistent':
    'Data export could not be assembled — the delivered chunks do not describe one request. ' +
    'Request it again.',
  // @desc: Data-export line once every chunk arrived; {received} is the chunk count. One short
  // sentence.
  // privacyBanner.ts:154-155
  'privacy.export.complete': (p) => `Data export ready — ${p.received} chunks.`,
  // @desc: Button on the privacy overlay that starts the two-step account deletion. Short phrase,
  // fits a narrow button.
  // privacyBanner.ts:157 (resolved in buildPrivacyViewModel)
  'privacy.action.delete': 'Delete my account',
  // @desc: Prompt shown beside the second-step buttons after the player asked to delete the
  // account; names the irreversibility. Two short sentences.
  // privacyBanner.ts:158
  'privacy.confirm.prompt': 'This cannot be undone. Confirm deletion?',
  // @desc: Button on the privacy overlay that withdraws a pending account deletion. Short phrase,
  // fits a narrow button.
  // privacyBanner.ts:159
  'privacy.action.cancel': 'Cancel account deletion',
  // @desc: Button on the privacy overlay that asks the server to build a data export. Short
  // phrase; it sits beside privacy.action.download, which must read differently.
  // privacyBanner.ts:160
  'privacy.action.export': 'Request my data export',
  // @desc: Button on the privacy overlay that saves the data export that has already arrived.
  // Short phrase, distinct from privacy.action.export.
  // privacyBanner.ts:164
  'privacy.action.download': 'Download my data export',
  // @desc: Dismiss button of the small evolution-reveal banner near the bottom of the screen.
  // Very short — one or two characters wide.
  // evolutionNotice.ts:209 (resolved in render())
  'evolutionNotice.ok': 'OK',
  // @desc: Stand-in for a species name that has not loaded yet; {id} is the numeric species
  // id. Used inside the evolution-reveal sentences. Very short.
  // evolutionNotice.ts:71 (speciesLabel return)
  'evolutionNotice.species.fallback': (p) => `Species #${p.id}`,
  // @desc: Evolution-reveal sentence for a monster the player nicknamed; {nickname} is that
  // nickname, {from} the previous species name and {to} the new one. One line in a small
  // banner.
  // evolutionNotice.ts:93 (evolutionNoticeLabel return)
  'evolutionNotice.reveal.nicknamed': (p) => `${p.nickname} evolved from ${p.from} into ${p.to}!`,
  // @desc: Evolution-reveal sentence for a monster with no nickname; {from} is the previous
  // species name and {to} the new one. One line in a small banner.
  // evolutionNotice.ts:95 (evolutionNoticeLabel return)
  'evolutionNotice.reveal.anonymous': (p) => `Your ${p.from} evolved into ${p.to}!`,
  // @desc: Title of the main menu side panel and the first breadcrumb in its sub-lists.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.title': 'Menu',
  // @desc: Main-menu entry opening the monster box (party and storage).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.monsters.title': 'Monsters',
  // @desc: Feedback-line description of the Monsters main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.monsters.desc': 'See your party and stored monsters.',
  // @desc: Main-menu entry opening the bag (items, feeding and care).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.bag.title': 'Bag',
  // @desc: Feedback-line description of the Bag main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.bag.desc': 'Use items and care for your monsters.',
  // @desc: Main-menu entry opening the quest journal.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.journal.title': 'Journal',
  // @desc: Feedback-line description of the Journal main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.journal.desc': 'Review your quests and their progress.',
  // @desc: Main-menu entry opening the Social sub-list (trades, challenges, rankings).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.title': 'Social',
  // @desc: Feedback-line description of the Social main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.desc': 'Trades, challenges and rankings with other players.',
  // @desc: Main-menu entry opening the Profile sub-list (name, account, privacy).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.title': 'Profile',
  // @desc: Feedback-line description of the Profile main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.desc': 'Your name, account and privacy settings.',
  // @desc: Main-menu entry opening the Options sub-list (how to play).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.title': 'Options',
  // @desc: Feedback-line description of the Options main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.desc': 'Help on how to play the game.',
  // @desc: Main-menu entry that closes the menu and returns to the world.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.close.title': 'Close',
  // @desc: Feedback-line description of the Close main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.close.desc': 'Close the menu and return to the world.',
  // @desc: Social sub-list entry opening the incoming-trade screen.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.trades.title': 'Trades',
  // @desc: Feedback-line description of the Trades entry in the Social sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.trades.desc': 'See and answer the trade offered to you.',
  // @desc: Social sub-list entry opening the battle-challenge screen.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.challenges.title': 'Challenges',
  // @desc: Feedback-line description of the Challenges entry in the Social sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.challenges.desc': 'Challenge a player or answer a challenge.',
  // @desc: Social sub-list entry opening the ranked leaderboard.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.rankings.title': 'Rankings',
  // @desc: Feedback-line description of the Rankings entry in the Social sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.rankings.desc': 'See the ranked leaderboard.',
  // @desc: Profile sub-list entry opening the rename form.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.name.title': 'Name',
  // @desc: Feedback-line description of the Name entry in the Profile sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.name.desc': 'Change the name other players see.',
  // @desc: Profile sub-list entry opening the account and sign-in screen.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.account.title': 'Account',
  // @desc: Feedback-line description of the Account entry in the Profile sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.account.desc': 'Sign in or keep this guest progress.',
  // @desc: Profile sub-list entry opening the privacy screen (data export, deletion).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.privacy.title': 'Privacy',
  // @desc: Feedback-line description of the Privacy entry in the Profile sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.privacy.desc': 'Export or delete your data.',
  // @desc: Options sub-list entry opening the how-to-play help screen.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.help.title': 'How to play',
  // @desc: Feedback-line description of the How to play entry in the Options sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.help.desc': 'Controls and goals of the game.',
  // @desc: Reason a main-menu entry is disabled while the menu is open over a battle (feedback
  // line); also the status-line and announced reason when an action is refused during a battle.
  // ui/screens/mainMenuScreen.ts (battleReason); main.ts (refusedInBattle)
  'menu.disabled.inBattle': 'Not during a battle',
  // @desc: Feedback-line reason the Bag main-menu entry is disabled over a battle: use the
  // battle's own Bag command.
  // ui/screens/mainMenuScreen.ts (battleReason)
  'menu.disabled.battleBag': 'Use items from the battle Bag command',
} satisfies Catalog);
