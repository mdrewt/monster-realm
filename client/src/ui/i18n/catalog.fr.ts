// ui/i18n/catalog.fr.ts — the French catalog, the M24 PROOF LOCALE.
//
// WHY THIS FILE EXISTS. `fr` is the second registered locale: it proves, at runtime and under
// the §5.3 parity gate (catalogParity.test.ts), that the resolver/catalog resolver/catalog seam
// carries a real translation — every `MessageId` resolves, every closure reads exactly the
// same param fields as its English twin (the one CLDR-plural key, `battle.weather.banner`, left with
// the 1v1 view in bt-17; `ui/i18n/plural.ts` keeps its own tests). It mirrors catalog.en.ts
// ENTRY FOR ENTRY, IN THE SAME ORDER, so a side-by-side diff of the two files lines up.
//
// ONE ENTRY PER `MessageId` AND `A11yKey`, and the type makes that total: `satisfies Catalog` is load-bearing
// — `Object.freeze<T>` is generic, so without it a stowaway key would be swallowed
// into `T`; `satisfies` restores the excess-property check, and the mapped type reports an
// omitted key by name (TS2741). Frozen for the same reason `CATALOG_EN` is: the type annotation
// is erased at runtime, and a caller that casts it away must not be able to rewrite the shared
// singleton for every later importer.
//
// THE `// @desc:` CONVENTION (M24 §2.3) applies here exactly as in catalog.en.ts: the contiguous
// `//` block directly above every entry carries one `// @desc:` line (≥10 non-whitespace chars)
// written in ENGLISH for the translator/TMS, saying WHAT the string is, WHERE the player sees it
// and any width constraint; the `<file>:NNN`-style citations are copied from the English
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
  // bt-11 (BT11.6): the tactical battle's hint-bar verbs (ui/hintBarModel.ts, given the shell's hint).
  // @desc: Verb on the X button chip in the hint bar during a tactical battle: toggles the purple
  // danger overlay (every enemy's attackable tiles). One short word.
  'chrome.chip.danger': 'Menace',
  // @desc: Verb on the LB button chip in the hint bar during a tactical battle: selects the
  // previous one of the player's units. Two short words.
  'chrome.chip.prevUnit': 'Unité préc.',
  // @desc: Verb on the RB button chip in the hint bar during a tactical battle: selects the next
  // one of the player's units. Two short words.
  'chrome.chip.nextUnit': 'Unité suiv.',
  // @desc: Verb on the B button chip in the hint bar during a tactical battle while a planned
  // step can be taken back for free. One short word.
  'chrome.chip.undo': 'Annuler',
  // @desc: Verb on the Start button chip during a tactical battle on the player's live turn when
  // ending it grants no Guard. Two short words.
  'chrome.chip.endTurn': 'Fin du tour',
  // @desc: Verb on the Start button chip during a tactical battle on the player's live turn when
  // ending it grants Guard (reduced damage until the next turn). One short word.
  'chrome.chip.guard': 'Garde',
  // @desc: Verb on the Start button chip during a tactical battle while the player pre-plans a
  // unit's next turn: sends the plan. One short word.
  'chrome.chip.submit': 'Envoyer',
  // @desc: Verb on the A button chip at the deploy confirm screen of a wild pack battle: sends the
  // remembered formation into battle. One word.
  'chrome.chip.deploy': 'Déployer',
  // @desc: Verb on the X button chip at the deploy confirm screen: opens the formation editor. Two
  // short words.
  'chrome.chip.editFormation': 'Modifier la formation',
  // @desc: Verb on the A button chip in the formation editor: puts the shown monster into the
  // highlighted slot. One word.
  'chrome.chip.assign': 'Assigner',
  // @desc: Verb on the LB button chip in the formation editor: shows the previous party monster.
  // Two short words.
  'chrome.chip.prevMonster': 'Monstre précédent',
  // @desc: Verb on the RB button chip in the formation editor: shows the next party monster. Two
  // short words.
  'chrome.chip.nextMonster': 'Monstre suivant',
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
  // @desc: The request banner's line when several trade requests wait; {count} is how many.
  // Digits, one short line.
  // main.ts
  'notice.request.trades': (p) => `${p.count} demandes d’échange`,
  // @desc: The world interaction chip above what the character faces: {key} is the A button's
  // keycap, {verb} a resolved interact.verb.* word, {name} the npc id or the healer name. main.ts
  // (#interact-prompt)
  'interact.chip': (p) => `[${p.key}] ${p.verb} — ${p.name}`,
  // @desc: The world interaction chip when A would open a picker of several things to act on; {key}
  // is the A button's keycap. main.ts (#interact-prompt)
  'interact.choose': (p) => `[${p.key}] Choisir…`,
  // @desc: The hint bar's A verb while the world picker of several things to act on is open (uif-12).
  // One short word. ui/hintBarModel.ts (#hint-bar)
  'interact.chip.choose': 'Choisir',
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
  // @desc: One row of the Challenge confirm's party-size pick (bt-15): how many monsters each side
  // fields, {n} vs {n}, largest first. Very short — up to three rows sit side by side. main.ts
  // (#interact-prompt rows)
  'interact.challenge.size': (p) => `${p.n} contre ${p.n}`,
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
  // @desc: Name of the D-pad Up button in Controls (a row label). One short word.
  // ui/controlsModel.ts
  'controls.button.up': 'Haut',
  // @desc: Name of the D-pad Down button in Controls (a row label). One short word.
  // ui/controlsModel.ts
  'controls.button.down': 'Bas',
  // @desc: Name of the D-pad Left button in Controls (a row label). One short word.
  // ui/controlsModel.ts
  'controls.button.left': 'Gauche',
  // @desc: Name of the D-pad Right button in Controls (a row label). One short word.
  // ui/controlsModel.ts
  'controls.button.right': 'Droite',
  // @desc: Name of the A button (confirm / interact) in Controls; keep the button letter
  // in parentheses. ui/controlsModel.ts
  'controls.button.a': 'Valider (A)',
  // @desc: Name of the B button (back / cancel) in Controls; keep the button letter in
  // parentheses. ui/controlsModel.ts
  'controls.button.b': 'Retour (B)',
  // @desc: Name of the X button (jump) in Controls; keep the button letter in parentheses.
  // ui/controlsModel.ts
  'controls.button.x': 'Saut (X)',
  // @desc: Name of the Y button (more / info) in Controls; keep the button letter in
  // parentheses. ui/controlsModel.ts
  'controls.button.y': 'Infos (Y)',
  // @desc: Name of the LB button (previous tab) in Controls; keep the button name in
  // parentheses. ui/controlsModel.ts
  'controls.button.lb': 'Onglet précédent (LB)',
  // @desc: Name of the RB button (next tab) in Controls; keep the button name in
  // parentheses. ui/controlsModel.ts
  'controls.button.rb': 'Onglet suivant (RB)',
  // @desc: Name of the Start button (opens the main menu) in Controls; keep the button
  // name in parentheses. ui/controlsModel.ts
  'controls.button.start': 'Menu (Start)',
  // @desc: Name of the Select button (opens help) in Controls; keep the button name in
  // parentheses. ui/controlsModel.ts
  'controls.button.select': 'Aide (Select)',
  // @desc: Name of the shortcut that opens Monsters › Storage, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.storage': 'Stockage',
  // @desc: Name of the shortcut that opens the Inventory, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.bag': 'Inventaire',
  // @desc: Name of the shortcut that opens Monsters › Party, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.party': 'Équipe',
  // @desc: Name of the shortcut that opens the Journal, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.journal': 'Journal',
  // @desc: Name of the shortcut that opens Social › Trades, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.trades': 'Échanges',
  // @desc: Name of the shortcut that opens Social › Challenges, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.challenges': 'Défis',
  // @desc: Name of the shortcut that opens Social › Rankings, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.rankings': 'Classement',
  // @desc: Name of the shortcut that opens Profile › Name, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.name': 'Nom',
  // @desc: Name of the shortcut that opens Profile › Account, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.account': 'Compte',
  // @desc: Name of the shortcut that opens Controls, a row of the Shortcuts tab in
  // Controls. One short word. ui/controlsModel.ts
  'controls.accel.controls': 'Commandes',
  // @desc: Name of the shortcut that saves the local bug-report bundle, a row of the Shortcuts tab
  // in Controls. ui/controlsModel.ts
  'controls.accel.bugReport': 'Enregistrer un rapport de bug',
  // @desc: Name of the shortcut that dismisses the error notice, a row of the Shortcuts tab in
  // Controls. ui/controlsModel.ts
  'controls.accel.dismissError': 'Fermer l’erreur',
  // @desc: Line shown in Controls while a slot waits for a key press; {label} is the row
  // name (e.g. Confirm (A)). ui/controlsModel.ts
  'controls.capture.prompt': (p) => `Appuyez sur une touche pour : ${p.label}…`,
  // @desc: Feedback line in Controls when the pressed key is reserved (Tab, F5, F11, F12,
  // a modifier or a Ctrl/Alt/Meta chord). One sentence. ui/controlsModel.ts
  'controls.refused.reserved':
    'Cette touche appartient au navigateur et ne peut pas être attribuée.',
  // @desc: Feedback line in Controls when a change would leave a protected button (D-pad,
  // A, B, Start) with no key. One sentence. ui/controlsModel.ts
  'controls.refused.protected':
    'Les déplacements, Valider, Retour et Menu doivent toujours garder une touche.',
  // @desc: Feedback line in Controls when key capture ends without a change. One or two
  // words. ui/controlsModel.ts
  'controls.cancelled': 'Inchangé.',
  // @desc: Feedback line in Controls when a free key has been bound. One or two words.
  // ui/controlsModel.ts
  'controls.bound': 'Enregistré.',
  // @desc: Feedback line in Controls when the pressed key was bound elsewhere and the two
  // bindings swapped; {key}/{otherKey} are keycaps, {label}/{otherLabel} row names.
  // ui/controlsModel.ts
  'controls.swapped': (p) =>
    `Échangé : ${p.key} est maintenant ${p.label}, ${p.otherKey} est maintenant ${p.otherLabel}`,
  // @desc: Feedback line in Controls when the pressed key moved from another row into an
  // empty slot, leaving that row without a key; {key} is a keycap, {label}/{otherLabel} row names.
  // ui/controlsModel.ts
  'controls.swappedUnbound': (p) =>
    `Échangé : ${p.key} est maintenant ${p.label}, ${p.otherLabel} n’a plus de touche`,
  // @desc: Feedback line in Controls when a row's Primary and Alt keys traded places;
  // {key}/{otherKey} are keycaps, {label} the row name. ui/controlsModel.ts
  'controls.swappedSlots': (p) => `Échangé : ${p.key} et ${p.otherKey} pour ${p.label}`,
  // @desc: Heading of the Controls screen (key remapping). ui/controlsView.ts
  'controls.title': 'Commandes',
  // @desc: Tab of Controls listing the twelve virtual buttons. ui/controlsView.ts
  'controls.tab.buttons': 'Boutons',
  // @desc: Tab of Controls listing the optional shortcut keys. ui/controlsView.ts
  'controls.tab.shortcuts': 'Raccourcis',
  // @desc: A row's Primary key cell in Controls; {label} is the row name
  // (e.g. Confirm (A)), {key} its keycap or the no-key mark. ui/controlsView.ts
  'controls.slot.primary': (p) => `${p.label} : ${p.key}`,
  // @desc: A row's Alt (second) key cell in Controls; {label} is the row name, {key}
  // its keycap or the no-key mark. ui/controlsView.ts
  'controls.slot.alt': (p) => `${p.label} (alt.) : ${p.key}`,
  // @desc: Mark shown in an Controls key cell that holds no key. ui/controlsView.ts
  'controls.slot.none': '—',
  // @desc: Cell on a shortcut row of Controls that removes the shortcut's keys; {label}
  // is the row name. ui/controlsView.ts
  'controls.clear': (p) => `Effacer ${p.label}`,
  // @desc: Feedback line in Controls after a shortcut's keys were removed; {label} is
  // the row name. One sentence. ui/controlsView.ts
  'controls.cleared': (p) => `${p.label} n’a plus de touche.`,
  // @desc: Last row of each Controls tab: restore every default key. ui/controlsView.ts
  'controls.resetAll': 'Tout réinitialiser',
  // @desc: Yes / No question asked before Controls restores every default key.
  // ui/controlsView.ts
  'controls.reset.question': 'Réinitialiser toutes les commandes ?',
  // @desc: Feedback line in Controls after every default key was restored. One
  // sentence. ui/controlsView.ts
  'controls.reset.done': 'Toutes les commandes ont repris leur valeur par défaut.',
  // @desc: Button shown in Controls while a slot waits for a key press; it ends the
  // wait with nothing changed. One word. ui/controlsView.ts
  'controls.cancel': 'Annuler',
  // @desc: Appended to an Controls feedback line when the browser refused to store
  // the new keys: they work now and are lost on reload. One sentence. ui/controlsView.ts
  'controls.saveFailed': 'Enregistrement impossible : ce réglage dure jusqu’au rechargement.',
  // @desc: Tab of Controls holding the text-size setting. One word. ui/controlsView.ts
  'controls.tab.display': 'Affichage',
  // @desc: The default (x1) text size on the Controls › Display tab. One word. ui/controlsView.ts
  'controls.text.normal': 'Normale',
  // @desc: The x1.5 text size on the Controls › Display tab. One or two words. ui/controlsView.ts
  'controls.text.large': 'Grande',
  // @desc: The x2 text size on the Controls › Display tab. Two words at most. ui/controlsView.ts
  'controls.text.xlarge': 'Très grande',
  // @desc: A row of the Controls › Display tab; {label} is a text size (Normal, Large, Extra
  // large). ui/controlsView.ts
  'controls.text.row': (p) => `Taille du texte : ${p.label}`,
  // @desc: The row of the Controls › Display tab for the size in use; {label} is that size.
  // ui/controlsView.ts
  'controls.text.current': (p) => `Taille du texte : ${p.label} (actuelle)`,
  // @desc: Feedback line after a text size was chosen on Controls › Display; {label} is the size.
  // One sentence. ui/controlsView.ts
  'controls.text.set': (p) => `Taille du texte : ${p.label}.`,
  // @desc: Heading of the How to Play (help) overlay.
  // index.html #help-title (resolved in HelpView show())
  'chrome.help.title': 'Comment jouer',
  // @desc: Heading of the Journal overlay listing the player's active quests. One or two words.
  // questLogView.ts #quest-log-title (resolved in render())
  'journal.title': 'Journal',
  // @desc: How to Play tab with a short introduction to the game. Short (at most 14 characters).
  // ui/helpModel.ts
  'help.tab.intro': 'Introduction',
  // @desc: How to Play tab listing the game's terms and mechanics. Short (at most 14 characters).
  // ui/helpModel.ts
  'help.tab.encyclopedia': 'Encyclopédie',
  // @desc: First paragraph of How to Play's Introduction: a book-jacket blurb, no spoilers. Two or three sentences.
  // ui/helpModel.ts
  'help.intro.p1':
    'Au-delà des chemins du village, les hautes herbes s’animent. Des monstres sauvages parcourent le royaume, chacun sans pareil, et aucun n’appartient encore à personne. Quittez la route, affrontez-les sur le champ de bataille et gagnez les plus audacieux à votre cause.',
  // @desc: Second paragraph of How to Play's Introduction: a book-jacket blurb, no spoilers. Two or three sentences.
  // ui/helpModel.ts
  'help.intro.p2':
    'Faites grandir votre équipe par l’entraînement, les soins et l’essence que vous récoltez, et voyez-la prendre des formes inédites. Préparez chaque coup sur la grille tactique, puis partagez le monde avec d’autres joueurs : échangez, défiez-les et grimpez au classement. Votre royaume vous attend.',
  // @desc: How to Play's Introduction row that saves a bug report bundle (as F9 does). A short action label.
  // ui/helpModel.ts
  'help.intro.report': 'Signaler un problème',
  // @desc: Encyclopedia entry name (party): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.party.term': 'Équipe',
  // @desc: Encyclopedia definition of the party entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.party.def':
    'Les monstres que vous emmenez, jusqu’à six. Seuls les monstres de l’équipe peuvent combattre ou être envoyés en renfort.',
  // @desc: Encyclopedia entry name (storage): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.storage.term': 'Stockage',
  // @desc: Encyclopedia definition of the storage entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.storage.def':
    'Là où attendent vos autres monstres. Les nouvelles recrues y arrivent : sélectionnez un monstre puis Déplacer pour l’amener dans une place libre de l’équipe.',
  // @desc: Encyclopedia entry name (recruit): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.recruit.term': 'Recruter',
  // @desc: Encyclopedia definition of the recruit entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.recruit.def':
    'Gagner un monstre sauvage à votre cause au lieu de le vaincre : affaiblissez-le, placez-vous à côté et consacrez un tour entier à l’essai. Un échec coûte le tour.',
  // @desc: Encyclopedia entry name (bait): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.bait.term': 'Appât',
  // @desc: Encyclopedia definition of the bait entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.bait.def':
    'Un objet offert lors d’une tentative de recrutement pour améliorer les chances. Il est consommé, que la tentative réussisse ou non.',
  // @desc: Encyclopedia entry name (evolution): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.evolution.term': 'Évolution',
  // @desc: Encyclopedia definition of the evolution entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.evolution.def':
    'Un monstre qui remplit les conditions d’une voie devient une nouvelle espèce. Avec une seule voie ouverte, cela se fait seul ; avec plusieurs, vous choisissez dans la liste Évoluer.',
  // @desc: Encyclopedia entry name (essence): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.essence.term': 'Essence',
  // @desc: Encyclopedia definition of the essence entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.essence.def':
    'Une ressource propre à chaque affinité, gagnée en remportant des combats sauvages. Les voies d’évolution en demandent certaines quantités.',
  // @desc: Encyclopedia entry name (affinity): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.affinity.term': 'Affinité',
  // @desc: Encyclopedia definition of the affinity entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.affinity.def':
    'Le type élémentaire d’un monstre, comme Feu, Eau ou Plante. Les affrontements entre types décident des attaques fortes et faibles.',
  // @desc: Encyclopedia entry name (status): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.status.term': 'Altérations d’état',
  // @desc: Encyclopedia definition of the status entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.status.def':
    'Des conditions sur une unité. Le poison et la brûlure la blessent à chaque fin de manche ; la paralysie peut lui faire perdre un tour ; le sommeil et le gel l’empêchent d’agir jusqu’à ce qu’ils cessent.',
  // @desc: Encyclopedia entry name (ap): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.ap.term': 'Points d’action (PA)',
  // @desc: Encyclopedia definition of the ap entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.ap.def':
    'Ce qu’un monstre dépense pendant son tour en combat tactique : déplacements, techniques, objets et recrutement. Les points restants à la fin du tour sont perdus.',
  // @desc: Encyclopedia entry name (initiative): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.initiative.term': 'Initiative',
  // @desc: Encyclopedia definition of the initiative entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.initiative.def':
    'À chaque manche, les unités agissent de la plus rapide à la plus lente. La barre d’ordre des tours montre qui suit ; les changements de vitesse s’appliquent dès la manche suivante.',
  // @desc: Encyclopedia entry name (queue): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.queue.term': 'Plan d’action',
  // @desc: Encyclopedia definition of the queue entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.queue.def':
    'Un plan de trois actions au plus pour le prochain tour d’un monstre. Quand son tour vient, le plan s’exécute ; si une étape devient impossible, il s’arrête là et les points non dépensés reviennent.',
  // @desc: Encyclopedia entry name (idle): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.idle.term': 'Horloge d’inactivité',
  // @desc: Encyclopedia definition of the idle entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.idle.def':
    'Un minuteur de tour qui ne tourne que lorsque le combat vous attend. En PvP, un tour manqué passe tout seul ; en combat sauvage, trop attendre y met fin par une fuite.',
  // @desc: Encyclopedia entry name (stance): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.stance.term': 'Postures',
  // @desc: Encyclopedia definition of the stance entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.stance.def':
    'La façon dont un monstre sauvage se comporte en combat : un agressif fonce sur vous, celui qui garde son territoire le défend sans poursuivre, et un craintif garde ses distances.',
  // @desc: Encyclopedia entry name (guard): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.guard.term': 'Garde',
  // @desc: Encyclopedia definition of the guard entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.guard.def':
    'Terminez un tour sans attaquer et avec au moins 2 points non dépensés, et votre monstre se met en garde : il subit moins de dégâts jusqu’à son prochain tour.',
  // @desc: Encyclopedia entry name (deploy): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.deploy.term': 'Déploiement',
  // @desc: Encyclopedia definition of the deploy entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.deploy.def':
    'Avant un combat, choisissez quels monstres de l’équipe entrent sur le terrain et où ils se placent. Votre dernière formation est retenue.',
  // @desc: Encyclopedia entry name (ranked): a game term. One to three words.
  // ui/helpModel.ts
  'help.entry.ranked.term': 'Classé',
  // @desc: Encyclopedia definition of the ranked entry. One or two sentences.
  // ui/helpModel.ts
  'help.entry.ranked.def':
    'Les combats contre d’autres joueurs qui modifient votre cote. Gagnez-les pour grimper dans le tableau Classement.',
  // @desc: Encyclopedia detail line naming the related entries; {terms} is a comma-separated list of entry names.
  // ui/helpModel.ts
  'help.detail.related': (p) => `Voir aussi : ${p.terms}.`,
  // @desc: Submit button of the profile-rename dialog; short verb, fits a narrow button.
  // index.html:60 (resolved in RenameView show())
  'chrome.rename.submit': 'Renommer',
  // @desc: Status-strip error shown when the browser blocked the account data-export download.
  // main.ts:582
  'chrome.status.exportBlocked': 'export des données : téléchargement bloqué par le navigateur',
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
  // @desc: Status-strip error shown when the player moves a monster from the box to the party
  // but every party slot is taken; nothing is moved.
  'chrome.status.partyFull': 'équipe complète — placez d’abord un monstre dans la boîte',
  // @desc: Status-line notice, also spoken by the live region, when the player's own character
  // enters another zone; {name} is the destination zone's content-sourced display name.
  'chrome.status.zoneEntered': (p) => `Vous entrez dans ${p.name}`,
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
  // tactics/strings.ts, deployPanel.ts, results.ts, tacticsBattle.ts (the battle frame's title)
  'battle.title': 'Combat',
  // @desc: Outcome banner when the player's side wins the battle. Large bold text, one or two
  // words.
  // tactics/strings.ts (the results panel's victory title)
  'battle.outcome.victory': 'Victoire !',
  // @desc: Outcome banner when the player's side loses the battle. Large bold text, one or two
  // words.
  // tactics/strings.ts (the results panel's defeat title)
  'battle.outcome.defeat': 'Défaite…',
  // @desc: Outcome banner when the player successfully flees a wild battle. Large bold text, one
  // short phrase.
  // tactics/strings.ts (the results panel's fled title)
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
  // player's display name. One line; the Social sheet's Accept / Decline rows answer it.
  // pvpView.ts:190
  'pvp.incoming.label': (p) => `${p.challenger} vous lance un défi !`,
  // @desc: Status line while the player's own challenge is pending; {target} is the challenged
  // player's display name; carries a spaced em dash and an ellipsis. One line; the Social
  // sheet's Cancel row withdraws it.
  // pvpView.ts:221
  'pvp.outgoing.label': (p) => `Défi envoyé à ${p.target} — en attente…`,
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
  // @desc: Heading of the raising overlay, which shows the player's inventory (the Bag pockets;
  // monster stats live on the Monsters Summary). One short line.
  // raisingView.ts:104 (resolved in show())
  'raising.title': 'Inventaire',
  // @desc: Empty-state line of the raising overlay's inventory section when the player carries
  // nothing. One short line.
  // raisingView.ts:308
  'raising.inventory.empty': 'Aucun objet.',
  // @desc: Name line of an inventory card; {name} is the item name and {count} how many the
  // player carries (the "x" is a plain letter x). Glyph-only, so identical to English. Bold, one
  // line.
  // raisingView.ts:318
  'raising.inventory.item': (p) => `${p.name} (x${p.count})`,
  // @desc: Feedback line on the Monsters sheet after the server accepted a Care action on a
  // monster. One short line.
  // main.ts (dispatch, the `care` arm; pre-migration careAction.ts CARED_MESSAGE)
  'raising.feedback.cared': 'Choyé !',
  // @desc: Heading of the Monsters overlay, where the player arranges which monsters are in
  // the active party and which stay in storage (the 1v1 swap hint that quoted it left in bt-17). One short line.
  // boxView.ts:69 (resolved in show())
  'box.title': 'Monstres',
  // @desc: Explainer under the heading telling the player that only Party monsters battle and
  // that new recruits land in Storage; the quoted « Déplacer » must match the box.sheet.move
  // row label exactly (the Monsters sheet's Move row is the one way to move a monster). Two
  // sentences, wraps freely up to 600px wide; carries a spaced em dash.
  // boxView.ts:94-96 (resolved in show())
  'box.hint':
    'Seuls les monstres de votre équipe peuvent combattre ou être échangés en cours de combat. Les nouvelles recrues arrivent dans le Stockage — sélectionnez-en une et choisissez « Déplacer » pour la placer dans un emplacement libre de l’équipe.',
  // @desc: Placeholder text of an unoccupied party slot; {slot} is the slot index as shown today
  // (counted from 0). One short line, dimmed.
  // boxView.ts:160
  'box.party.emptySlot': (p) => `Emplacement ${p.slot} : (vide)`,
  // @desc: The empty Storage panel's reason line (the EmptyState, uif-6) when no monster is in
  // storage. One short line.
  // boxView.ts:173
  'box.box.empty': 'Aucun monstre dans le stockage.',
  // @desc: The empty Storage panel's cue (uif-6, the EmptyState): where stored monsters come
  // from. One short sentence, muted.
  // boxView.ts (#buildBox)
  'box.storage.emptyCue': 'Les monstres que vous recrutez sont gardés ici.',
  // @desc: The empty Storage panel's next step (uif-6, the EmptyState): what the player can do to
  // fill it. One short sentence.
  // boxView.ts (#buildBox)
  'box.storage.emptyNext': 'Recrutez un monstre sauvage en combat, puis revenez.',
  // @desc: Info line on a monster card in the party or box; {species} is the species name,
  // {level} the level ("Niv." abbreviates "Niveau"), {current}/{max} its hit points and
  // {percent} the same as a percentage. Keep the "PV {current}/{max}" shape. One line of small
  // text.
  // boxView.ts:205
  'box.card.stats': (p) =>
    `${p.species} · Niv.${p.level} · PV ${p.current}/${p.max} (${p.percent} %)`,
  // @desc: The full-stats line of the Monsters Summary pane; {trust} is the server's trust tier
  // tag, not translated (e.g. "Friendly"), and the five numbers are {attack}, {defense},
  // {speed}, {spAttack} (special attack) and {spDefense} (special defense), each prefixed by its
  // French abbreviation. One line of small text, about 70 characters wide.
  // boxView.ts (the Summary part)
  'box.summary.stats': (p) =>
    `Confiance ${p.trust} · ATQ ${p.attack} · DÉF ${p.defense} · VIT ${p.speed} · ATQ SPÉ ${p.spAttack} · DÉF SPÉ ${p.spDefense}`,
  // @desc: Badge on a monster card when the monster can evolve but the player must choose a path
  // on the Monsters sheet's Evolve list first. One short line; carries a leading star and a
  // spaced em dash.
  // boxView.ts:216
  'box.card.evolveBadge': '★ Prêt à évoluer — choisissez une voie',
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
  // @desc: Action on a monster's action sheet that moves it between the party and storage;
  // quoted verbatim inside box.hint, so the two must stay identical. One word.
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
  // @desc: Reason shown after the disabled Care row while the monster's care cooldown runs;
  // {hours} and {minutes} are the time left, rounded up to the whole minute (1 ms reads 0h 1m).
  // Short phrase.
  // boxView.ts (the Monsters frame)
  'box.sheet.careCooldown': (p) => `Prêt dans ${p.hours} h ${p.minutes} min`,
  // @desc: Status line of the trade overlay when the player is in no trade. One short line.
  // tradeView.ts
  'trade.status.none': 'Aucun échange en cours',
  // @desc: One monster row on a trade side; {nickname} is the monster's nickname, {species} its
  // species name, {level} its level ("Niv." abbreviates "Niveau") and {current}/{max} its hit
  // points ("PV"). One line.
  // tradeSessionView.ts
  'trade.side.card': (p) =>
    `${p.nickname} (${p.species}) Niv.${p.level} PV : ${p.current}/${p.max}`,
  // @desc: Currency row on a trade side; {amount} is the number of gold coins offered and "or"
  // is the currency name (gold). Very short, one line.
  // tradeSessionView.ts
  'trade.side.currency': (p) => `${p.amount} or`,
  // @desc: Placeholder row on a trade side that offers no monster, item or gold. One word in
  // parentheses.
  // tradeSessionView.ts
  'trade.side.nothing': '(rien)',
  // @desc: Status line of the Social Trades panel when the player has at least one open trade
  // session. Two words.
  // tradeView.ts
  'trade.status.open': 'Échanges en cours',
  // @desc: First line of a trade-session row on the Social Trades panel; {name} is the other
  // player's name.
  // tradeView.ts
  'trade.row.title': (p) => `Échange avec ${p.name}`,
  // @desc: Second line of a trade-session row: whether each side has confirmed; {mine} and {theirs}
  // are the resolved tradeSession.mark.* words.
  // tradeView.ts
  'trade.row.marks': (p) => `Vous : ${p.mine} · Eux : ${p.theirs}`,
  // @desc: Heading of the trade session editor; {name} is the other player's name.
  // tradeSessionView.ts
  'tradeSession.title': (p) => `Échange avec ${p.name}`,
  // @desc: Heading of the editor's panel listing what the player has put into the trade.
  // tradeSessionView.ts
  'tradeSession.side.mine': 'Votre offre',
  // @desc: Heading of the editor's panel listing what the other player has put into the trade.
  // tradeSessionView.ts
  'tradeSession.side.theirs': 'Son offre',
  // @desc: Mark on a side of a trade session whose owner has confirmed the trade. One word.
  // tradeSessionView.ts, tradeView.ts
  'tradeSession.mark.confirmed': 'Confirmé',
  // @desc: Mark on a side of a trade session whose owner has not confirmed yet. Two words.
  // tradeSessionView.ts, tradeView.ts
  'tradeSession.mark.unconfirmed': 'Non confirmé',
  // @desc: An editor row that cannot be used right now; {label} is the row's own text and {reason}
  // a resolved tradeSession.reason.* phrase.
  // tradeSessionView.ts
  'tradeSession.row.blocked': (p) => `${p.label} — ${p.reason}`,
  // @desc: Why a party monster cannot be offered: it has no HP left. Lower case, one word.
  // tradeSessionView.ts
  'tradeSession.reason.fainted': 'K.O.',
  // @desc: Why a party monster cannot be offered: it is already offered in another trade. Lower case.
  // tradeSessionView.ts
  'tradeSession.reason.inAnotherTrade': 'dans un autre échange',
  // @desc: Why a party monster cannot be offered: it is in a battle. Lower case.
  // tradeSessionView.ts
  'tradeSession.reason.inBattle': 'en combat',
  // @desc: Why another monster cannot be added: the offer already holds the most a side may give.
  // Lower case.
  // tradeSessionView.ts
  'tradeSession.reason.limit': 'offre complète',
  // @desc: Why the trade cannot be confirmed yet: the player changed the offer and has not sent it.
  // Lower case.
  // tradeSessionView.ts
  'tradeSession.reason.unsent': 'envoyez d’abord votre offre',
  // @desc: Why the offer cannot be sent: it is the same as the one already on the table. Lower case.
  // tradeSessionView.ts
  'tradeSession.reason.nothingToSend': 'aucun changement',
  // @desc: An item row of the editor's picker; {name} is the item, {qty} how many are offered and
  // {held} how many the player has. Numbers are digits.
  // tradeSessionView.ts
  'tradeSession.row.item': (p) => `${p.name} : ${p.qty} sur ${p.held}`,
  // @desc: The coins row of the editor's picker; {amount} is how many coins are offered and
  // {balance} how many the player has. Numbers are digits.
  // tradeSessionView.ts
  'tradeSession.row.coins': (p) => `Pièces : ${p.amount} sur ${p.balance}`,
  // @desc: Editor row that sends the player's changed offer to the other player. Two words.
  // tradeSessionView.ts
  'tradeSession.row.apply': 'Mettre à jour l’offre',
  // @desc: Editor row that confirms the trade as it is shown. Two words.
  // tradeSessionView.ts
  'tradeSession.row.confirm': 'Valider l’échange',
  // @desc: Editor row that cancels the whole trade for both players. Two words.
  // tradeSessionView.ts
  'tradeSession.row.cancel': 'Annuler l’échange',
  // @desc: The Yes / No question before the player confirms a trade; No is the default answer.
  // tradeSessionView.ts
  'tradeSession.prompt.confirm': 'Confirmer cet échange ? Un échange conclu est définitif.',
  // @desc: The Yes / No question before the player confirms a trade whose own side offers a
  // monster: a traded monster's trust and quality time start over, and trading it back does not
  // restore them. No is the default answer.
  // tradeSessionView.ts
  'tradeSession.prompt.confirmMonsters':
    'Confirmer cet échange ? Un échange conclu est définitif. Les monstres échangés perdent leur confiance et leur temps de qualité avec vous, même s’ils vous reviennent.',
  // @desc: The Yes / No question before the player cancels a trade; No is the default answer.
  // tradeSessionView.ts
  'tradeSession.prompt.cancel': 'Annuler cet échange ?',
  // @desc: Notice inside the editor after either offer changed and every confirmation was cleared.
  // tradeSessionView.ts
  'tradeSession.notice.changed': 'L’offre a changé. Vérifiez-la avant de confirmer.',
  // @desc: Toast shown when a trade the player was in is over: completed, cancelled or dropped.
  // main.ts
  'tradeSession.notice.closed': 'Échange terminé.',
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
  // @desc: Row of the action sheet opened on a PvP challenge: accept it. One short verb.
  // tradeView.ts (the Social action sheet)
  'social.action.accept': 'Accepter',
  // @desc: Row of the action sheet opened on a PvP challenge: decline it (a Yes / No question
  // follows). One short verb.
  // tradeView.ts (the Social action sheet)
  'social.action.decline': 'Refuser',
  // @desc: Row of the action sheet opened on the player's own PvP challenge: withdraw it. One short
  // verb.
  // tradeView.ts (the Social action sheet)
  'social.action.cancel': 'Annuler',
  // @desc: The Yes / No question before a PvP challenge is declined; No is the default answer.
  // tradeView.ts (the Social prompt)
  'social.confirm.declineChallenge': 'Refuser ce défi ?',
  // @desc: Button in the NPC dialogue overlay that opens the shop this NPC runs; shown only when
  // the NPC has one. One word, fits a narrow button.
  // dialogueView.ts:72
  'dialogue.action.shop': 'Boutique',
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
  // @desc: The heal frame's title, the first line of its title bar. One or two words.
  // healView.ts (render, the title bar)
  'heal.title': 'Soins',
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
  // @desc: Heading of the privacy & account-data overlay (account deletion, data export). One
  // short line.
  // privacyView.ts (resolved in show())
  'privacy.title': 'Confidentialité et données du compte',
  // @desc: The pseudonymization disclosure under the Privacy section's controls: what account
  // deletion removes and what it keeps. Compliance text: the English is the exact mandated wording
  // (privacyBanner.ts PRIVACY_PSEUDONYMIZATION_DISCLOSURE, pinned byte for byte); translate it
  // faithfully, keep `Identity` in backticks, and never promise erasure. A paragraph.
  // privacyView.ts (resolved in show())
  'privacy.disclosure':
    'Les champs directs de nom et d’affichage sont dissociés lors de la suppression. La clé `Identity`, ' +
    'ainsi que les horodatages et l’historique comportemental qui lui sont associés, ne sont pas ' +
    'purgés des lignes multi-utilisateurs ou historiques ; il s’agit d’une limite de ' +
    'pseudonymisation documentée et acceptée, et non d’un effacement.',
  // @desc: Button that closes the Profile screen; it is the last row and always enabled. Short
  // verb, fits a very narrow button.
  // ui/profileView.ts (resolved in show())
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
  // @desc: Title of the main menu side panel.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.title': 'Menu',
  // @desc: Main-menu entry opening the monster box (party and storage).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.monsters.title': 'Monstres',
  // @desc: Feedback-line description of the Monsters main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.monsters.desc': 'Voir votre équipe et vos monstres stockés.',
  // @desc: Main-menu entry opening the Inventory (items, feeding and care).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.bag.title': 'Inventaire',
  // @desc: Feedback-line description of the Inventory main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.bag.desc': 'Utiliser des objets et soigner vos monstres.',
  // @desc: Main-menu entry opening the quest journal.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.journal.title': 'Journal',
  // @desc: Feedback-line description of the Journal main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.journal.desc': 'Consulter vos quêtes et leur progression.',
  // @desc: Main-menu entry opening the Social frame (Players, Trades, Challenges, Rankings tabs).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.title': 'Social',
  // @desc: Feedback-line description of the Social main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.social.desc': 'Échanges, défis et classements avec les autres joueurs.',
  // @desc: Main-menu entry opening the Profile screen (name, account, privacy).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.title': 'Profil',
  // @desc: Feedback-line description of the Profile main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.profile.desc': 'Votre nom, votre compte et vos réglages de confidentialité.',
  // @desc: Main-menu entry that closes the menu and returns to the world.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.close.title': 'Fermer',
  // @desc: Feedback-line description of the Close main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.close.desc': 'Fermer le menu et revenir au monde.',
  // @desc: Header of the Name section of the Profile screen (the rename form).
  // ui/renameView.ts
  'menu.profile.name.title': 'Nom',
  // @desc: Header of the Account section of the Profile screen (sign-in and guest claim).
  // ui/claimView.ts
  'menu.profile.account.title': 'Compte',
  // @desc: Main-menu entry opening the How to Play help screen (uif-15c: a root entry; it was in
  // the retired Options sub-list).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.help.title': 'Comment jouer',
  // @desc: Feedback-line description of the How to Play main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.help.desc': 'Commandes et objectifs du jeu.',
  // @desc: Main-menu entry opening the Controls screen (key remapping; uif-15c: a root entry).
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.controls.title': 'Commandes',
  // @desc: Feedback-line description of the Controls main-menu entry, shown on Y.
  // ui/menuModel.ts (MENU_ENTRIES)
  'menu.controls.desc': 'Choisir la touche de chaque bouton.',
  // @desc: Reason a main-menu entry is disabled while the menu is open over a battle (feedback
  // line); also the status-line and announced reason when an action is refused during a battle.
  // ui/screens/mainMenuScreen.ts (battleReason); main.ts (refusedInBattle)
  'menu.disabled.inBattle': 'Impossible pendant un combat',
  // @desc: Feedback-line reason the Inventory main-menu entry is disabled over a battle: use the
  // battle's own Items command (tactics.menu.item).
  // ui/screens/mainMenuScreen.ts (battleReason)
  'menu.disabled.battleBag': 'Utilisez les objets avec la commande Objets du combat',
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
  // @desc: Bag empty-pocket cue: where items come from. One short sentence. uif-8 (UIF8.4).
  // raisingView.ts (the Bag frame's EmptyState)
  'bag.empty.cue': 'Les objets s’obtiennent à la boutique et en combattant dans la nature.',
  // @desc: Bag empty-pocket next step: what the player can do. One short sentence; LB / RB are
  // the pocket-switch buttons. uif-8 (UIF8.4). raisingView.ts (the Bag frame's EmptyState)
  'bag.empty.next':
    'Rendez-vous dans une boutique, ou appuyez sur LB / RB pour voir une autre poche.',
  // @desc: Journal quest detail line; {step} is the quest's current step number counted from 0.
  // questLogView.ts (the Journal detail)
  'journal.detail.step': (p) => `Étape ${p.step}`,
  // @desc: Journal empty state, shown instead of a blank list when the player has no active
  // quest: the reason, then where quests come from and what to do next. Names no key or button
  // (bindings are remappable). One or two short sentences. questLogView.ts #quest-log-empty
  'journal.empty': 'Aucune quête en cours. Parlez aux villageois pour savoir qui a besoin d’aide.',
  // @desc: Status line when a conversation ended because the player chose a reply after moving
  // too far from the NPC: says the conversation ended and why. One short sentence.
  // main.ts endedLine (the refused advance_dialogue, "walked too far away")
  'dialogue.ended.walkedAway': 'Conversation terminée : vous êtes trop loin.',
  // @desc: Status line when a conversation ended because the player and the NPC are no longer
  // in the same zone: says the conversation ended and why. One short sentence.
  // main.ts endedLine (the refused advance_dialogue, "no longer in same zone")
  'dialogue.ended.leftZone': 'Conversation terminée : vous avez quitté la zone.',
  // @desc: Status line when a conversation ended because the NPC is gone: says the conversation
  // ended and why. One short sentence.
  // main.ts endedLine (the refused advance_dialogue, "npc not found" / "npc character not found")
  'dialogue.ended.npcGone': 'Conversation terminée : il n’y a plus personne ici.',
  // @desc: Status line acknowledging a completed quest and the gold it paid; {name} is the quest
  // content id shown verbatim (as in the Journal), {amount} the gold gained. One short line.
  // main.ts (the quest-completion batch listener)
  'quest.complete.reward': (p) => `Quête terminée : ${p.name}. Vous avez reçu ${p.amount} or.`,
  // @desc: Status line acknowledging a completed quest that paid no gold; {name} is the quest
  // content id shown verbatim (as in the Journal). One short line.
  // main.ts (the quest-completion batch listener)
  'quest.complete.done': (p) => `Quête terminée : ${p.name}.`,
  // bt-10 (BT10.5/BT10.6): the tactical client's text (tactics/strings.ts is the only requester).
  // @desc: Accessible name of the tactical battle board (the grid of tiles and units). One or two
  // words.
  'tactics.board.label': 'Champ de bataille',
  // @desc: Accessible name of the tactical battle's bottom command band. One word.
  'tactics.dock.label': 'Commandes',
  // @desc: Accessible name of the tactical battle's running list of event lines. One or two words.
  'tactics.ticker.label': 'Journal de combat',
  // @desc: Accessible name of the strip of unit chips that shows who acts next. One or two words.
  'tactics.turnbar.label': 'Ordre des tours',
  // @desc: Label on a turn-bar chip whose unit has already locked its plan for the round. One or
  // two words.
  'tactics.turnbar.locked': 'Plan verrouillé',
  // @desc: Turn-bar badge shown while the player-versus-player surge (rising damage) is in effect.
  // One word.
  'tactics.turnbar.surgeActive': 'Surcharge !',
  // @desc: Chip on a unit info box: the unit is guarding this round. One word.
  'tactics.hud.guard': 'Garde',
  // @desc: Chip on a unit info box: the unit still holds its one-time first-stand protection. Two
  // words.
  'tactics.hud.firstStand': 'Premier rempart',
  // @desc: A wild monster's AI stance: it attacks on sight. One word.
  'tactics.stance.aggressive': 'Agressif',
  // @desc: A wild monster's AI stance: it defends its area but does not chase. A short phrase.
  'tactics.stance.territorial': 'Garde son territoire',
  // @desc: A wild monster's AI stance: it keeps away and flees. One word.
  'tactics.stance.skittish': 'Craintif',
  // @desc: A status condition shown as an adjective on a unit: poison. One word.
  'tactics.status.poison': 'Empoisonné',
  // @desc: A status condition shown as an adjective on a unit: burn. One word.
  'tactics.status.burn': 'Brûlé',
  // @desc: A status condition shown as an adjective on a unit: paralysis. One word.
  'tactics.status.paralysis': 'Paralysé',
  // @desc: A status condition shown as an adjective on a unit: sleep. One word.
  'tactics.status.sleep': 'Endormi',
  // @desc: A status condition shown as an adjective on a unit: freeze. One word.
  'tactics.status.freeze': 'Gelé',
  // @desc: Marker over an enemy unit showing it plans to attack next. One word.
  'tactics.intent.attack': 'Attaque',
  // @desc: Marker over an enemy unit showing it plans to move next. One word.
  'tactics.intent.move': 'Déplacement',
  // @desc: Marker over an enemy unit showing it plans to hold its position next. One word.
  'tactics.intent.hold': 'Attente',
  // @desc: Reason a queued plan stopped: its target is no longer there. Lower-case, inserted after
  // a colon in the halted line.
  'tactics.halt.targetGone': 'cible disparue',
  // @desc: Reason a queued plan stopped: the target is too far or unreachable. Lower-case, inserted
  // after a colon in the halted line.
  'tactics.halt.outOfReach': 'hors de portée',
  // @desc: Reason a queued plan stopped: the unit can no longer act. Lower-case, inserted after a
  // colon in the halted line.
  'tactics.halt.cannotAct': 'action impossible',
  // @desc: Reason a queued plan stopped: the item is not in the bag. Lower-case, inserted after a
  // colon in the halted line.
  'tactics.halt.itemNotHeld': 'objet non possédé',
  // @desc: Reason a queued plan stopped: not enough action points or resources. Lower-case,
  // inserted after a colon in the halted line.
  'tactics.halt.unaffordable': 'trop coûteux',
  // @desc: Reason a recruit stopped: there is no room in the party. Lower-case, inserted after a
  // colon in the halted line.
  'tactics.halt.partyFull': 'équipe pleine',
  // @desc: Reason a queued plan stopped: the action is not allowed here. Lower-case, inserted after
  // a colon in the halted line.
  'tactics.halt.notAllowed': 'non autorisé',
  // @desc: Battle-log line when a tactical battle starts. One short sentence.
  'tactics.ticker.battleStarted': 'Le combat commence',
  // @desc: Battle-log line when the player's side wins. One short sentence.
  'tactics.ticker.won': 'Vous avez gagné le combat',
  // @desc: Battle-log line when the player's side loses. One short sentence.
  'tactics.ticker.lost': 'Vous avez perdu le combat',
  // @desc: Battle-log line when the battle ends because a side fled. One short sentence.
  'tactics.ticker.fled': 'Le combat s’est terminé : fuite',
  // @desc: Battle-log line when the battle ends with no winner recorded. Two words.
  'tactics.ticker.battleEnded': 'Combat terminé',
  // @desc: Turn-bar heading with the current round; {round} is the round number counted from 1. Two
  // words.
  'tactics.turnbar.round': (p) => `Manche ${p.round}`,
  // @desc: Turn-bar badge counting down the rounds until the surge begins; {n} is the number of
  // rounds left. A short phrase.
  'tactics.turnbar.surgeIn': (p) => `Surcharge dans ${p.n}`,
  // @desc: Turn-bar badge naming the round at which a wild battle forces a retreat; {round} is that
  // round number. A short phrase.
  'tactics.turnbar.retreatAt': (p) => `Retraite à la manche ${p.round}`,
  // @desc: Level label on a unit info box; {level} is the unit's level. Abbreviation plus number.
  'tactics.hud.level': (p) => `Niv.${p.level}`,
  // @desc: Hit-point line on a unit info box; {hp} is current and {max} the maximum hit points.
  // Abbreviation plus fraction.
  'tactics.hud.hp': (p) => `PV ${p.hp}/${p.max}`,
  // @desc: Action-point line on the active unit's info box; {ap} is points left and {max} the pool
  // size. Abbreviation plus fraction.
  'tactics.hud.ap': (p) => `PA ${p.ap}/${p.max}`,
  // @desc: Role chip on a unit info box; {role} is the unit's role name, carried verbatim from game
  // data. A short label.
  'tactics.hud.role': (p) => `Rôle : ${p.role}`,
  // @desc: Battle-log line when a unit uses a skill; {unit} is the actor and {skill} the skill
  // name. One short sentence.
  'tactics.ticker.executed': (p) => `${p.unit} utilise ${p.skill}`,
  // @desc: Battle-log clause for a hit; {target} is the unit hit and {damage} the damage dealt. One
  // short clause.
  'tactics.ticker.hit': (p) => `${p.target} subit ${p.damage} dégâts`,
  // @desc: Battle-log clause for a miss; {unit} is the attacker and {target} the unit it missed.
  // One short clause.
  'tactics.ticker.missed': (p) => `${p.unit} rate ${p.target}`,
  // @desc: Battle-log line when a unit's queued plan stops; {unit} is the actor and {reason} is a
  // lower-case reason text from the tactics.halt.* keys. One short sentence.
  'tactics.ticker.halted': (p) => `${p.unit} s’arrête : ${p.reason}`,
  // @desc: Battle-log line when a unit's queued plan is discarded; {unit} is the actor. One short
  // sentence.
  'tactics.ticker.voided': (p) => `${p.unit} perd son plan en attente`,
  // @desc: Battle-log line when a unit is passed automatically for not acting in time; {unit} is
  // the actor and {strike} how many such misses it has. One short sentence.
  'tactics.ticker.autoPass': (p) => `${p.unit} passe (échec ${p.strike})`,
  // @desc: Battle-log line when a unit holds its position instead of moving; {unit} is the actor.
  // One short sentence.
  'tactics.ticker.stoodGround': (p) => `${p.unit} tient bon`,
  // @desc: Battle-log line when a status condition lands; {unit} is the unit and {status} the
  // adjective from tactics.status.*. One short sentence.
  'tactics.ticker.statusApplied': (p) => `${p.unit} est maintenant ${p.status}`,
  // @desc: Battle-log line for status damage at the end of a round; {unit} is the unit, {amount}
  // the damage, {status} the adjective from tactics.status.*. One short sentence.
  'tactics.ticker.statusTick': (p) => `${p.unit} subit ${p.amount} dégâts (${p.status})`,
  // @desc: Battle-log line when a status condition ends; {unit} is the unit and {status} the
  // adjective from tactics.status.*. One short sentence.
  'tactics.ticker.statusCured': (p) => `${p.unit} n’est plus ${p.status}`,
  // @desc: Battle-log line when a status condition fails to land; {unit} is the unit and {status}
  // the adjective from tactics.status.*. One short sentence.
  'tactics.ticker.statusBlocked': (p) => `${p.unit} résiste (${p.status})`,
  // @desc: Battle-log line when the Surge (rising damage late in a PvP battle) hurts a unit; {unit}
  // is the unit and {amount} the damage it takes. One short sentence.
  'tactics.ticker.surge': (p) => `${p.unit} subit ${p.amount} dégâts de Surcharge`,
  // @desc: Battle-log clause when a unit faints; {unit} is the unit. One short clause.
  'tactics.ticker.ko': (p) => `${p.unit} est mis K.O.`,
  // @desc: Battle-log line when a recruit attempt succeeds; {target} is the recruited monster. One
  // short sentence.
  'tactics.ticker.recruitOk': (p) => `${p.target} rejoint votre équipe`,
  // @desc: Battle-log line when a recruit attempt fails; {target} is the monster and {pct} the
  // percent chance it had. One short sentence.
  'tactics.ticker.recruitFail': (p) => `Échec du recrutement de ${p.target} (${p.pct}%)`,
  // @desc: Battle-log line for a unit's end-of-battle rewards; {unit} is the unit, {xp} experience,
  // {essence} essence and {currency} gold. One short sentence.
  'tactics.ticker.awards': (p) =>
    `${p.unit} gagne ${p.xp} XP, ${p.essence} essence et ${p.currency} or`,
  // @desc: Battle-log line when a unit moves; {unit} is the actor and {tiles} how many tiles it
  // moved. One short sentence.
  'tactics.ticker.moved': (p) => `${p.unit} se déplace de ${p.tiles} case(s)`,
  // @desc: Battle-log line when a unit uses a bag item; {unit} is the actor, {item} the item name
  // and {target} the unit it was used on. One short sentence.
  'tactics.ticker.itemUsed': (p) => `${p.unit} utilise ${p.item} sur ${p.target}`,
  // @desc: Battle-log line when a unit ends its turn; {unit} is the unit. One short sentence.
  'tactics.ticker.turnEnded': (p) => `${p.unit} termine son tour`,
  // @desc: Battle-log line when a unit ends its turn guarding; {unit} is the unit. One short
  // sentence.
  'tactics.ticker.guarded': (p) => `${p.unit} se met en garde`,
  // @desc: Battle-log line when a round ends; {round} is the round number counted from 1. One short
  // sentence.
  'tactics.ticker.roundEnded': (p) => `Fin de la manche ${p.round}`,
  // @desc: Banner for the current unit's turn while its plan is not yet locked (an own unit or a
  // human opponent's); {unit} is that unit's name. Neutral wording. One short phrase.
  'tactics.banner.turn': (p) => `Au tour de ${p.unit}`,
  // bt-11 (BT11.1/BT11.2/BT11.6): the command menu, its reasons, the plan strip, the ghost and the
  // dock buttons (tactics/strings.ts is the only requester).
  // @desc: Accessible name of the tactical battle's command menu (the list of actions a unit can
  // take). Two short words.
  'tactics.menu.label': 'Menu des commandes',
  // @desc: Command-menu row and plan chip: move the unit to a tile. One short word.
  'tactics.menu.move': 'Déplacer',
  // @desc: Command-menu row opening the unit's list of attack skills. One short word.
  'tactics.menu.skills': 'Compétences',
  // @desc: Command-menu row for using an item (greyed in this phase of the game). One short word.
  'tactics.menu.item': 'Objets',
  // @desc: Command-menu row and plan chip: try to recruit an adjacent wild monster. One short
  // word.
  'tactics.menu.recruit': 'Recruter',
  // @desc: Command-menu row and plan chip: leave the wild battle. One short word.
  'tactics.menu.flee': 'Fuir',
  // @desc: Command-menu row and plan chip: end the unit's turn without Guard. Two short words.
  'tactics.menu.endTurn': 'Fin du tour',
  // @desc: Command-menu row label replacing End Turn when ending the turn now grants Guard
  // (reduced damage until the next turn). One short word.
  'tactics.menu.guard': 'Garde',
  // @desc: Command-menu row while pre-planning a unit's next turn: sends the planned steps. One
  // short word.
  'tactics.menu.submit': 'Envoyer',
  // @desc: Command-menu row that opens a confirmation to discard a unit's already-sent plan. Two
  // short words.
  'tactics.menu.clearPlan': 'Effacer le plan',
  // @desc: Confirmation row that discards the unit's sent plan. One short sentence.
  'tactics.menu.clearYes': 'Oui, effacer le plan',
  // @desc: Confirmation row that keeps the unit's sent plan and closes the menu. One short
  // phrase.
  'tactics.menu.clearNo': 'Garder le plan',
  // @desc: Bait sub-list row: attempt the recruit without a bait item. Two short words.
  'tactics.menu.noBait': 'Sans appât',
  // @desc: Reason shown on a greyed skill row: no target can be hit from here. One short phrase.
  'tactics.reason.outOfRange': 'Hors de portée',
  // @desc: Reason shown on the greyed Recruit row: the party has no room for a recruit. Two short
  // words.
  'tactics.reason.partyFull': 'Équipe au complet',
  // @desc: Reason shown on a greyed row: the unit lacks the action points (AP) it costs. One
  // short phrase.
  'tactics.reason.unaffordable': 'Pas assez de PA',
  // @desc: Reason shown on the greyed Move row: the unit has already moved its two strides this
  // turn. One short phrase.
  'tactics.reason.strideCap': 'Plus de foulées',
  // @desc: Reason shown on the greyed Item row: items cannot be used in tactical battles in this
  // phase. One short phrase.
  'tactics.reason.notAvailable': 'Pas encore disponible',
  // @desc: Reason shown on greyed rows once the planned turn ends with End Turn, Recruit or Flee.
  // Two short words.
  'tactics.reason.planComplete': 'Plan terminé',
  // @desc: Reason shown on the greyed Move row: a stride is affordable but no tile can be
  // reached. One short phrase.
  'tactics.reason.boxedIn': 'Aucune case à portée',
  // @desc: Accessible name of the strip of planned steps (chips) for the selected unit. One short
  // word.
  'tactics.queue.label': 'Plan d’action',
  // @desc: Status notice when the player clears a sent plan after the unit's turn has already
  // begun. One short line; the dash is U+2014.
  'tactics.queue.tooLate': 'Trop tard — déjà en action',
  // @desc: Accessible name of the translucent sprite drawn where a planned move ends. Two short
  // words.
  'tactics.ghost.label': 'Position prévue',
  // @desc: Accessible name of the command-dock button that toggles the purple danger overlay (the
  // pointer twin of the X button). Two short words.
  'tactics.dock.danger': 'Zone de danger',
  // @desc: Accessible name of the command-dock button selecting the previous own unit (the
  // pointer twin of LB). Two short words.
  'tactics.dock.prevUnit': 'Unité précédente',
  // @desc: Accessible name of the command-dock button selecting the next own unit (the pointer
  // twin of RB). Two short words.
  'tactics.dock.nextUnit': 'Unité suivante',
  // @desc: Reason shown on the greyed Recruit row: recruiting needs the unit's whole action-point
  // budget AND an adjacent wild, so the turn must start next to one; {ap} is the full budget. One
  // short line; the dash is U+2014.
  'tactics.reason.recruitFullAp': (p) => `Il faut les ${p.ap} PA — commencez le tour adjacent`,
  // @desc: Reason shown on the greyed Flee row: fleeing needs the unit's whole action-point
  // budget; {ap} is the full budget. One short phrase.
  'tactics.reason.fleeFullAp': (p) => `Il faut les ${p.ap} PA`,
  // @desc: Word of the plan strip's badge on a step certain to execute as planned (a live-turn step,
  // End Turn or Flee). One short word; its glyph is a check mark.
  'tactics.badge.firm': 'Ferme',
  // @desc: Word of the plan strip's badge on a pre-queued step that holds only if the board stays as
  // projected. One short word; its glyph is a tilde.
  'tactics.badge.provisional': 'Provisoire',
  // @desc: Word of the plan strip's badge on a step the rules would now refuse (its target gone, its
  // path blocked, the plan unaffordable). One short word; its glyph is a cross.
  'tactics.badge.stale': 'Périmé',
  // @desc: Accessible name of the forecast panel shown while the player aims a skill or a recruit
  // attempt. One short word.
  'tactics.forecast.label': 'Prévision',
  // @desc: Forecast line when the aimed skill cannot hit the target at any accuracy roll. One short
  // phrase.
  'tactics.forecast.miss': 'Ne peut pas toucher',
  // @desc: Forecast line item when the target's type takes no damage from the skill's type. Two
  // short words.
  'tactics.forecast.typeImmune': 'Aucun effet',
  // @desc: Forecast line item for the same-type attack bonus (the skill shares the attacker's type).
  // The acronym STAB or a short phrase.
  'tactics.forecast.stab': 'Bonus d’affinité',
  // @desc: Accessible name of the full skull: the minimum damage roll knocks the target out. One
  // short word.
  'tactics.forecast.lethal': 'Létal',
  // @desc: Accessible name of the hollow skull: only the maximum damage roll knocks the target out.
  // One short phrase.
  'tactics.forecast.lethalMax': 'Létal au jet maximal',
  // @desc: Forecast line when the target's First Stand would catch the blow and leave it at 1 HP.
  // One short phrase.
  'tactics.forecast.firstStand': 'Survit à 1 PV',
  // @desc: Label over a pre-queued forecast: its numbers are projected from planned moves and may
  // change before the unit acts. One short line; the dash is U+2014.
  'tactics.projected.label': 'Projeté — le plateau peut changer',
  // @desc: Caveat under a pre-queued forecast in a player-versus-player battle: the projection
  // assumes the enemy units do not move. One short phrase.
  'tactics.projected.enemiesHold': 'suppose que les ennemis restent en place',
  // @desc: Note on a plan-strip Recruit step whose bait is planned more often than the bag holds;
  // {n} is how many the player holds. One short phrase.
  'tactics.badge.onlyHeld': (p) => `seulement ${p.n} en stock`,
  // @desc: Accessible name of a plan-strip step's action-point pips; {ap} is the step's cost in
  // action points. A number and the unit.
  'tactics.chip.cost': (p) => `${p.ap} PA`,
  // @desc: First forecast line naming the aimed target; {unit} is the target's name. Two short words.
  'tactics.forecast.vs': (p) => `contre ${p.unit}`,
  // @desc: Forecast line with the chance to hit; {pct} is a whole percentage. One short phrase.
  'tactics.forecast.hit': (p) => `Touche ${p.pct} %`,
  // @desc: Forecast line with the damage range; {min} and {max} are hit points, the dash is U+2013.
  // One short phrase.
  'tactics.forecast.damage': (p) => `${p.min}–${p.max} dégâts`,
  // @desc: Forecast line item for a whole-number type multiplier; {num} is the multiplier. The sign is
  // U+00D7.
  'tactics.forecast.typeTimes': (p) => `Affinité ×${p.num}`,
  // @desc: Forecast line item for a fractional type multiplier; {num} over {den}. The sign is U+00D7.
  'tactics.forecast.typeOver': (p) => `Affinité ×${p.num}/${p.den}`,
  // @desc: Forecast line item for the flanking multiplier; {num} over {den}. The sign is U+00D7.
  'tactics.forecast.flank': (p) => `Flanc ×${p.num}/${p.den}`,
  // @desc: Forecast line item for the target's Guard multiplier; {num} over {den}. The sign is U+00D7.
  'tactics.forecast.guard': (p) => `Garde ×${p.num}/${p.den}`,
  // @desc: Forecast line for the status the skill may inflict; {status} is the status word already
  // translated. One short phrase.
  'tactics.forecast.status': (p) => `Peut infliger ${p.status}`,
  // @desc: Forecast line with the recruit chance; {pct} is a whole percentage. One short phrase.
  'tactics.forecast.recruit': (p) => `Recrutement ${p.pct} %`,
  // @desc: Forecast line item summing the recruit chance: {base} the species base, {bait} the bait's
  // share, {weakened} the low-health share, {pct} the total. Numbers and signs only.
  'tactics.forecast.recruitLines': (p) => `${p.base} + ${p.bait} + ${p.weakened} = ${p.pct} %`,
  // @desc: Forecast line naming the bait chosen for the recruit attempt; {item} is the item's name
  // or the no-bait label. One short phrase.
  'tactics.forecast.bait': (p) => `Appât : ${p.item}`,
  // @desc: Assumption line under a pre-queued forecast; {unit} is the target's name and {tile} its
  // projected board square in chess notation (a letter and a number). One short phrase.
  'tactics.projected.assumes': (p) => `si ${p.unit} est toujours en ${p.tile}`,
  // --- bt-12 (BT12.2/BT12.3/BT12.4/BT12.6): the deploy panel and the results panel ------------
  // tactics/strings.ts is their only requester.
  // @desc: Title of the wild pack confirm screen, where the player picks which monsters to send into
  // a tactical battle. One short phrase.
  'tactics.deploy.title': 'Choisissez votre équipe',
  // @desc: Accessible name of the list showing the remembered formation, slot by slot. One or two
  // words.
  'tactics.deploy.label': 'Ordre de bataille',
  // @desc: Text of a formation slot with no monster in it. One word.
  'tactics.deploy.empty': 'Vide',
  // @desc: Menu row that sends the shown formation into battle. One word (a verb).
  'tactics.deploy.deploy': 'Déployer',
  // @desc: Menu row that opens the formation editor; also the editor's title. Two words.
  'tactics.deploy.edit': 'Modifier la formation',
  // @desc: Status line while the deploy is being sent to the server. One word plus an ellipsis
  // (U+2026).
  'tactics.deploy.sending': 'Déploiement…',
  // @desc: Accessible name of the editor's candidate group (the monster the next A press places into
  // a slot). Three short words.
  'tactics.deploy.candidateLabel': 'Monstre à placer',
  // @desc: Accessible name of the editor's previous-candidate button (the LB twin). Two words.
  'tactics.deploy.prevMonster': 'Monstre précédent',
  // @desc: Accessible name of the editor's next-candidate button (the RB twin). Two words.
  'tactics.deploy.nextMonster': 'Monstre suivant',
  // @desc: Editor menu row that sends the edited formation into battle. One word.
  'tactics.deploy.confirm': 'Confirmer',
  // @desc: Editor menu row that returns to the confirm screen, discarding the edits. One word.
  'tactics.deploy.back': 'Retour',
  // @desc: Accessible name of the confirm screen's list of the wild monsters the player is about to
  // face (species name and level per row). Two short words.
  'tactics.deploy.wilds': 'Meute sauvage',
  // @desc: The idle countdown shown during the last minute of a wild battle's decision window, asking
  // whether the player is still at the keyboard; {s} is the whole seconds left. A short question and
  // the seconds with the unit symbol.
  'tactics.clock.stillThere': (p) => `Toujours là ? ${p.s} s`,
  // @desc: Label of a formation slot; {n} is the slot number, 1-based. One word plus the number.
  'tactics.deploy.slot': (p) => `Emplacement ${p.n}`,
  // @desc: Accessible name of the results panel's list of rewards. One word.
  'tactics.results.label': 'Récompenses',
  // @desc: The results panel's only line when nothing was earned. Two words.
  'tactics.results.none': 'Aucune récompense',
  // @desc: The results panel's button that closes it at once (it also closes on its own after a
  // few seconds). One word.
  'tactics.results.continue': 'Continuer',
  // @desc: One results line per own monster; {name} is the monster's name, {xp} and {essence} the
  // whole numbers it earned. Signs and units as in the English.
  'tactics.results.monster': (p) => `${p.name} : +${p.xp} XP, +${p.essence} d'essence`,
  // @desc: The results line for the player's gold; {amount} is a whole number. A sign, the number
  // and the currency word.
  'tactics.results.currency': (p) => `+${p.amount} or`,
  // @desc: The results line for a wild recruited during the battle; {name} is its species name. One
  // short exclamation.
  'tactics.results.recruited': (p) => `${p.name} rejoint votre équipe !`,
  // @desc: Accessible name of the strip under the turn bar that names both PvP players with their
  // strike pips. One word.
  'tactics.players.label': 'Joueurs',
  // @desc: Root menu row that gives up the PvP match (a confirm follows). One word.
  'tactics.menu.forfeit': 'Abandonner',
  // @desc: Confirmation row that forfeits the PvP match: the player loses it at once. One short
  // sentence.
  'tactics.menu.forfeitYes': 'Oui, abandonner le match',
  // @desc: Confirmation row that keeps the PvP match going and closes the menu. One short phrase.
  'tactics.menu.forfeitNo': 'Continuer le combat',
  // @desc: Results line: the battle was adjudicated on the sides' remaining HP share. One short
  // phrase.
  'tactics.results.endHow.adjudicatedHpPercent': 'Décidé aux PV restants',
  // @desc: Results line: the battle was adjudicated on the number of conscious monsters. One short
  // phrase.
  'tactics.results.endHow.adjudicatedConscious': 'Décidé aux monstres conscients',
  // @desc: Results line: the battle was adjudicated on the attack damage dealt over the match. One
  // short phrase.
  'tactics.results.endHow.adjudicatedDamageDealt': 'Décidé aux dégâts infligés',
  // @desc: Results line: the battle was adjudicated by the deterministic coin (every other step
  // tied). One short phrase.
  'tactics.results.endHow.adjudicatedCoin': 'Décidé à pile ou face',
  // @desc: Results line: the battle ended because a player forfeited (the menu row or a
  // disconnect). One short phrase.
  'tactics.results.endHow.forfeit': 'Terminé par abandon',
  // @desc: Accessible name of the clock ring on the waiting unit's turn-bar chip; {s} is the whole
  // seconds left in the window. The number, the unit symbol and one word.
  'tactics.clock.ring': (p) => `${p.s} s restantes`,
  // @desc: Accessible name of a player's strike pips; {name} is the player's name, {n} the strikes
  // taken so far and {max} the strikes that forfeit. The name, a colon, then the count.
  'tactics.clock.strikes': (p) => `${p.name} : ${p.n} prises sur ${p.max}`,
  // @desc: Results line for the PvP rating change; {before} and {after} are whole ratings, {delta}
  // is the signed difference (a sign is always printed). An arrow between the two ratings.
  'tactics.results.rating': (p) => `Classement ${p.before} → ${p.after} (${p.delta})`,
  // @desc: Results line for a first rated game (no rating stood before it); {after} is the new whole
  // rating. One word and the number.
  'tactics.results.ratingNew': (p) => `Classement ${p.after}`,
  // @desc: Last row of a context sheet (the bordered mini-menu of a frame); choosing it closes the
  // sheet, as the Back button does. One word.
  // boxView.ts (the Monsters sheet)
  'kit.sheet.close': 'Fermer',
  // @desc: Last row of a sub-list inside a context sheet (for example the food list); choosing it
  // returns to the sheet's own rows. One word.
  // boxView.ts (the Monsters Feed and Evolve lists)
  'kit.sheet.back': 'Retour',
  // @desc: Accessible name a screen reader announces for the tactical battle frame when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.battleView.title': 'Combat',
  // @desc: Accessible name a screen reader announces for the Monsters frame (party and box) when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.boxView.title': 'Monstres',
  // @desc: Accessible name a screen reader announces for the Inventory (bag) frame when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.raisingView.title': 'Inventaire',
  // @desc: Accessible name a screen reader announces for the evolution screen when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.evolutionView.title': 'Évolution',
  // @desc: Accessible name a screen reader announces for a conversation with a character in the world when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.dialogueView.title': 'Conversation',
  // @desc: Accessible name a screen reader announces for the quest journal when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.questLogView.title': 'Journal (quêtes)',
  // @desc: Accessible name a screen reader announces for the healing station screen when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.healView.title': 'Soins',
  // @desc: Accessible name a screen reader announces for a shop when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.shopView.title': 'Boutique',
  // @desc: Accessible name a screen reader announces for an incoming trade offer when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.tradeView.title': 'Proposition d’échange',
  // @desc: Accessible name a screen reader announces for a player-versus-player challenge when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.pvpView.title': 'Défi PvP',
  // @desc: Accessible name a screen reader announces for the rankings board when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.leaderboardView.title': 'Classement',
  // @desc: Accessible name a screen reader announces for the player's profile frame when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.profileView.title': 'Profil',
  // @desc: Accessible name a screen reader announces for a live trade with another player when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.tradeSessionView.title': 'Échange',
  // @desc: Accessible name a screen reader announces for the help screen when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.helpView.title': 'Comment jouer',
  // @desc: Accessible name a screen reader announces for the main menu when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.menuView.title': 'Menu',
  // @desc: Accessible name a screen reader announces for the key-binding settings screen when it opens; a short
  // dialog title, no trailing punctuation. overlayA11y.ts (aria-label) and announcements.ts
  'a11y.overlay.controlsView.title': 'Commandes',
  // @desc: Accessible name of the game world canvas (the map the player walks on), announced
  // when the last open frame closes. render/world.ts (aria-label) and main.ts
  'a11y.world.region': 'Carte du monde',
} satisfies Catalog);
