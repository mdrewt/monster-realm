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
   - **Derive.** The expected value is computed from the registry (`OVERLAY_IDS.length`). This is
     only for a quantity the product's output can lower or raise: a distinctness check
     (`new Set(names).size`), a count of what the code under test returned, the size of another
     product table's key set, a generator bound.
   - **Own entity.** The test asserts what it is about ("my query is in the batch once and the
     private table is not") and drops the restated total.
   - **Delete.** An assertion the owner already makes goes: a second roster, a bare count, and a
     tally the test's own loop fixes (it adds one per pass, a failed expectation throws before the
     increment, and any member it skips is one the test names itself). The deletion names the
     surviving test, and for a protected behaviour someone other than the deleter re-creates the
     defect and shows the survivor red (`standards/testing-tdd.md`, "Deleting a check is
     legitimate"). Each fact below names the defect to re-create.
3. **A per-member expectation is behaviour, not a restatement.** A hand-written table that says
   what each member should be (its tier, whether a battle keeps it, whether a reconnect closes it,
   which adapter it holds, what kind of frame it opens as, what it is called) stays hand-written.
   It is never rebuilt by reading the product table it checks. Where the registry has a key type,
   the table is typed `Record<K, _>` over it, so the compiler asks for the new row.
4. **The subscription batch is read from what `connect()` sends.** The array stays unexported: a
   test that imported it would compare the batch with itself.
5. **A test's own fixture is not a registry.** A count of rows the test built is read from the
   fixture (`SAMPLE_VM.entries.length`) or dropped.
6. **A hand list that restates what a source scan measured goes,** once an executing check holds
   whatever the list alone held ("Pins that read source text" below).

## What the pins cost

| Fact | Literal sites |
|---|---|
| Overlay ids (16) | the number at 36 assertion sites in five files: `ui/overlayRegistry.test.ts` 19, `ui/overlayA11y.test.ts` 6, `ui/overlayA11yWiring.test.ts` 5, `ui/a11yCopy.test.ts` 4, `ui/announcements.test.ts` 2, and once more in `ui/contextStack.test.ts`; numbers worked out from it by hand (15, 48, 64, 180) in the first, and (14, 15, 17, 23, 48, 51, 272) in `ui/contextStack.test.ts` |
| Catalog keys (543) | 12 sites in six tests of `ui/i18n/catalog.test.ts`, beside the roster that already fixes it |
| Subscription batch (29) | 3 sites in `net/connection.runtime.test.ts`, beside the exact roster in `net/connection.test.ts` |
| Help entries (16) | 5 sites in `main.help.test.ts`, 4 in `ui/helpView.test.ts`, 4 in `ui/helpModel.test.ts` |
| Command kinds (36: 10 safe, 26 refused) | 4 sites in `ui/battlePolicy.test.ts`, 6 in `ui/contextStack.test.ts` |
| Menu root rows (8) | the same eight-key array written out in five test files, and the numbers 8 and 7 at 15 sites in five |

Of the last 300 commits on `master` (`git log -300 --name-only`), 63 changed
`ui/i18n/catalog.test.ts`; nine of the ten most recent changed the key count, in nine to twelve
places each, and three of the ten added no test. 27 changed `ui/i18n/catalogParity.test.ts`; of
the twelve most recent, seven edited the hand list of the keys `main.ts` resolves and four the
hand list of the files that import the resolver. Ten changed `ui/contextStack.test.ts` and left
`ui/contextStack.ts` alone; six of them moved the command counts. Eight titles state a count
their bodies do not assert: 18 overlays above 16 in `ui/overlayA11y.test.ts` (twice) and
`ui/overlayA11yWiring.test.ts`, 15 safe commands above 10 in `ui/contextStack.test.ts`, and 511
keys (twice) and 527 keys (twice) above 543 in `ui/i18n/catalog.test.ts`. Nothing checks a title.

A build run may add a pin file to its own file list when a measurement proves the need and no
unmerged slice holds the file. That spares the spec author the list and leaves the rest:

- **The edits.** One overlay is still about 36 count sites in five files, plus the hand
  arithmetic; one string is 12.
- **The serialization.** Two slices that name the same test file never run together, and a run
  that needs a file an unmerged slice holds stops. Every slice that adds a command names
  `ui/contextStack.test.ts`; every slice that adds a string names `ui/i18n/catalog.test.ts`.
- **The drift.** A count in a title or a comment is bumped by hand or goes stale.

This plan does not remove a second cost of the same kind: a test that builds another module's
type by hand (`PointerDeps`, a `Command`, a view's callbacks) stops compiling when that type
changes. A fixture row is not a restated registry, and rule 3 keeps it.

## Shared facts

### Overlay ids

**Product value.** `OVERLAY_IDS` in `ui/overlayRegistry.ts`: the keys of `OVERLAY_TIERS`, a
`Record<OverlayId, OverlayTier>`, in declaration order.

**Owner.** `ui/overlayRegistry.test.ts` › "UIF16B.7 OVERLAY_IDS is the exact 16-id roster":
ordered equality with a hand-written list. Order is behaviour: `canOpen` names the first blocker
in declaration order. Its title loses the count.

**Protected:** accessibility. **Defect to re-create.** Swap two rows of `OVERLAY_TIERS`, then
delete one id's row and its other compile-forced rows; the owner goes red both times.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/overlayRegistry.test.ts` › "OR-MANIFEST-COMPLETE BITES" | the `ui/*View.ts` file count is `OVERLAY_IDS.length + 4` | already derived; see "Pins that read source text" |
| `ui/overlayRegistry.test.ts` › "OR-TIERS-PARTITION BITES" | the three tier lists; `OVERLAY_IDS.length` is 16; the lists together hold 16 ids and equal `OVERLAY_IDS`; a `Set` of the ids has 16 | the tier lists and their equality with `OVERLAY_IDS` stay (rule 3). The two length-16 assertions: delete; survivors: this test's own equality, and the owner. The duplicate check: derive (`OVERLAY_IDS.length`). The title loses its count |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-EMPTY-ALLOWS-ALL BITES" | a tally of 16, one per pass | delete; survivor: the owner. The title loses its count |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-GUARDONLY-ALL BITES" | a tally of 180, one per pass but the target itself | delete; survivor: the owner |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-BATTLE-DENIES-ALL BITES" | a tally of 15, one per pass but the battle | delete; survivor: the owner |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-BATTLE-TARGET-DENIES BITES" | a tally of 15, one per pass but the battle | delete; survivor: the owner |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-MULTI-BLOCKER BITES" | the generator bound `maxLength: 16` | derive: `OVERLAY_IDS.length` |
| `ui/overlayRegistry.test.ts` › "OR-CANOPEN-TOTAL BITES" | the generator bound `maxLength: 16` | derive: `OVERLAY_IDS.length` |
| `ui/overlayRegistry.test.ts` › "OR-ANYVISIBLE-PROBES-EVERY-ID BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner. The title loses the count |
| `ui/overlayRegistry.test.ts` › "OR-ANYVISIBLE-EXEMPT BITES" | `OVERLAY_IDS.length` is 16; a tally of 48, three per pass | delete both; survivor: the owner |
| `ui/overlayRegistry.test.ts` › "OR-VISIBLEIDS-EXACT BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivors: the owner, and this test's own all-true case equal to `OVERLAY_IDS` |
| `ui/overlayRegistry.test.ts` › "OR-HANDLES-DIALOGUE-HAS-NO-HIDE BITES" | a tally of 15 over a table the test built, one per pass but the dialogue | delete (rule 5); survivor: the owner |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-TOTALITY-COMPILE BITES" | `OVERLAY_IDS.length` is 16; `OVERLAY_A11Y` has 16 keys | delete both; survivors: this test's own missing-key and extra-key sets against `OVERLAY_IDS`, and the owner |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-LABELKEY-SHAPE BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass; 16 distinct label keys | delete the first two; survivor: the owner. The distinctness check: derive (`OVERLAY_IDS.length`) |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-DISMISSIBLE-VS-TIER BITES" | `OVERLAY_IDS.length` is 16; the two branches together ran 16 times; 13 ids took the constrained branch, 3 the other, by their row in `OVERLAY_TIERS` | delete the first two; survivor: the owner. The 13 and the 3: derive from the tier lists (`EXPECTED_EXCLUSIVE_TOP.length + EXPECTED_GUARD_ONLY.length`, `EXPECTED_HIDE_SWITCH.length`) |
| `ui/overlayRegistry.test.ts` › "OR-A11Y-PURE-DATA-TABLE BITES" | `OVERLAY_IDS.length` is 16; 64 fields checked, counted over each product row's own fields; 16 selectors checked, one per pass; 16 distinct selectors | delete the length and the selector tally; survivor: the owner. The field count: derive (`4 * OVERLAY_IDS.length`): a product row missing a field lowers it. The distinctness check: derive |
| `ui/overlayA11y.test.ts` › "S1-ARIA-ALL-17 BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner. The title loses its count |
| `ui/overlayA11y.test.ts` › "LRC-ADOPT BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner. The title loses its count |
| `ui/overlayA11y.test.ts` › "under the fr locale an opened overlay is named and announced in French" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner |
| `ui/overlayA11yWiring.test.ts` › "S10-WIRE-TOTALITY BITES" | `OVERLAY_IDS.length` is 16; the opener table's keys and `OVERLAY_A11Y`'s keys equal `OVERLAY_IDS`; 16 distinct accessible names | delete the length; survivor: the owner. The opener table's key equality stays (the table is this test's fixture). The `OVERLAY_A11Y` key equality: delete; survivor: `ui/overlayRegistry.test.ts` › "OR-A11Y-TOTALITY-COMPILE BITES". The distinctness check: derive. The title loses its count |
| `ui/overlayA11yWiring.test.ts`, the `afterAll` of the describe "m23-s10 / A11Y-13,14,16" | three tallies of 16, one per generated per-id test | delete: their subject is whether another test ran, which `standards/testing-tdd.md` does not count as a check. Survivors: `ui/overlayA11yWiring.test.ts` › "S10-WIRE-TOTALITY BITES" (the opener table covers every id) and the per-id tests themselves |
| `ui/overlayA11yWiring.test.ts` › "QF1-1-PARTITION-TOTAL BITES" | the three anchor classes sum to `OVERLAY_IDS.length` | already derived |
| `ui/a11yCopy.test.ts` › "A11YCOPY-OVERLAY-NAMESPACE-EXACT BITES" | `OVERLAY_IDS.length` is 16; 16 distinct derived keys; the Controls key is among them; a tally of 16, one per pass | delete the length, the membership check and the tally; survivor: the owner. The distinctness check: derive |
| `ui/a11yCopy.test.ts` › "UIF16B.3 the overlay-title namespace is exactly 16 keys" | the `a11y.overlay.*` namespace has 16 keys | delete; survivor: `ui/a11yCopy.test.ts` › "A11YCOPY-OVERLAY-NAMESPACE-EXACT BITES" (the namespace equals the keys built from `OVERLAY_IDS`). The title loses its count |
| `ui/announcements.test.ts` › "S1-ANN-OVERLAY-OPENED-DERIVED BITES" | `OVERLAY_IDS.length` is 16; a tally of 16, one per pass | delete both; survivor: the owner. The title loses its count |

`ui/contextStack.test.ts` › "SO2-7-ROSTER" also asserts the 16; its row is under "Frame ids". The
other 22 test files that name `OVERLAY_IDS` only loop over it in a setup or teardown hook and pin
nothing. `indexShell.smoke.test.ts` and `main.dispatch.test.ts` loop over it;
`ui/menuModel.test.ts` checks one id's membership.

### The accessible-name keys

**Product value.** The `a11y.*` keys of `CATALOG_EN` (`ui/i18n/catalog.en.ts`), typed by the
`A11yKey` union in `ui/i18n/messageIds.ts`: one `a11y.overlay.<id>.title` per overlay id and
`a11y.world.region`.

**Owner.** `ui/i18n/catalog.test.ts` › "ts-6b-9 the en a11y.* values are byte-identical": the
`a11y.*` key set of both catalogs equals its hand table, which also states each English name
(rule 3). Its describe title loses the count.

**Protected:** accessibility. **Defect to re-create.** Add an `a11y.*` key to the union and both
catalogs; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/i18n/catalog.test.ts` › "ts-6b-9 the en a11y.* values are byte-identical" | its own table has 17 rows; at least 15 French names differ from the English | delete the 17; survivor: the same test's key-set equality. The floor: derive (the table's size less its two named cognates) |
| `ui/a11yCopy.test.ts` › "a11yCopy is exactly the a11y.* entries of CATALOG_EN" | `a11yCopy` has 17 keys, and equals the `a11y.*` entries read from `CATALOG_EN` | delete the count; survivor: the same test's equality |
| `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" | the parsed `A11yKey` union has 17 members | delete; survivor: the same test's comparison of the parsed total with `Object.keys(CATALOG_EN).length` |

### Frame ids

**Product value.** `FrameId` in `ui/contextStack.ts` (`OverlayId` or `SOCIAL_FRAME`), the key type
of `SCREEN_POLICY`, `RECONNECT_CLOSES` and, in `ui/screens/index.ts`, `SCREEN_ADAPTERS`. The frame
ids have no list of their own: they are the overlay roster plus the Social frame. The overlay ids
that are not `MIRRORED_IDS` are the player frames.

**Owner.** `ui/contextStack.test.ts` › "CTL2-1-POLICY: SCREEN_POLICY is total over the frame ids":
the keys of `SCREEN_POLICY` equal the overlay ids plus the Social frame, and `MIRRORED_IDS` equals
the hand-written server pair. The membership itself is the overlay owner's.

**Protected:** gameplay (what a battle and a reconnect close) and accessibility (one modal at a
time). **Defect to re-create.** Give `SCREEN_POLICY` a row for an id that is not a frame id, by a
cast; this owner goes red. Drop an overlay id; the overlay owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/contextStack.test.ts` › "CTL2-1-POLICY: SCREEN_POLICY is total over the frame ids" | `MIRRORED_IDS` has 2 members | delete; survivor: the same test's equality with the pair |
| `ui/contextStack.test.ts`, module scope | `PLAYER_IDS`, the 14 player ids written out; `PLAYER_FRAMES`, one frame per id with its kind (the challenge a prompt, Profile a text entry); `SAFE_OVER_BATTLE` (4) and `UNSAFE_OVER_BATTLE` (10) | `PLAYER_IDS` derives: `OVERLAY_IDS` without the hand-written server pair. The kind of each player frame stays hand-written, as a `Record` over the player ids (rule 3), and `PLAYER_FRAMES` is `PLAYER_IDS` mapped through it, so the frames keep the ids' order. The safe and unsafe lists stay (rule 3) |
| `ui/contextStack.test.ts` › "CTL3-2-DROP-EXACT" | `PLAYER_IDS` has 14; it equals `OVERLAY_IDS` without the pair; a battle drop returns 15 commands, then 14 | delete the length and the equality (the list is derived); survivors: the overlay owner and this section's owner. The command counts: derive (`PLAYER_IDS.length + 1`, `PLAYER_IDS.length`). The title loses its count |
| `ui/contextStack.test.ts` › "CTL3-2-POLICY-EXACT" | a 17-row hand table of owner and battle rule; it has 17 rows; its ids equal the frame ids | the table stays, typed `Record<FrameId, _>` (rule 3). The row count: delete; survivor: the same test's id equality |
| `ui/contextStack.test.ts` › "CTL3-4-CONV-APPEARS" | its title names 14 player frames; its body reads `PLAYER_IDS` | already derived. The title loses its count |
| `ui/contextStack.test.ts` › "CTL3-5-OPEN-GATE" | its own row table has 23 rows | delete (rule 5); survivor: this section's owner |
| `ui/contextStack.test.ts` › "CTL6C-1-RECONCILE-KEEPS-SAFE-OVER-BATTLE" | the safe list has 4 and the unsafe list 10; together they equal `PLAYER_IDS`; a drop returns 10 closes | delete the two lengths; survivor: the same test's equality with `PLAYER_IDS`. The close count: derive (`UNSAFE_OVER_BATTLE.length`) |
| `ui/contextStack.test.ts` › "the SCREEN_POLICY battleSafe column is exactly the literal table" | a hand `Record<FrameId, boolean>`; 5 product rows are true | the table stays (rule 3). The count: delete; survivor: the same test's row-by-row equality |
| `ui/contextStack.test.ts` › "SO1-1-SWEEP-STAMPED" | a tally of 48, three per pass; a tally of 5, one per pass through the branch its own table picks | delete both; survivor: this section's owner |
| `ui/contextStack.test.ts` › "SO1-1-ROSTER-LITERAL" | `SO1_ROSTER`, a hand `Record<FrameId, boolean>`; it has 17 keys, 11 true; `RECONNECT_CLOSES` equals it | the table and the equality stay (rule 3). The two counts of its own rows: delete; survivor: the same test's equality. The title loses its counts |
| `ui/contextStack.test.ts` › "SO1-1-ROSTER-SWEEP" | a tally of 51, three per pass | delete; survivor: this section's owner |
| `ui/contextStack.test.ts` › "SO2-1-OPEN-EDGE" | the openable ids (frame ids without the mirrored pair) are 15 | delete; survivor: this section's owner |
| `ui/contextStack.test.ts` › "SO2-3-MIRROR-TRIO" | `PLAYER_IDS` has 14 | delete; survivors: the overlay owner and this section's owner |
| `ui/contextStack.test.ts` › "SO2-5-GATE-STACK" | a tally of 272 cells, one per pass | delete; survivor: this section's owner |
| `ui/contextStack.test.ts` › "SO2-7-ROSTER" | `MIRRORED_IDS` is the pair and has 2; `PLAYER_IDS` has 14; `OVERLAY_IDS` has 16; the mirrored and player ids together equal `OVERLAY_IDS` | the pair equality and the disjointness stay. The three counts and the union equality: delete (the list is derived); survivors: the overlay owner and this section's owner. The title loses its count |
| `ui/contextStack.test.ts` › "CTL11A-2-DENY-PREDICATE" | its hand list of the server-owned frames has 2 members | delete (rule 5); survivor: this section's owner (the server-owned rows equal the pair) |
| `ui/screens/index.test.ts` › "CTL6B-1-ADAPTERS-TOTAL" | the keys of `SCREEN_ADAPTERS` equal the frame ids; there are 17; the `CONVERTED` map of 11 adapters, by identity; 6 legacy ids, named | the key equality, the `CONVERTED` map and the legacy list stay (rule 3). The 17 and the 6: delete; survivors: the same test's key equality and its legacy-list equality. The title loses its count |
| `input/router.test.ts`, module scope, and › "CTL11A-2-DECIDE-DENIED" | `PLAYER_FRAMES`, the player ids and the Social frame written out; its length plus 2 is `OVERLAY_IDS.length + 1` | the list derives (the frame ids without the server pair). The arithmetic check: delete; survivor: this section's owner |

`FRAME_IDS` is built in both `ui/contextStack.test.ts` and `ui/screens/index.test.ts` as the
overlay ids plus the literal `'social'`; both read `SOCIAL_FRAME` instead.

### Catalog keys

**Product value.** `Object.keys(CATALOG_EN)` in `ui/i18n/catalog.en.ts`, typed by the `MessageId`
and `A11yKey` unions in `ui/i18n/messageIds.ts`. Both catalogs are `satisfies Catalog`, so a key
missing from either is a compile error.

**Owner.** `ui/i18n/catalog.test.ts` › "m24s3/21r-b/21r-b2 CAT-01": the keys equal the sorted hand
roster `EXPECTED_KEYS`, every English value equals its row, and the parameterised keys are exactly
those with sample parameters. Its title loses the count and the history of counts.

The roster keeps its English values. A slice that adds a string already edits
`ui/i18n/catalog.en.ts`, `ui/i18n/catalog.fr.ts` and `ui/i18n/messageIds.ts`, so the roster row
costs it no new file; the row is where the tester states the string before the catalog holds it.

**Protected:** treated as protected (i18n parity). **Defect to re-create.** Add one key with text
to the union and both catalogs; the owner goes red. Remove one and the owner goes red again. Drop
one key from the French catalog only; `ui/i18n/catalogParity.test.ts` ›
"m24s7 PARITY-01: I18N-26" goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/i18n/catalog.test.ts` › "m24s3/21r-b/21r-b2 CAT-01" | `EXPECTED_KEYS` has 543 members | delete; survivor: the same test's equality with the catalog's keys |
| `ui/i18n/catalog.test.ts` › "m24s1 CATALOG-SHAPE" | the keys equal `EXPECTED_KEYS` | delete; survivor: the owner. Its other assertions stay. The title loses the count history |
| `ui/i18n/catalog.test.ts` › "the legacy ids keep their names in both catalogs" | 543 keys in en, in fr and in the roster; the keys equal `EXPECTED_KEYS` | own entity: it keeps its four ids. The three counts and the equality: delete; survivors: the owner, and `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" for the French key set. The title loses its count |
| `ui/i18n/catalog.test.ts` › "the six raising ids that carried the retired Monsters section" | 543 keys in en and in fr | own entity: its retired and kept ids. The counts: delete; survivors: the owner, and `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" |
| `ui/i18n/catalog.test.ts` › "the eleven ids that labelled the four views" | 543 keys in en and in fr | own entity. The counts: delete; survivors: the owner, and `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26". The title loses its count |
| `ui/i18n/catalog.test.ts` › "UIF15B.1 the six menu.social" | 543 keys in en and in fr | own entity. The counts: delete; survivors: the owner, and `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" |
| `ui/i18n/catalog.test.ts` › "UIF15C.5 the six menu.options" | 543 keys in en and in fr | own entity. The counts: delete; survivors: the owner, and `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" |
| `ui/i18n/catalog.test.ts` › "no English or French catalog value still names a retired mouse-only control" | the number of values its loop read equals a sum over the hand tables | delete: one per pass; survivor: the owner, which holds every key and value |
| `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" | the parsed unions total `Object.keys(CATALOG_EN).length` | already derived |
| `ui/i18n/resolver.test.ts` › "m24s1 RESOLVER-T:" | a snapshot of every plain `chrome.*` key and value | delete the snapshot; survivor: the owner, whose roster holds the same keys and values. Its loop (`t(key)` equals `CATALOG_EN[key]`) stays |
| `tactics/strings.test.ts` › "BT11-1-STRINGS-ROSTER" and › "BT10-6-STRINGS-ROSTER" | its hand lists of `tactics.*` keys are in both catalogs, and the first holds that they are the whole namespace | own entity: the tactics module's own keys, edited by the slice that changes that module. Stays |

### The locale registry

**Product value.** The keys of `CATALOGS` in `ui/i18n/resolver.ts`.

**Owner.** `ui/i18n/resolver.test.ts` › "m24s1 RESOLVER-LOCALE": the registry's keys are exactly
`en` and `fr`. Its title loses the count.

**Protected:** treated as protected (i18n parity). **Defect to re-create.** Register a third
locale; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-01: I18N-26" | the registry's keys are `en` and `fr` | delete; survivor: the owner |
| `ui/i18n/catalogParity.test.ts` › "m24s7 PLURAL-01" | its plural table's keys equal the registry's | already derived |
| `ui/i18n/catalogShape.test.ts` › "m24s6 SHAPE-04: a11y.* keys stay out of tf()" | the registry's keys are `en` and `fr` | delete; survivor: the owner. Its loop over the registered locales stays |

### Help entries

**Product value.** `ENTRY_KEYS` in `ui/helpModel.ts`, in list order.

**Owner.** `ui/helpModel.test.ts` › "UIF14.4 ENTRY_KEYS is the sixteen mechanics in the pinned
order": ordered equality with a hand-written list. Its title loses the count.

**Protected:** no. **Defect to re-create.** Remove one key from `ENTRY_KEYS`; the owner goes red.

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
| `ui/i18n/catalog.test.ts`, module scope, and › "UIF14.4 the other 34 plain Help ids" | `UIF14_ENTRY_KEYS`, the 16 keys written out to build 32 rows of the catalog roster; 34 ids; 16 distinct texts per kind | the list stays hand-written: it is part of the catalog owner's roster. The 34: delete; it counts the test's own list (rule 5). The distinctness check: derive (`UIF14_ENTRY_KEYS.length`). The title loses its counts |
| `ui/screens/helpScreen.test.ts` › "UIF14.1 HELP_LAYOUT is a tabs layout" | the Encyclopedia's items equal `ENTRY_KEYS` | already derived. The title loses its count |

### Subscription batch

**Product value.** The queries `connect()` in `net/connection.ts` passes to the first `subscribe`
call of a build. The array is not exported (rule 4).

**Owner.** `net/connection.test.ts` › "ts-4.4 the subscription batch is exactly the 29 queries
below": the queries a mocked build received in that call, sorted, equal a hand-written list,
sorted. A query added, dropped, doubled or swapped for another changes the sorted list. Its title
loses the count, and so does its assertion that the hand list has 29 members.

**Protected:** privacy. What a client subscribes to is what it is sent. **Defect to re-create.**
Add `SELECT * FROM trade_offer` to the batch; double `zone_def`; drop `my_wallet`; swap `npc` for
`monster_pub`. The owner goes red each time, and on the swap it is the only test that does.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `net/connection.runtime.test.ts` › "the one subscription batch includes the public zone_def table exactly once" | the batch has 29 queries | own entity: `zone_def` once and no `character` query. The count: delete; survivor: the owner. The title loses its count |
| `net/connection.runtime.test.ts` › "the one subscription batch names each of the seven owner-scoped tactical views exactly once" | the batch has 29 queries | own entity: the seven views once each and no private battle table. The count: delete; survivor: the owner. The title loses its count |
| `net/connection.runtime.test.ts` › "the one subscription batch names my_trade_session exactly once" | the batch has 29 queries | own entity: the view once and never the private table. The count: delete; survivor: the owner. The title loses its count |

### Command kinds and their battle policy

**Product value.** `COMMAND_BATTLE_POLICY` in `ui/battlePolicy.ts`, a
`Record<Command['kind'], 'safe' | 'refuse'>`: the compiler holds its keys to the `Command` union
of `ui/screens/types.ts`.

**Owner.** `ui/battlePolicy.test.ts` › "the battle policy table has no row for any of the seven
1v1 commands": the table's keys equal `COMMAND_KINDS`, a hand-written list the compiler checks
against `Command['kind']` in both directions. Its title loses the count.

The policy of each kind is a per-member expectation (rule 3), held by
`ui/contextStack.test.ts` › "CTL6C-3-REFUSAL-TABLE": one sample command per kind in two hand
lists, safe and refused, compared with the table row by row.

**Protected:** gameplay (which commands a battle refuses). **Defect to re-create.** Add a row to
the table for a kind that is not a `Command`, by a cast; the owner goes red. Flip one kind's row
from `refuse` to `safe`; "CTL6C-3-REFUSAL-TABLE" goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/battlePolicy.test.ts` › "the battle policy table has no row for any of the seven 1v1 commands" | `COMMAND_KINDS` has 36 members | delete; survivor: the same test's type-level check that the list is exactly the `Command` kinds |
| `ui/battlePolicy.test.ts` › "UIF14B.3 reportProblem is classified once" | the table has 36 keys | own entity: `reportProblem` is safe. The count: delete; survivor: the owner |
| `ui/battlePolicy.test.ts` › "ts-4.6 the policy table has no respondTrade" | the keys equal `COMMAND_KINDS`; 10 rows safe, 26 refused | own entity: no row for the three retired kinds. The key equality: delete; survivor: the owner. The two counts: delete; survivor: `ui/contextStack.test.ts` › "CTL6C-3-REFUSAL-TABLE". The title loses its counts |
| `ui/contextStack.test.ts` › "CTL6C-3-REFUSAL-TABLE" | its lists have 10 and 26 rows, 36 kinds in all; the safe kinds in order; the table's keys equal the kinds listed | the two lists and the key equality stay (rule 3). The three counts: delete; survivor: the same test's key equality. The ordered safe list: delete; survivor: the same test's row-by-row comparison. The title loses its count |
| `ui/contextStack.test.ts` › "deployUnits is battle-safe" | the table holds 10 safe, 26 refused, 36 kinds | own entity: `deployUnits` is safe and no battle stack refuses it. The three counts: delete; survivors: `ui/contextStack.test.ts` › "CTL6C-3-REFUSAL-TABLE" for the split and the owner for the total. The title loses its counts |
| `main.dispatch.test.ts` › "at a battle base every view callback of a command the battle refuses" | the refused kinds its callbacks reach, and the safe kinds it drives, against the table | own entity: the kinds its own callbacks send. Stays |

### Menu root rows

**Product value.** `MENU_ENTRIES` in `ui/menuModel.ts`, in display order.

**Owner.** `ui/menuModel.test.ts` › "UIF15C.1 CTL5-1-ENTRIES": the root keys equal `ROOT_KEYS`, a
hand-written list, in order.

**Protected:** keyboard reachability (the press counts follow the order). **Defect to
re-create.** Swap two entries of `MENU_ENTRIES`; the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `ui/menuModel.test.ts` › "UIF15C.1 CTL5-1-ENTRIES" | the root has 8 rows, twice | delete both; survivor: the same test's equality with `ROOT_KEYS` |
| `ui/menuModel.test.ts` › "UIF16B.1 the root Profile row is an open leaf" | the seven root leaves, written out | derive: `ROOT_KEYS` without `close` |
| `ui/menuModel.test.ts` › "CTL10B-2-MENU-NO-INITIATE" | the table has 7 leaves | derive: `ROOT_KEYS.length - 1` |
| `ui/screens/mainMenuScreen.test.ts`, module scope | its own `ROOT_KEYS`, the eight keys | derive: the keys of `MENU_ENTRIES`. The tests that compare a layout or a label table with it then prove the screen follows the model |
| `ui/screens/mainMenuScreen.test.ts` › "CTL5-2-A-OPENS-CHILD" | 7 distinct targets; a tally of 7 presses, one per pass | the distinctness check: derive (`OTHER_KEYS.length`). The tally: delete; survivor: the owner |
| `ui/screens/mainMenuScreen.test.ts` › "UIF15C.3 every OTHER remembered cursor" | its list of the keys but Close has 7 members | delete (rule 5); survivor: the owner |
| `ui/menuView.test.ts`, module scope | its own `ROOT_KEYS` | derive: the keys of `MENU_ENTRIES` |
| `ui/menuView.test.ts` › "constructing a second view over the same shared markup", › "UIF15C.1 the real root paints exactly eight", › "MV-VIS-03", › "MV-RENDER-REPLACES" and › "MV-A11Y-OPTION-01" | the view painted 8 rows (seven sites) | derive: `ROOT_KEYS.length`. The second title loses its count |
| `main.menu.test.ts`, module scope | its own `ROOT_KEYS` | derive: the keys of `MENU_ENTRIES` |
| `main.menu.test.ts` › "UIF15B.5 every root leaf" | a tally of 7 leaves driven, one per pass | delete; survivor: the owner |
| `ui/reachability.test.ts` › "UIF15C.3 the bound of 7 presses holds" | its own list of the eight keys; the search reaches 7 leaves; a tally of `8 * 17` cells, one per pass | the list derives (the keys of `MENU_ENTRIES`). The 7: derive (the entries of `MENU_ENTRIES` that open a frame). The tally: delete; survivor: the owner. The title keeps its 7, the press bound, and loses its row count |

### Menu accelerators

**Product value.** The keys of `ACCEL_PATHS` in `input/router.ts`.

**Owner.** `input/router.test.ts` › "CTL11A-1-PATHS": `ACCEL_PATHS` equals a hand-written table of
every path. Its title loses the count.

**Protected:** keyboard reachability. **Defect to re-create.** Add an eleventh accelerator path;
the owner goes red.

| Test | Asserts of this fact | Disposition |
|---|---|---|
| `input/router.test.ts` › "CTL11A-1-PATHS" | `ACCEL_PATHS` has 10 keys | delete; survivor: the same test's equality with its path table |
| `input/router.test.ts` › "UIF15C.2 Y is the one-key path" | its list of menu accelerators has 10 members | delete (rule 5); survivor: the owner |
| `ui/reachability.test.ts` › "the hand-written MENU_ACCELS manifest is exactly the menu accelerators" | `MENU_ACCELS` equals the keys of `ACCEL_PATHS`, lists none twice and has 10 | `MENU_ACCELS` derives (the keys of `ACCEL_PATHS`); the equality, the duplicate check and the count: delete; survivor: the owner. Its Controls-path assertions stay. The title loses its count |

## Pins that read source text

Each row is a shared fact that is itself read from source, a hand list that restates a source
scan, or a source-text fact that more than one test asserts. The dispositions are those of
`standards/testing-tdd.md`, "Deleting a check is legitimate" and "Behavior-preserving changes". A
source read in these files that no row names restates no shared fact and is outside this plan:
the scans of `ui/i18n/catalogParity.test.ts` for dynamic, undefined and dead keys, its parse of
the unions, the purity read of `ui/overlayRegistry.test.ts`, and the scan of `client/e2e` in
`ui/reachability.test.ts`.

| Test | Reads | Disposition |
|---|---|---|
| `ui/i18n/catalogParity.test.ts` › "m24s7/21r-b PARITY-02: I18N-27": the two lists of the literal keys `main.ts` resolves, one per binding | `main.ts`, through the scan | delete (rule 6): the lists restate what the scan measured. Survivor: `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-02: fixtures", which proves alias and two-binding resolution on fixtures |
| `ui/i18n/catalogParity.test.ts` › "m24s7/21r-b PARITY-02: I18N-27": the list of the files that import the resolver | every non-test file under `client/src`, through the scan | replace first: the list is the only check that the walk reaches every directory. `ui/i18n/catalogParity.test.ts` › "m24s7 PARITY-02: fixtures" gains a fixture tree with a file two directories down, run through the same walk, and is watched red on a walk that does not descend; then the list goes. The title loses its file count |
| `ui/i18n/catalog.test.ts` › "m24s1 SHAPE-01" and the same scan inside › "m24s3 CAT-02" | `ui/i18n/catalog.en.ts`, for a `// @desc:` comment beside every entry | delete both: the fact is asserted three times. Survivor: `ui/i18n/catalogShape.test.ts` › "m24s6 SHAPE-01: I18N-24", which reads every registered catalog |
| `ui/i18n/catalog.test.ts` › "m24s1 CATALOG-SHAPE" | `ui/i18n/catalog.en.ts`, for its entry-line count and for one `satisfies Catalog` and one `Object.freeze(` | delete the three reads; survivors: the same test's `Object.isFrozen(CATALOG_EN)`, and the owner of the catalog keys for an entry the type does not know |
| `ui/i18n/catalog.test.ts` › "m24s1 SHAPE-06" | every `catalog.<tag>.ts`, for `oneOther(` | delete the read of the real catalogs: the fact is asserted twice. Survivor: `ui/i18n/catalogShape.test.ts` › "m24s6 SHAPE-06: I18N-33". Its two fixture assertions stay |
| `ui/overlayRegistry.test.ts` › "OR-MANIFEST-COMPLETE BITES" | the names of the `ui/*View.ts` files | stays, re-pointed if the views move. It is the only protection of an accessibility behaviour: a view file outside the registry opens with no accessible name, focus anchor or exclusion, and only a directory listing finds a file that nothing imports |
| `ui/overlayA11yWiring.test.ts`, every test | `client/index.html` and `client/src/styles.css`, loaded as the document the real views run on | not a pin: the files are the fixture, and the assertions are on the DOM and on computed style |

**Defect to re-create for the key lists.** Make the scan resolve no aliased import; the fixtures
test goes red.

`docs/refactors/client-shell.md`, "Tests and docs that follow the code", has two rows that edit
these hand lists as code leaves `main.ts`. The slice that removes the lists rewrites those rows:
nothing follows the code there once the lists are gone.

## What this plan leaves alone

- **Per-member tables** (rule 3): the tier lists, the battle-safe and reconnect tables, the frame
  kind of each player frame, the `CONVERTED` adapter map, the root element ids and anchor classes
  of `ui/overlayA11yWiring.test.ts`, the sweep rows of `ui/reachability.test.ts`.
- **A screen's own row.** `ui/screens/helpScreen.test.ts` and `ui/screens/profileScreen.test.ts`
  each assert that the shipped adapter table holds their own screen.
- **Fixture tallies** that restate no registry: a count of runs of a test's own property, or of
  rows that name no product list.
- **Copy asserted where it is rendered or translated:** the French values of
  `ui/i18n/catalogParity.test.ts`, the per-string tests of `ui/i18n/catalog.test.ts`.
- **Floors on what `client/index.html` ships** in `ui/overlayA11yWiring.test.ts`: they follow the
  document, not a registry.
- **The end-to-end specs.** Those under `client/e2e` that write the menu root keys out
  (`client/e2e/ui-chrome.spec.ts` is one) compare them with the live document.
- **Hand-built fixtures of another module's types** ("What the pins cost").

## Slices, in order

Each slice edits tests only, and the tester makes the edit. It takes the dispositions of the
sections its line names, re-creates each section's defect on a scratch copy for the deleted
assertions of a protected behaviour, and shows the named survivor red; someone other than the
tester adjudicates. It makes the title changes the owner paragraphs and rows name, drops the
registry's count from any other title in the files it edits, and rewrites the comments its edits
make false (a note that a list is hand-written, a count in a comment). The slice for a line
deletes that line, and the slice that deletes the last line deletes this file.

1. Catalog keys: `client/src/ui/i18n/catalog.test.ts`, `client/src/ui/i18n/resolver.test.ts`. It also takes that first file's rows of "The accessible-name keys" (and that section's owner title), "Help entries" and "Pins that read source text", and the title of the locale registry's owner.
2. The catalog scan's hand lists and the locale registry: `client/src/ui/i18n/catalogParity.test.ts`, `client/src/ui/i18n/catalogShape.test.ts`, `docs/refactors/client-shell.md`. It takes those files' rows of "Pins that read source text", "The accessible-name keys" and "The locale registry".
3. Command kinds and their battle policy: `client/src/ui/battlePolicy.test.ts`, `client/src/ui/contextStack.test.ts`.
4. Overlay ids: `client/src/ui/overlayRegistry.test.ts`, `client/src/ui/overlayA11y.test.ts`, `client/src/ui/overlayA11yWiring.test.ts`, `client/src/ui/a11yCopy.test.ts`, `client/src/ui/announcements.test.ts`. It also takes the `ui/a11yCopy.test.ts` row of "The accessible-name keys".
5. Frame ids: `client/src/ui/contextStack.test.ts`, `client/src/ui/screens/index.test.ts`, `client/src/input/router.test.ts`.
6. Subscription batch: `client/src/net/connection.runtime.test.ts`, `client/src/net/connection.test.ts`.
7. Menu root rows and accelerators: `client/src/ui/menuModel.test.ts`, `client/src/ui/screens/mainMenuScreen.test.ts`, `client/src/ui/menuView.test.ts`, `client/src/main.menu.test.ts`, `client/src/ui/reachability.test.ts`, `client/src/input/router.test.ts`.
8. Help entries: `client/src/ui/helpModel.test.ts`, `client/src/ui/helpView.test.ts`, `client/src/main.help.test.ts`, `client/src/ui/screens/helpScreen.test.ts`.

Lines 3 and 5 both edit `client/src/ui/contextStack.test.ts`, and lines 5 and 7
`client/src/input/router.test.ts`: each pair runs in that order. Lines 7 and 8 each edit a
`client/src/main.*.test.ts` file, and line 2 edits `client/src/ui/i18n/catalogParity.test.ts`,
which an extraction from `main.ts` edits until line 2 lands; none of the three runs beside a
slice that claims those files.

A title that loses a count is checked against the open acceptance ledgers before it changes: a
ledger that selects a test by its title would select nothing afterwards.
