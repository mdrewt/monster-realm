// Append-only-ids eval (ADR-0006): stable content ids are NEVER removed or
// renumbered (clients + saved data key on them). New ids are fine; a vanished id
// fails the gate. Compares each registry DIRECTORY game-core/content/<reg>/*.ron
// (M8.9e fan-out: globbed in sorted filename order) against committed baselines
// (evals/baselines/*-ids.json).
//
// 11r-i / T2: added `abilities`, `shops`, `npcs` registries (numeric entity
// `id:` — NOT `npcs`' string `npc_id:`, which is a separate gate, see
// evals/append-only-string-ids.eval.mjs). HARD CONSTRAINT (ADR-0173): this
// change may only ADD registries/guards — `parseIds` and `readRegistryDir`'s
// behaviour for EXISTING inputs must not change. Two out-of-scope
// `game-core/tests/*.rs` files assert exact properties of those two
// functions (whole-line-only comment stripping; the "id authored twice
// across two part files" trap) — see pt_d1_roster.rs / pt_d3_tuning.rs
// `comment_needle_violations`. A baseline generated FROM the extractor under
// test is self-confirming and forbidden — every baseline here must be
// derived by reading the RON directly, then cross-checked against parseIds.
//
// 12r-a: the gate is now BIDIRECTIONAL. Until this slice `checkRegistry` only
// ever asked "is every BASELINE id still in the content?", so a live id that no
// baseline pinned was invisible to it. Three baselines had drifted far behind
// the content they guard (species pinned 3 of 16 live ids, skills 6 of 11,
// items 2 of 5), which made append-only enforcement VACUOUS for every unpinned
// id: deleting or renumbering species 20, item 4 or skill 7 outright — the exact
// regression ADR-0006 exists to stop — passed this gate GREEN. Both halves are
// enforced now: a pinned id must never vanish, and a live id no baseline pins
// fails loud with a "baseline needs regeneration" instruction.
//   AUTHOR OBLIGATION: a content PR that adds an id MUST append that id to the
// registry's evals/baselines/*-ids.json in the SAME PR. There is no lazy path
// that re-opens the blind spot.
//   ORDERING (load-bearing, pinned by a tooth): the comment-needle guard MUST
// run BEFORE the growth check. `parseIds` harvests ids straight out of comments
// (readRegistryDir strips whole-line line-comments only), so with the growth
// check first an id echoed in a masking comment is reported as "not in the
// baseline — regenerate", instructing the author to pin a PHANTOM id that
// exists nowhere in the content. A pinned phantom can never be removed without
// violating append-only, so the baseline would be poisoned permanently. The
// ambiguous registry is refused instead, and growth advice withheld until the
// comment is rewritten in the `id=N` form.
//   BASELINE FLOOR (production only): a commit that deletes content AND shrinks
// the baseline in the same breath is self-consistent, so both directions agree
// and both go green. `floorViolations` is the independent anchor — a hand-
// ratcheted minimum id count per registry. It runs ONLY in the default export,
// against the seven real committed baselines, and must NEVER be called from
// `checkRegistry`: the temp-fixture teeth run 2-3 id fixtures against keys like
// `species` (floor 16), so a floor inside `checkRegistry` would false-fail the
// negative controls and make several teeth pass for entirely the wrong reason.
//   SCOPE LIMITS + named residuals (this gate is deliberately narrow):
//   (i) id REUSE / rebinding is NOT detected. Swapping species 20 and 21, or
//       rebinding id 20 to a different creature, is green — the set of ids is
//       unchanged. Catching it needs a MAP-shaped baseline (id -> identity),
//       like evals/baselines/evolution-path-edge-ids.json. Own slice.
//   (ii) `parseIds` is not string-aware, so an id echoed inside a QUOTED RON
//       string value still masks a removal. Deliberately NOT fixed here: it
//       directly contradicts the intentional negative control at the end of the
//       T2-e block (an in-string comment sequence must NOT refuse a registry),
//       so changing it is a policy change about what string values mean to this
//       gate, and needs its own slice.
//   (iii) `parseIds` accepts plain decimal only, so RON's `0x14`, `2_00` and
//       `id : 20` forms evade or mis-harvest it (`id: 2_00` renumbers species 2
//       to 200 and stays green). Zero live occurrences across all content dirs
//       today. Same future "extractor hardening" slice as (ii).
//   NO ADR NUMBER WAS RESERVED for this slice, so this comment block plus the
// three regenerated baseline `_comment`s ARE the decision record. An ADR is
// OWED for the bidirectional semantics + the ordering constraint (ADR-0173 is
// the direct precedent); the PR body asks the supervisor to reserve a number.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function parseIds(ron) {
  return [...ron.matchAll(/\bid:\s*(\d+)/g)].map((m) => Number(m[1]));
}

// Returns the baseline ids that are MISSING from current (the violation set).
export function removedIds(baselineIds, currentIds) {
  const cur = new Set(currentIds);
  return baselineIds.filter((id) => !cur.has(id));
}

// 12r-a: the other half of the bidirectional gate — the LIVE ids the baseline
// does not pin. De-duplicated (a duplicate live id is `validate_content`'s job,
// not this gate's, and repeating it in the remediation advice is just spam) and
// numerically ascending, so the message is stable and reviewable. Mirrors
// `removedIds`' convention; module-local because nothing outside this file
// imports `parseIds`/`removedIds` either.
function unpinnedIds(baselineIds, currentIds) {
  const base = new Set(baselineIds);
  return [...new Set(currentIds)].filter((id) => !base.has(id)).sort((a, b) => a - b);
}

// 12r-a: per-registry MINIMUM pinned-id count, ratcheted BY HAND when content
// grows. The floor is the only check that survives a commit which deletes
// content and shrinks the baseline together (self-consistent, so removal and
// growth both agree), and the E2 teeth cannot substitute for it — their fixture
// RON is derived FROM the baseline, so a baseline pinning only the dropped id
// would satisfy them.
const BASELINE_ID_FLOORS = {
  zones: 2,
  species: 16,
  skills: 11,
  items: 5,
  abilities: 3,
  shops: 1,
  npcs: 2,
};

// PURE. Takes `{ zones: n, species: n, ... }` and returns one human-readable
// string per registry whose count is BELOW its floor, or whose key is ABSENT
// from the input (a baseline that failed to read is a broken baseline, never
// "nothing to check"). Empty array = healthy. Iterates its OWN floor table, not
// the caller's object, so an omitted key cannot slip through. Production-only:
// never call this from `checkRegistry` — see the ordering/floor notes in the
// file header.
export function floorViolations(countsByKey) {
  const violations = [];
  for (const key of Object.keys(BASELINE_ID_FLOORS)) {
    const floor = BASELINE_ID_FLOORS[key];
    const count = countsByKey == null ? undefined : countsByKey[key];
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      violations.push(
        `${key}: pinned-id count is ABSENT from the floor check — its baseline JSON did not yield an id array, which is a broken baseline, not "nothing to check" (floor ${floor})`,
      );
      continue;
    }
    if (count < floor) {
      violations.push(
        `${key}: baseline pins only ${count} id(s), below its floor of ${floor} — a baseline may only ever GROW; either it drifted behind the content (regenerate it from a HAND READ of game-core/content/${key}/*.ron, never from parseIds) or it was SHRUNK alongside a content deletion, which is self-consistent and therefore invisible to both the removal and the growth check`,
      );
    }
  }
  return violations;
}

// M8.9e: each registry is now a DIRECTORY of *.ron parts. Read them all in
// sorted filename order and concatenate the text, then run the same parseIds —
// preserving the fan-out property (adding a part needs no eval edit).
function readRegistryDir(dirPath) {
  const text = readdirSync(dirPath)
    .filter((name) => name.endsWith('.ron'))
    .sort()
    .map((name) => readFileSync(`${dirPath}/${name}`, 'utf8'))
    .join('\n');
  // Strip whole-line `//` comments before id-scanning. Every registry part file
  // carries a header comment, and the migration multiplies that comment surface
  // (N files per registry), so a bare `id: <n>` written inside a comment must NOT
  // be counted as a stable content id — that would poison the committed baseline.
  // Only full-line comments are stripped, never mid-line `//` (it can occur inside
  // a string value), so real `id:` fields are untouched.
  return text.replace(/^[ \t]*\/\/.*$/gm, '');
}

// 11r-i / T2-d: trailing-comment ambiguity detector. `readRegistryDir` strips
// WHOLE-LINE `//` comments only — deliberately, and its behaviour is pinned by
// out-of-scope `game-core/tests/{pt_d1_roster,pt_d3_tuning}.rs`, so it must not
// change. That leaves a blind spot: a MID-LINE trailing comment echoing
// `id: 99` keeps a genuinely-deleted id "present" to `parseIds`'s raw scan, so
// `removedIds` never flags the removal. This guard is layered ON TOP (it does
// not touch `parseIds`/`readRegistryDir`): the registry is REFUSED rather than
// silently trusted whenever such a comment exists, so the ambiguity has to be
// resolved by an author (the shipped convention is the `id=N` form — see
// `pt_d1_roster.rs::comment_needle_violations`, which enforces it Rust-side for
// species/evolutions/encounters/items/shops but NOT abilities/npcs; extending it
// is a named follow-up in ADR-0173).
//
// 11r-i (red-team follow-up): BLOCK comments `/* … */` are a second, WIDER
// instance of the same blind spot. Nothing strips them — `readRegistryDir`'s
// `^[ \t]*//.*$` replace is line-comment-only — so a block comment echoing
// `id: 99` keeps a genuinely-deleted id "present" to `parseIds` exactly as a
// trailing `//` comment does, and it does not even need to share a line with
// real code:
//
//   [                                          parseIds -> [1, 99, 2]
//     (id: 1, name: "A"),                      removedIds([1,2,99], …) -> []
//     /* id: 99 retired, no longer real */     <-- id 99 REALLY removed, unflagged
//     (id: 2, name: "B"),
//   ]
//
// Block comments are already used in this repo's `.ron` content, and the Rust
// `t6_ron_comment_hygiene_over_tuning_dirs` sees inside them only for the
// tuning dirs — zones/skills/abilities/npcs/species had no block-comment
// defence at all. So block comments are scanned here for EVERY registry.
//
// A block comment is flagged REGARDLESS of whether real code precedes it on
// its line (unlike a `//` comment, which is only flagged mid-line, because a
// whole-line `//` comment is already stripped upstream by `readRegistryDir`
// and so can never mask anything).
//
// String-aware in BOTH directions: a `//` or `/*` inside a RON string value
// (e.g. a URL in flavour text) is DATA, not a comment, and must not trip the
// guard; conversely quotes INSIDE a comment must never be mistaken for the
// start of a string literal. The needle is `\bid:\s*\d` — exactly what
// `parseIds` would harvest — so `item_id:`/`species_id:` mentions and the
// conventional `id=N` form are left alone.
function trailingCommentIdNeedles(ron) {
  const found = [];
  let i = 0;
  let line = 1;
  let codeSeenOnLine = false;
  while (i < ron.length) {
    const ch = ron[i];
    if (ch === '\n') {
      line += 1;
      codeSeenOnLine = false;
      i += 1;
      continue;
    }
    // A RON string literal is skipped WHOLESALE, escapes honoured, so neither
    // `//` nor `/*` inside a quoted value is ever read as a comment opener.
    if (ch === '"') {
      codeSeenOnLine = true;
      i += 1;
      while (i < ron.length) {
        if (ron[i] === '\\') {
          i += 2;
          continue;
        }
        if (ron[i] === '"') {
          i += 1;
          break;
        }
        if (ron[i] === '\n') line += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && ron[i + 1] === '/') {
      const nl = ron.indexOf('\n', i);
      const end = nl === -1 ? ron.length : nl;
      const comment = ron.slice(i, end);
      // Whole-line comments are already stripped upstream and are safe anyway.
      if (codeSeenOnLine && /\bid:\s*\d/.test(comment)) {
        found.push(`line ${line}: ${comment.trim()}`);
      }
      i = end;
      continue;
    }
    if (ch === '/' && ron[i + 1] === '*') {
      const close = ron.indexOf('*/', i + 2);
      const end = close === -1 ? ron.length : close + 2;
      const comment = ron.slice(i, end);
      // NOTHING strips block comments — flag them wherever they sit.
      if (/\bid:\s*\d/.test(comment)) {
        found.push(`line ${line}: ${comment.trim()}`);
      }
      for (let k = i; k < end; k += 1) {
        if (ron[k] === '\n') line += 1;
      }
      i = end;
      continue;
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      codeSeenOnLine = true;
    }
    i += 1;
  }
  return found;
}

function checkRegistry(ronDir, baselinePath, baselineKey, label) {
  const ron = readRegistryDir(ronDir);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))[baselineKey];
  // 11r-i / T2-c (attributed Boy Scout fix): `removedIds([], anything)` is always
  // `[]`, so an absent/wiped baseline array would report pass:true and silently
  // disable append-only enforcement for the whole registry. An empty baseline is
  // a BROKEN baseline, never "nothing to enforce".
  if (!Array.isArray(baseline) || baseline.length === 0) {
    return {
      pass: false,
      detail: `${label}: baseline ${baselinePath} key "${baselineKey}" is missing or EMPTY — a wiped baseline silently disables append-only enforcement (ADR-0006); restore the pinned ids`,
    };
  }
  const maskingComments = trailingCommentIdNeedles(ron);
  if (maskingComments.length) {
    return {
      pass: false,
      detail: `${label}: a comment (trailing mid-line \`//\`, or a \`/* … */\` block) carries an id-shaped needle, which masks a removed id from the append-only scan — rewrite it in the \`id=N\` form: ${maskingComments.join('; ')}`,
    };
  }
  // 12r-a: BOTH directions, computed after the two guards above (the ordering is
  // load-bearing — see the file header). `missing` is a pinned id that vanished
  // from the content; `unpinned` is a live id no baseline pins. They are DISTINCT
  // diagnoses on purpose: telling an author to regenerate the baseline in
  // response to a removal is how a shipped id gets silently un-pinned.
  const current = parseIds(ron);
  const missing = removedIds(baseline, current);
  const unpinned = unpinnedIds(baseline, current);
  const removalDetail = missing.length
    ? `${label}: removed/renumbered stable ids: ${missing.join(', ')} (ids are append-only) — restore the CONTENT for those ids; NEVER delete an id from the baseline to make this pass, that un-pins a shipped id and voids the guarantee`
    : '';
  // Renders the `unpinned` list ONLY — never the baseline, never the full live
  // set, and never the baseline PATH (for the temp-fixture teeth that path is a
  // random mkdtemp string whose digits could collide with a literal-substring
  // assertion). Naming an already-pinned id here would read as "the author must
  // add this", which is exactly how a baseline gets poisoned.
  const growthDetail = unpinned.length
    ? `${label}: live ids that no baseline pins: ${unpinned.join(', ')} — baseline needs regeneration: append them to its \`evals/baselines/*-ids.json\` baseline in this same PR, so append-only enforcement actually covers them. The baseline may only ever be APPENDED to, never shrunk. If a number listed here is not a real registry entry — harvested out of flavour text or a nested field — rewrite that occurrence in the \`id=N\` form instead of pinning it`
    : '';
  if (removalDetail && growthDetail) {
    // A RENUMBER fires both halves. Report them together, removal first: an
    // early return after the removal branch would hide the growth half and
    // invite the author to "fix" it by regenerating off the renumbered content.
    return { pass: false, detail: `${removalDetail}; ${growthDetail}` };
  }
  if (removalDetail) return { pass: false, detail: removalDetail };
  if (growthDetail) return { pass: false, detail: growthDetail };
  return {
    pass: true,
    detail: `${label}: ${current.length} ids; all ${baseline.length} baseline ids retained, none unpinned`,
  };
}

// Teeth-only helper (11r-i / T2): exercises the REAL checkRegistry — the same
// module-private function the production registries loop below calls — via a
// scratch directory + scratch baseline JSON file. This is deliberately NOT a
// re-implementation of checkRegistry's logic (a copy could itself drift or be
// wrong); every T2-a/c/d tooth below calls this exact function, so a fix
// lands the moment checkRegistry itself is corrected, wherever inside it the
// fix lives.
function withTempRegistry(ronText, baselineIds, key, label) {
  const dir = mkdtempSync(join(tmpdir(), 'appendonly-teeth-'));
  const baselinePath = join(dir, 'baseline.json');
  try {
    writeFileSync(join(dir, '000-part.ron'), ronText, 'utf8');
    writeFileSync(baselinePath, JSON.stringify({ [key]: baselineIds }), 'utf8');
    return checkRegistry(dir, baselinePath, key, label);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Teeth-only helper (12r-a / T3): renders a minimal registry RON from a list of
// ids, so a fixture can be derived from a baseline array (or from a baseline
// MINUS one id) without hand-writing the text. Plain string concatenation — no
// dynamically-constructed regexes anywhere in this file (semgrep's
// `detect-non-literal-regexp` is a hard CI gate here and has bitten this repo
// twice); every scan below is a literal regex or an indexOf/includes.
function ronFromIds(ids) {
  let out = '[\n';
  for (const id of ids) {
    out += '  (id: ' + id + ', name: "x"),\n';
  }
  return out + ']\n';
}

// Teeth-only helper: substring occurrence count, indexOf-based (no RegExp).
function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

// Teeth-only helper: reads a COMMITTED baseline array (the real, shipped JSON)
// so the E2 teeth below are self-maintaining — they drop an id that the repo
// actually pins today rather than a number frozen into this file.
function committedBaselineIds(baselinePath, key) {
  return JSON.parse(readFileSync(baselinePath, 'utf8'))[key];
}

export default async function () {
  const name = 'append-only-ids (stable content ids never removed/renumbered)';

  // Proof-of-teeth: dropping a baseline id must be flagged.
  if (removedIds([0, 1, 2], [0, 1]).length === 0) {
    return { name, pass: false, detail: 'proof-of-teeth: failed to flag a removed id' };
  }

  // --------------------------------------------------------------------
  // T2-a: a dropped baseline id in each of abilities/shops/npcs must FAIL,
  // naming the missing id. Exercises the real checkRegistry through temp
  // fixture files (not a copy of its logic) — kills a per-registry wiring
  // mistake (swapped baseline key, wrong json field, mis-labelled registry)
  // as well as a regression in removedIds threading, for each of the three
  // NEW registries individually (the generic proof above only proves the
  // mechanism once, not that each new row is wired correctly).
  // --------------------------------------------------------------------
  const droppedIdCases = [
    {
      label: 'abilities',
      key: 'abilities',
      ron: '[\n  (id: 1, name: "A"),\n  (id: 2, name: "B"),\n]\n',
      baselineIds: [1, 2, 3],
      droppedId: 3,
    },
    {
      label: 'shops',
      key: 'shops',
      ron: '[\n  (id: 1, name: "S1", stock: []),\n]\n',
      baselineIds: [1, 2],
      droppedId: 2,
    },
    {
      label: 'npcs',
      key: 'npcs',
      ron: '[\n  (id: 1, npc_id: "a", zone_id: 0, dialogue_tree_id: "t"),\n]\n',
      baselineIds: [1, 2],
      droppedId: 2,
    },
  ];
  for (const { label, key, ron, baselineIds, droppedId } of droppedIdCases) {
    const result = withTempRegistry(ron, baselineIds, key, label);
    if (result.pass || !result.detail.includes(String(droppedId))) {
      return {
        name,
        pass: false,
        detail: `T2-a proof-of-teeth: ${label} failed to flag dropped id ${droppedId} — got ${JSON.stringify(result)}`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T2-b: extractor-misfire guards — proves `\bid:` does not harvest
  // NEIGHBOURING numeric fields for the three new registries. Kills a
  // hypothetical widened regex (e.g. bare `id\s*:` without the `\b`, or one
  // that also matches any `..._id:`/`denom:`) that would silently poison the
  // abilities/shops/npcs baselines with foreign numbers the moment content
  // authors add nested numeric fields (item stock, ability effect params,
  // npc placement fields).
  // --------------------------------------------------------------------
  const shopsMisfireFixture =
    '[\n  (\n    id: 1,\n    name: "S",\n    stock: [( item_id: 42, buy_price: 5 )],\n  ),\n]\n';
  const shopsMisfireIds = parseIds(shopsMisfireFixture);
  if (JSON.stringify(shopsMisfireIds) !== JSON.stringify([1])) {
    return {
      name,
      pass: false,
      detail: `T2-b proof-of-teeth: shops fixture extracted ${JSON.stringify(shopsMisfireIds)}, expected only [1] (item_id: 42 must never leak in)`,
    };
  }

  const abilitiesMisfireFixture =
    '[\n  (\n    id: 1,\n    name: "A",\n    effect: EntryHeal(denom: 4),\n  ),\n]\n';
  const abilitiesMisfireIds = parseIds(abilitiesMisfireFixture);
  if (JSON.stringify(abilitiesMisfireIds) !== JSON.stringify([1])) {
    return {
      name,
      pass: false,
      detail: `T2-b proof-of-teeth: abilities fixture extracted ${JSON.stringify(abilitiesMisfireIds)}, expected only [1] (denom: 4 must never leak in)`,
    };
  }

  const npcsMisfireFixture =
    '[\n  (\n    id: 1,\n    npc_id: "x",\n    zone_id: 5,\n    sprite_id: 11,\n    dialogue_tree_id: "y",\n  ),\n]\n';
  const npcsMisfireIds = parseIds(npcsMisfireFixture);
  if (JSON.stringify(npcsMisfireIds) !== JSON.stringify([1])) {
    return {
      name,
      pass: false,
      detail: `T2-b proof-of-teeth: npcs fixture extracted ${JSON.stringify(npcsMisfireIds)}, expected only [1] (zone_id: 5 / sprite_id: 11 must never leak in; note npc_id/dialogue_tree_id are a SEPARATE string gate, evals/append-only-string-ids.eval.mjs)`,
    };
  }

  // --------------------------------------------------------------------
  // T2-c: empty-baseline guard — a LIVE vacuous-pass bug. `removedIds([],
  // anything)` always returns `[]`, so `checkRegistry` currently reports
  // pass:true for a registry whose baseline array is empty: a baseline
  // wiped to `[]` (accidental JSON edit, botched merge, or the
  // self-confirming-baseline mistake this slice explicitly warns against)
  // would silently disable append-only enforcement for that entire
  // registry. Kills: `checkRegistry` exactly as it stands today.
  //
  // This is an attributed Boy Scout fix — the IMPLEMENTER adds the guard
  // (~4 lines) to `checkRegistry`; this tooth stays RED until it lands.
  // --------------------------------------------------------------------
  for (const emptyBaselineLabel of ['abilities', 'shops', 'npcs']) {
    const result = withTempRegistry(
      '[\n  (id: 1, name: "X"),\n]\n',
      [],
      emptyBaselineLabel,
      emptyBaselineLabel,
    );
    if (result.pass) {
      return {
        name,
        pass: false,
        detail: `T2-c proof-of-teeth: ${emptyBaselineLabel} with an EMPTY baseline array passed vacuously — an empty baseline must FAIL, never silently pass (checkRegistry needs a Boy Scout guard: baseline.length === 0 is a broken/wiped baseline, not "nothing to enforce")`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T2-d: trailing-comment masking — a LIVE bug proven by red-team.
  // `readRegistryDir` strips ONLY whole-line `//` comments (by design — see
  // its own docstring above); a mid-line TRAILING comment that echoes a
  // genuinely-removed id keeps that id "present" to `parseIds`'s raw
  // `\bid:\s*(\d+)` scan, so `removedIds` never flags the removal.
  // `game-core/tests/{pt_d1_roster,pt_d3_tuning}.rs`'s
  // `comment_needle_violations` defends species/evolutions/encounters/items/
  // shops against exactly this pattern (Rust-side, out of `touches:` for
  // this slice) — but NOT abilities or npcs, the two registries this slice
  // adds. Extending that Rust helper to cover them is a NAMED FOLLOW-UP
  // (recorded in ADR-0173), not fixed here (game-core/** is out of scope).
  //
  // This tooth calls the REAL checkRegistry (not a re-implementation) via a
  // scratch fixture whose ONLY real `id:` field is 1; id 99 survives solely
  // inside a trailing comment on a line that ALSO carries real code (so
  // readRegistryDir's whole-line strip leaves it untouched). It is
  // deliberately designed to constrain THE EVAL (checkRegistry may grow a
  // comment-hygiene guard) rather than prescribe any change to
  // parseIds/readRegistryDir, which is the hard-constrained shared helper —
  // it kills a checkRegistry that trusts parseIds' raw output
  // unconditionally for these two registries, and stays RED until the
  // implementer adds that guard.
  // --------------------------------------------------------------------
  const trailingCommentCases = [
    {
      label: 'abilities',
      key: 'abilities',
      ron: '[\n  (\n    id: 1,\n    name: "Solo",\n    effect: StatusImmunity(immune_to: Burn), // replaces id: 99, retired\n  ),\n]\n',
    },
    {
      label: 'npcs',
      key: 'npcs',
      ron: '[\n  (\n    id: 1,\n    npc_id: "solo_npc",\n    zone_id: 0,\n    dialogue_tree_id: "solo_talk", // was id: 99 before consolidation\n  ),\n]\n',
    },
  ];
  for (const { label, key, ron } of trailingCommentCases) {
    const result = withTempRegistry(ron, [1, 99], key, label);
    if (result.pass) {
      return {
        name,
        pass: false,
        detail: `T2-d proof-of-teeth: ${label} passed with id 99 genuinely gone from every real field, surviving ONLY inside a trailing mid-line comment — the gate must still flag it as removed (residual: extend game-core/tests/{pt_d1_roster,pt_d3_tuning}.rs comment_needle_violations to abilities/npcs, tracked in ADR-0173)`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T2-e: BLOCK-comment masking — the red-team's executed repro, verbatim:
  //
  //   const ron = '[\n  (id: 1, name: "A"),\n' +
  //               '  /* id: 99 retired, no longer a real entry */\n' +
  //               '  (id: 2, name: "B"),\n]\n';
  //   parseIds(ron)                 -> [1, 99, 2]
  //   removedIds([1,2,99], [1,99,2]) -> []      <-- id 99 REALLY removed, unflagged
  //
  // `readRegistryDir` strips WHOLE-LINE `//` comments only, and T2-d's guard
  // (as first written) only looked at mid-line `//` comments — so a `/* … */`
  // block comment was invisible to BOTH, for EVERY registry. Note the block
  // comment here sits on its OWN line with no code beside it, so a guard that
  // reuses the `//` rule's "only when real code precedes it" condition still
  // fails this tooth: block comments are never stripped and must be flagged
  // wherever they sit.
  //
  // Applied to all seven registries' shapes via the shared checkRegistry —
  // zones/skills/abilities/npcs/species have no Rust-side block-comment
  // defence at all (`t6_ron_comment_hygiene_over_tuning_dirs` covers only the
  // tuning dirs), so this JS guard is their only net.
  // --------------------------------------------------------------------
  const blockCommentCases = [
    {
      label: 'abilities',
      key: 'abilities',
      ron: '[\n  (id: 1, name: "A"),\n  /* id: 99 retired, no longer a real entry */\n  (id: 2, name: "B"),\n]\n',
    },
    {
      label: 'npcs',
      key: 'npcs',
      ron: '[\n  (id: 1, npc_id: "a", zone_id: 0), /* was id: 99 before consolidation */\n  (id: 2, npc_id: "b", zone_id: 0),\n]\n',
    },
    {
      label: 'species',
      key: 'species',
      // Multi-line block comment: the needle is on a LATER line than the `/*`,
      // killing a guard that only inspects the opening line of the span.
      ron: '[\n  (id: 1, name: "A"),\n  /* retired roster entry:\n     id: 99 was folded into id 2\n  */\n  (id: 2, name: "B"),\n]\n',
    },
  ];
  for (const { label, key, ron } of blockCommentCases) {
    const result = withTempRegistry(ron, [1, 2, 99], key, label);
    if (result.pass) {
      return {
        name,
        pass: false,
        detail: `T2-e proof-of-teeth: ${label} passed with id 99 genuinely gone from every real field, surviving ONLY inside a /* … */ BLOCK comment — nothing strips block comments, so the gate must refuse the registry rather than trust parseIds' raw scan — got ${JSON.stringify(result)}`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T2-e(controls): the block-comment guard must not become a blunt
  // "contains /*" refusal. Two negative controls, both of which a
  // string-BLIND or needle-blind implementation would false-fail:
  //   (1) a block comment with NO id-shaped needle is fine (the `id=N`
  //       convention, and ordinary prose, must stay authorable);
  //   (2) `/*` and `//` appearing INSIDE a quoted RON string VALUE are DATA
  //       (flavour text, a URL, a path) — never a comment opener.
  // Kills a guard that scans raw text for `/*` without string-literal
  // awareness, which would refuse legitimate committed content.
  // --------------------------------------------------------------------
  const blockCommentControls = [
    {
      what: 'block comment with no id-shaped needle (id=N convention)',
      ron: '[\n  (id: 1, name: "A"),\n  /* id=99 was retired here; see ADR-0006 */\n  (id: 2, name: "B"),\n]\n',
    },
    {
      // 12r-a: the in-string needle was `id: 99` when this control was written
      // (11r-i). `parseIds` is NOT string-aware — only `trailingCommentIdNeedles`
      // is — so it harvests that 99 as a live id, and the growth guard this slice
      // adds would then refuse the registry ("99 is not in the baseline"), turning
      // this control RED for a reason that has nothing to do with what it asserts.
      // Fixed by moving the needle to an ALREADY-PINNED id (2): parseIds now sees
      // [1, 2, 2] against the fixture baseline [1, 2], so nothing is unpinned and
      // nothing is missing. The control keeps its full kill — a string-BLIND
      // comment guard still sees `/* id: 2 */` as a block comment carrying an
      // id-shaped needle and still false-fails here. Deliberately NOT fixed by
      // pinning 99 into the fixture baseline: that would make this suite ASSERT
      // that a number inside flavour text is a legitimate content id (see the
      // parked "string-needle refusal" follow-up).
      what: 'comment-looking sequences inside a quoted string VALUE',
      ron: '[\n  (id: 1, name: "Path: C://data"),\n  (id: 2, name: "glob /* id: 2 */ in flavour text"),\n]\n',
    },
  ];
  for (const { what, ron } of blockCommentControls) {
    const result = withTempRegistry(ron, [1, 2], 'zones', 'zones');
    if (!result.pass) {
      return {
        name,
        pass: false,
        detail: `T2-e negative control FAILED (${what}): the comment guard must not refuse this — got ${JSON.stringify(result)}`,
      };
    }
  }

  // ====================================================================
  // 12r-a / T3 — BIDIRECTIONAL enforcement.
  //
  // The live defect: `checkRegistry` only ever asks "is every BASELINE id
  // still present in the content?". A live id ABSENT FROM THE BASELINE is
  // invisible. Three baselines were never updated as content grew
  // (species pins [1,2,3] against 16 live ids; skills [1..6] against 11;
  // items [1,2] against 5), so today DELETING species 20, item 4 or skill 7
  // outright — the exact regression ADR-0006 exists to stop — passes this
  // gate GREEN. The teeth below encode both halves: a shipped id must never
  // vanish (E2), and a live id that no baseline pins must FAIL LOUD with a
  // "regenerate the baseline" instruction (E3) instead of silently widening
  // the blind spot again.
  // ====================================================================

  // --------------------------------------------------------------------
  // T3-a (E2): removing a currently-SHIPPED id must turn the gate red, for
  // each of the three drifted registries. Deliberately NOT hand-written
  // fixtures: each case reads the REAL committed baseline JSON at run time
  // and first asserts the PRECONDITION that the id it is about to delete is
  // actually pinned there. That precondition is what makes this tooth red
  // TODAY (species-ids.json does not pin 20, item-ids.json does not pin 4,
  // skill-ids.json does not pin 7) and it is what keeps the tooth honest
  // afterwards: a "fix" that regenerates only ONE baseline, or that pins a
  // subset, still fails here. Kills: today's checkRegistry + today's stale
  // baselines, together — the pair is the defect.
  // --------------------------------------------------------------------
  const shippedIdCases = [
    {
      label: 'species',
      key: 'species',
      baseline: 'evals/baselines/species-ids.json',
      droppedId: 20,
    },
    { label: 'items', key: 'items', baseline: 'evals/baselines/item-ids.json', droppedId: 4 },
    { label: 'skills', key: 'skills', baseline: 'evals/baselines/skill-ids.json', droppedId: 7 },
  ];
  for (const { label, key, baseline, droppedId } of shippedIdCases) {
    const pinned = committedBaselineIds(baseline, key);
    if (!Array.isArray(pinned) || !pinned.includes(droppedId)) {
      return {
        name,
        pass: false,
        detail: `T3-a proof-of-teeth (E2): ${label} — the baseline is stale; ${baseline} does not pin id ${droppedId}, which ${label} ships in game-core/content/${label}/*.ron today. Deleting or renumbering that id therefore passes this gate GREEN (append-only enforcement is vacuous for every unpinned id). Regenerate the baseline from a HAND READ of the RON — got ${JSON.stringify(pinned)}`,
      };
    }
    const survivors = pinned.filter((id) => id !== droppedId);
    const result = withTempRegistry(ronFromIds(survivors), pinned, key, label);
    if (
      result.pass ||
      !result.detail.includes(String(droppedId)) ||
      !result.detail.includes('append-only')
    ) {
      return {
        name,
        pass: false,
        detail: `T3-a proof-of-teeth (E2): ${label} content with shipped id ${droppedId} DELETED must fail and name it as append-only — got ${JSON.stringify(result)}`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T3-b (E3): a live id that the baseline does not pin must FAIL, with an
  // explicit `baseline needs regeneration` instruction. Without this the
  // drift that caused T3-a simply re-accumulates: content grows, nobody
  // touches the baseline, and the gate quietly stops covering the new ids.
  //
  // ALL SEVEN registries, not just the three that drifted — an
  // implementation that hardcodes the growth branch to species/skills/items,
  // or that short-circuits on the first registry (`zones`), passes every
  // other tooth in this file. The literal `baseline needs regeneration` is
  // asserted as a raw substring (never via a shared constant, which would
  // make the assertion vacuous).
  // --------------------------------------------------------------------
  const unpinnedGrowthKeys = ['zones', 'species', 'skills', 'items', 'abilities', 'shops', 'npcs'];
  for (const key of unpinnedGrowthKeys) {
    const result = withTempRegistry(ronFromIds([1, 2, 9999]), [1, 2], key, key);
    if (
      result.pass ||
      !result.detail.includes('9999') ||
      !result.detail.includes('baseline needs regeneration')
    ) {
      return {
        name,
        pass: false,
        detail: `T3-b proof-of-teeth (E3): ${key} shipped live id 9999 with a baseline of [1, 2] that does not pin it — the gate must FAIL, name 9999, and say "baseline needs regeneration" (an unpinned id is an id this gate cannot protect) — got ${JSON.stringify(result)}`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T3-c: negative controls for the growth check. Each of these would be
  // false-failed by a blunt implementation, and each uses a DIFFERENT
  // key/label so a per-key short-circuit cannot hide behind a uniform
  // `zones` fixture.
  //   c1 live == baseline exactly                  -> pass
  //   c2 live [2,1] vs baseline [1,2]              -> pass  (order-independent;
  //      kills a JSON.stringify / positional comparison)
  //   c3 live [1,1,2] vs baseline [1,2]            -> pass  (a DUPLICATE live id
  //      is `validate_content`'s job, not this gate's; kills a length/count
  //      comparison, which is the laziest way to "detect" growth)
  // --------------------------------------------------------------------
  const growthControls = [
    {
      what: 'c1 live set identical to the baseline',
      key: 'species',
      ids: [1, 2, 3],
      baselineIds: [1, 2, 3],
    },
    {
      what: 'c2 live ids in a different ORDER than the baseline',
      key: 'zones',
      ids: [2, 1],
      baselineIds: [1, 2],
    },
    {
      what: 'c3 a DUPLICATE live id (validate_content owns duplicates)',
      key: 'items',
      ids: [1, 1, 2],
      baselineIds: [1, 2],
    },
  ];
  for (const { what, key, ids, baselineIds } of growthControls) {
    const result = withTempRegistry(ronFromIds(ids), baselineIds, key, key);
    if (!result.pass) {
      return {
        name,
        pass: false,
        detail: `T3-c negative control FAILED (${what}, key ${key}): nothing is removed and nothing is unpinned, so the gate must PASS — got ${JSON.stringify(result)}`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T3-c4: the reported `unpinned` list must be the DE-DUPLICATED set of
  // live ids the baseline does not pin — not the raw parseIds array. A raw
  // array leaks two ways: it repeats a duplicated live id (spam), and a
  // naive "live ids differ from baseline" dump names already-pinned ids as
  // if the author had to add them (phantoms). Both make the gate's own
  // remediation advice wrong, which is how a baseline gets poisoned.
  //
  // ID CHOICE (deliberate): 301/302 pinned, 777 unpinned — digit-shapes that
  // cannot collide with prose or path noise in the message. `mkdtempSync`'s
  // random 6-char suffix contains a `1` in roughly 9% of runs, and the
  // existing empty-baseline detail already interpolates `baselinePath`, so a
  // literal `!detail.includes('1')` assertion would be FLAKY rather than
  // strict. Same kill, deterministic.
  // --------------------------------------------------------------------
  const dedupeCases = [
    { what: 'duplicate PINNED id', ids: [301, 301, 302, 777] },
    { what: 'duplicate UNPINNED id', ids: [301, 301, 302, 777, 777] },
  ];
  for (const { what, ids } of dedupeCases) {
    const result = withTempRegistry(ronFromIds(ids), [301, 302], 'skills', 'skills');
    const names777Once = countOccurrences(result.detail, '777') === 1;
    const namesPinned = result.detail.includes('301') || result.detail.includes('302');
    if (result.pass || !names777Once || namesPinned) {
      return {
        name,
        pass: false,
        detail: `T3-c4 proof-of-teeth (${what}): skills live ${JSON.stringify(ids)} vs baseline [301, 302] must fail naming 777 EXACTLY ONCE and must never name the already-pinned 301/302 (the unpinned list is a de-duplicated SET difference, not the raw parseIds array) — got ${JSON.stringify(result)}`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T3-d: the two diagnoses must stay DISTINCT. A baseline id that is
  // legitimately pinned but absent from the content is a REMOVAL — the
  // author must restore the content, and must NEVER be told to regenerate
  // the baseline (that is how a shipped id gets un-pinned and the append-only
  // guarantee silently evaporates). Kills a guard collapsed into one blunt
  // "the sets differ" message, which is the tempting one-liner here.
  // --------------------------------------------------------------------
  const removalOnly = withTempRegistry(ronFromIds([1]), [1, 2], 'npcs', 'npcs');
  if (
    removalOnly.pass ||
    !removalOnly.detail.includes('append-only') ||
    removalOnly.detail.includes('baseline needs regeneration')
  ) {
    return {
      name,
      pass: false,
      detail: `T3-d proof-of-teeth: npcs live [1] vs baseline [1, 2] is a REMOVAL, not growth — the detail must keep the append-only removal diagnosis and must NOT tell the author to regenerate the baseline — got ${JSON.stringify(removalOnly)}`,
    };
  }

  // --------------------------------------------------------------------
  // T3-e: a RENUMBER (id 7 -> 77) fires BOTH halves, and both must be
  // reported. This is precisely the attack this slice exists to catch, and
  // the natural implementation bug is an early `return` after the removal
  // branch that hides the growth half — leaving the author to fix the
  // removal, re-run, and only then discover the second problem, or worse to
  // "fix" it by regenerating the baseline off the renumbered content.
  //
  // Assertion care: `'77'.includes('7')` is true, so a naive
  // `detail.includes('7')` proves nothing. Asserted instead on (a) the two
  // message substrings and (b) the EXACT rendered removal clause, whose
  // prefix the contract preserves byte-for-byte from today's message.
  // --------------------------------------------------------------------
  const renumbered = withTempRegistry(ronFromIds([1, 2, 77]), [1, 2, 7], 'abilities', 'abilities');
  const rendersRemoved7 = renumbered.detail.includes(
    'removed/renumbered stable ids: 7 (ids are append-only)',
  );
  if (
    renumbered.pass ||
    !rendersRemoved7 ||
    !renumbered.detail.includes('77') ||
    !renumbered.detail.includes('baseline needs regeneration')
  ) {
    return {
      name,
      pass: false,
      detail: `T3-e proof-of-teeth: abilities live [1, 2, 77] vs baseline [1, 2, 7] is a RENUMBER — id 7 removed AND id 77 unpinned. BOTH halves must be reported in one detail: the existing "removed/renumbered stable ids: 7 (ids are append-only)" clause AND the "baseline needs regeneration" clause naming 77 — got ${JSON.stringify(renumbered)}`,
    };
  }

  // --------------------------------------------------------------------
  // T3-f: ORDERING. The comment-needle guard must run BEFORE the growth
  // check. `parseIds` harvests ids straight out of comments (it is not
  // comment-aware; `readRegistryDir` strips whole-line `//` only), so with
  // the growth check first this fixture would report "id 99 is not in the
  // baseline — regenerate", instructing the author to pin a PHANTOM id that
  // exists nowhere in the content. A pinned phantom can never be removed
  // (that would be an append-only violation), so the baseline is poisoned
  // permanently. The registry must be REFUSED for the ambiguous comment
  // instead, and the growth advice withheld until the comment is rewritten
  // in the `id=N` form.
  // --------------------------------------------------------------------
  const maskedGrowth = withTempRegistry(
    '[\n  (id: 1, name: "x"), // was id: 99\n]\n',
    [1],
    'species',
    'species',
  );
  if (
    maskedGrowth.pass ||
    !maskedGrowth.detail.includes('comment') ||
    maskedGrowth.detail.includes('baseline needs regeneration')
  ) {
    return {
      name,
      pass: false,
      detail: `T3-f proof-of-teeth: a masking mid-line comment must be diagnosed as a COMMENT problem before any growth advice is given — otherwise the gate tells the author to pin phantom id 99 (harvested out of the comment) into the baseline, permanently. Got ${JSON.stringify(maskedGrowth)}`,
    };
  }

  const registries = [
    {
      ron: 'game-core/content/zones',
      baseline: 'evals/baselines/zone-ids.json',
      key: 'zones',
      label: 'zones',
    },
    {
      ron: 'game-core/content/species',
      baseline: 'evals/baselines/species-ids.json',
      key: 'species',
      label: 'species',
    },
    {
      ron: 'game-core/content/skills',
      baseline: 'evals/baselines/skill-ids.json',
      key: 'skills',
      label: 'skills',
    },
    {
      ron: 'game-core/content/items',
      baseline: 'evals/baselines/item-ids.json',
      key: 'items',
      label: 'items',
    },
    {
      ron: 'game-core/content/abilities',
      baseline: 'evals/baselines/ability-ids.json',
      key: 'abilities',
      label: 'abilities',
    },
    {
      ron: 'game-core/content/shops',
      baseline: 'evals/baselines/shop-ids.json',
      key: 'shops',
      label: 'shops',
    },
    {
      ron: 'game-core/content/npcs',
      baseline: 'evals/baselines/npc-ids.json',
      key: 'npcs',
      label: 'npcs',
    },
  ];

  // --------------------------------------------------------------------
  // T3-g: registry-table COVERAGE. Every guard in this file is worthless for
  // a registry that is not in the table, and silently losing a row (a botched
  // merge, a "cleanup" of a registry someone thought was dead) is the exact
  // same defect class as this slice: enforcement that looks green because it
  // is not looking. Asserted as a sorted, de-duplicated label set against a
  // literal list — a dropped row, a duplicated row, or a renamed label all
  // fail here rather than passing quietly.
  // --------------------------------------------------------------------
  const expectedRegistryLabels = [
    'abilities',
    'items',
    'npcs',
    'shops',
    'skills',
    'species',
    'zones',
  ];
  const actualRegistryLabels = registries.map((r) => r.label).sort();
  const uniqueRegistryLabels = [...new Set(actualRegistryLabels)];
  if (
    registries.length !== expectedRegistryLabels.length ||
    uniqueRegistryLabels.length !== expectedRegistryLabels.length ||
    actualRegistryLabels.join(',') !== expectedRegistryLabels.join(',')
  ) {
    return {
      name,
      pass: false,
      detail: `T3-g proof-of-teeth: the production registries table must cover EXACTLY the seven registries ${JSON.stringify(expectedRegistryLabels)} — a deleted or duplicated row silently disables append-only enforcement for a whole registry. Got ${JSON.stringify(actualRegistryLabels)}`,
    };
  }

  // --------------------------------------------------------------------
  // BASELINE FLOOR (12r-a, production-only).
  //
  // Second defect, invisible to `removedIds` AND to the growth check: a
  // commit that DELETES content and SHRINKS the baseline in the same breath
  // is self-consistent, so both directions agree and the gate goes green.
  // The E2 teeth above cannot catch it either — their fixture RON is derived
  // FROM the baseline, so a baseline containing only the dropped id would
  // satisfy them. The floor is the independent anchor: a hardcoded minimum
  // id-count per registry, ratcheted by hand, that a shrink cannot argue with.
  //
  // CONTRACT (the implementer builds exactly this):
  //   `export function floorViolations(countsByKey)` — a PURE function taking
  //   `{ zones: n, species: n, ... }` and returning an array of human-readable
  //   strings, one per registry whose count is BELOW its floor or whose key is
  //   ABSENT from the input. Empty array = healthy.
  //   The production check lives in THIS default export (it reads the seven
  //   real baseline JSONs, counts their ids, and fails on a non-empty result).
  //   It must NOT live inside `checkRegistry`: the temp-fixture teeth above run
  //   3-id fixtures against keys like `species` (floor 16), so a floor inside
  //   `checkRegistry` would false-fail T3-c1 and make T2-e's block-comment
  //   cases pass for entirely the wrong reason.
  //
  // The floor numbers are duplicated here on purpose. This is a tooth-owned
  // literal, never a read of the implementer's constant — asserting a message
  // or a threshold against the very value that produced it proves nothing.
  // --------------------------------------------------------------------
  const baselineFloor = [
    { key: 'zones', baseline: 'evals/baselines/zone-ids.json', floor: 2 },
    { key: 'species', baseline: 'evals/baselines/species-ids.json', floor: 16 },
    { key: 'skills', baseline: 'evals/baselines/skill-ids.json', floor: 11 },
    { key: 'items', baseline: 'evals/baselines/item-ids.json', floor: 5 },
    { key: 'abilities', baseline: 'evals/baselines/ability-ids.json', floor: 3 },
    { key: 'shops', baseline: 'evals/baselines/shop-ids.json', floor: 1 },
    { key: 'npcs', baseline: 'evals/baselines/npc-ids.json', floor: 2 },
  ];

  // Floor tooth 1 — the COMMITTED baselines must actually clear the floor.
  // RED today for species (3 < 16), skills (6 < 11) and items (2 < 5): those
  // three baselines never grew with the content, which is what makes the whole
  // append-only guarantee vacuous for every id they do not pin.
  for (const { key, baseline, floor } of baselineFloor) {
    const pinned = committedBaselineIds(baseline, key);
    const count = Array.isArray(pinned) ? pinned.length : 0;
    if (count < floor) {
      return {
        name,
        pass: false,
        detail: `baseline floor: ${key} pins only ${count} id(s) in ${baseline}, below the floor of ${floor}. Either the baseline drifted behind the content (regenerate it from a HAND READ of game-core/content/${key}/*.ron) or it was SHRUNK alongside a content deletion — a shrink is self-consistent, so neither the removal check nor the growth check can see it`,
      };
    }
  }

  // Floor tooth 2 — the floor LOGIC itself must bite, so it cannot be a no-op
  // that merely happens to pass once the baselines are regenerated. Exercises
  // the real exported `floorViolations` (self-import: the module is already
  // fully evaluated here, so this is the same instance, and it forces the
  // function to be exported rather than buried in an inline expression).
  //
  // Two directions, which together pin the implementer's floor to EXACTLY the
  // tooth-owned numbers above: at-floor counts must be clean (floor no higher
  // than the literals), and floor-minus-one must be flagged for EVERY key
  // (floor no lower). Plus an OMITTED key, which kills an implementation that
  // iterates the caller's object instead of its own floor table — a missing
  // count is a broken read, never "nothing to check".
  const selfModule = await import(import.meta.url);
  const floorViolationsFn = selfModule.floorViolations;
  if (typeof floorViolationsFn !== 'function') {
    return {
      name,
      pass: false,
      detail:
        'baseline floor: `export function floorViolations(countsByKey)` is missing — the production floor check must be a PURE, exercisable function (returning one string per below-floor/absent registry), not an inline expression no tooth can reach. It must live at module scope, NOT inside checkRegistry',
    };
  }
  const atFloorCounts = {};
  for (const { key, floor } of baselineFloor) atFloorCounts[key] = floor;
  const atFloorResult = floorViolationsFn({ ...atFloorCounts });
  if (!Array.isArray(atFloorResult) || atFloorResult.length !== 0) {
    return {
      name,
      pass: false,
      detail: `baseline floor: floorViolations() must return an EMPTY array for counts sitting exactly ON the floor ${JSON.stringify(atFloorCounts)} — a floor set higher than the shipped content would fail the gate permanently. Got ${JSON.stringify(atFloorResult)}`,
    };
  }
  for (const { key, floor } of baselineFloor) {
    const shrunk = { ...atFloorCounts, [key]: floor - 1 };
    const shrunkResult = floorViolationsFn(shrunk);
    if (
      !Array.isArray(shrunkResult) ||
      shrunkResult.length === 0 ||
      !shrunkResult.join('; ').includes(key)
    ) {
      return {
        name,
        pass: false,
        detail: `baseline floor proof-of-teeth: floorViolations() must flag ${key} at ${floor - 1} id(s), one below its floor of ${floor}, and name the registry in the violation — otherwise the floor is a no-op for that row. Got ${JSON.stringify(shrunkResult)}`,
      };
    }
    const omitted = { ...atFloorCounts };
    delete omitted[key];
    const omittedResult = floorViolationsFn(omitted);
    if (
      !Array.isArray(omittedResult) ||
      omittedResult.length === 0 ||
      !omittedResult.join('; ').includes(key)
    ) {
      return {
        name,
        pass: false,
        detail: `baseline floor proof-of-teeth: floorViolations() must flag ${key} when its count is ABSENT entirely (a baseline that failed to read is a broken baseline, never "nothing to check") — got ${JSON.stringify(omittedResult)}`,
      };
    }
  }

  // PRODUCTION floor check (12r-a) — the seven real committed baselines only.
  // Deliberately here and NOT in `checkRegistry`: the temp-fixture teeth above
  // run 2-3 id fixtures against keys like `species` (floor 16), so a floor
  // inside `checkRegistry` would false-fail the negative controls.
  const productionIdCounts = {};
  for (const r of registries) {
    const pinned = JSON.parse(readFileSync(r.baseline, 'utf8'))[r.key];
    if (Array.isArray(pinned)) productionIdCounts[r.key] = pinned.length;
  }
  const productionFloorViolations = floorViolations(productionIdCounts);
  if (productionFloorViolations.length) {
    return {
      name,
      pass: false,
      detail: `baseline floor: ${productionFloorViolations.join('; ')}`,
    };
  }

  const results = registries.map((r) => checkRegistry(r.ron, r.baseline, r.key, r.label));
  const failures = results.filter((r) => !r.pass);

  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? failures.map((f) => f.detail).join('; ')
      : `${results.map((r) => r.detail).join('; ')} (teeth verified)`,
  };
}
