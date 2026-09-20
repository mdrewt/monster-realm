// ui/i18n/catalog.fr.ts — the French catalog, the M24 PROOF LOCALE (m24-s7, ADR-0263).
//
// WHY THIS FILE EXISTS. `fr` is the second registered locale: it proves, at runtime and under
// the §5.3 parity gate (catalogParity.test.ts), that the resolver/catalog seam built by S1-S6
// carries a real translation — every `MessageId` resolves, every closure reads exactly the
// same param fields as its English twin, and the first CLDR plural (`battle.weather.banner`)
// selects through `selectPlural` rather than an `n === 1` branch. It mirrors catalog.en.ts
// ENTRY FOR ENTRY, IN THE SAME ORDER, so a side-by-side diff of the two files lines up.
//
// ONE ENTRY PER `MessageId`, and the type makes that total: `satisfies Catalog` is load-bearing
// (ADR-0256 D2) — `Object.freeze<T>` is generic, so without it a stowaway key would be swallowed
// into `T`; `satisfies` restores the excess-property check, and the mapped type reports an
// omitted key by name (TS2741). Frozen for the same reason `CATALOG_EN` is: the type annotation
// is erased at runtime, and a caller that casts it away must not be able to rewrite the shared
// singleton for every later importer.
//
// THE `// @desc:` CONVENTION (M24 §2.3) applies here exactly as in catalog.en.ts: the contiguous
// `//` block directly above every entry carries one `// @desc:` line (≥10 non-whitespace chars)
// written in ENGLISH for the translator/TMS, saying WHAT the string is, WHERE the player sees it
// and any width constraint; the `battleView.ts:NNN`-style citations are copied from the English
// entry so the "where" is the same in both files. S8 exports it as the ICU `description`.
//
// FRENCH TYPOGRAPHY. The values use a REAL no-break space (U+00A0) before `:` `;` `!` `?` and
// `%`, and inside « » guillemets, so a browser never wraps a line just before the punctuation;
// the apostrophe is `’` U+2019 (never ASCII, which would also close the single-quoted value);
// the ellipsis is `…` U+2026; sentences are in sentence case WITH accented capitals (`Équipe`,
// `Élevage`, `Évolution`). Every English glyph is kept as-is — `·` U+00B7, `—` U+2014, `→`,
// `✓`, `•`, `★`, the `×` U+00D7 in `shop.sell.*` versus the ASCII `x` in `raising.*` — as are
// the TRAILING SPACE in `shop.buy.row` / `shop.sell.row` (the Buy/Sell button follows the text)
// and the LEADING ` — ` in `leaderboard.row` (the display name is a sibling `<bdi>` element, not
// a param). Keyboard key names (Esc, B, M, ?, F8, F9) stay untranslated: they name physical
// keys. Abbreviations: Lv → Niv., HP → PV, Acc → Préc., W/L → V/D, ATK/DEF/SPD → ATQ/DÉF/VIT.
// Params are MODEL DATA (affinities, weather labels, species/skill/item/player names, tiers,
// stats, counts, prices) interpolated verbatim, never catalogued (M24 §2.5); numbers are raw
// digits — no `fmtNumber` grouping (YAGNI for chrome strings, ADR-0263).

import type { Catalog } from './messageIds';
import { cldr, selectPlural } from './plural';

// French's CLDR plural category set is {one, many, other} — three live categories, so the forms
// are authored by hand through `cldr(...)` (SHAPE-06 forbids the two-category helper here).
// `one` covers BOTH 0 and 1 (« 0 tour », « 1 tour »); `other` is every other integer
// (« 2 tours »); `many` is CLDR's 10^6 case (1 000 000, 2 000 000 …), rendered with the
// partitive « de » as in « 1 000 000 de tours ». The three categories fr never selects (`zero`,
// `two`, `few`) mirror the nearest live form so the record stays total (ADR-0256 D2).
const WEATHER_TURN_FORMS = cldr({
  zero: 'tour',
  one: 'tour',
  two: 'tours',
  few: 'tours',
  many: 'de tours',
  other: 'tours',
});

export const CATALOG_FR: Catalog = Object.freeze({
  // @desc: Menu-launcher button pinned to the bottom-left of the world view, telling the player
  // how to open help and the menu. One line, at most 47 characters (fits a 320px-wide viewport).
  // index.html:143
  'chrome.helpHint': '? pour l’aide · clic ou M pour le menu',
  // @desc: Heading of the help overlay listing keyboard controls and game goals.
  // index.html:94 (resolved in HelpView show())
  'chrome.help.title': 'Commandes et objectifs',
  // @desc: Submit button of the profile-rename dialog; short verb, fits a narrow button.
  // index.html:60 (resolved in RenameView show())
  'chrome.rename.submit': 'Renommer',
  // @desc: Submit button of the trade-proposal dialog; the player offers a trade to another
  // player. Short verb, fits a narrow button.
  // index.html:80 (resolved in TradeProposeView show())
  'chrome.tradePropose.submit': 'Proposer',
  // @desc: Status-strip error shown when the browser blocked the account data-export download.
  // main.ts:582
  'chrome.status.exportBlocked': 'export des données : téléchargement bloqué par le navigateur',
  // @desc: Status-strip error shown when the player opens the privacy overlay while another
  // overlay is already open.
  // main.ts:651
  'chrome.status.privacyOverlayBusy': 'confidentialité : fermez d’abord l’autre panneau',
  // @desc: Status-strip error shown when an action failed because the connection dropped;
  // {where} is the name of the action or view that was in progress (e.g. "shop").
  // main.ts:961
  'chrome.status.disconnected': (p) => `${p.where} : déconnecté — réessayez`,
  // @desc: Status-strip error shown when the loaded game content is older than the server's and
  // the page must be reloaded.
  // main.ts:1040
  'chrome.status.contentStale': 'contenu obsolète — rechargez la page',
  // @desc: Status-strip error shown when the browser blocked the bug-report bundle download; the
  // bundle is still printed to the developer console.
  // main.ts:2442
  'chrome.status.bugBundleBlocked':
    'rapport de bogue : téléchargement bloqué — copiez-le depuis la console',
  // @desc: Status-strip error shown when the player asks to heal but no heal location is
  // available in the current zone.
  // main.ts:2524
  'chrome.status.healUnavailable': 'soins : aucun lieu de soins disponible',
  // @desc: Heading of the battle overlay; the first thing announced when a PvE or PvP battle opens.
  // One word, fits a 320px-wide column.
  // battleView.ts:110 (resolved in show())
  'battle.title': 'Combat',
  // @desc: Exit hint shown under the outcome banner once a battle has ended; "Esc" is the keyboard
  // key name and must stay recognisable as such. One short line.
  // battleView.ts:243 (resolved in show())
  'battle.continueHint': 'Appuyez sur Esc pour continuer',
  // @desc: Explainer shown in place of the swap buttons when the player has no healthy bench
  // monster in this battle; the second sentence tells them how to reach the party screen afterwards
  // ("Esc" and "B" are keyboard key names; "Équipe et Boîte" is that screen's title, box.title).
  // Two sentences, wraps freely in a 320px-wide column.
  // battleView.ts:216-218 (resolved in show())
  'battle.swap.hint':
    'Aucun monstre de l’équipe en état de combattre ne peut entrer dans ce combat. À la fin du combat, appuyez sur Esc, puis sur B pour Équipe et Boîte.',
  // @desc: PvP status banner shown after the player has submitted their move, while the opponent's
  // move is still outstanding; carries a typographic apostrophe and an ellipsis. One line.
  // battleView.ts:347
  'battle.pvp.waiting': 'En attente de l’action de l’adversaire…',
  // @desc: Field-weather banner above the two monster cards; {label} is the weather name (e.g.
  // "Pluie") and {turns} the number of turns it has left, followed by the CLDR-selected plural of
  // "tour". One centred line, about 40 characters wide.
  // battleView.ts:361
  'battle.weather.banner': (p) =>
    `${p.label} (${p.turns} ${selectPlural('fr', p.turns, WEATHER_TURN_FORMS)})`,
  // @desc: Role word prefixed to the player's own monster card header, rendered as "Vous :
  // <species>". Very short — shares one line with the species name and the level.
  // battleView.ts:291
  'battle.card.you': 'Vous',
  // @desc: Role word prefixed to the opposing monster card header, rendered as "Adversaire :
  // <species>"; in PvP the rival's display name replaces it when known. Very short — shares one
  // line with the species name and the level.
  // battleView.ts:289
  'battle.card.opponent': 'Adversaire',
  // @desc: Level badge on the right of a monster card header; {level} is the monster's level and
  // "Niv." abbreviates "Niveau". Very short — shares one line with the card's name.
  // battleView.ts:373
  'battle.card.level': (p) => `Niv.${p.level}`,
  // @desc: Small line under a monster card's health bar; {current}/{max} are hit points ("PV" =
  // points de vie) and {affinity} is the monster's elemental type name (e.g. "Feu"). One line,
  // small text.
  // battleView.ts:407
  'battle.card.hpLine': (p) => `PV ${p.current}/${p.max} · ${p.affinity}`,
  // @desc: PvP skill button: submits the move rather than using it at once, hence the leading
  // "Valider :"; {name} is the skill name, {affinity} its elemental type. Keep {affinity} LAST and
  // keep the "Valider :" prefix first (tests match the start of the text). Fits a half-width
  // button.
  // battleView.ts:443
  'battle.skill.pvpSubmit': (p) => `Valider : ${p.name} · ${p.affinity}`,
  // @desc: PvE skill button, used at once; {name} is the skill name, {power} its damage value and
  // {affinity} its elemental type. Keep {affinity} LAST (tests match the start of the text). Fits a
  // half-width button. Glyph-only in English, so identical here.
  // battleView.ts:444
  'battle.skill.pveLabel': (p) => `${p.name} (${p.power}) · ${p.affinity}`,
  // @desc: Hover tooltip on a skill button giving its hit chance; {accuracy} is a percentage and
  // "Préc." abbreviates "Précision". Very short.
  // battleView.ts:445
  'battle.skill.accuracy': (p) => `Préc. ${p.accuracy} %`,
  // @desc: Button label to run from an ongoing PvE battle. Short verb, fits a narrow button.
  // battleView.ts:470
  'battle.action.flee': 'Fuir',
  // @desc: First option of the bait selector shown in a wild battle: attempt recruitment with no
  // bait item. Short, fits a narrow dropdown.
  // battleView.ts:522
  'battle.recruit.noBait': 'Sans appât',
  // @desc: Button label to attempt recruiting the wild monster with the selected bait. Short verb,
  // fits a narrow button.
  // battleView.ts:541
  'battle.recruit.submit': 'Recruter',
  // @desc: Placeholder option of the cure-item selector before the player picks an item. Short,
  // fits a narrow dropdown.
  // battleView.ts:562
  'battle.cure.placeholder': 'Choisir un objet',
  // @desc: One option of the cure-item selector; {name} is the item name, {cureStatus} the ailment
  // it removes (e.g. "Poison") and {count} how many the player carries. One line in a narrow
  // dropdown.
  // battleView.ts:568
  'battle.cure.option': (p) => `${p.name} (soigne ${p.cureStatus}) ×${p.count}`,
  // @desc: Button label to use the selected cure item on the player's monster. Short, fits a narrow
  // button.
  // battleView.ts:580
  'battle.cure.submit': 'Utiliser l’objet',
  // @desc: PvP swap button: submits a switch to the bench monster {species} rather than swapping at
  // once. Fits a narrow button.
  // battleView.ts:601
  'battle.swap.pvpSubmit': (p) => `Valider l’échange : ${p.species}`,
  // @desc: PvE swap button: switches at once to the bench monster {species}, whose hit points are
  // {current}/{max}. Fits a narrow button.
  // battleView.ts:602
  'battle.swap.pveLabel': (p) => `Échanger : ${p.species} (${p.current}/${p.max})`,
  // @desc: Outcome banner when the player's side wins the battle. Large bold text, one or two
  // words.
  // battleView.ts:629
  'battle.outcome.victory': 'Victoire !',
  // @desc: Outcome banner when the player's side loses the battle. Large bold text, one or two
  // words.
  // battleView.ts:632
  'battle.outcome.defeat': 'Défaite…',
  // @desc: Outcome banner when the player successfully flees a wild battle. Large bold text, one
  // short phrase.
  // battleView.ts:635
  'battle.outcome.fled': 'Fuite réussie !',
  // @desc: Title of the PvP challenge overlay when the player has no incoming or outgoing
  // challenge; "PvP" is the player-versus-player abbreviation, kept as-is. One word.
  // pvpView.ts:135
  'pvp.title.idle': 'PvP',
  // @desc: Title of the PvP challenge overlay while an incoming or outgoing challenge exists. Two
  // words, one line.
  // pvpView.ts:142
  'pvp.title.challenge': 'Défi PvP',
  // @desc: Announcement in the PvP overlay that another player wants to fight; {challenger} is that
  // player's display name. One line, above the Accept/Decline buttons.
  // pvpView.ts:190
  'pvp.incoming.label': (p) => `${p.challenger} vous lance un défi !`,
  // @desc: Button label to accept an incoming PvP challenge. Short verb, fits a narrow button.
  // pvpView.ts:198
  'pvp.incoming.accept': 'Accepter',
  // @desc: Button label to decline an incoming PvP challenge. Short verb, fits a narrow button.
  // pvpView.ts:206
  'pvp.incoming.decline': 'Refuser',
  // @desc: Status line while the player's own challenge is pending; {target} is the challenged
  // player's display name; carries a spaced em dash and an ellipsis. One line, above the Cancel
  // button.
  // pvpView.ts:221
  'pvp.outgoing.label': (p) => `Défi envoyé à ${p.target} — en attente…`,
  // @desc: Button label to withdraw the challenge the player has sent. Short phrase, fits a
  // button.
  // pvpView.ts:226
  'pvp.outgoing.cancel': 'Annuler le défi',
  // @desc: Empty-state line over the challengeable-player list when nobody else is online. One
  // line.
  // pvpView.ts:241
  'pvp.players.none': 'Aucun joueur en ligne à défier',
  // @desc: Heading over the list of online players the player may challenge; each list entry below
  // it is a player's name. One word plus colon.
  // pvpView.ts:241
  'pvp.players.heading': 'Défier :',
  // @desc: Heading of the evolution overlay, listing every party monster's evolution paths.
  // One word, fits a 320px-wide column.
  // evolutionView.ts:102 (resolved in show())
  'evolution.title': 'Évolution',
  // @desc: Explainer paragraph under the evolution heading telling the player how to read the
  // path cards and that they pick a path only when several are ready at once. Two sentences,
  // wraps freely up to 700px wide.
  // evolutionView.ts:113-115 (resolved in show())
  'evolution.hint':
    'Chaque voie indique ce qu’elle exige et où en est ce monstre. Quand deux voies ou plus sont prêtes en même temps, c’est vous qui choisissez laquelle suivre.',
  // @desc: Empty-state line of the evolution overlay when the player owns no monster yet. One
  // short line.
  // evolutionView.ts:162
  'evolution.monsters.empty': 'Aucun monstre pour l’instant.',
  // @desc: Stats line under a monster's name on its evolution card; {level} is the level ("Niv."
  // abbreviates "Niveau"), {stage} the evolution stage number, {trust} the trust tier name (e.g.
  // "Dévoué"), {qualityTime} the quality-time tier number and {nutrition} a percentage. One
  // line of small text, about 60 characters wide.
  // evolutionView.ts:187-189
  'evolution.card.stats': (p) =>
    `Niv.${p.level} · Stade ${p.stage} · Confiance ${p.trust} · Temps de qualité ${p.qualityTime} · Nutrition ${p.nutrition} %`,
  // @desc: Line on a monster's evolution card when the species has no evolution path at all.
  // One short line of small text.
  // evolutionView.ts:195
  'evolution.card.noPaths': 'Aucune voie d’évolution.',
  // @desc: Informational note on a monster's card when exactly one path is ready: the server
  // evolves it automatically on the player's next action; {species} is the species it becomes.
  // One line; carries a spaced em dash.
  // evolutionView.ts:207
  'evolution.card.ready': (p) => `Prêt — évoluera en ${p.species} à votre prochaine action.`,
  // @desc: Prompt above the choice buttons when two or more paths are ready and the player must
  // pick one; ends with a colon because the buttons follow. One line; carries a spaced em dash.
  // evolutionView.ts:215
  'evolution.card.choosePrompt': 'Deux voies ou plus sont prêtes — choisissez-en une :',
  // @desc: Heading of one evolution path row; {species} is the species this path leads to and
  // the leading arrow means "evolves into". Glyph-only, so identical to English. Very short.
  // evolutionView.ts:242
  'evolution.path.heading': (p) => `→ ${p.species}`,
  // @desc: Status line of an evolution path row when every requirement is satisfied (the
  // unsatisfied case shows a model-supplied reason instead). One short line of small text.
  // evolutionView.ts:248
  'evolution.path.allMet': 'Toutes les conditions sont remplies.',
  // @desc: One requirement row of an evolution path that IS satisfied: a check mark, then
  // {label} (the requirement name, e.g. "Niveau"), the monster's {current} value and the
  // {required} value. Same shape as evolution.gate.unmetRow with a different leading mark. One
  // line of small text.
  // evolutionView.ts:264
  'evolution.gate.metRow': (p) => `✓ ${p.label} : ${p.current} / ${p.required}`,
  // @desc: One requirement row of an evolution path that is NOT yet satisfied: a bullet, then
  // {label} (the requirement name), the monster's {current} value and the {required} value. Same
  // shape as evolution.gate.metRow with a different leading mark. One line of small text.
  // evolutionView.ts:264
  'evolution.gate.unmetRow': (p) => `• ${p.label} : ${p.current} / ${p.required}`,
  // @desc: Button label to choose one of several ready evolution paths; {species} is the species
  // the monster becomes. Fits a narrow button.
  // evolutionView.ts:272
  'evolution.choice.evolve': (p) => `Faire évoluer en ${p.species}`,
  // @desc: Heading of the raising overlay, which shows the party monsters' stats with Care/Train
  // buttons and the player's inventory. One short line.
  // raisingView.ts:104 (resolved in show())
  'raising.title': 'Élevage et inventaire',
  // @desc: Section heading above the monster cards in the raising overlay. One word.
  // raisingView.ts:124 (resolved in show())
  'raising.monsters.heading': 'Monstres',
  // @desc: Section heading above the item cards in the raising overlay. One word.
  // raisingView.ts:134 (resolved in show())
  'raising.inventory.heading': 'Inventaire',
  // @desc: Empty-state line of the raising overlay's monster section when the player owns no
  // monster. One short line.
  // raisingView.ts:193
  'raising.monsters.empty': 'Aucun monstre.',
  // @desc: Status line under a monster's name on its raising card; {level} is the level ("Niv."
  // abbreviates "Niveau"), {trust} the trust tier name (e.g. "Amical") and {current}/{max} its
  // hit points. One line of small text.
  // raisingView.ts:209
  'raising.card.status': (p) => `Niv.${p.level} · Confiance ${p.trust} · PV ${p.current}/${p.max}`,
  // @desc: Battle-stat line on a monster's raising card; the five numbers are {attack},
  // {defense}, {speed}, {spAttack} (special attack) and {spDefense} (special defense), each
  // prefixed by its French abbreviation. One line of small text, about 55 characters wide.
  // raisingView.ts:214-216
  'raising.card.stats': (p) =>
    `ATQ ${p.attack} · DÉF ${p.defense} · VIT ${p.speed} · ATQ SPÉ ${p.spAttack} · DÉF SPÉ ${p.spDefense}`,
  // @desc: Button label to care for (tend to) a monster, raising its trust. Short verb, fits a
  // very narrow button.
  // raisingView.ts:224
  'raising.card.care': 'Choyer',
  // @desc: Button label to feed a training item to a monster; {name} is the item name and
  // {count} how many the player carries (the "x" is a plain letter x, not a multiplication
  // sign). Fits a narrow button.
  // raisingView.ts:269
  'raising.card.train': (p) => `Entraîner : ${p.name} (x${p.count})`,
  // @desc: Empty-state line of the raising overlay's inventory section when the player carries
  // nothing. One short line.
  // raisingView.ts:308
  'raising.inventory.empty': 'Aucun objet.',
  // @desc: Name line of an inventory card; {name} is the item name and {count} how many the
  // player carries (the "x" is a plain letter x). Glyph-only, so identical to English. Bold, one
  // line.
  // raisingView.ts:318
  'raising.inventory.item': (p) => `${p.name} (x${p.count})`,
  // @desc: Heading of the party & box overlay, where the player arranges which monsters are in
  // the active party and which stay in storage; quoted inside battle.swap.hint. One short line.
  // boxView.ts:69 (resolved in show())
  'box.title': 'Équipe et Boîte',
  // @desc: Button beside the party & box heading that fully heals every party monster. Short
  // phrase, fits a narrow button.
  // boxView.ts:79 (resolved in show())
  'box.heal': 'Soigner l’équipe',
  // @desc: Explainer under the heading telling the player that only Party monsters battle and
  // that new recruits land in the Box; the quoted « Vers l’équipe » must match the
  // box.card.toParty button label exactly. Two sentences, wraps freely up to 600px wide; carries
  // a spaced em dash.
  // boxView.ts:94-96 (resolved in show())
  'box.hint':
    'Seuls les monstres de votre Équipe peuvent combattre ou entrer en combat. Les nouvelles recrues arrivent dans votre Boîte — chaque monstre de la boîte a un bouton « Vers l’équipe » qui le déplace dans un emplacement libre de l’équipe.',
  // @desc: Section heading above the six party slots. One word.
  // boxView.ts:101 (resolved in show())
  'box.section.party': 'Équipe',
  // @desc: Section heading above the stored (box) monsters. One word.
  // boxView.ts:111 (resolved in show())
  'box.section.box': 'Boîte',
  // @desc: Placeholder text of an unoccupied party slot; {slot} is the slot index as shown today
  // (counted from 0). One short line, dimmed.
  // boxView.ts:160
  'box.party.emptySlot': (p) => `Emplacement ${p.slot} : (vide)`,
  // @desc: Empty-state line of the box section when no monster is in storage. One short line,
  // dimmed.
  // boxView.ts:173
  'box.box.empty': 'Aucun monstre dans la boîte.',
  // @desc: Small button on a monster card that opens the nickname prompt. Short verb, fits a
  // very narrow button.
  // boxView.ts:197
  'box.card.rename': 'Renommer',
  // @desc: Info line on a monster card in the party or box; {species} is the species name,
  // {level} the level ("Niv." abbreviates "Niveau"), {current}/{max} its hit points and
  // {percent} the same as a percentage. Keep the "PV {current}/{max}" shape. One line of small
  // text.
  // boxView.ts:205
  'box.card.stats': (p) =>
    `${p.species} · Niv.${p.level} · PV ${p.current}/${p.max} (${p.percent} %)`,
  // @desc: Badge on a monster card when the monster can evolve but the player must choose a path
  // on the evolution screen first. One short line; carries a leading star and a spaced em dash.
  // boxView.ts:216
  'box.card.evolveBadge': '★ Prêt à évoluer — choisissez une voie',
  // @desc: Button on a party monster's card that moves it into the box (storage). Short phrase,
  // fits a very narrow button.
  // boxView.ts:227
  'box.card.toBox': 'Vers la boîte',
  // @desc: Button on a box monster's card that moves it into an open party slot; quoted verbatim
  // inside box.hint, so the two must stay identical. Short phrase, fits a very narrow button.
  // boxView.ts:235
  'box.card.toParty': 'Vers l’équipe',
  // @desc: Label of the browser's text-input prompt dialog asking for a monster's new nickname;
  // the current name is pre-filled. Short, ends with a colon.
  // boxView.ts:248 (prompt() argument)
  'box.rename.prompt': 'Nouveau surnom :',
  // @desc: Status line of the trade overlay when the player is in no trade. One short line.
  // tradeView.ts:93
  'trade.status.none': 'Aucun échange en cours',
  // @desc: Heading of the trade overlay's left column listing what the player gives away. Two
  // words, one line.
  // tradeView.ts:111 (#renderSide heading argument)
  'trade.side.offer': 'Vous donnez',
  // @desc: Heading of the trade overlay's right column listing what the player gets. Two words,
  // one line.
  // tradeView.ts:112 (#renderSide heading argument)
  'trade.side.receive': 'Vous recevez',
  // @desc: One monster row on a trade side; {nickname} is the monster's nickname, {species} its
  // species name, {level} its level ("Niv." abbreviates "Niveau") and {current}/{max} its hit
  // points ("PV"). One line.
  // tradeView.ts:133
  'trade.side.card': (p) =>
    `${p.nickname} (${p.species}) Niv.${p.level} PV : ${p.current}/${p.max}`,
  // @desc: Currency row on a trade side; {amount} is the number of gold coins offered and "or"
  // is the currency name (gold). Very short, one line.
  // tradeView.ts:153
  'trade.side.currency': (p) => `${p.amount} or`,
  // @desc: Placeholder row on a trade side that offers no monster, item or gold. One word in
  // parentheses.
  // tradeView.ts:159
  'trade.side.nothing': '(rien)',
  // @desc: Button label to accept the trade offered to the player. Short verb, fits a narrow
  // button.
  // tradeView.ts:193 (#actionLabel return)
  'trade.action.accept': 'Accepter',
  // @desc: Button label to reject the trade offered to the player. Short verb, fits a narrow
  // button.
  // tradeView.ts:195 (#actionLabel return)
  'trade.action.reject': 'Refuser',
  // @desc: Button label for the second confirmation step that completes an accepted trade. Short
  // phrase, fits a button.
  // tradeView.ts:197 (#actionLabel return)
  'trade.action.confirm': 'Confirmer l’échange',
  // @desc: Button label to withdraw from a trade the player proposed or accepted. Short verb,
  // fits a narrow button.
  // tradeView.ts:199 (#actionLabel return)
  'trade.action.cancel': 'Annuler',
  // @desc: Fallback heading of the shop overlay when no shop is nearby (a real shop shows its
  // own name instead). One word.
  // shopView.ts:124
  'shop.title': 'Boutique',
  // @desc: Only row of the for-sale list when the player is not standing at a shop. One short
  // line.
  // shopView.ts:125
  'shop.noShop': 'Aucune boutique disponible.',
  // @desc: Only row of the for-sale list when the shop stocks nothing. One short line.
  // shopView.ts:136
  'shop.forSale.empty': 'Rien à vendre.',
  // @desc: Only row of the sell list when the player carries nothing a shop would take. One
  // short line.
  // shopView.ts:144
  'shop.inventory.empty': 'Aucun objet à vendre.',
  // @desc: Text of one for-sale row, followed on the same line by the Buy button; {name} is the
  // item name and {price} its cost in gold ("or"). Carries a spaced em dash and MUST END WITH A
  // SPACE — it separates the text from the button. One line.
  // shopView.ts:155
  'shop.buy.row': (p) => `${p.name} — ${p.price} or `,
  // @desc: Button label to buy one unit of the item in its row. Short verb, fits a very narrow
  // button.
  // shopView.ts:157
  'shop.buy.submit': 'Acheter',
  // @desc: Text of one sellable inventory row, followed on the same line by the Sell button;
  // {name} is the item name, {count} how many the player carries (after a multiplication sign)
  // and {price} what the shop pays in gold ("or"). Carries a spaced em dash and MUST END WITH A
  // SPACE — it separates the text from the button. One line.
  // shopView.ts:175
  'shop.sell.row': (p) => `${p.name} (×${p.count}) — ${p.price} or `,
  // @desc: Button label to sell one unit of the item in its row. Short verb, fits a very narrow
  // button.
  // shopView.ts:177
  'shop.sell.submit': 'Vendre',
  // @desc: Text of one inventory row for an item the shop will not buy (no button follows);
  // {name} is the item name and {count} how many the player carries (after a multiplication
  // sign). Carries a spaced em dash. One line.
  // shopView.ts:190
  'shop.sell.unsellable': (p) => `${p.name} (×${p.count}) — Invendable`,
  // @desc: Placeholder option of the trade-proposal dialog's target selector, shown before the
  // player picks another player to trade with; ends with an ellipsis. Short, fits a narrow
  // dropdown.
  // tradeProposeView.ts:168
  'tradePropose.target.placeholder': 'Choisir un joueur…',
  // @desc: Button in the NPC dialogue overlay that opens the shop this NPC runs; shown only when
  // the NPC has one. One word, fits a narrow button.
  // dialogueView.ts:72
  'dialogue.action.shop': 'Boutique',
  // @desc: Button on the guest-claim overlay that opens the privacy & account-data surface
  // (account deletion, data export). Same French as privacy.title today, but a different key:
  // this is a BUTTON label. One short line.
  // claimView.ts:96 (resolved in show() and render())
  'claim.privacyButton': 'Confidentialité et données du compte',
  // @desc: Only row of the ranked leaderboard when no player has a rating yet (ratings exist
  // only after a decisive ranked battle). One short line.
  // leaderboardView.ts:60
  'leaderboard.empty': 'Aucun joueur classé pour l’instant',
  // @desc: Text that FOLLOWS a player's name on one leaderboard row: {rating} is the ranked
  // rating number, {wins}/{losses} the win and loss counts ("V" = victoires, "D" = défaites).
  // MUST START WITH A SPACE and a spaced em dash — the name is rendered just before this text in
  // its own element and is not a placeholder. One line.
  // leaderboardView.ts:69
  'leaderboard.row': (p) => ` — ${p.rating} (V${p.wins}/D${p.losses})`,
  // @desc: Footer of the diagnostic error overlay naming its two keyboard shortcuts: F8 closes
  // it, F9 downloads a bug report; "F8"/"F9" are key names. One short line, small text.
  // errorOverlayView.ts:81 (resolved in show())
  'errorOverlay.footer': 'F8 fermer · F9 rapport de bogue',
  // @desc: One row of the quest log; {name} is the quest's content identifier (e.g.
  // "quest_001", not player text) and {step} the current step number counted from 0. One line.
  // questLogView.ts:45
  'questLog.entry': (p) => `${p.name} (étape ${p.step})`,
  // @desc: One row of the heal overlay offering a heal at this location; {cost} is the price
  // text the heal model produces (e.g. "Gratuit" or "25 or"). One short line.
  // healView.ts:47
  'heal.location': (p) => `Se soigner ici (${p.cost})`,
  // @desc: Heading of the privacy & account-data overlay (account deletion, data export). Same
  // French as claim.privacyButton today, but a different key: this is a HEADING. One short line.
  // privacyView.ts:145 (resolved in show())
  'privacy.title': 'Confidentialité et données du compte',
  // @desc: Button that closes the privacy & account-data overlay; it is the first control and
  // always enabled. Short verb, fits a very narrow button.
  // privacyView.ts:151 (resolved in show())
  'privacy.close': 'Fermer',
  // @desc: Second-step button that confirms the player's account deletion request, shown only
  // after they asked to delete. Short phrase, fits a narrow button.
  // privacyView.ts:187 (#paintButton label argument)
  'privacy.confirm.delete': 'Confirmer la suppression',
  // @desc: Second-step button that backs out of a pending account deletion request, shown
  // beside privacy.confirm.delete. Short phrase, fits a narrow button.
  // privacyView.ts:188 (#paintButton label argument)
  'privacy.confirm.keep': 'Garder mon compte',
  // @desc: Dismiss button of the small evolution-reveal banner near the bottom of the screen.
  // Very short — one or two characters wide; "OK" is the same in French.
  // evolutionNotice.ts:209 (resolved in render())
  'evolutionNotice.ok': 'OK',
  // @desc: Stand-in for a species name that has not loaded yet; {id} is the numeric species
  // id after the French "n°" (numéro) abbreviation. Used inside the evolution-reveal sentences.
  // Very short.
  // evolutionNotice.ts:71 (speciesLabel return)
  'evolutionNotice.species.fallback': (p) => `Espèce n° ${p.id}`,
  // @desc: Evolution-reveal sentence for a monster the player nicknamed; {nickname} is that
  // nickname, {from} the previous species name and {to} the new one. One line in a small
  // banner.
  // evolutionNotice.ts:93 (evolutionNoticeLabel return)
  'evolutionNotice.reveal.nicknamed': (p) => `${p.nickname} a évolué de ${p.from} en ${p.to} !`,
  // @desc: Evolution-reveal sentence for a monster with no nickname; {from} is the previous
  // species name and {to} the new one. One line in a small banner.
  // evolutionNotice.ts:95 (evolutionNoticeLabel return)
  'evolutionNotice.reveal.anonymous': (p) => `Votre ${p.from} a évolué en ${p.to} !`,
} satisfies Catalog);
