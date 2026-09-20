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
// string is rendered (pre-migration line numbers, kept as the translator's "where"). S4
// (ADR-0260) did the same for the five mid-density views — `evolution.*`, `raising.*`, `box.*`,
// `trade.*`, `shop.*` — including seven literals the scanner never saw (function arguments and
// `return` values: tradeView's side headings and action labels, boxView's `prompt()` label).
// Every value is byte-identical to the literal it replaced — including `’` U+2019 and `…`
// U+2026, the `—` U+2014 / `→` / `★` / `✓` / `•` glyphs, the `×` U+00D7 in `shop.sell.*` versus
// the ASCII `x` in `raising.*`, and the TRAILING SPACE in `shop.buy.row` / `shop.sell.row` (the
// Buy/Sell button follows the text) — because catalog.test.ts pins the English bytes and several
// e2e specs match them. Still no plural key: `(${turns} turns)` keeps its pre-existing English
// plural defect on purpose — fixing it is a reword, which takes a FRESH key and the first
// `oneOther` use (ADR-0259 alternatives); likewise `Slot ${slot}` (0-based) and `(x${count})`
// keep their pre-existing shape (ADR-0260 consequences). Model data (affinities, weather labels,
// species/skill/item/player names, tiers, stats, counts, prices) are PARAMS, interpolated
// verbatim, never catalogued (M24 §2.5).

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
  // @desc: Line on a monster's evolution card when the species has no evolution path at all.
  // One short line of small text.
  // evolutionView.ts:195
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
  // @desc: Small button on a monster card that opens the nickname prompt. Short verb, fits a
  // very narrow button.
  // boxView.ts:197
  'box.card.rename': 'Rename',
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
  // @desc: Label of the browser's text-input prompt dialog asking for a monster's new nickname;
  // the current name is pre-filled. Short, ends with a colon.
  // boxView.ts:248 (prompt() argument)
  'box.rename.prompt': 'New nickname:',
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
} satisfies Catalog);
