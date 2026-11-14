# Test pins: one owner per shared fact

A fact that one product registry holds (the overlay ids, the catalog keys, the subscription
batch) is written out as a literal by many client tests, so a slice that adds one screen, string
or subscription edits test files outside the module it changes. This file is the plan for giving
each such fact one owner. It names each fact, the product value it comes from, the test that owns
its literal, what every other assertion of it becomes, and the slices still to make. The decision
and what it rules out are in `docs/DECISIONS.md` ("Each client registry has one test that states
its members").

Paths are under `client/src/`. A test is named by its file and the opening words of its title,
enough to match one test in that file. Counts are those of commit `485e8bca`.

## Rules

1. **One owner.** Each registry below has one test that states its members: a roster compared
   with the registry for equality, in order where order is behaviour, in the test file beside the
   registry. A roster fixes the count, so no test asserts a bare count of a registry and no test
   title carries one.
2. **Every other assertion of the fact takes one of three forms.**
   - **Derive.** The expected value is computed from the registry (`OVERLAY_IDS.length - 1`). This
     is for a quantity the code under test produces or a loop can lower: a distinctness check
     (`new Set(names).size`), a tally of a loop that skips a member, the size of another table's
     key set, a generator bound.
   - **Own entity.** The test asserts what it is about ("my query is in the batch once and the
     private table is not") and drops the restated total.
   - **Delete.** An assertion the owner already makes goes: a second roster, a bare count, a tally
     that adds one per pass of a loop over the registry with no path that skips a member. The
     deletion names the surviving test, and for a protected behaviour someone other than the
     deleter re-creates the defect and shows the survivor red
     (`standards/testing-tdd.md`, "Deleting a check is legitimate"). Each fact below names the
     defect to re-create.
3. **A per-member expectation is behaviour, not a restatement.** A hand-written table that says
   what each member should be (its tier, whether a battle keeps it, whether a reconnect closes it,
   which adapter it holds, what it is called) stays hand-written. It is never rebuilt by reading
   the product table it checks. Where the registry has a key type, the table is typed
   `Record<K, _>` over it, so the compiler asks for the new row.
4. **The subscription batch is read from what `connect()` sends.** The array stays unexported: a
   test that imported it would compare the batch with itself.
5. **A test's own fixture is not a registry.** A count of rows the test built is read from the
   fixture (`SAMPLE_VM.entries.length`).
6. **A hand list that restates what a source scan measured is deleted,** with the scan's fixture
   test as the survivor. A source read that is the only protection of a protected behaviour stays
   as it is until an executing test replaces it ("Pins that read source text" below).

## What the pins cost

| Fact | Literal sites |
|---|---|
| Overlay ids (16) | the number at 36 assertion sites in five files: `ui/overlayRegistry.test.ts` 19, `ui/overlayA11y.test.ts` 6, `ui/overlayA11yWiring.test.ts` 5, `ui/a11yCopy.test.ts` 4, `ui/announcements.test.ts` 2; numbers worked out from it by hand (15, 48, 64, 180) in the first, and (14, 15, 17, 23, 48, 51, 272) in `ui/contextStack.test.ts` |
| Catalog keys (543) | 12 sites in six tests of `ui/i18n/catalog.test.ts`, beside the roster that already fixes it |
| Subscription batch (29) | 3 sites in `net/connection.runtime.test.ts`, beside the exact roster in `net/connection.test.ts` |
| Help entries (16) | 5 sites in `main.help.test.ts`, 4 in `ui/helpView.test.ts`, 4 in `ui/helpModel.test.ts` |
| Command kinds (36: 10 safe, 26 refused) | 4 sites in `ui/battlePolicy.test.ts`, 6 in `ui/contextStack.test.ts` |
| Menu root rows (8) | the same eight-key array written out in five test files |

Of the last 300 commits on `master`, 65 changed `ui/i18n/catalog.test.ts`; each of the ten most
recent changed all 12 copies of the key count, and three of the ten changed nothing but the roster
and the counts. 28 changed `ui/i18n/catalogParity.test.ts`; of the twelve most recent, seven
edited the hand list of the keys `main.ts` resolves and four the hand list of the files that
import the resolver. Ten changed `ui/contextStack.test.ts` and left `ui/contextStack.ts` alone;
six of them moved the command counts. Three titles in `ui/overlayA11y.test.ts` and
`ui/overlayA11yWiring.test.ts` say 18 overlays above bodies that assert 16: nothing checks a
title.

A build run may add a pin file to its own `touches:` when a measurement proves the need and no
unmerged slice holds the file. That spares the spec author the list. It leaves the rest:

- **The edits.** One overlay is still about 36 count sites in five files, plus the hand
  arithmetic; one string is 12.
- **The serialization.** Two slices that name the same file are never in flight together, and a
  request for a file an unmerged slice holds parks the run. Of the 83 `touches:` lines in the open
  specs, 13 name `ui/contextStack.test.ts`, 10 `ui/i18n/catalog.test.ts`, 9
  `ui/i18n/catalogParity.test.ts`, 8 `ui/screens/index.test.ts` and 6 `ui/reachability.test.ts`.
- **The drift.** A count in a title or a comment is bumped by hand or goes stale.

This plan does not remove a second cost the same runs paid: a test that builds another module's
type by hand (`PointerDeps`, a `Command`, a view's callbacks) breaks at compile time when that
type changes. In the two days after the tool shipped, runs added a client unit-test file to
their own `touches:` eleven times: five for a fixture of that kind, three for a count, roster or
floor pin and three for the changed entity's own tests. A fixture row is not a restated registry,
and rule 3 keeps it.

## Shared facts

### Overlay ids

**Product value.** `OVERLAY_IDS` in `ui/overlayRegistry.ts`: the keys of `OVERLAY_TIERS`, a
`Record<OverlayId, OverlayTier>`, in declaration order.

**Owner.** `ui/overlayRegistry.test.ts` › "UIF16B.7 OVERLAY_IDS is the exact 16-id roster":
ordered equality with a hand-written list. Order is behaviour: `canOpen` names the first blocker
in declaration order. Its title loses the count.

**Defect to re-create.** Delete one id's row from `OVERLAY_TIERS` and its other compile-forced
rows; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/overlayRegistry.test.ts` › "OR-MANIFEST-COMPLETE BITES" | the `ui/*View.ts` file count is `OVERLAY_IDS.length + 4` | already derived; see "Pins that read source text" |
| `ui/overlayRegistry.test.ts` › "OR-TIERS-PARTITION BITES" | the three tier lists; `OVERLAY_IDS.length` is 16; the lists together hold 16 ids and equal `OVERLAY_IDS`; a `Set` of the ids has 16 | the tier lists and their equality with `OVERLAY_IDS` stay (rule 3). The two length-16 assertions: delete; survivors: this test's own equality, and the owner. The duplicate check: derive (`OVERLAY_IDS.length`) |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-EMPTY-ALLOWS-ALL BITES" | a tally of 16, one per pass | delete; survivor: the owner |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-GUARDONLY-ALL BITES" | 180 denies, a loop that skips the target itself | derive: `EXPECTED_GUARD_ONLY.length * (OVERLAY_IDS.length - 1)` |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-BATTLE-DENIES-ALL BITES" | a tally of 15, a loop that skips the battle | derive: `OVERLAY_IDS.length - 1` |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-BATTLE-TARGET-DENIES BITES" | 15 denies, a loop that skips the battle | derive: `OVERLAY_IDS.length - 1` |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-MULTI-BLOCKER BITES" | the generator bound `maxLength: 16` | derive: `OVERLAY_IDS.length` |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-TOTAL BITES" | the generator bound `maxLength: 16` | derive: `OVERLAY_IDS.length` |
| `ui/overlayRegistry.test.ts` › "OR-ANYVISIBLE-PROBES-EVERY-ID BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner. The title loses the count |
| `ui/overlayRegistry.test.ts` › "OR-ANYVISIBLE-EXEMPT BITES" | `OVERLAY_IDS.length` is 16; a tally of 48, three per pass | delete both; survivor: the owner |
| `ui/overlayRegistry.test.ts` › "OR-VISIBLEIDS-EXACT BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivors: the owner, and this test's own all-true case equal to `OVERLAY_IDS` |
| `ui/overlayRegistry.test.ts` › "OR-HANDLES-DIALOGUE-HAS-NO-HIDE BITES" | a tally of 15, a loop that skips the dialogue | derive: `OVERLAY_IDS.length - NO_HIDE_THUNK.length` |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-TOTALITY-COMPILE BITES" | `OVERLAY_IDS.length` is 16; `OVERLAY_A11Y` has 16 keys | delete both; survivors: this test's own missing-key and extra-key sets against `OVERLAY_IDS`, and the owner |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-LABELKEY-SHAPE BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass; 16 distinct label keys | delete the first two; survivor: the owner. The distinctness check: derive (`OVERLAY_IDS.length`) |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-DISMISSIBLE-VS-TIER BITES" | `OVERLAY_IDS.length` is 16; the two branches together ran 16 times; 13 ids constrained, 3 not | delete the first two; survivor: the owner. The 13 and the 3: derive from the tier lists (`EXPECTED_EXCLUSIVE_TOP.length + EXPECTED_GUARD_ONLY.length`, `EXPECTED_HIDE_SWITCH.length`) |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-PURE-DATA-TABLE BITES" | `OVERLAY_IDS.length` is 16; 64 fields checked (a loop over each row's own fields); 16 selectors checked, one per pass; 16 distinct selectors | delete the length and the selector tally; survivor: the owner. The field count: derive (`4 * OVERLAY_IDS.length`), since a row missing a field lowers it. The distinctness check: derive |
| `ui/overlayA11y.test.ts` › "S1-ARIA-ALL-17 BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner. The title loses its count |
| `ui/overlayA11y.test.ts` › "LRC-ADOPT BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner. The title loses its count |
| `ui/overlayA11y.test.ts` › "under the fr locale an opened overlay is named and announced in French" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner |
| `ui/overlayA11yWiring.test.ts` › "S10-WIRE-TOTALITY BITES" | `OVERLAY_IDS.length` is 16; the opener table's keys and `OVERLAY_A11Y`'s keys equal `OVERLAY_IDS`; 16 distinct accessible names | delete the length; survivor: the owner. The opener table's key equality stays (the table is this test's fixture). The `OVERLAY_A11Y` key equality: delete; survivor: `ui/overlayRegistry.test.ts` › "OR-A11Y-TOTALITY-COMPILE BITES". The distinctness check: derive. The title loses its count |
| `ui/overlayA11yWiring.test.ts`, the `afterAll` of the describe "m23-s10 / A11Y-13,14,16" | three tallies of 16, one per generated per-id test | derive (`OVERLAY_IDS.length`): a skipped per-id test lowers the tally |
| `ui/overlayA11yWiring.test.ts` › "QF1-1-PARTITION-TOTAL BITES" | the three anchor classes sum to `OVERLAY_IDS.length` | already derived |
| `ui/a11yCopy.test.ts` › "A11YCOPY-OVERLAY-NAMESPACE-EXACT BITES" | `OVERLAY_IDS.length` is 16; 16 distinct derived keys; the Controls key is among them; a tally of 16, one per pass | delete the length, the membership check and the tally; survivor: the owner. The distinctness check: derive |
| `ui/a11yCopy.test.ts` › "UIF16B.3 the overlay-title namespace is exactly 16 keys" | the `a11y.overlay.*` namespace has 16 keys | delete; survivor: `ui/a11yCopy.test.ts` › "A11YCOPY-OVERLAY-NAMESPACE-EXACT BITES" (the namespace equals the keys built from `OVERLAY_IDS`). The title loses its count |
| `ui/announcements.test.ts` › "S1-ANN-OVERLAY-OPENED-DERIVED BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner. The title loses its count |
| `ui/contextStack.test.ts` › "SO2-7-ROSTER" | `OVERLAY_IDS` has 16 members | delete; survivor: the owner. See "Frame ids" for the rest of this test |

The other 22 test files that name `OVERLAY_IDS` only loop over it in a setup or teardown hook
and pin nothing. `indexShell.smoke.test.ts` and `main.dispatch.test.ts` loop over it;
`ui/menuModel.test.ts` checks one id's membership.

### The accessible-name keys

**Product value.** The `a11y.*` keys of `CATALOG_EN` (`ui/i18n/catalog.en.ts`), typed by the
`A11yKey` union in `ui/i18n/messageIds.ts`: one `a11y.overlay.<id>.title` per overlay id and
`a11y.world.region`.

**Owner.** `ui/i18n/catalog.test.ts` › "ts-6b-9 the en a11y.* values are byte-identical": the
key set of both catalogs' `a11y.*` entries equals its hand table, which also states each English
name (rule 3).

**Defect to re-create.** Add an `a11y.*` key to the union and both catalogs; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/i18n/catalog.test.ts` › "ts-6b-9 the en a11y.* values are byte-identical" | its own table has 17 rows | delete; survivor: the same test's key-set equality |
| `ui/a11yCopy.test.ts` › "a11yCopy is exactly the a11y.* entries of CATALOG_EN" | `a11yCopy` has 17 keys, and equals the `a11y.*` entries read from `CATALOG_EN` | delete the count; survivor: the same test's equality |
| `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" | the parsed `A11yKey` union has 17 members | delete; survivor: the same test's comparison of the parsed total with `Object.keys(CATALOG_EN).length` |

### Frame ids

**Product value.** `FrameId` in `ui/contextStack.ts` (`OverlayId` or `SOCIAL_FRAME`), the key type
of `SCREEN_POLICY`, `RECONNECT_CLOSES` and, in `ui/screens/index.ts`, `SCREEN_ADAPTERS`. The
overlay ids that are not `MIRRORED_IDS` are the player frames.

**Owner.** `ui/contextStack.test.ts` › "CTL2-1-POLICY: SCREEN_POLICY is total over the frame ids":
the keys of `SCREEN_POLICY` equal the overlay ids plus the Social frame, and `MIRRORED_IDS` equals
the hand-written pair.

**Defect to re-create.** Give `SCREEN_POLICY` a row for an id that is not a frame id (a cast past
the type); the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/contextStack.test.ts`, module scope | `PLAYER_IDS` and `PLAYER_FRAMES`, the 14 player ids written out twice; `SAFE_OVER_BATTLE` (4) and `UNSAFE_OVER_BATTLE` (10) | `PLAYER_IDS` derives: `OVERLAY_IDS` without the hand-written server pair; `PLAYER_FRAMES` derives from it. The safe and unsafe lists stay (rule 3) |
| `ui/contextStack.test.ts` › "CTL3-2-DROP-EXACT" | `PLAYER_IDS` has 14; it equals `OVERLAY_IDS` without the pair; a battle drop is 15 commands, then 14 | delete the length and the equality (the list is derived); survivor: the owner. The command counts: derive (`PLAYER_IDS.length + 1`, `PLAYER_IDS.length`). The title loses its count |
| `ui/contextStack.test.ts` › "CTL3-2-POLICY-EXACT" | a 17-row hand table of owner and battle rule; it has 17 rows; its ids equal the frame ids | the table stays, typed `Record<FrameId, _>` (rule 3). The row count: delete; survivor: the same test's id equality |
| `ui/contextStack.test.ts` › "CTL3-5-OPEN-GATE" | its row table has 23 rows (9 named and one per player id) | derive: `9 + PLAYER_IDS.length` |
| `ui/contextStack.test.ts` › "CTL6C-1-RECONCILE-KEEPS-SAFE-OVER-BATTLE" | the safe list has 4 and the unsafe list 10; together they equal `PLAYER_IDS`; a drop is 10 closes | delete the two lengths; survivor: the same test's equality with `PLAYER_IDS`. The close count: derive (`UNSAFE_OVER_BATTLE.length`) |
| `ui/contextStack.test.ts` › "the SCREEN_POLICY battleSafe column is exactly the literal table" | a hand `Record<FrameId, boolean>`; 5 rows are true | the table stays (rule 3). The count of its own true rows: delete; survivor: the same test's row-by-row equality |
| `ui/contextStack.test.ts` › "SO1-1-SWEEP-STAMPED" | a tally of 48, three per pass of a loop over the frame ids without the dialogue; 5 frames kept, counted in one branch | the 48: delete; survivor: the owner. The 5: derive (the false rows of `SO1_ROSTER` without the dialogue) |
| `ui/contextStack.test.ts` › "SO1-1-ROSTER-LITERAL" | `SO1_ROSTER`, a hand `Record<FrameId, boolean>`; it has 17 keys, 11 true; `RECONNECT_CLOSES` equals it | the table and the equality stay (rule 3). The two counts of its own rows: delete; survivor: the same test's equality. The title loses its counts |
| `ui/contextStack.test.ts` › "SO1-1-ROSTER-SWEEP" | a tally of 51, three per frame id | delete; survivor: the owner |
| `ui/contextStack.test.ts` › "SO2-1-OPEN-EDGE" | the openable ids (frame ids without the mirrored pair) are 15 | delete; survivor: the owner |
| `ui/contextStack.test.ts` › "SO2-3-MIRROR-TRIO" | `PLAYER_IDS` has 14 | delete; survivor: the owner |
| `ui/contextStack.test.ts` › "SO2-5-GATE-STACK" | a tally of 272 cells, one per pass | delete; survivor: the owner |
| `ui/contextStack.test.ts` › "SO2-7-ROSTER" | `MIRRORED_IDS` is the pair and has 2; `PLAYER_IDS` has 14; the two together equal `OVERLAY_IDS` | the pair equality and the disjointness stay. The three counts and the union equality: delete (the list is derived); survivor: the owner |
| `ui/contextStack.test.ts` › "CTL11A-2-DENY-PREDICATE" | its hand list of the server-owned frames has 2 members | delete; survivor: the owner (the server-owned rows equal the pair) |
| `ui/screens/index.test.ts` › "CTL6B-1-ADAPTERS-TOTAL" | the keys of `SCREEN_ADAPTERS` equal the frame ids; there are 17; the `CONVERTED` map of 11 adapters, by identity; 6 legacy ids, named | the key equality, the `CONVERTED` map and the legacy list stay (rule 3). The 17 and the 6: delete; survivors: the same test's key equality and its legacy-list equality |
| `input/router.test.ts`, module scope, and › "CTL11A-2-DECIDE-DENIED" | `PLAYER_FRAMES`, the player ids and the Social frame written out; its length plus 2 is `OVERLAY_IDS.length + 1` | the list derives (the frame ids without the server pair). The arithmetic check: delete; survivor: the owner |

`FRAME_IDS` is built in both `ui/contextStack.test.ts` and `ui/screens/index.test.ts` as the
overlay ids plus the literal `'social'`; both read `SOCIAL_FRAME` instead.

### Catalog keys

**Product value.** `Object.keys(CATALOG_EN)` in `ui/i18n/catalog.en.ts`, typed by the `MessageId`
and `A11yKey` unions in `ui/i18n/messageIds.ts`. Both catalogs are `satisfies Catalog`, so a key
missing from either is a compile error.

**Owner.** `ui/i18n/catalog.test.ts` › "m24s3/21r-b/21r-b2 CAT-01": the keys equal the sorted hand
roster `EXPECTED_KEYS`, every English value equals its row, and the parameterised keys are exactly
those with sample parameters. Its title loses the count and the history of counts.

The roster keeps its English values. A slice that adds a string already edits `ui/i18n/catalog.en.ts`,
`ui/i18n/catalog.fr.ts` and `ui/i18n/messageIds.ts`, so the roster row costs it no new file;
the row is where the tester states the string before the catalog holds it.

**Defect to re-create.** Add one key with text to the union and both catalogs; the owner goes red.
Remove one and the owner goes red again.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/i18n/catalog.test.ts` › "m24s3/21r-b/21r-b2 CAT-01" | `EXPECTED_KEYS` has 543 members | delete; survivor: the same test's equality with the catalog's keys |
| `ui/i18n/catalog.test.ts` › "m24s1 CATALOG-SHAPE" | the keys equal `EXPECTED_KEYS` | delete; survivor: the owner. Its other assertions stay. The title loses the count history |
| `ui/i18n/catalog.test.ts` › "the legacy ids keep their names in both catalogs" | 543 keys in en, in fr and in the roster; the keys equal `EXPECTED_KEYS` | own entity: it keeps its four ids. The three counts and the equality: delete; survivors: the owner, and `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" for the French key set. The title loses its count |
| `ui/i18n/catalog.test.ts` › "the six raising ids that carried the retired Monsters section" | 543 keys in en and in fr | own entity: its retired and kept ids. The counts: delete; survivors as above |
| `ui/i18n/catalog.test.ts` › "the eleven ids that labelled the four views" | 543 keys in en and in fr | own entity. The counts: delete; survivors as above. The title loses its count |
| `ui/i18n/catalog.test.ts` › "UIF15B.1 the six menu.social" | 543 keys in en and in fr | own entity. The counts: delete; survivors as above |
| `ui/i18n/catalog.test.ts` › "UIF15C.5 the six menu.options" | 543 keys in en and in fr | own entity. The counts: delete; survivors as above |
| `ui/i18n/catalog.test.ts` › "no English or French catalog value still names a retired mouse-only control" | the number of values read equals a sum over the hand tables | derive: one per plain value and two per parameterised value of `CATALOG_EN` |
| `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" | the parsed unions total `Object.keys(CATALOG_EN).length` | already derived |
| `ui/i18n/resolver.test.ts` › "m24s1 RESOLVER-T:" | a snapshot of every plain `chrome.*` key and value | delete the snapshot; survivor: the owner, whose roster holds the same keys and values. Its `t(key)` equals `CATALOG_EN[key]` loop stays |
| `tactics/strings.test.ts` › "BT11-1-STRINGS-ROSTER" and › "BT10-6-STRINGS-ROSTER" | its hand lists of `tactics.*` keys are in both catalogs, and the first holds that they are the whole namespace | own entity: the tactics module's own keys, edited by the slice that changes that module. Stays |

### The locale registry

**Product value.** The keys of `CATALOGS` in `ui/i18n/resolver.ts`.

**Owner.** `ui/i18n/resolver.test.ts` › "m24s1 RESOLVER-LOCALE": the registry is exactly the two
locales.

**Defect to re-create.** Register a third locale; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" | the registry's keys are `en` and `fr` | delete; survivor: the owner |
| `ui/i18n/catalogParity.test.ts` › "m24s7 PLURAL-01" | its plural table's keys equal the registry's | already derived |
| `ui/i18n/catalogShape.test.ts` › "m24s6 SHAPE-04: a11y.* keys stay out of tf()" | the registry's keys are `en` and `fr` | delete; survivor: the owner. Its loop over the registered locales stays |

### Help entries

**Product value.** `ENTRY_KEYS` in `ui/helpModel.ts`, in list order.

**Owner.** `ui/helpModel.test.ts` › "UIF14.4 ENTRY_KEYS is the sixteen mechanics in the pinned
order": ordered equality with a hand-written list. Its title loses the count.

**Defect to re-create.** Remove one key from `ENTRY_KEYS`; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/helpModel.test.ts` › "UIF14.4 ENTRY_KEYS is the sixteen mechanics in the pinned order" | a `Set` of the keys has 16 | derive: `ENTRY_KEYS.length` |
| `ui/helpModel.test.ts` › "UIF14.4 every entry reads its term and definition" | 16 distinct terms in en and in fr | derive: `ENTRY_KEYS.length` |
| `ui/helpModel.test.ts` › "PURE: a fresh object per call" | a later model still has 16 entries | derive: `ENTRY_KEYS.length` |
| `ui/helpView.test.ts` › "UIF14.4 #help-encyclopedia is the static ul.mr-nav-list" | 16 rows after a repaint | own entity (rule 5): `SAMPLE_VM.entries.length`. The title loses its count |
| `ui/helpView.test.ts` › "UIF14.4 a second render with new terms" | 16 rows | own entity: `SAMPLE_VM.entries.length`. The title loses its count |
| `ui/helpView.test.ts` › "UIF14.5 a detail paint shows ONE [data-context-sheet]" | the list still holds 16 rows | own entity: `SAMPLE_VM.entries.length` |
| `ui/helpView.test.ts` › "UIF14.5 closing the detail hides the sheet" | 16 rows | own entity: `SAMPLE_VM.entries.length` |
| `main.help.test.ts` › "UIF14.1 Select opens How to Play on Introduction" | 16 Encyclopedia rows | derive: `ENTRY_KEYS.length` |
| `main.help.test.ts` › "UIF14.4 on the Encyclopedia ArrowDown walks the sixteen terms" | 16 terms, 16 of them distinct | derive both: `ENTRY_KEYS.length`. The title loses its count |
| `main.help.test.ts` › "UIF14.5 A opens the entry under the cursor" | 16 rows behind the sheet | derive: `ENTRY_KEYS.length` |
| `main.help.test.ts` › "clicking the Select chip opens the same two-tab Help" | 16 rows | derive: `ENTRY_KEYS.length` |
| `ui/i18n/catalog.test.ts` › "UIF14.4 the other 34 plain Help ids" | its own copy of the 16 keys; 34 ids; 16 distinct texts per kind | its key list reads `ENTRY_KEYS`. The two counts: derive (`2 + 2 * ENTRY_KEYS.length`, `ENTRY_KEYS.length`). The title loses its counts |
| `ui/screens/helpScreen.test.ts` › "UIF14.1 HELP_LAYOUT is a tabs layout" | the Encyclopedia's items equal `ENTRY_KEYS` | already derived |

### Subscription batch

**Product value.** The queries `connect()` in `net/connection.ts` passes to the one `subscribe`
call of a build. The array is not exported (rule 4).

**Owner.** `net/connection.test.ts` › "ts-4.4 the subscription batch is exactly the 29 queries
below": the queries a mocked build received, sorted, equal a hand-written list, sorted. A query
added, dropped, doubled or swapped changes the sorted list. Its title loses the count, and so
does its assertion that the hand list has 29 members.

**Defect to re-create.** Add `SELECT * FROM trade_offer` to the batch, then double `zone_def`,
then drop `my_wallet`; the owner goes red each time. What a client subscribes to is what it is
sent, so this deletion is adjudicated as a privacy check.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `net/connection.runtime.test.ts` › "the one subscription batch includes the public zone_def table exactly once" | the batch has 29 queries | own entity: `zone_def` once and no `character` query. The count: delete; survivor: the owner. The title loses its count |
| `net/connection.runtime.test.ts` › "the one subscription batch names each of the seven owner-scoped tactical views exactly once" | the batch has 29 queries | own entity: the seven views once each and no private battle table. The count: delete; survivor: the owner. The title loses its count |
| `net/connection.runtime.test.ts` › "the one subscription batch names my_trade_session exactly once" | the batch has 29 queries | own entity: the view once and never the private table. The count: delete; survivor: the owner. The title loses its count |

### Command kinds and their battle policy

**Product value.** `COMMAND_BATTLE_POLICY` in `ui/battlePolicy.ts`, a
`Record<Command['kind'], 'safe' | 'refuse'>`: the compiler holds its keys to the `Command` union
of `ui/screens/types.ts`.

**Owner.** `ui/contextStack.test.ts` › "CTL6C-3-REFUSAL-TABLE": one sample command per kind in
two hand lists, safe and refused; each kind's row in the table equals its list, and the table's
keys equal the kinds listed. The two lists become one table typed
`Record<Command['kind'], { command: Command; policy: 'safe' | 'refuse' }>`, so the compiler asks
for the new kind's row. Its title loses the count.

**Defect to re-create.** Flip one kind's row from `refuse` to `safe`; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/contextStack.test.ts` › "CTL6C-3-REFUSAL-TABLE" | its lists have 10 and 26 rows, 36 kinds in all; the safe kinds in order | delete the three counts; survivor: the same test's key equality. The ordered safe list: delete; survivor: the same test's row-by-row comparison |
| `ui/contextStack.test.ts` › "deployUnits is battle-safe" | the table holds 10 safe, 26 refused, 36 kinds | own entity: `deployUnits` is safe and no battle stack refuses it. The three counts: delete; survivor: the owner. The title loses its counts |
| `ui/battlePolicy.test.ts`, module scope | `COMMAND_KINDS`, the 36 kinds, checked against `Command['kind']` by the compiler | stays: it is the type-level roster the tests below read |
| `ui/battlePolicy.test.ts` › "the battle policy table has no row for any of the seven 1v1 commands" | the table's keys equal `COMMAND_KINDS`; the list has 36 members | own entity: no row for the seven retired kinds, and the key equality. The count: delete; survivor: the same test's type-level check that the list is exactly the `Command` kinds. The title loses its count |
| `ui/battlePolicy.test.ts` › "UIF14B.3 reportProblem is classified once" | the table has 36 keys | own entity: `reportProblem` is safe. The count: delete; survivor: the owner |
| `ui/battlePolicy.test.ts` › "ts-4.6 the policy table has no respondTrade" | the keys equal `COMMAND_KINDS`; 10 safe, 26 refused | own entity: no row for the three retired kinds, each session kind refused. The key equality: delete; survivor: `ui/battlePolicy.test.ts` › "the battle policy table has no row for any of the seven 1v1 commands". The two counts: delete; survivor: the owner. The title loses its counts |
| `main.dispatch.test.ts` › "at a battle base every view callback of a command the battle refuses" | the refused kinds its callbacks reach, and the safe kinds it drives, against the table | own entity: the kinds its own callbacks send. Stays |

### Menu root rows

**Product value.** `MENU_ENTRIES` in `ui/menuModel.ts`, in display order.

**Owner.** `ui/menuModel.test.ts` › "UIF15C.1 CTL5-1-ENTRIES": the root keys equal `ROOT_KEYS`, a
hand-written list, in order.

**Defect to re-create.** Swap two entries of `MENU_ENTRIES`; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/screens/mainMenuScreen.test.ts`, module scope | its own `ROOT_KEYS`, the eight keys | derive: the keys of `MENU_ENTRIES`. The tests that compare a layout or a label table with it then prove the screen follows the model |
| `ui/menuView.test.ts`, module scope | its own `ROOT_KEYS` | derive: the keys of `MENU_ENTRIES` |
| `main.menu.test.ts`, module scope | its own `ROOT_KEYS` | derive: the keys of `MENU_ENTRIES` |
| `ui/reachability.test.ts` › "UIF15C.3 the bound of 7 presses holds" | its own list of the eight keys; 7 reachable rows; `8 * 17` cells | the list derives (the keys of `MENU_ENTRIES`); the two counts derive from it and from `MENU_ACCELS.length` |
| `ui/menuModel.test.ts` › "UIF16B.1 the root Profile row is an open leaf" | the seven root leaves, written out | derive: `ROOT_KEYS` without `close` |

### Menu accelerators

**Product value.** The keys of `ACCEL_PATHS` in `input/router.ts`.

**Owner.** `input/router.test.ts` › "CTL11A-1-PATHS": the key set and each path, hand-written. Its
title loses the count.

**Defect to re-create.** Add an eleventh accelerator path; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `input/router.test.ts` › "CTL11A-1-PATHS" | `ACCEL_PATHS` has 10 keys | delete; survivor: the same test's equality with its hand-written path table |
| `ui/reachability.test.ts` › "the hand-written MENU_ACCELS manifest is exactly the menu accelerators" | `MENU_ACCELS` equals the keys of `ACCEL_PATHS` and has 10 | `MENU_ACCELS` derives (the keys of `ACCEL_PATHS`); the equality and the count: delete; survivor: the owner. Its Controls-path assertions stay. The title loses its count |

## Pins that read source text

Each row is a place where a test this plan edits reads a hand-written file as text, a hand list
that restates such a scan, or a source-text fact that more than one test asserts. "Delete" and
"replace first" are `standards/testing-tdd.md`, "Deleting a check is legitimate" and
"Behavior-preserving changes"; "stays" means no executing test can carry the behaviour yet and
this plan does not edit the read. The other source reads in these files belong to tests this plan
does not edit.

| Test | Reads | Disposition |
|---|---|---|
| `ui/i18n/catalogParity.test.ts` › "m24s7/21r-b PARITY-02: I18N-27" | every non-test file under `client/src`, for calls of the resolver's `t` and `tf` | Three hand lists restate what the scan measured: the files that import the resolver, and the literal keys `main.ts` resolves through each of its two bindings. Delete the three (rule 6); survivors: `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-02: fixtures", which proves alias and two-binding resolution on fixtures, and this test's own floor on the number of literal call sites, which proves the live scan resolved them. The title loses its file count. The rest stays: that no resolver key in the tree is dynamic, and the list of the two dynamic `a11y` sites, are what make the dead-key scan sound |
| `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-04: I18N-28" | the same scan, and the `MessageId` union as text | stays: that every key has a requester is a property of the whole tree. Its assertion that its own exemption list is empty: delete; survivor: the same test's dead-key findings. The title loses that clause |
| `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" | `ui/i18n/messageIds.ts`, to parse the two unions | replace first: the same test gains the executing comparison (the keys of `CATALOGS.en` equal the keys of `CATALOGS.fr`), is watched red on a key dropped from the French catalog past the type, and then loses the parse. `satisfies Catalog` holds each catalog to the unions at compile time |
| `ui/i18n/catalog.test.ts` › "m24s1 SHAPE-01" and the same scan inside › "m24s3 CAT-02" | `ui/i18n/catalog.en.ts`, for a `// @desc:` comment beside every entry | delete both; survivor: `ui/i18n/catalogShape.test.ts` › "m24s6 SHAPE-01: I18N-24", which reads every registered catalog |
| `ui/i18n/catalog.test.ts` › "m24s1 CATALOG-SHAPE" | `ui/i18n/catalog.en.ts`, for its entry-line count and for one `satisfies Catalog` and one `Object.freeze(` | delete the three reads; survivors: the same test's `Object.isFrozen(CATALOG_EN)`, and the owner of the catalog keys for an entry the type does not know |
| `ui/i18n/catalog.test.ts` › "m24s1 SHAPE-06" | every `catalog.<tag>.ts`, for `oneOther(` | delete the read of the real catalogs; survivor: `ui/i18n/catalogShape.test.ts` › "m24s6 SHAPE-06: I18N-33". Its two fixture assertions stay |
| `ui/overlayRegistry.test.ts` › "OR-MANIFEST-COMPLETE BITES" | the names of the `ui/*View.ts` files | stays: it is the only check that a new view file is an overlay or a named exemption |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-PURE-DATA-TABLE BITES" | `ui/overlayRegistry.ts`, for no import and no `document` or `window` | stays: module purity has no executing check. Its second half runs the table |
| `ui/overlayA11yWiring.test.ts`, every test | `client/index.html` and `client/src/styles.css`, loaded as the document the real views run on | not a pin: the files are the fixture, and the assertions are on the DOM and on computed style |
| `ui/reachability.test.ts` › "QF8-3-E2E-NO-RETIRED-SELECTOR" | every file under `client/e2e`, for retired catalog ids and DOM hooks | delete; survivors: the type checker for a retired catalog id (`client/e2e` is type-checked and `t` takes a `MessageId`), `ui/i18n/catalog.test.ts` › "the six raising ids that carried the retired Monsters section" for the ids themselves, and for the hooks the tests that prove the views no longer render them: the `QF8_RETIRED` rows of this file, `ui/evolutionView.test.ts` › "★★ BITES: one eligible path", `ui/raisingView.feedbackGate.test.ts` › "QF9-2-GATE-NO-SINK" and `ui/tradeView.test.ts` › "ts-4.6 the view never writes" |
| `net/connection.test.ts` › "E1-MAIN-01", "E1-MAIN-02", "E1-MAIN-03", "E1-MAIN-04", and the tests of `main.dispatch.test.ts` that read `main.ts` | `main.ts` | `docs/refactors/client-shell.md`, "Tests and docs that follow the code", moves each with the code it reads; this plan adds nothing |

**Defect to re-create for the hand lists.** Make the scan resolve no import binding; the fixtures
test and the call-site floor go red.

## What this plan leaves alone

- **Per-member tables** (rule 3): the tier lists, the battle-safe and reconnect tables, the
  `CONVERTED` adapter map, the root element ids and anchor classes of
  `ui/overlayA11yWiring.test.ts`, the sweep rows of `ui/reachability.test.ts`.
- **A screen's own row.** `ui/screens/helpScreen.test.ts` and `ui/screens/profileScreen.test.ts`
  each assert that the shipped adapter table holds their own screen.
- **Fixture tallies.** A count of rows a test built itself, or of runs of its own property.
- **Copy asserted where it is rendered or translated:** the French values of
  `ui/i18n/catalogParity.test.ts`, the per-string tests of `ui/i18n/catalog.test.ts`.
- **Floors on what `client/index.html` ships** in `ui/overlayA11yWiring.test.ts`: they follow the
  document, not a registry.
- **Hand-built fixtures of another module's types** ("What the pins cost").

## Slices, in order

Each slice edits tests only, and the tester makes the edit. It takes the dispositions of one
section above, re-creates that section's defect on a scratch copy for each deleted assertion of a
protected behaviour, and shows the named survivor red; someone other than the tester adjudicates.
The slice for a line deletes that line, and the slice that deletes the last line deletes this
file.

1. Catalog keys: `client/src/ui/i18n/catalog.test.ts`, `client/src/ui/i18n/resolver.test.ts`. It also takes the catalog rows of "Pins that read source text", and that file's rows of "Help entries" and "The accessible-name keys".
2. The catalog scan's hand lists and the locale registry: `client/src/ui/i18n/catalogParity.test.ts`. It takes that file's rows of "Pins that read source text", "The accessible-name keys" and "The locale registry".
3. Command kinds and their battle policy: `client/src/ui/contextStack.test.ts`, `client/src/ui/battlePolicy.test.ts`.
4. Overlay ids: `client/src/ui/overlayRegistry.test.ts`, `client/src/ui/overlayA11y.test.ts`, `client/src/ui/overlayA11yWiring.test.ts`, `client/src/ui/a11yCopy.test.ts`, `client/src/ui/announcements.test.ts`.
5. Frame ids: `client/src/ui/contextStack.test.ts`, `client/src/ui/screens/index.test.ts`, `client/src/input/router.test.ts`.
6. Subscription batch: `client/src/net/connection.runtime.test.ts`, `client/src/net/connection.test.ts`.
7. Menu root rows and accelerators: `client/src/ui/screens/mainMenuScreen.test.ts`, `client/src/ui/menuView.test.ts`, `client/src/main.menu.test.ts`, `client/src/ui/menuModel.test.ts`, `client/src/ui/reachability.test.ts`, `client/src/input/router.test.ts`. It also takes that last file's row of "Pins that read source text".
8. Help entries: `client/src/ui/helpModel.test.ts`, `client/src/ui/helpView.test.ts`, `client/src/main.help.test.ts`.
9. The battle-policy tests move beside `ui/battlePolicy.ts`: the tests of `client/src/ui/contextStack.test.ts` whose subject is `ui/battlePolicy.ts` ("CTL6C-3-REFUSAL-TABLE" and the owner of the command kinds among them) move whole, bodies unchanged, to `client/src/ui/battlePolicy.test.ts`.

Lines 7 and 8 each edit a `client/src/main.*.test.ts` file, which the extractions of
`docs/refactors/client-shell.md` also name, so neither runs beside one of them. Lines 3, 5 and 9
edit `client/src/ui/contextStack.test.ts` and run in that order.

A title that loses a count is checked against the open acceptance ledgers before it changes: a
ledger that selects a test by its title would select nothing afterwards.
