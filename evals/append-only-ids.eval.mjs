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
  const current = parseIds(ron);
  const missing = removedIds(baseline, current);
  return {
    pass: missing.length === 0,
    detail: missing.length
      ? `${label}: removed/renumbered stable ids: ${missing.join(', ')} (ids are append-only)`
      : `${label}: ${current.length} ids; all ${baseline.length} baseline ids retained`,
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
      what: 'comment-looking sequences inside a quoted string VALUE',
      ron: '[\n  (id: 1, name: "Path: C://data"),\n  (id: 2, name: "glob /* id: 99 */ in flavour text"),\n]\n',
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
