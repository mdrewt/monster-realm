// ui/i18n/catalog.fr.ts — the French catalog, the M24 PROOF LOCALE.
//
// WHY THIS FILE EXISTS. `fr` is the second registered locale: it proves, at runtime and under
// the §5.3 parity gate (catalogParity.test.ts), that the resolver/catalog resolver/catalog seam
// carries a real translation — every `MessageId` resolves, every closure reads exactly the
// same param fields as its English twin, and the first CLDR plural (`battle.weather.banner`)
// selects through `selectPlural` rather than an `n === 1` branch. It mirrors catalog.en.ts
// ENTRY FOR ENTRY, IN THE SAME ORDER, so a side-by-side diff of the two files lines up.
//
// ONE ENTRY PER `MessageId`, and the type makes that total: `satisfies Catalog` is load-bearing
// — `Object.freeze<T>` is generic, so without it a stowaway key would be swallowed
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
// digits — no `fmtNumber` grouping (YAGNI for chrome strings).

import type { Catalog } from './messageIds';
import { cldr, selectPlural } from './plural';

// French's CLDR plural category set is {one, many, other} — three live categories, so the forms
// are authored by hand through `cldr(...)` (SHAPE-06 forbids the two-category helper here).
// `one` covers BOTH 0 and 1 (« 0 tour », « 1 tour »); `other` is every other integer
// (« 2 tours »); `many` is CLDR's 10^6 case (1 000 000, 2 000 000 …), rendered with the
// partitive « de » as in « 1 000 000 de tours ». The three categories fr never selects (`zero`,
// `two`, `few`) mirror the nearest live form so the record stays total.
const WEATHER_TURN_FORMS = cldr({
  zero: 'tour',
  one: 'tour',
  two: 'tours',
  few: 'tours',
  many: 'de tours',
  other: 'tours',
});

export const CATALOG_FR: Catalog = Object.freeze({
  // @desc: Verb on the Start button chip in the hint bar at the bottom of the game screen; the
  // button name "Start" is drawn beside it. One short word (at most 12 characters).
  // index.html #chip-start (painted by hintBar.ts from hintBarModel.ts)
  'chrome.chip.menu': 'Menu',
  // @desc: Verb on the Select button chip in the hint bar at the bottom of the game screen; the
  // button name "Select" is drawn beside it. Opens the help screen. One short word (at most 12
  // characters). index.html #chip-select (painted by hintBar.ts)
  'chrome.chip.help': 'Aide',
  // @desc: Hint-bar chip verb for A inside a sheet or a frame: confirm the highlighted item. One
  // short word (at most 12 characters). hintBarModel.ts (#hint-bar)
  'chrome.chip.ok': 'OK',
  // @desc: Hint-bar chip verb for B inside a sheet or a frame: go back one level. One short word
  // (at most 12 characters). hintBarModel.ts (#hint-bar)
  'chrome.chip.back': 'Retour',
  // @desc: Hint-bar chip verb for Start while a frame is open: close every frame. One short word
  // (at most 12 characters). hintBarModel.ts (#hint-bar)
  'chrome.chip.close': 'Fermer',
  // @desc: Hint-bar chip verb for Y in the world while a trade or challenge request waits: open
  // that request's Accept / Decline / View sheet. One short word. hintBarModel.ts (#hint-bar)
  'chrome.chip.view': 'Voir',
  // @desc: Hint-bar chip verb for B in the world while a notice shows: hide the newest notice (the
  // error toast or the request banner). One short word. hintBarModel.ts (#hint-bar)
  'chrome.chip.dismiss': 'Masquer',
  // @desc: Hint-bar chip verb for Start while typing in a text field: stop typing. One short
  // word. hintBarModel.ts (#hint-bar)
  'chrome.chip.done': 'Terminé',
  // @desc: Badge beside the Start chip and the Social menu row while a trade or challenge request
  // waits for an answer. One short word. hintBar.ts, menuModel.ts
  'chrome.badge.request': 'Nouveau',
  // @desc: Row of the world request sheet: accept the waiting trade or challenge. main.ts
  // (#interact-prompt rows)
  'notice.sheet.accept': 'Accepter',
  // @desc: Row of the world request sheet: decline the waiting trade or challenge. main.ts
  // (#interact-prompt rows)
  'notice.sheet.decline': 'Refuser',
  // @desc: Row of the world request sheet: open Social on the request's tab. main.ts
  // (#interact-prompt rows)
  'notice.sheet.view': 'Voir',
  // @desc: The request banner and sheet heading for an incoming trade; {name} is the other
  // player's display name (player text). Names no key. main.ts (#notice-banner)
  'notice.request.trade': (p) => `${p.name} veut échanger`,
  // @desc: The request banner and sheet heading for an incoming PvP challenge; {name} is the
  // challenger's display name (player text). Names no key. main.ts (#notice-banner)
  'notice.request.challenge': (p) => `${p.name} vous défie en combat`,
  // @desc: The world interaction chip above what the character faces: {key} is the A button's
  // keycap, {verb} a resolved interact.verb.* word, {name} the npc id or the healer name. main.ts
  // (#interact-prompt)
  'interact.chip': (p) => `[${p.key}] ${p.verb} — ${p.name}`,
  // @desc: The world interaction chip when A would open a picker of several things to act on; {key}
  // is the A button's keycap. main.ts (#interact-prompt)
  'interact.choose': (p) => `[${p.key}] Choisir…`,
  // @desc: One row of the world picker / action sheet: {verb} a resolved interact.verb.* word,
  // {name} the npc id or the healer name. main.ts (#interact-prompt rows)
  'interact.entry': (p) => `${p.verb} — ${p.name}`,
  // @desc: Verb in the world interaction chip and picker for talking to a character. One short
  // word. main.ts
  'interact.verb.talk': 'Parler',
  // @desc: Verb in the world interaction chip and picker for opening a shopkeeper's shop. One short
  // word. main.ts
  'interact.verb.shop': 'Boutique',
  // @desc: Verb in the world interaction chip and picker for healing the party at a healer. One
  // short word. main.ts
  'interact.verb.heal': 'Soigner',
  // @desc: Verb in the world picker for proposing a trade to the player the character faces. One
  // short word. main.ts
  'interact.verb.trade': 'Échanger',
  // @desc: Verb in the world picker for challenging the player the character faces to a PvP
  // battle. One short word. main.ts
  'interact.verb.challenge': 'Défier',
  // @desc: The Yes / No question asked before a challenge is sent to the faced player; {name} is
  // that player's display name. main.ts (#interact-prompt)
  'interact.confirm.challenge': (p) => `Défier ${p.name} ?`,
  // @desc: Name shown for a heal location in the world interaction chip and picker. One short word.
  // main.ts
  'interact.healer': 'Guérisseur',
  // @desc: Keycap label of the Enter key, drawn in square brackets in the world interaction chip.
  // One short word. main.ts
  'key.enter': 'Entrée',
  // @desc: Keycap label of the numeric keypad's Enter key, drawn in square brackets on hint chips.
  // One short word or two. input/glyphs.ts
  'key.numpadEnter': 'Entrée (pavé)',
  // @desc: Keycap label of the Backspace key (the B button by default), drawn in square brackets on
  // hint chips. A symbol or one short word. input/glyphs.ts
  'key.backspace': '⌫',
  // @desc: Keycap label of the space bar, drawn in square brackets on hint chips. One short word.
  // input/glyphs.ts
  'key.space': 'Espace',
  // @desc: Keycap label of the Escape key (the Start button by default), drawn in square brackets on
  // hint chips. One short word, abbreviated as printed on keyboards. input/glyphs.ts
  'key.escape': 'Échap',
  // @desc: Keycap label of the up arrow key, drawn in square brackets on hint chips. Keep the arrow
  // symbol. input/glyphs.ts
  'key.arrowUp': '↑',
  // @desc: Keycap label of the down arrow key, drawn in square brackets on hint chips. Keep the
  // arrow symbol. input/glyphs.ts
  'key.arrowDown': '↓',
  // @desc: Keycap label of the left arrow key, drawn in square brackets on hint chips. Keep the
  // arrow symbol. input/glyphs.ts
  'key.arrowLeft': '←',
  // @desc: Keycap label of the right arrow key, drawn in square brackets on hint chips. Keep the
  // arrow symbol. input/glyphs.ts
  'key.arrowRight': '→',
  // @desc: Keycap label of the Page Up key, abbreviated as printed on keyboards, drawn in square
  // brackets on hint chips. input/glyphs.ts
  'key.pageUp': 'Pg préc',
  // @desc: Keycap label of the Page Down key, abbreviated as printed on keyboards, drawn in square
  // brackets on hint chips. input/glyphs.ts
  'key.pageDown': 'Pg suiv',
  // @desc: Keycap label of the slash key (US layout position), shown until the player's own layout
  // has been learned from a press. input/glyphs.ts
  'key.slash': '/',
  // @desc: Keycap label of a numeric keypad digit key; {key} is the digit. Must differ from the bare
  // digit key. input/glyphs.ts
  'key.numpad': (p) => `Pavé ${p.key}`,
  // @desc: Name of the D-pad Up button in Options › Controls (a row label). One short word.
  // ui/controlsModel.ts
  'controls.button.up': 'Haut',
  // @desc: Name of the D-pad Down button in Options › Controls (a row label). One short word.
  // ui/controlsModel.ts
  'controls.button.down': 'Bas',
  // @desc: Name of the D-pad Left button in Options › Controls (a row label). One short word.
  // ui/controlsModel.ts
  'controls.button.left': 'Gauche',
  // @desc: Name of the D-pad Right button in Options › Controls (a row label). One short word.
  // ui/controlsModel.ts
  'controls.button.right': 'Droite',
  // @desc: Name of the A button (confirm / interact) in Options › Controls; keep the button letter
  // in parentheses. ui/controlsModel.ts
  'controls.button.a': 'Valider (A)',
  // @desc: Name of the B button (back / cancel) in Options › Controls; keep the button letter in
  // parentheses. ui/controlsModel.ts
  'controls.button.b': 'Retour (B)',
  // @desc: Name of the X button (jump) in Options › Controls; keep the button letter in parentheses.
  // ui/controlsModel.ts
  'controls.button.x': 'Saut (X)',
  // @desc: Name of the Y button (more / info) in Options › Controls; keep the button letter in
  // parentheses. ui/controlsModel.ts
  'controls.button.y': 'Infos (Y)',
  // @desc: Name of the LB button (previous tab) in Options › Controls; keep the button name in
  // parentheses. ui/controlsModel.ts
  'controls.button.lb': 'Onglet précédent (LB)',
  // @desc: Name of the RB button (next tab) in Options › Controls; keep the button name in
  // parentheses. ui/controlsModel.ts
  'controls.button.rb': 'Onglet suivant (RB)',
  // @desc: Name of the Start button (opens the main menu) in Options › Controls; keep the button
  // name in parentheses. ui/controlsModel.ts
  'controls.button.start': 'Menu (Start)',
  // @desc: Name of the Select button (opens help) in Options › Controls; keep the button name in
  // parentheses. ui/controlsModel.ts
  'controls.button.select': 'Aide (Select)',
  // @desc: Name of the shortcut that opens Monsters › Storage, a row of the Shortcuts tab in Options
  // › Controls. One short word. ui/controlsModel.ts
  'controls.accel.storage': 'Stockage',
  // @desc: Name of the shortcut that opens the Bag, a row of the Shortcuts tab in Options ›
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.bag': 'Sac',
  // @desc: Name of the shortcut that opens Monsters › Party, a row of the Shortcuts tab in Options ›
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.party': 'Équipe',
  // @desc: Name of the shortcut that opens the Journal, a row of the Shortcuts tab in Options ›
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.journal': 'Journal',
  // @desc: Name of the shortcut that opens Social › Trades, a row of the Shortcuts tab in Options ›
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.trades': 'Échanges',
  // @desc: Name of the shortcut that opens Social › Challenges, a row of the Shortcuts tab in
  // Options › Controls. One short word. ui/controlsModel.ts
  'controls.accel.challenges': 'Défis',
  // @desc: Name of the shortcut that opens Social › Rankings, a row of the Shortcuts tab in Options
  // › Controls. One short word. ui/controlsModel.ts
  'controls.accel.rankings': 'Classement',
  // @desc: Name of the shortcut that opens Profile › Name, a row of the Shortcuts tab in Options ›
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.name': 'Nom',
  // @desc: Name of the shortcut that opens Profile › Account, a row of the Shortcuts tab in Options
  // › Controls. One short word. ui/controlsModel.ts
  'controls.accel.account': 'Compte',
  // @desc: Name of the shortcut that saves the local bug-report bundle, a row of the Shortcuts tab
  // in Options › Controls. ui/controlsModel.ts
  'controls.accel.bugReport': 'Enregistrer un rapport de bug',
  // @desc: Name of the shortcut that dismisses the error notice, a row of the Shortcuts tab in
  // Options › Controls. ui/controlsModel.ts
  'controls.accel.dismissError': 'Fermer l’erreur',
  // @desc: Line shown in Options › Controls while a slot waits for a key press; {label} is the row
  // name (e.g. Confirm (A)). ui/controlsModel.ts
  'controls.capture.prompt': (p) => `Appuyez sur une touche pour : ${p.label}…`,
  // @desc: Feedback line in Options › Controls when the pressed key is reserved (Tab, F5, F11, F12,
  // a modifier or a Ctrl/Alt/Meta chord). One sentence. ui/controlsModel.ts
  'controls.refused.reserved':
    'Cette touche appartient au navigateur et ne peut pas être attribuée.',
  // @desc: Feedback line in Options › Controls when a change would leave a protected button (D-pad,
  // A, B, Start) with no key. One sentence. ui/controlsModel.ts
  'controls.refused.protected':
    'Les déplacements, Valider, Retour et Menu doivent toujours garder une touche.',
  // @desc: Feedback line in Options › Controls when key capture ends without a change. One or two
  // words. ui/controlsModel.ts
  'controls.cancelled': 'Inchangé.',
  // @desc: Feedback line in Options › Controls when a free key has been bound. One or two words.
  // ui/controlsModel.ts
  'controls.bound': 'Enregistré.',
  // @desc: Feedback line in Options › Controls when the pressed key was bound elsewhere and the two
  // bindings swapped; {key}/{otherKey} are keycaps, {label}/{otherLabel} row names.
  // ui/controlsModel.ts
  'controls.swapped': (p) =>
    `Échangé : ${p.key} est maintenant ${p.label}, ${p.otherKey} est maintenant ${p.otherLabel}`,
  // @desc: Feedback line in Options › Controls when the pressed key moved from another row into an
  // empty slot, leaving that row without a key; {key} is a keycap, {label}/{otherLabel} row names.
  // ui/controlsModel.ts
  'controls.swappedUnbound': (p) =>
    `Échangé : ${p.key} est maintenant ${p.label}, ${p.otherLabel} n’a plus de touche`,
  // @desc: Feedback line in Options › Controls when a row's Primary and Alt keys traded places;
  // {key}/{otherKey} are keycaps, {label} the row name. ui/controlsModel.ts
  'controls.swappedSlots': (p) => `Échangé : ${p.key} et ${p.otherKey} pour ${p.label}`,
  // @desc: Heading of the Options › Controls screen (key remapping). ui/controlsView.ts
  'controls.title': 'Commandes',
  // @desc: Tab of Options › Controls listing the twelve virtual buttons. ui/controlsView.ts
  'controls.tab.buttons': 'Boutons',
  // @desc: Tab of Options › Controls listing the optional shortcut keys. ui/controlsView.ts
  'controls.tab.shortcuts': 'Raccourcis',
  // @desc: A row's Primary key cell in Options › Controls; {label} is the row name
  // (e.g. Confirm (A)), {key} its keycap or the no-key mark. ui/controlsView.ts
  'controls.slot.primary': (p) => `${p.label} : ${p.key}`,
  // @desc: A row's Alt (second) key cell in Options › Controls; {label} is the row name, {key}
  // its keycap or the no-key mark. ui/controlsView.ts
  'controls.slot.alt': (p) => `${p.label} (alt.) : ${p.key}`,
  // @desc: Mark shown in an Options › Controls key cell that holds no key. ui/controlsView.ts
  'controls.slot.none': '—',
  // @desc: Cell on a shortcut row of Options › Controls that removes the shortcut's keys; {label}
  // is the row name. ui/controlsView.ts
  'controls.clear': (p) => `Effacer ${p.label}`,
  // @desc: Feedback line in Options › Controls after a shortcut's keys were removed; {label} is
  // the row name. One sentence. ui/controlsView.ts
  'controls.cleared': (p) => `${p.label} n’a plus de touche.`,
  // @desc: Last row of each Options › Controls tab: restore every default key. ui/controlsView.ts
  'controls.resetAll': 'Tout réinitialiser',
  // @desc: Yes / No question asked before Options › Controls restores every default key.
  // ui/controlsView.ts
  'controls.reset.question': 'Réinitialiser toutes les commandes ?',
  // @desc: Feedback line in Options › Controls after every default key was restored. One
  // sentence. ui/controlsView.ts
  'controls.reset.done': 'Toutes les commandes ont repris leur valeur par défaut.',
  // @desc: Button shown in Options › Controls while a slot waits for a key press; it ends the
  // wait with nothing changed. One word. ui/controlsView.ts
  'controls.cancel': 'Annuler',
  // @desc: Appended to an Options › Controls feedback line when the browser refused to store
  // the new keys: they work now and are lost on reload. One sentence. ui/controlsView.ts
  'controls.saveFailed': 'Enregistrement impossible : ce réglage dure jusqu’au rechargement.',
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
  // @desc: Status-strip error shown when the player moves a monster from the box to the party
  // but every party slot is taken; nothing is moved.
  'chrome.status.partyFull': 'équipe complète — placez d’abord un monstre dans la boîte',
  // @desc: Feedback line inside an overlay (shop, trade, trade offer, rename, care, session) when
  // the player acted while the connection was down, so nothing was sent. Same wording as
  // chrome.status.disconnected without its {where} prefix.
  // careAction.ts:72 (performCare, for care + main.ts's 8 overlay-feedback sites), sessionModel.ts:31
  'chrome.feedback.disconnected': 'déconnecté — réessayez',
  // @desc: Feedback line in the profile-rename dialog after the new display name was saved.
  // main.ts:2801
  'chrome.rename.updated': 'Nom mis à jour !',
  // @desc: Heading of the session overlay shown when the player's sign-in has expired.
  // sessionModel.ts:124
  'chrome.session.expired.title': 'Session expirée',
  // @desc: Body text of the session-expired overlay; offers signing in again or continuing as a guest
  // on this device.
  // sessionModel.ts:125
  'chrome.session.expired.body':
    'Votre connexion a expiré. Reconnectez-vous pour continuer à sauvegarder votre progression sur tous vos appareils, ou continuez en tant qu’invité sur celui-ci.',
  // @desc: Heading of the session overlay shown when the sign-in service cannot be reached.
  // sessionModel.ts:127
  'chrome.session.unreachable.title': 'Service de connexion indisponible',
  // @desc: Body text of the sign-in-unavailable overlay; reassures the player and offers continuing as
  // a guest meanwhile.
  // sessionModel.ts:128
  'chrome.session.unreachable.body':
    'Impossible de joindre le service de connexion. Votre compte est en sécurité — le jeu réessaie en arrière-plan, ou vous pouvez continuer en tant qu’invité pour l’instant.',
  // @desc: Button on the session overlay that starts continuing as a guest (a confirmation step
  // follows). Short, fits a button.
  // sessionModel.ts:130
  'chrome.session.continue': 'Continuer en tant qu’invité',
  // @desc: Confirmation question on the session overlay; must name the irreversible consequence
  // (the account session on this tab is given up) before the player confirms.
  // sessionModel.ts:133
  'chrome.session.confirmPrompt':
    'Continuer en tant qu’invité abandonne la session de ce compte dans cet onglet, sans retour possible. Continuer en tant qu’invité ?',
  // @desc: Button on the session overlay that tries signing in again; the default action, so it is
  // focused when the overlay opens. One short word, fits a button.
  // sessionModel.ts (buildSessionViewModel)
  'session.retry': 'Réessayer',
  // @desc: Line at the foot of the session overlay; says the B and Start buttons do nothing while it
  // is up, and names the keys that move between its buttons and choose one.
  // sessionModel.ts (buildSessionViewModel)
  'session.hint': 'B et Start sont sans effet ici. Tab pour naviguer, Entrée pour choisir.',
  // @desc: Heading of the battle overlay; the first thing announced when a PvE or PvP battle opens.
  // One word, fits a 320px-wide column.
  // battleView.ts:110 (resolved in show())
  'battle.title': 'Combat',
  // @desc: Exit hint shown under the outcome banner once a battle has ended; "Enter" and "Esc" are
  // keyboard key names and must stay recognisable as such. One short line.
  // battleView.ts:243 (resolved in show())
  'battle.continueHint': 'Appuyez sur Entrée ou Esc pour continuer',
  // @desc: Explainer shown in place of the swap buttons when the player has no healthy bench
  // monster in this battle; the second sentence tells them how to reach the party screen afterwards
  // ("Esc" and "B" are keyboard key names; "Équipe et boîte" is that screen's title, box.title).
  // Two sentences, wraps freely in a 320px-wide column.
  // battleView.ts:216-218 (resolved in show())
  'battle.swap.hint':
    'Aucun monstre de l’équipe en état de combattre ne peut entrer dans ce combat. À la fin du combat, appuyez sur Esc, puis sur B pour Équipe et boîte.',
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
  // @desc: PvP skill cell of the two-column skill grid: submits the move rather than using it at
  // once, hence the leading "Valider :"; {name} is the skill name, {power} its damage value,
  // {affinity} its elemental type and {accuracy} its hit chance ("Préc." abbreviates "Précision").
  // Keep the "Valider :" prefix first. Fits a half-width button.
  // battleView.ts (#renderSkills)
  'battle.skill.pvpSubmit': (p) =>
    `Valider : ${p.name} (${p.power}) · ${p.affinity} · Préc. ${p.accuracy} %`,
  // @desc: PvE skill cell of the two-column skill grid, used at once; {name} is the skill name,
  // {power} its damage value, {affinity} its elemental type and {accuracy} its hit chance ("Préc."
  // abbreviates "Précision"). Keep {name} first. Fits a half-width button.
  // battleView.ts (#renderSkills)
  'battle.skill.pveLabel': (p) => `${p.name} (${p.power}) · ${p.affinity} · Préc. ${p.accuracy} %`,
  // @desc: Button label to run from an ongoing PvE battle. Short verb, fits a narrow button.
  // battleView.ts:470
  'battle.action.flee': 'Fuir',
  // @desc: Accessible name of the bait list a wild battle's Recruit command opens (a group of
  // buttons: No bait, then one per bait item). One word.
  // battleView.ts (#renderRecruit)
  'battle.recruit.listLabel': 'Appât',
  // @desc: First row of the bait list shown in a wild battle: attempt recruitment with no bait
  // item. Short, fits a narrow button.
  // battleView.ts (#renderRecruit)
  'battle.recruit.noBait': 'Sans appât',
  // @desc: Question shown after the player picks a bait row; {bait} is the bait item's name. Yes
  // attempts the recruit with it. One short line.
  // battleView.ts (#renderRecruitConfirm)
  'battle.recruit.confirm': (p) => `Recruter avec ${p.bait} ?`,
  // @desc: Question shown after the player picks the No bait row; Yes attempts the recruit with no
  // bait. One short line.
  // battleView.ts (#renderRecruitConfirm)
  'battle.recruit.confirmNoBait': 'Recruter sans appât ?',
  // @desc: The Recruit question's default answer: attempt the recruit. One word.
  // battleView.ts (#renderRecruitConfirm)
  'battle.recruit.yes': 'Oui',
  // @desc: The Recruit question's other answer: go back to the bait list. One word.
  // battleView.ts (#renderRecruitConfirm)
  'battle.recruit.no': 'Non',
  // @desc: Accessible name of the list of cure items a battle's Bag command opens. Two words.
  // battleView.ts (#renderCureItems)
  'battle.cure.listLabel': 'Objets de soin',
  // @desc: One row of the battle Bag's cure-item list; {name} is the item name, {cureStatus} the
  // ailment it removes (e.g. "Poison") and {count} how many the player carries. One line in a
  // narrow button.
  // battleView.ts (#renderCureItems)
  'battle.cure.option': (p) => `${p.name} (soigne ${p.cureStatus}) ×${p.count}`,
  // @desc: The one target row after a cure item is picked: the player's active monster, {species},
  // the only monster an item can be used on in battle. Pressing it uses the item. Short.
  // battleView.ts (#renderCureTarget)
  'battle.cure.target': (p) => `Utiliser sur ${p.species}`,
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
  // @desc: Battle command list entry that opens the skill grid. One short word; the five command
  // entries share one narrow row.
  // battleView.ts (#renderCommands)
  'battle.command.fight': 'Attaque',
  // @desc: Battle command list entry that moves to the recruit controls (wild battles only). One
  // short verb; the five command entries share one narrow row.
  // battleView.ts (#renderCommands)
  'battle.command.recruit': 'Recruter',
  // @desc: Battle command list entry that moves to the bench monsters to swap in. One short verb;
  // the five command entries share one narrow row.
  // battleView.ts (#renderCommands)
  'battle.command.swap': 'Changer',
  // @desc: Battle command list entry that moves to the battle items (status cures). One short
  // noun; the five command entries share one narrow row.
  // battleView.ts (#renderCommands)
  'battle.command.bag': 'Sac',
  // @desc: Battle command list entry that runs from a wild battle at once (greyed, with a reason,
  // in a player battle). One short verb; the five command entries share one narrow row.
  // battleView.ts (#renderCommands)
  'battle.command.run': 'Fuir',
  // @desc: Accessible name of the battle command list (Fight, Recruit, Swap, Bag, Run), read by a
  // screen reader as the group's label. One word.
  // battleView.ts (#renderCommands)
  'battle.commands.label': 'Commandes',
  // @desc: Caption over the greyed battle command list after the player has submitted a PvP move;
  // {name} is the rival's display name. Ends with an ellipsis. One line.
  // battleView.ts (#renderCommands)
  'battle.commands.waiting': (p) => `En attente de ${p.name}…`,
  // @desc: Why Run is disabled in a battle against another player, shown under the command list.
  // One short sentence.
  // battleView.ts (#renderCommands)
  'battle.command.runPvpReason': 'Impossible de fuir un combat entre joueurs.',
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
  // @desc: Line on a monster's evolution card when the species has no evolution path at all; also
  // the reason after the Monsters sheet's disabled Evolve… row. One short line of small text.
  // evolutionView.ts:195, boxView.ts (the Monsters frame)
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
  // @desc: Feedback line in the raising overlay after the server accepted a Care action on a
  // monster. One short line.
  // main.ts:2615 (onCare adapter; pre-migration careAction.ts CARED_MESSAGE)
  'raising.feedback.cared': 'Choyé !',
  // @desc: Heading of the party & box overlay, where the player arranges which monsters are in
  // the active party and which stay in storage; quoted inside battle.swap.hint. One short line.
  // boxView.ts:69 (resolved in show())
  'box.title': 'Équipe et boîte',
  // @desc: Explainer under the heading telling the player that only Party monsters battle and
  // that new recruits land in the Box; the quoted « Vers l’équipe » must match the
  // box.card.toParty button label exactly. Two sentences, wraps freely up to 600px wide; carries
  // a spaced em dash.
  // boxView.ts:94-96 (resolved in show())
  'box.hint':
    'Seuls les monstres de votre équipe peuvent combattre ou être échangés en cours de combat. Les nouvelles recrues arrivent dans votre Boîte — chaque monstre de la boîte a un bouton « Vers l’équipe » qui le déplace dans un emplacement libre de l’équipe.',
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
  // @desc: Label of the in-frame text field asking for a monster's new nickname; the current name
  // is pre-filled. Short, ends with a colon.
  // boxView.ts (the Monsters nickname row)
  'box.rename.prompt': 'Nouveau surnom :',
  // @desc: Tab of the Monsters screen listing the party (up to six monsters). One word.
  // boxView.ts (the Monsters frame)
  'box.tab.party': 'Équipe',
  // @desc: Tab of the Monsters screen listing the monsters kept in storage (the box). One word.
  // boxView.ts (the Monsters frame)
  'box.tab.storage': 'Stockage',
  // @desc: Action on a monster's action sheet that shows its details. One word.
  // boxView.ts (the Monsters frame)
  'box.sheet.summary': 'Résumé',
  // @desc: Action on a monster's action sheet that opens a text field to rename it. One word.
  // boxView.ts (the Monsters frame)
  'box.sheet.nickname': 'Surnom',
  // @desc: Action on a monster's action sheet that moves it between the party and storage.
  // One word.
  // boxView.ts (the Monsters frame)
  'box.sheet.move': 'Déplacer',
  // @desc: Confirmation line after a monster moved from storage into the party; the screen draws a
  // check mark before it. Short phrase.
  // boxView.ts (the Monsters frame)
  'box.feedback.movedToParty': 'Déplacé dans l’équipe',
  // @desc: Confirmation line after a monster moved from the party into storage; the screen draws a
  // check mark before it. Short phrase.
  // boxView.ts (the Monsters frame)
  'box.feedback.movedToBox': 'Déplacé dans le stockage',
  // @desc: Action on a monster's action sheet that sends it a care visit (the raising screen's Care
  // action, on a server cooldown). One word.
  // boxView.ts (the Monsters frame)
  'box.sheet.care': 'Choyer',
  // @desc: Action on a monster's action sheet that opens the list of foods to feed it; the
  // trailing ellipsis (one character) marks a row that opens a list. One word plus the ellipsis.
  // boxView.ts (the Monsters frame)
  'box.sheet.feed': 'Nourrir…',
  // @desc: Action on a monster's action sheet that opens the list of its evolution paths; the
  // trailing ellipsis (one character) marks a row that opens a list. One word plus the ellipsis.
  // boxView.ts (the Monsters frame)
  'box.sheet.evolve': 'Évoluer…',
  // @desc: Reason shown after the disabled Feed… row when the player holds no food. Two words.
  // boxView.ts (the Monsters frame)
  'box.sheet.feedNone': 'Aucune nourriture',
  // @desc: One row of the food list under a monster's action sheet; {name} is the item's name and
  // {count} how many the player holds. Keep the "(x{count})" shape. One short line.
  // boxView.ts (the Monsters frame)
  'box.feed.item': (p) => `${p.name} (x${p.count})`,
  // @desc: Question of the Yes / No confirm before evolving a monster; {name} is the monster's
  // nickname or species and {species} the species it would become. One question, ends with "?".
  // boxView.ts (the Monsters frame)
  'box.evolve.confirm': (p) => `Faire évoluer ${p.name} en ${p.species} ?`,
  // @desc: Confirmation line after a monster was fed; {name} is the monster's nickname or species;
  // the screen draws a check mark before it. Short phrase.
  // boxView.ts (the Monsters frame)
  'box.feedback.fed': (p) => `${p.name} nourri`,
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
  // @desc: Feedback line in the live-trade overlay after the player accepted the offer.
  // main.ts:2668
  'trade.feedback.accepted': 'Échange accepté !',
  // @desc: Feedback line in the live-trade overlay after the player rejected the offer.
  // main.ts:2675
  'trade.feedback.rejected': 'Échange refusé.',
  // @desc: Feedback line in the live-trade overlay after the player confirmed and the trade went through.
  // main.ts:2682
  'trade.feedback.completed': 'Échange conclu !',
  // @desc: Feedback line in the live-trade overlay after the player cancelled the trade.
  // main.ts:2689
  'trade.feedback.cancelled': 'Échange annulé.',
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
  // @desc: Feedback line in the shop overlay after a purchase succeeded; {qty} is how many were
  // bought, {name} the item name and {gold} the total gold spent, after a minus sign (U+2212).
  // Starts with a check mark. One line.
  // main.ts (dispatch, buy)
  'shop.feedback.buy.item': (p) => `✓ Acheté ${p.qty} ${p.name} (−${p.gold} or)`,
  // @desc: Feedback line in the shop overlay after a purchase succeeded while the item or its
  // price is not loaded; {qty} is how many were bought, after a multiplication sign. Starts with
  // a check mark. One short line.
  // main.ts (dispatch, buy)
  'shop.feedback.buy.count': (p) => `✓ Acheté ×${p.qty}`,
  // @desc: Feedback line in the shop overlay after a sale succeeded; {qty} is how many were
  // sold, {name} the item name and {gold} the total gold received, after a plus sign. Starts
  // with a check mark. One line.
  // main.ts (dispatch, sell)
  'shop.feedback.sell.item': (p) => `✓ Vendu ${p.qty} ${p.name} (+${p.gold} or)`,
  // @desc: Feedback line in the shop overlay after a sale succeeded while the item is not
  // loaded; {qty} is how many were sold, after a multiplication sign. Starts with a check mark.
  // One short line.
  // main.ts (dispatch, sell)
  'shop.feedback.sell.count': (p) => `✓ Vendu ×${p.qty}`,
  // @desc: Label of the shop's Buy tab (the tab strip under the title; the frame opens on it).
  // One short word.
  // shopView.ts (paint, the tab strip)
  'shop.tab.buy': 'Acheter',
  // @desc: Label of the shop's Sell tab, beside the Buy tab. One short word.
  // shopView.ts (paint, the tab strip)
  'shop.tab.sell': 'Vendre',
  // @desc: The description slot's text when the item under the cursor has no description, shown
  // after Y. A single em dash (U+2014), a "nothing here" mark.
  // shopView.ts (paint, the description slot)
  'shop.description.none': '—',
  // @desc: The quantity row under the Buy tab after A on an item; {name} is the item, {qty} the
  // quantity the D-pad is changing, after a multiplication sign. One short line.
  // shopView.ts (paint, the prompt)
  'shop.qty.buy': (p) => `Combien de ${p.name} acheter ? ×${p.qty}`,
  // @desc: The quantity row under the Sell tab; {name} is the item, {qty} the quantity the D-pad
  // is changing, after a multiplication sign. One short line.
  // shopView.ts (paint, the prompt)
  'shop.qty.sell': (p) => `Combien de ${p.name} vendre ? ×${p.qty}`,
  // @desc: The Yes / No question before a purchase; {qty} items named {name} for {gold} gold in
  // total. One short line, a question.
  // shopView.ts (paint, the prompt)
  'shop.confirm.buy': (p) => `Acheter ${p.qty} ${p.name} pour ${p.gold} or ?`,
  // @desc: The Yes / No question before a sale; {qty} items named {name} for {gold} gold in
  // total. One short line, a question.
  // shopView.ts (paint, the prompt)
  'shop.confirm.sell': (p) => `Vendre ${p.qty} ${p.name} pour ${p.gold} or ?`,
  // @desc: The affirmative option of a Yes / No confirm (the shop's buy and sell, the heal
  // question, the Monsters sheet's Evolve confirm). One short word.
  // shopView.ts, healView.ts, boxView.ts, sessionModel.ts (the confirm options)
  'prompt.yes': 'Oui',
  // @desc: The negative option of a Yes / No confirm, beside Yes. One short word.
  // shopView.ts, healView.ts, boxView.ts, sessionModel.ts (the confirm options)
  'prompt.no': 'Non',
  // @desc: Tab of the Social screen that will list the players online. One word, fits a narrow tab.
  // tradeView.ts (the Social tab strip)
  'social.tab.players': 'Joueurs',
  // @desc: Tab of the Social screen showing the trade offered to or by the player. One word, fits a
  // narrow tab.
  // tradeView.ts (the Social tab strip)
  'social.tab.trades': 'Échanges',
  // @desc: Tab of the Social screen showing PvP challenges sent to or by the player. One word, fits
  // a narrow tab.
  // tradeView.ts (the Social tab strip)
  'social.tab.challenges': 'Défis',
  // @desc: Tab of the Social screen showing the ranked leaderboard. One word, fits a narrow tab.
  // tradeView.ts (the Social tab strip)
  'social.tab.rankings': 'Classement',
  // @desc: Line shown on the Social screen's Players tab while the player list is not built yet. One
  // short sentence.
  // tradeView.ts (the Players tab)
  'social.players.placeholder': 'La liste des joueurs n’est pas encore disponible.',
  // @desc: Badge after a player's name on the Social screen's Players tab: that player is in the
  // same zone, a short walk away. One short word, fits a narrow badge.
  // leaderboardView.ts (the Players tab)
  'social.players.nearby': 'À proximité',
  // @desc: Line shown on the Social screen's Players tab when no other player is online. One short
  // sentence.
  // leaderboardView.ts (the Players tab)
  'social.players.none': 'Aucun autre joueur en ligne',
  // @desc: Hint shown after choosing a player on the Social screen's Players tab: trading and
  // challenging are face to face. {name} is the player's display name. One short sentence.
  // leaderboardView.ts (the Players tab)
  'social.players.walkUp': (p) => `Approchez-vous de ${p.name} et appuyez sur A`,
  // @desc: Row of the action sheet opened on a trade offer or a PvP challenge: accept it. One short
  // verb.
  // tradeView.ts (the Social action sheet)
  'social.action.accept': 'Accepter',
  // @desc: Row of the action sheet opened on a trade offer or a PvP challenge: decline it (a Yes /
  // No question follows). One short verb.
  // tradeView.ts (the Social action sheet)
  'social.action.decline': 'Refuser',
  // @desc: Row of the action sheet opened on an accepted trade: complete it (a Yes / No question
  // follows). One short verb.
  // tradeView.ts (the Social action sheet)
  'social.action.confirm': 'Confirmer',
  // @desc: Row of the action sheet opened on the player's own trade offer or challenge: withdraw it.
  // One short verb.
  // tradeView.ts (the Social action sheet)
  'social.action.cancel': 'Annuler',
  // @desc: The Yes / No question before a trade offer is declined; No is the default answer.
  // tradeView.ts (the Social prompt)
  'social.confirm.declineTrade': 'Refuser cet échange ?',
  // @desc: The Yes / No question before an accepted trade is completed, which cannot be reversed; No
  // is the default answer.
  // tradeView.ts (the Social prompt)
  'social.confirm.confirmTrade': 'Conclure cet échange ? Cette action est irréversible.',
  // @desc: The Yes / No question before a PvP challenge is declined; No is the default answer.
  // tradeView.ts (the Social prompt)
  'social.confirm.declineChallenge': 'Refuser ce défi ?',
  // @desc: Placeholder option of the trade-proposal dialog's target selector, shown before the
  // player picks another player to trade with; ends with an ellipsis. Short, fits a narrow
  // dropdown.
  // tradeProposeView.ts:168
  'tradePropose.target.placeholder': 'Choisir un joueur…',
  // @desc: Feedback line in the trade-proposal dialog after the offer was sent to the other player.
  // main.ts:2828
  'tradePropose.feedback.sent': 'Offre envoyée !',
  // @desc: Step names in the trade-proposal wizard's header (ctl-8e), in order: pick the player,
  // pick your monsters, type the coins you give, type the coins you ask for, confirm. One word each.
  // tradeProposeView.ts
  'tradePropose.step.target': 'Joueur',
  // @desc: Wizard step name: choose which of your monsters to offer. One word.
  // tradeProposeView.ts
  'tradePropose.step.offer': 'Offre',
  // @desc: Wizard step name: type how many coins you give. One word.
  // tradeProposeView.ts
  'tradePropose.step.coins': 'Pièces',
  // @desc: Wizard step name: type how many coins you ask for in return. One word.
  // tradeProposeView.ts
  'tradePropose.step.ask': 'Demande',
  // @desc: Wizard step name: check the offer and send it. One word.
  // tradeProposeView.ts
  'tradePropose.step.review': 'Vérifier',
  // @desc: Question on the wizard's last step, above Yes / No; Yes sends the trade offer.
  // tradeProposeView.ts
  'tradePropose.review.prompt': 'Envoyer cette offre ?',
  // @desc: Shown on the wizard's last step instead of the question when no player is chosen or
  // nothing is offered or asked for, so the offer cannot be sent yet.
  // tradeProposeView.ts
  'tradePropose.review.incomplete': 'Cette offre n’est pas complète.',
  // @desc: Answer that sends the trade offer. One word.
  // tradeProposeView.ts
  'tradePropose.review.yes': 'Oui',
  // @desc: Answer that does not send the trade offer and goes back a step. One word.
  // tradeProposeView.ts
  'tradePropose.review.no': 'Non',
  // @desc: Button in the NPC dialogue overlay that opens the shop this NPC runs; shown only when
  // the NPC has one. One word, fits a narrow button.
  // dialogueView.ts:72
  'dialogue.action.shop': 'Boutique',
  // @desc: Button on the guest-claim overlay that opens the privacy & account-data surface
  // (account deletion, data export). Same French as privacy.title today, but a different key:
  // this is a BUTTON label. One short line.
  // claimView.ts:96 (resolved in show() and render())
  'claim.privacyButton': 'Confidentialité et données du compte',
  // @desc: Button on the guest-claim overlay that starts sign-in so guest progress can be claimed onto an account. Short verb phrase.
  'claim.signInButton': 'Se connecter',
  // @desc: Button on the guest-claim overlay that returns to the game once the claim is settled or declined. Short phrase.
  'claim.joinButton': 'Continuer à jouer',
  // @desc: Button on the guest-claim overlay: first step of declining the claim (a confirmation follows). One word.
  'claim.declineButton': 'Refuser',
  // @desc: Button confirming the decline: permanently deletes the claim code. Short phrase.
  'claim.declineConfirmButton': 'Oui, refuser',
  // @desc: Button cancelling the decline: keeps the claim code. Short phrase.
  'claim.declineCancelButton': 'Garder mon code',
  // @desc: Feedback line on the guest-claim overlay, above its buttons, when the player tries to
  // rejoin the game while a claim code is still pending — the join is refused until the claim is
  // finished or declined. One line.
  // claimModel.ts:96 (resolved in claimStep)
  'claim.feedback.veto':
    'Terminez ou refusez le transfert en attente avant de rejoindre la partie.',
  // @desc: First-run notice on the guest-claim overlay: guest progress can only be claimed from
  // the device it was made on. One line.
  // claimModel.ts:320 (resolved in buildClaimViewModel)
  'claim.nudge':
    'La progression d’invité ne se transfère que depuis l’appareil sur lequel vous la récupérez.',
  // @desc: Confirmation prompt shown after the player asks to decline the claim; it names the
  // irreversible consequence (the claim code is deleted for good) and asks again. Two sentences.
  // claimModel.ts:321-322 (resolved in buildClaimViewModel)
  'claim.decline.confirmPrompt':
    'Refuser supprime définitivement ce code de transfert — votre progression d’invité ne pourra ' +
    'plus être transférée vers un compte une fois le code disparu. Refuser et continuer en tant ' +
    'qu’invité ?',
  // @desc: Heading of the guest-claim overlay while a claim code is pending (also the initial
  // prompt). One short line.
  // claimModel.ts:324 (resolved in buildClaimViewModel)
  'claim.pending.title': 'Conservez votre progression d’invité',
  // @desc: Body of the guest-claim overlay while a claim code is pending: sign in to claim the
  // guest progress, or decline and stay a guest on this device. One sentence, two clauses.
  // claimModel.ts:325-326
  'claim.pending.body':
    'Connectez-vous pour récupérer la progression réalisée en tant qu’invité, ou refusez pour ' +
    'continuer à jouer en tant qu’invité sur cet appareil.',
  // @desc: Heading of the guest-claim overlay after sign-in while the account is still being
  // prepared. One short line.
  // claimModel.ts:327
  'claim.awaiting.title': 'Finalisation du transfert',
  // @desc: Body of the guest-claim overlay while waiting for the account to be ready before the
  // guest progress can transfer. One sentence.
  // claimModel.ts:328-329
  'claim.awaiting.body':
    'En attente que votre compte soit prêt avant que votre progression d’invité puisse être ' +
    'transférée.',
  // @desc: Heading of the guest-claim overlay once the guest progress is attached to the account.
  // One short line.
  // claimModel.ts:330
  'claim.claimed.title': 'Progression récupérée',
  // @desc: Body of the guest-claim overlay once the claim succeeded. One sentence.
  // claimModel.ts:331
  'claim.claimed.body': 'Votre progression d’invité est désormais rattachée à votre compte.',
  // @desc: Heading of the guest-claim overlay after a sign-in attempt failed. One short line.
  // claimModel.ts:381
  'claim.signInFailed.title': 'La connexion n’a pas abouti',
  // @desc: Body of the guest-claim overlay when the sign-in provider rejected the attempt; invites
  // another try. Two short sentences.
  // claimModel.ts:353 (resolved in buildClaimViewModel)
  'claim.signInFailed.rejected':
    'La connexion a été refusée. Veuillez réessayer de vous connecter.',
  // @desc: Body of the guest-claim overlay when the sign-in link had expired. Two short sentences.
  // claimModel.ts:354
  'claim.signInFailed.expired':
    'Ce lien de connexion a expiré. Veuillez réessayer de vous connecter.',
  // @desc: Body of the guest-claim overlay when the player cancelled the sign-in themselves. Two
  // short sentences.
  // claimModel.ts:355
  'claim.signInFailed.declined':
    'La connexion a été annulée. Vous pourrez réessayer quand vous le souhaitez.',
  // @desc: Body of the guest-claim overlay when the sign-in service could not be reached;
  // reassures that guest progress is kept. Two sentences.
  // claimModel.ts:356-357
  'claim.signInFailed.unreachable':
    'Impossible de joindre le service de connexion. Veuillez réessayer dans un instant — votre ' +
    'progression d’invité est en sécurité.',
  // @desc: Body of the guest-claim overlay for any other sign-in failure; reassures that guest
  // progress is kept. Two sentences.
  // claimModel.ts:363
  'claim.signInFailed.fallback':
    'La connexion ne s’est pas terminée. Veuillez réessayer — votre progression d’invité est en ' +
    'sécurité.',
  // @desc: Heading of the guest-claim overlay when the server refused the claim because the code
  // is invalid, already used or expired. One short line.
  // claimModel.ts:335 (resolved in buildClaimViewModel)
  'claim.reject.unusable.title': 'Ce code de transfert n’est plus utilisable',
  // @desc: Body for the unusable-code refusal: the code is spent, and the player keeps playing on
  // this device. Two sentences.
  // claimModel.ts:336
  'claim.reject.unusable.body':
    'Ce code de transfert a déjà été utilisé ou a expiré. Vous pouvez continuer à jouer sur cet ' +
    'appareil.',
  // @desc: Heading when the signed-in account already has its own game data and cannot take the
  // guest progress. One short line.
  // claimModel.ts:339
  'claim.reject.destination.title': 'Ce compte ne peut pas recevoir cette progression',
  // @desc: Body for that refusal: why the progress cannot move, and that the code still works on
  // another account. Two sentences.
  // claimModel.ts:340
  'claim.reject.destination.body':
    'Ce compte possède déjà des données de jeu, la progression d’invité ne peut donc pas y être ' +
    'transférée. Le code de transfert reste valable sur un autre compte.',
  // @desc: Heading when the claim is refused for a momentary reason (another tab open, a battle
  // in progress). One short line.
  // claimModel.ts:343
  'claim.reject.transient.title': 'Transfert pas encore possible',
  // @desc: Body for the momentary refusal: close the other tab or finish the battle, then retry.
  // One sentence.
  // claimModel.ts:344
  'claim.reject.transient.body':
    'Le transfert n’a pas pu aboutir pour le moment — fermez votre autre onglet ou terminez votre ' +
    'combat en cours, puis réessayez.',
  // @desc: Heading for any other claim refusal (e.g. not signed in). One short line.
  // claimModel.ts:347
  'claim.reject.generic.title': 'Impossible de finaliser le transfert',
  // @desc: Body for the other refusals: sign-in is required first; guest progress is kept. Two
  // sentences.
  // claimModel.ts:348
  'claim.reject.generic.body':
    'Vous devez vous connecter avant de pouvoir récupérer cette progression. Votre progression ' +
    'd’invité est en sécurité.',
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
  // @desc: Footer of the error toast naming its keys: B or F8 closes it, F9 downloads a bug
  // report; "B" is a button name, "F8"/"F9" are key names. One short line, small text.
  // errorOverlayView.ts:81 (resolved in show())
  'errorOverlay.footer': 'B ou F8 fermer · F9 rapport de bogue',
  // @desc: One row of the quest log; {name} is the quest's content identifier (e.g.
  // "quest_001", not player text) and {step} the current step number counted from 0. One line.
  // questLogView.ts:45
  'questLog.entry': (p) => `${p.name} (étape ${p.step})`,
  // @desc: One row of the heal overlay offering a heal at this location; {cost} is the price
  // text the heal model produces (e.g. "Gratuit" or "25 or"). One short line.
  // healView.ts:47
  'heal.location': (p) => `Se soigner ici (${p.cost})`,
  // @desc: The heal frame's Yes / No question; {cost} is the price text the heal model produces
  // (e.g. "Gratuit" or "25 or"), carried verbatim. One short line, a question.
  // healView.ts (paint, the question)
  'heal.prompt.question': (p) => `Soigner l’équipe pour ${p.cost} ?`,
  // @desc: Why the heal frame's Yes is disabled: no healer is bound (the frame was left open
  // across a reconnect). One short sentence.
  // healView.ts (paint, the reason)
  'heal.prompt.unavailable': 'Aucun soigneur à portée. Soin indisponible.',
  // @desc: Summary line on the wizard's last step: the chosen player's name, how many of your
  // monsters are ticked, the coins you give and the coins you ask for. Numbers are digits.
  // tradeProposeView.ts
  'tradePropose.review.summary': (p) =>
    `Pour ${p.target} · Monstres : ${p.monsters} · Pièces : ${p.offer} · Demande : ${p.ask}`,
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
  // @desc: Countdown banner in the HUD and the privacy overlay's status line while account
  // deletion is pending but the remaining time could not be computed. One line.
  // privacyBanner.ts:31 (resolved in privacyBannerLabel)
  'privacy.countdown.dark': 'Suppression du compte en attente — temps restant indisponible',
  // @desc: Countdown banner / status line once the deletion deadline has passed and the account
  // may be deleted at any moment. One short line.
  // privacyBanner.ts:32 (resolved in privacyBannerLabel)
  'privacy.countdown.due': 'Suppression du compte imminente',
  // @desc: Ticking countdown banner / status line while deletion is pending; {duration} is the
  // remaining time already formatted from privacy.countdown.days/hours/minutes/seconds (e.g.
  // "6 j 23 h 59 min 58 s", a no-break space inside each group). One line.
  // privacyBanner.ts:33 (resolved in privacyBannerLabel)
  'privacy.countdown.grace': (p) => `Suppression du compte dans ${p.duration}`,
  // @desc: One group of the countdown duration: {n} whole days followed by the day unit symbol
  // (a no-break space between them in French). Very short.
  // privacyBanner.ts:62 (resolved in formatDuration)
  'privacy.countdown.days': (p) => `${p.n} j`,
  // @desc: One group of the countdown duration: {n} hours (0-23) and the hour unit symbol. Very
  // short.
  // privacyBanner.ts:63 (resolved in formatDuration)
  'privacy.countdown.hours': (p) => `${p.n} h`,
  // @desc: One group of the countdown duration: {n} minutes (0-59) and the minute unit symbol.
  // Very short.
  // privacyBanner.ts:64 (resolved in formatDuration)
  'privacy.countdown.minutes': (p) => `${p.n} min`,
  // @desc: One group of the countdown duration: {n} seconds (0-59) and the second unit symbol;
  // this group is always present and ticks every second. Very short.
  // privacyBanner.ts:65 (resolved in formatDuration)
  'privacy.countdown.seconds': (p) => `${p.n} s`,
  // @desc: Notice on the privacy overlay when the account has already been permanently deleted
  // (shown on open, and after a refused cancel). Must not read like a generic rejection. Two
  // sentences.
  // privacyBanner.ts:126-127 (resolved in buildPrivacyViewModel)
  'privacy.notice.terminal':
    'Ce compte a déjà été définitivement supprimé. Il ne peut pas être restauré.',
  // @desc: Notice on the privacy overlay when a delete / cancel / export click could not be sent
  // because the connection is down; it is NOT a server rejection. Two short sentences.
  // privacyBanner.ts:131 (resolved in buildPrivacyViewModel)
  'privacy.notice.disconnected': 'Non connecté — votre demande n’a pas été envoyée. Réessayez.',
  // @desc: Status line of the privacy overlay for an account with no deletion pending. One short
  // sentence.
  // privacyBanner.ts:133 (resolved in buildPrivacyViewModel)
  'privacy.status.active': 'Ce compte est actif.',
  // @desc: Status line of the privacy overlay before the account row has arrived. One short
  // sentence.
  // privacyBanner.ts:134
  'privacy.status.unknown': 'Statut du compte indisponible.',
  // @desc: Status line of the privacy overlay for an account that has been permanently deleted.
  // One short sentence.
  // privacyBanner.ts:135
  'privacy.status.terminal': 'Ce compte a été définitivement supprimé.',
  // @desc: Data-export line of the privacy overlay when no export has been delivered to this
  // device. One sentence.
  // privacyBanner.ts:147 (resolved in buildPrivacyViewModel)
  'privacy.export.none': 'Aucun export de données n’est encore arrivé sur cet appareil.',
  // @desc: Data-export line while chunks are still missing; {received} chunks of {total} have
  // arrived (both counts). Deliberately does not promise the rest will arrive. One sentence. The
  // French puts the counts after a label so 0 and 1 need no singular form.
  // privacyBanner.ts:148-149
  'privacy.export.incomplete': (p) =>
    `Export de données incomplet — fragments livrés : ${p.received} sur ${p.total}.`,
  // @desc: Data-export line while chunks are missing and the total is unknown; deliberately no
  // number. One sentence.
  // privacyBanner.ts:150
  'privacy.export.incompleteDark': 'Export de données incomplet — certains fragments manquent.',
  // @desc: Data-export line when the delivered chunks contradict each other and the export must
  // be requested again; deliberately no number. Two sentences.
  // privacyBanner.ts:151-153
  'privacy.export.inconsistent':
    'L’export de données n’a pas pu être assemblé — les fragments livrés ne décrivent pas une ' +
    'seule demande. Demandez-le à nouveau.',
  // @desc: Data-export line once every chunk arrived; {received} is the chunk count. One short
  // sentence. The French puts the count after a label so 0 and 1 need no singular form.
  // privacyBanner.ts:154-155
  'privacy.export.complete': (p) => `Export de données prêt — fragments reçus : ${p.received}.`,
  // @desc: Button on the privacy overlay that starts the two-step account deletion. Short phrase,
  // fits a narrow button.
  // privacyBanner.ts:157 (resolved in buildPrivacyViewModel)
  'privacy.action.delete': 'Supprimer mon compte',
  // @desc: Prompt shown beside the second-step buttons after the player asked to delete the
  // account; names the irreversibility. Two short sentences.
  // privacyBanner.ts:158
  'privacy.confirm.prompt': 'Cette action est irréversible. Confirmer la suppression ?',
  // @desc: Button on the privacy overlay that withdraws a pending account deletion. Short phrase,
  // fits a narrow button.
  // privacyBanner.ts:159
  'privacy.action.cancel': 'Annuler la suppression du compte',
  // @desc: Button on the privacy overlay that asks the server to build a data export. Short
  // phrase; it sits beside privacy.action.download, which must read differently.
  // privacyBanner.ts:160
  'privacy.action.export': 'Demander l’export de mes données',
  // @desc: Button on the privacy overlay that saves the data export that has already arrived.
  // Short phrase, distinct from privacy.action.export.
  // privacyBanner.ts:164
  'privacy.action.download': 'Télécharger l’export de mes données',
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
  // @desc: Title of the main menu side panel and the first breadcrumb in its sub-lists.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.title': 'Menu',
  // @desc: Main-menu entry opening the monster box (party and storage).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.monsters.title': 'Monstres',
  // @desc: Feedback-line description of the Monsters main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.monsters.desc': 'Voir votre équipe et vos monstres stockés.',
  // @desc: Main-menu entry opening the bag (items, feeding and care).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.bag.title': 'Sac',
  // @desc: Feedback-line description of the Bag main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.bag.desc': 'Utiliser des objets et soigner vos monstres.',
  // @desc: Main-menu entry opening the quest journal.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.journal.title': 'Journal',
  // @desc: Feedback-line description of the Journal main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.journal.desc': 'Consulter vos quêtes et leur progression.',
  // @desc: Main-menu entry opening the Social sub-list (trades, challenges, rankings).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.title': 'Social',
  // @desc: Feedback-line description of the Social main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.desc': 'Échanges, défis et classements avec les autres joueurs.',
  // @desc: Main-menu entry opening the Profile sub-list (name, account, privacy).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.title': 'Profil',
  // @desc: Feedback-line description of the Profile main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.desc': 'Votre nom, votre compte et vos réglages de confidentialité.',
  // @desc: Main-menu entry opening the Options sub-list (how to play).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.title': 'Options',
  // @desc: Feedback-line description of the Options main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.desc': 'Aide pour apprendre à jouer.',
  // @desc: Main-menu entry that closes the menu and returns to the world.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.close.title': 'Fermer',
  // @desc: Feedback-line description of the Close main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.close.desc': 'Fermer le menu et revenir au monde.',
  // @desc: Social sub-list entry opening the incoming-trade screen.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.trades.title': 'Échanges',
  // @desc: Feedback-line description of the Trades entry in the Social sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.trades.desc': 'Voir et répondre à l’échange qui vous est proposé.',
  // @desc: Social sub-list entry opening the battle-challenge screen.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.challenges.title': 'Défis',
  // @desc: Feedback-line description of the Challenges entry in the Social sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.challenges.desc': 'Voir les défis et y répondre.',
  // @desc: Social sub-list entry opening the ranked leaderboard.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.rankings.title': 'Classement',
  // @desc: Feedback-line description of the Rankings entry in the Social sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.rankings.desc': 'Voir le classement des joueurs.',
  // @desc: Profile sub-list entry opening the rename form.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.name.title': 'Nom',
  // @desc: Feedback-line description of the Name entry in the Profile sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.name.desc': 'Changer le nom que voient les autres joueurs.',
  // @desc: Profile sub-list entry opening the account and sign-in screen.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.account.title': 'Compte',
  // @desc: Feedback-line description of the Account entry in the Profile sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.account.desc': 'Se connecter ou conserver cette progression invitée.',
  // @desc: Profile sub-list entry opening the privacy screen (data export, deletion).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.privacy.title': 'Confidentialité',
  // @desc: Feedback-line description of the Privacy entry in the Profile sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.privacy.desc': 'Exporter ou supprimer vos données.',
  // @desc: Options sub-list entry opening the how-to-play help screen.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.help.title': 'Comment jouer',
  // @desc: Feedback-line description of the How to play entry in the Options sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.help.desc': 'Commandes et objectifs du jeu.',
  // @desc: Options sub-list entry opening the Controls screen (key remapping).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.controls.title': 'Commandes',
  // @desc: Feedback-line description of the Controls entry in the Options sub-list, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.options.controls.desc': 'Choisir la touche de chaque bouton.',
  // @desc: Reason a main-menu entry is disabled while the menu is open over a battle (feedback
  // line); also the status-line and announced reason when an action is refused during a battle.
  // ui/screens/mainMenuScreen.ts (battleReason); main.ts (refusedInBattle)
  'menu.disabled.inBattle': 'Impossible pendant un combat',
  // @desc: Feedback-line reason the Bag main-menu entry is disabled over a battle: use the
  // battle's own Bag command.
  // ui/screens/mainMenuScreen.ts (battleReason)
  'menu.disabled.battleBag': 'Utilisez les objets avec la commande Sac du combat',
  // @desc: Bag pocket tab: items that help recruit a wild monster. One word.
  // raisingView.ts (the Bag frame)
  'bag.pocket.bait': 'Appâts',
  // @desc: Bag pocket tab: items a monster can be fed to train a stat. One word.
  // raisingView.ts (the Bag frame)
  'bag.pocket.food': 'Nourriture',
  // @desc: Bag pocket tab: items that cure a monster's status in battle. One word.
  // raisingView.ts (the Bag frame)
  'bag.pocket.medicine': 'Remèdes',
  // @desc: Bag pocket tab: every item that fits no other pocket. One word.
  // raisingView.ts (the Bag frame)
  'bag.pocket.other': 'Divers',
  // @desc: Bag item action: feed this food to a monster (opens a monster list). One word.
  // raisingView.ts (the Bag frame)
  'bag.action.feed': 'Nourrir',
  // @desc: Bag item action: use this item (only possible from the battle Bag command). One word.
  // raisingView.ts (the Bag frame)
  'bag.action.use': 'Utiliser',
  // @desc: Bag item action: show the item's description. One short word.
  // raisingView.ts (the Bag frame)
  'bag.action.info': 'Infos',
  // @desc: Heading of the Bag's monster list after choosing Feed. A short question.
  // raisingView.ts (the Bag frame)
  'bag.picker.title': 'Nourrir quel monstre ?',
  // @desc: Feedback-line reason Feed is disabled: the player owns no monster. Short phrase.
  // raisingView.ts (the Bag frame)
  'bag.feed.noMonsters': 'Aucun monstre à nourrir',
  // @desc: Journal quest detail line; {step} is the quest's current step number counted from 0.
  // questLogView.ts (the Journal detail)
  'journal.detail.step': (p) => `Étape ${p.step}`,
} satisfies Catalog);
