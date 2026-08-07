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
//   EXPECTED DISTINCT ID COUNT (production only; historically "the baseline
// floor", and `floorViolations`/`BASELINE_ID_FLOORS` keep those names): a commit
// that deletes content AND shrinks the baseline in the same breath is
// self-consistent, so both directions agree and both go green. The per-registry
// expected count forces such a commit to also LOWER a hardcoded number in two
// separate places, which is a reviewable line in the diff rather than an
// invisible agreement between two files.
//   BE PRECISE ABOUT WHAT THIS BUYS: it is review VISIBILITY, not a mechanical
// impossibility. A fully-coordinated shrink — delete the content, un-pin the id,
// and lower BOTH count pins in the same commit — still passes, and no
// working-tree gate can tell that apart from a legitimate retirement without an
// external record of what was once shipped (that is what a cross-revision
// ever-issued ledger buys, cf. `evals/baselines/evolution-path-edge-ids.json`).
// Only species 20 / item 4 / skill 7 are hard-anchored, incidentally, by T3-a's
// precondition (a). Treat a PR that lowers one of these numbers as a shipped-id
// un-pinning until proven otherwise.
//   It is an EXACT PIN, not a minimum — 12r-a round 2, after the red-team proved
// four green bypasses of a `>=` floor. Under a minimum every id ever added mints
// one free future deletion: grow a baseline from 16 to 17 in a legitimate PR
// (nothing forces the literal to ratchet), delete an id back down to 16 in a
// later PR, both green, one shipped id silently un-pinned; or retire one id and
// add another in the SAME commit and the count never moves at all. So BOTH
// directions fail: below the expected count means a baseline was shrunk (restore
// the content and the pin), above it means content grew without the ratchet.
//   The count is of DISTINCT ids, never `Array.length` — the red-team padded a
// baseline with a duplicate entry, and with `-0` beside a live `0`, both of which
// add to `length` while `Set` collapses them, so a shipped id could be deleted
// from the content AND un-pinned while the count still looked healthy.
//   AUTHOR OBLIGATION: a content PR that adds an id must, IN THE SAME PR, append
// that id to the registry's baseline JSON, bump the production
// `BASELINE_ID_FLOORS` constant, AND bump the tooth-owned `baselineFloor` table
// in the default export. Three visible, reviewable lines; touching only one of
// them fails. There is no lazy path and no deferred ratchet.
//   `floorViolations` runs ONLY in the default export, against the seven real
// committed baselines (whose pinned ARRAYS it is handed, so the distinct-counting
// is inside the pure function where a tooth can reach it), and must NEVER be
// called from `checkRegistry`: the temp-fixture teeth run 2-3 id fixtures against
// keys like `species` (expected 16), so this check inside `checkRegistry` would
// false-fail the negative controls and make several teeth pass for entirely the
// wrong reason.
//   SCOPE LIMITS + named residuals (this gate is deliberately narrow):
//   (i) id REUSE / rebinding is NOT detected. Swapping species 20 and 21, or
//       rebinding id 20 to a different creature, is green — the set of ids is
//       unchanged. Catching it needs a MAP-shaped baseline (id -> identity),
//       like evals/baselines/evolution-path-edge-ids.json. Own slice.
//   (ii) `parseIds` is not string-aware, so an id echoed inside a QUOTED RON
//       string value still masks a removal. Deliberately NOT fixed here, and the
//       FIRST blocker is ADR-0173: `parseIds`' behaviour for existing inputs is
//       frozen by two out-of-scope `game-core/tests/*.rs` files, so no variant of
//       the fix may touch it. Layering a refusal on top (the shape used for
//       comment needles) is additionally ruled out because it contradicts the
//       intentional negative control at the end of the T2-e block (an in-string
//       comment sequence must NOT refuse a registry) — that control is a policy
//       statement about what string values mean to this gate. Own slice, which
//       must settle the policy first.
//   (iii) `parseIds` accepts plain decimal only, so RON's `0x14`/`0b10100`/`0o24`,
//       `2_00` and `id : 20` forms evade or mis-harvest it. Since 12r-a made the
//       gate bidirectional most of these are RED FALSE-FAILS, not green evasions:
//       `id : 20` harvests nothing (the pinned 20 reads as removed) and `id: 0x14`
//       harvests `0` (20 reads as removed AND 0 as unpinned) — noisy and
//       mis-diagnosed, but loud. TWO exceptions stay GREEN. (a) `id: 2_00`
//       harvests `2`, so renumbering species 2 to 200 is invisible. (b) On ZONES
//       specifically, the `0` mis-harvested out of a `0x`/`0b`/`0o` literal is
//       ITSELF a pinned id (zones pins 0 and 1), so rewriting `(id: 0, …)` as
//       `(id: 0x5, …)` renumbers the starting zone and stays GREEN — nothing is
//       reported missing and nothing is reported unpinned. Zero live occurrences
//       across all content dirs today. Same future "extractor hardening" slice
//       as (ii).
//   (iv) `parseIds` is FLAT and depth-blind: it cannot tell a top-level entry's
//       `id:` from an `id:` field on a NESTED sub-record. A nested `id:` inside a
//       registry entry is now a HARD FAIL WITH NO CORRECT REMEDIATION — the
//       nested number is harvested as a live id, the growth half reports it as
//       unpinned, and neither available answer is right: pinning it writes a
//       non-id into the append-only baseline permanently, and rewriting it as
//       `id=N` (the convention for prose) is not valid RON for a real field, so
//       the content loader returns `Err`. This residual is SHARPER than before
//       this slice — until 12r-a the gate only asked "is every baseline id still
//       present?", so a nested `id:` was harmless noise. The growth message says
//       so explicitly and tells the author NOT to pin it. Fixing it needs a
//       scoped, depth-aware extractor, which ADR-0173 puts in its own slice.
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

// 12r-a (round 2): per-registry EXPECTED DISTINCT pinned-id count. Historically
// named a "floor", and the names are kept because the teeth reference them, but
// the semantics are an EXACT PIN, not a minimum: a count below the expected
// number AND a count above it are both violations.
//   Why not a minimum: under `>=` every id ever added mints one free future
// deletion. Grow a baseline from 16 to 17 in a legitimate PR (nothing forces the
// literal below to ratchet), then delete an id back down to 16 in a later PR —
// both commits green, one shipped id silently un-pinned. Retiring one id while
// adding another in the SAME commit does it in one step. Exact equality makes
// the ratchet mandatory and, more importantly, REVIEWABLE.
//   AUTHOR OBLIGATION: a content PR that adds an id must, IN THE SAME PR, append
// that id to the registry's evals/baselines/*-ids.json AND bump the expected
// count here AND bump the tooth-owned `baselineFloor` table in this file's
// default export. Three visible lines; a diff that touches only one of them
// fails. A PR that LOWERS a number here is un-pinning a shipped id: restore the
// content instead.
//   This pin is the only check that survives a commit which deletes content and
// shrinks the baseline together (self-consistent, so the removal and growth
// halves both agree), and the E2 teeth cannot substitute for it — their fixture
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

// PURE. Takes `{ zones: <value>, species: <value>, ... }` and returns one
// human-readable string per registry whose DISTINCT id count does not EXACTLY
// equal its expected count, or whose key is ABSENT from the input (a baseline
// that failed to read is a broken baseline, never "nothing to check"). Empty
// array = healthy.
//
// Each per-key value may be EITHER:
//   * a NUMBER — an already-distinct count, used as-is; or
//   * the pinned ID ARRAY itself, in which case the count is
//     `new Set(ids).size`. This is the shape the production loop passes, so the
//     distinct-counting is inside this pure function where a tooth can reach it
//     rather than buried in the caller, where `pinned.length` and
//     `new Set(pinned).size` are indistinguishable from outside. That
//     indistinguishability is exactly how the duplicate-entry and `-0` padding
//     bypasses stayed green: both inflate `length` while `Set` collapses them.
// Anything else (a string, null, NaN, a missing key) is a BROKEN read.
//
// Membership is tested with `Object.hasOwn`, never a bare property read, so an
// inherited value off the prototype chain (`toString`, or anything an attacker
// plants on `Object.prototype`) can never report a registry as healthy.
//
// The comparison is EXACT EQUALITY in both directions — see the note on
// `BASELINE_ID_FLOORS` for why a minimum is not enough. Iterates its OWN table,
// not the caller's object, so an omitted key cannot slip through.
// Production-only: never call this from `checkRegistry` — see the ordering and
// expected-count notes in the file header.
export function floorViolations(countsByKey) {
  const violations = [];
  for (const key of Object.keys(BASELINE_ID_FLOORS)) {
    const expected = BASELINE_ID_FLOORS[key];
    const value =
      countsByKey != null && Object.hasOwn(countsByKey, key) ? countsByKey[key] : undefined;
    let count;
    if (Array.isArray(value)) {
      count = new Set(value).size;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      count = value;
    } else {
      violations.push(
        `${key}: pinned-id count is ABSENT from the expected-count check — its baseline JSON did not yield an id array or a count, which is a broken baseline, not "nothing to check" (expected exactly ${expected} distinct id(s))`,
      );
      continue;
    }
    if (count < expected) {
      violations.push(
        `${key}: baseline pins ${count} DISTINCT id(s) but exactly ${expected} are expected — a baseline was SHRUNK — restore the content and the pin. Either the baseline drifted behind the content (append the missing ids from a HAND READ of game-core/content/${key}/*.ron, never from parseIds) or it was shrunk alongside a content deletion, which is self-consistent and therefore invisible to both the removal and the growth check. Never lower the expected count to match a shrink. Note DISTINCT: a duplicated entry, or a \`-0\` beside a \`0\`, inflates the array's length without pinning anything`,
      );
      continue;
    }
    if (count > expected) {
      violations.push(
        `${key}: baseline pins ${count} DISTINCT id(s) but exactly ${expected} are expected — content grew — bump the expected count in THIS PR. The expected count is an EXACT pin, not a minimum: set ${key} to ${count} in BOTH \`BASELINE_ID_FLOORS\` and the tooth-owned \`baselineFloor\` table, in the same PR that adds the id. Under a minimum the bump is optional, and every id added that way mints one free future deletion (grow to ${count} in one PR, delete back to ${expected} in the next, both green)`,
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
// start of a string literal. The needle is `\bid:\s*\d+` — exactly what
// `parseIds` would harvest — so `item_id:`/`species_id:` mentions and the
// conventional `id=N` form are left alone.
//
// 12r-a round 2: returns `line N: <the matched needle>` — the MATCH ONLY, never
// the surrounding prose. `checkRegistry` interpolates this straight into a gate
// failure detail, so rendering the whole comment let a content author inject
// arbitrary text into a gate message; the red-team planted the literal phrase
// `baseline needs regeneration` in a comment and got a REMOVAL-context failure
// that handed the reviewer the exact wrong instruction. Detection is unchanged
// (same needle, same string-awareness, same per-registry rules) and the
// `line N: ` prefix is preserved — only the rendered payload narrowed.
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
      const needle = codeSeenOnLine ? /\bid:\s*\d+/.exec(comment) : null;
      if (needle) {
        found.push(`line ${line}: ${needle[0].trim()}`);
      }
      i = end;
      continue;
    }
    if (ch === '/' && ron[i + 1] === '*') {
      const close = ron.indexOf('*/', i + 2);
      const end = close === -1 ? ron.length : close + 2;
      const comment = ron.slice(i, end);
      // NOTHING strips block comments — flag them wherever they sit.
      const needle = /\bid:\s*\d+/.exec(comment);
      if (needle) {
        found.push(`line ${line}: ${needle[0].trim()}`);
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
    ? `${label}: live ids that no baseline pins: ${unpinned.join(', ')} — baseline needs regeneration: append them to its \`evals/baselines/*-ids.json\` baseline in this same PR, and bump that registry's expected distinct-id count in the same PR too, so append-only enforcement actually covers them. The baseline may only ever be APPENDED to, never shrunk. If a number listed here is NOT a real registry entry, do not pin it — the fix depends on where it came from: (a) harvested out of FLAVOUR TEXT or any other prose, rewrite that occurrence in the \`id=N\` form; (b) a genuine NESTED \`id:\` sub-record inside an entry — \`parseIds\` is flat and depth-blind, so it cannot tell that field from a top-level id. \`id=N\` is NOT valid RON for a real field, so rewriting it there breaks the content loader; this needs a scoped, depth-aware extractor in its own slice. Do NOT pin it and do NOT mangle the field`
    : '';
  if (removalDetail && growthDetail) {
    // A RENUMBER fires both halves. Report them together, removal first: an
    // early return after the removal branch would hide the growth half and
    // invite the author to "fix" it by regenerating off the renumbered content.
    return { pass: false, detail: `${removalDetail}; ${growthDetail}` };
  }
  if (removalDetail) return { pass: false, detail: removalDetail };
  if (growthDetail) return { pass: false, detail: growthDetail };
  // DISTINCT baseline count, never `baseline.length`: a padded baseline (a
  // duplicated entry, or `-0` beside `0`) has a length larger than the number of
  // ids it actually pins, which is how this line came to print the
  // self-contradictory "species: 15 ids; all 16 baseline ids retained" while a
  // shipped id had been deleted from the content and un-pinned.
  return {
    pass: true,
    detail: `${label}: ${current.length} ids; all ${new Set(baseline).size} distinct baseline ids retained, none unpinned`,
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

// Teeth-only helper (12r-a round 2 / T3-h): picks a probe id that a pinned set
// does NOT contain, preferring the LOWEST id sitting in a GAP inside the pinned
// range and falling back to `max + 1` when the set is contiguous.
//
// Why a gap and not simply `max + 1`: every round-1 growth probe (9999, 777, 77)
// was the numeric MAXIMUM of its fixture, so the mutant
//   `unpinned = live.filter((id) => !base.has(id) && id > Math.max(...baseline))`
// — a high-water-mark check, blind to any unpinned id BELOW the top of the
// baseline — survived the entire suite (mutant M3). That blindness is a live
// hazard, not a theoretical one: this repo deliberately leaves gap BANDS in its
// id ranges (species pins 1-10, then 20-23, then 30-31; ADR-0144 D1 reserves
// bands), so the next species is as likely to land at 11 or 24 as at 32.
function lowestGapOrNextId(pinnedIds) {
  const sorted = [...new Set(pinnedIds)].sort((a, b) => a - b);
  const present = new Set(sorted);
  const highest = sorted[sorted.length - 1];
  for (let candidate = sorted[0] + 1; candidate < highest; candidate += 1) {
    if (!present.has(candidate)) return candidate;
  }
  return highest + 1;
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
  // and first asserts the PRECONDITIONS that make the case meaningful. Those
  // preconditions are what made this tooth red at the start of this slice
  // (species-ids.json did not pin 20, item-ids.json did not pin 4,
  // skill-ids.json did not pin 7) and they are what keeps the tooth honest
  // afterwards: a "fix" that regenerates only ONE baseline, or that pins a
  // subset, still fails here. Kills: today's checkRegistry + today's stale
  // baselines, together — the pair is the defect.
  //
  // 12r-a round 2 — TWO preconditions with DISTINCT messages (red-team
  // finding 3). The round-1 tooth asserted only that the BASELINE pins the id,
  // while its failure message claimed the id "ships in game-core/content/
  // <label>/*.ron today" — a fact it never verified — and prescribed
  // "regenerate the baseline from a HAND READ of the RON". Under an F1a-style
  // edit (delete species 20 from the CONTENT and un-pin it from the baseline in
  // the same commit) that claim is FALSE and that advice reproduces the shrunk
  // baseline, so the gate stays red forever while the only real fix — restore
  // the content — is never stated. The live-content precondition is therefore
  // checked FIRST, reading the real registry directory, and carries the
  // remediation that actually applies to it. Kills: F1a (content deletion +
  // un-pin in one commit) reaching this tooth with misdirecting advice.
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
    // PRECONDITION (a) — the LIVE CONTENT still ships this id. Its remediation
    // is RESTORE THE CONTENT; regenerating the baseline here is the exact wrong
    // move (it would un-pin a shipped id permanently).
    const liveIds = parseIds(readRegistryDir(`game-core/content/${label}`));
    if (!liveIds.includes(droppedId)) {
      return {
        name,
        pass: false,
        detail: `T3-a precondition (a) FAILED: id ${droppedId} is GONE from the live content game-core/content/${label}/*.ron — this tooth deletes a currently-shipped id to prove the gate flags it, so the id must actually ship. RESTORE THE CONTENT for id ${droppedId} (git revert the deletion). Do NOT "fix" this by editing the baseline or by picking a different id for this tooth: an id that shipped may never be removed (ADR-0006), and un-pinning it from ${baseline} to make the numbers agree is precisely the F1a bypass this slice closes — got live ids ${JSON.stringify(liveIds)}`,
      };
    }
    // PRECONDITION (b) — the COMMITTED BASELINE pins it. Distinct remediation:
    // the content is confirmed present by (a), so the baseline genuinely drifted
    // and regenerating it from a hand read of the RON is the right fix.
    const pinned = committedBaselineIds(baseline, key);
    if (!Array.isArray(pinned) || !pinned.includes(droppedId)) {
      return {
        name,
        pass: false,
        detail: `T3-a precondition (b) FAILED: ${baseline} does not pin id ${droppedId}, even though precondition (a) just confirmed ${label} still ships it in game-core/content/${label}/*.ron. The baseline has DRIFTED BEHIND the content, so deleting or renumbering that id passes this gate GREEN (append-only enforcement is vacuous for every unpinned id). Regenerate the baseline by APPENDING the unpinned live ids, from a HAND READ of the RON — never from parseIds, and never by removing anything already pinned — got ${JSON.stringify(pinned)}`,
      };
    }
    const survivors = pinned.filter((id) => id !== droppedId);
    const result = withTempRegistry(ronFromIds(survivors), pinned, key, label);
    // Needle tightened (red-team finding 4): `'append-only'` is NOT unique to
    // the removal message — the GROWTH message contains "append-only
    // enforcement" too, so the round-1 assertion was satisfied by an
    // implementation that mis-diagnosed a removal as growth. The exact clause
    // `removed/renumbered stable ids` (same needle T3-e uses) is removal-only.
    if (
      result.pass ||
      !result.detail.includes(String(droppedId)) ||
      !result.detail.includes('removed/renumbered stable ids')
    ) {
      return {
        name,
        pass: false,
        detail: `T3-a proof-of-teeth (E2): ${label} content with shipped id ${droppedId} DELETED must fail and render the REMOVAL diagnosis ("removed/renumbered stable ids") naming it — the generic word "append-only" is not enough, it also appears in the growth message — got ${JSON.stringify(result)}`,
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

  // --------------------------------------------------------------------
  // T3-f2 (12r-a round 3): COMMENT TEXT IS NOT AN INJECTION CHANNEL INTO THE
  // GATE MESSAGE. `checkRegistry` interpolates `trailingCommentIdNeedles`'
  // output straight into its failure detail, so whatever that function renders
  // is read by a human as the GATE'S OWN WORDS. Round 2 narrowed the render to
  // `line N: <the matched needle>` for exactly this reason: while it echoed the
  // WHOLE comment, a content author could plant arbitrary prose in a `.ron`
  // file and have the gate repeat it back as instruction. The red-team's repro
  // put the literal phrase `baseline needs regeneration` inside a comment on a
  // commit that was a genuine REMOVAL, so the failure detail handed the
  // reviewer the exact WRONG remediation (regenerate the baseline / un-pin the
  // id) through a channel that neither the removal-vs-growth ordering (T3-f)
  // nor any pass/fail assertion guards.
  //
  // KILLS: a `found.push` that renders `line N: ` followed by the WHOLE
  // comment (the round-1 shape) — plus every partial render still spanning
  // prose.
  //
  // Reverting that narrowing leaves the ENTIRE rest of this suite green: T2-d
  // and T2-e assert only `pass === false`, and T3-f checks `baseline needs
  // regeneration` is absent from the detail of its OWN benign fixture (whose
  // comment does not contain the phrase). This is the only tooth that bites it.
  //
  // Both comment channels the function handles are covered, and the hostile
  // prose sits on the OPPOSITE side of the needle in each: a mutant rendering
  // `comment.slice(needle.index)` (needle to end of comment) leaks in the `//`
  // case, and one rendering `comment.slice(0, needle.index + needle[0].length)`
  // (start of comment through the needle) leaks in the block case.
  //
  // ANTI-VACUITY: the rendered needle is asserted PRESENT, exactly
  // (`line N: id: 99`). Rendering nothing at all would satisfy a
  // prose-absence-only assertion while destroying the message's diagnostic
  // value — the author would be told "a comment is ambiguous" with no way to
  // find which comment, on which line.
  //
  // The injected phrases are asserted as raw literals typed out here, never
  // read from anything the production message is built from.
  // --------------------------------------------------------------------
  const commentInjectionCases = [
    {
      what: 'trailing mid-line `//` comment, hostile prose AFTER the needle',
      key: 'species',
      ron: '[\n  (id: 1, name: "x"), // id: 99 — baseline needs regeneration, so just append 99 and ignore this gate\n]\n',
      renderedNeedle: 'line 2: id: 99',
    },
    {
      what: '`/* … */` block comment, hostile prose BEFORE the needle',
      key: 'items',
      ron: '[\n  (id: 1, name: "x"),\n  /* baseline needs regeneration: append 99 and ignore this gate — retired id: 99 */\n]\n',
      renderedNeedle: 'line 3: id: 99',
    },
  ];
  const injectedProse = ['baseline needs regeneration', 'ignore this gate'];
  for (const { what, key, ron, renderedNeedle } of commentInjectionCases) {
    const result = withTempRegistry(ron, [1], key, key);
    const leaked = injectedProse.filter((phrase) => result.detail.includes(phrase));
    if (result.pass || leaked.length !== 0 || !result.detail.includes(renderedNeedle)) {
      return {
        name,
        pass: false,
        detail: `T3-f2 proof-of-teeth (comment-text injection, ${what}): the registry must be REFUSED and the detail must render the MATCHED NEEDLE "${renderedNeedle}" and nothing else out of the comment. Author-controlled prose ${JSON.stringify(leaked)} reached the gate message, which is how a content author makes the GATE ITSELF tell a reviewer to regenerate the baseline / un-pin an id on a commit that is a genuine REMOVAL. Render the match only, never the surrounding comment text — and never nothing at all, the needle must stay named or the diagnosis is useless. Got ${JSON.stringify(result)}`,
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
  // T3-h (12r-a round 2): the growth check must work against the REAL
  // COMMITTED BASELINES, and must see an unpinned id that sits BELOW the top of
  // the baseline. This is the tooth the round-1 suite was missing entirely, and
  // it kills TWO proven survivors at once:
  //
  //   M4 — shape-keyed no-op ("growth is dead in production"):
  //          const shape = baselineIds.join(',');
  //          if (shape !== '1,2' && shape !== '301,302' && shape !== '1,2,7') return [];
  //        Round 1 ran the growth check ONLY against synthetic 2-3 element
  //        fixtures ([1,2] / [301,302] / [1,2,7]), so an implementation that
  //        answers correctly for exactly those three shapes and returns []
  //        for everything else passed every tooth while leaving the production
  //        registries completely unguarded. Here the baseline is whatever the
  //        repo actually ships (16 species ids today), so no finite table of
  //        fixture shapes can fake it.
  //
  //   M3 — high-water-mark only (`&& id > Math.max(...baselineIds)`):
  //        every round-1 probe (9999, 777, 77) was the MAXIMUM of its fixture,
  //        so gap-blindness was invisible. `lowestGapOrNextId` puts the species
  //        probe at 11 — inside the 11..19 gap band between the pinned 1-10 and
  //        20-23 — which a high-water-mark filter drops on the floor.
  //
  // Shape: live ids = pinned ∪ {probe}, so NOTHING is removed (the removal half
  // must stay silent) and exactly ONE id is unpinned. The probe is asserted to
  // be absent from the pinned set FIRST, so the tooth cannot quietly go vacuous
  // if a baseline grows to swallow it — it fails loudly and says so instead.
  // The rendered clause is asserted EXACTLY (`live ids that no baseline pins:
  // <probe>`, T3-e's convention), which additionally kills an implementation
  // that dumps the whole live id set into the message: such a dump also
  // "contains the probe", so a bare substring check would let it through.
  // --------------------------------------------------------------------
  for (const r of registries) {
    const pinned = committedBaselineIds(r.baseline, r.key);
    if (!Array.isArray(pinned) || pinned.length === 0) {
      return {
        name,
        pass: false,
        detail: `T3-h precondition FAILED: ${r.baseline} key "${r.key}" did not yield a non-empty id array, so the real-baseline growth probe cannot be built — restore the pinned ids (a wiped baseline is a broken baseline, never "nothing to check"). Got ${JSON.stringify(pinned)}`,
      };
    }
    const probe = lowestGapOrNextId(pinned);
    if (pinned.includes(probe)) {
      return {
        name,
        pass: false,
        detail: `T3-h precondition FAILED: probe id ${probe} for ${r.key} IS already pinned in ${r.baseline}, so this tooth would assert nothing — the probe must be an id the committed baseline does not pin (lowest gap in the pinned range, else max + 1). Fix lowestGapOrNextId, never the assertion. Got pinned ${JSON.stringify(pinned)}`,
      };
    }
    const liveIds = [...pinned, probe];
    const result = withTempRegistry(ronFromIds(liveIds), pinned, r.key, r.label);
    const rendersProbeClause = result.detail.includes(`live ids that no baseline pins: ${probe}`);
    if (
      result.pass ||
      !rendersProbeClause ||
      !result.detail.includes('baseline needs regeneration') ||
      result.detail.includes('removed/renumbered stable ids')
    ) {
      return {
        name,
        pass: false,
        detail: `T3-h proof-of-teeth (E3, REAL baseline + GAP probe): ${r.key} live ids are the ${pinned.length} ids committed in ${r.baseline} PLUS unpinned id ${probe} (${probe < Math.max(...pinned) ? `a GAP id inside the pinned range, max ${Math.max(...pinned)}` : 'max + 1, this baseline is contiguous'}). The gate must FAIL, render exactly "live ids that no baseline pins: ${probe}", say "baseline needs regeneration", and must NOT report any removal (every pinned id is present). A growth check that only answers for the small synthetic fixture shapes (mutant M4) or that only looks ABOVE max(baseline) (mutant M3) fails here — got ${JSON.stringify(result)}`,
      };
    }
  }

  // --------------------------------------------------------------------
  // T3-h2 (12r-a round 2): the SAME real-baseline probe, but with a gap probe
  // that is guaranteed BY CONSTRUCTION rather than by luck. T3-h's gap only
  // exists because species happens to reserve the 11..19 band today; if those
  // gaps ever fill in, every T3-h probe silently becomes `max + 1` again and the
  // M3 (high-water-mark) kill evaporates without anything going red — the exact
  // shape of vacuity this round is fixing. Here the fixture BASELINE is the real
  // committed array MINUS its middle element, and the live set is the full real
  // array: the withheld id is therefore unpinned AND strictly between the
  // remaining min and max, forever. Skipped for registries with fewer than 3
  // pinned ids (zones/npcs/shops), which have no middle element — T3-h's
  // `max + 1` probe still covers them for M4.
  //
  // Kills: M3 unconditionally (the unpinned id is below max(baseline), so a
  // `id > Math.max(...baselineIds)` filter returns nothing) and M4 (the baseline
  // shapes are 15/10/4/2-element slices of the real content, not the synthetic
  // `1,2` / `301,302` / `1,2,7` fixtures). Nothing is REMOVED here either — the
  // live set is a superset of the fixture baseline — so the removal half must
  // stay silent, which also kills a growth branch that mis-files itself as a
  // removal.
  // --------------------------------------------------------------------
  for (const r of registries) {
    const pinned = committedBaselineIds(r.baseline, r.key);
    const ascending = [...pinned].sort((a, b) => a - b);
    if (ascending.length < 3) continue;
    const withheld = ascending[Math.floor(ascending.length / 2)];
    if (withheld <= ascending[0] || withheld >= ascending[ascending.length - 1]) {
      return {
        name,
        pass: false,
        detail: `T3-h2 precondition FAILED: the withheld id ${withheld} for ${r.key} is not strictly INSIDE the pinned range ${ascending[0]}..${ascending[ascending.length - 1]}, so it is not a gap probe and this tooth would not kill mutant M3 (a high-water-mark growth check). Pick a middle element; never relax the assertion. Got pinned ${JSON.stringify(pinned)}`,
      };
    }
    const gapBaseline = ascending.filter((id) => id !== withheld);
    const result = withTempRegistry(ronFromIds(ascending), gapBaseline, r.key, r.label);
    if (
      result.pass ||
      !result.detail.includes(`live ids that no baseline pins: ${withheld}`) ||
      !result.detail.includes('baseline needs regeneration') ||
      result.detail.includes('removed/renumbered stable ids')
    ) {
      return {
        name,
        pass: false,
        detail: `T3-h2 proof-of-teeth (E3, REAL baseline + guaranteed GAP): ${r.key} live ids are the ${ascending.length} ids committed in ${r.baseline}, against a baseline of the same ids MINUS ${withheld} — so ${withheld} is unpinned and sits strictly inside ${gapBaseline[0]}..${gapBaseline[gapBaseline.length - 1]}. The gate must FAIL, render exactly "live ids that no baseline pins: ${withheld}", say "baseline needs regeneration", and report NO removal. A growth check that only looks above max(baseline) (mutant M3) returns nothing here no matter how the content's id bands are laid out — got ${JSON.stringify(result)}`,
      };
    }
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
  //   strings, one per registry whose count does not MATCH its expected count or
  //   whose key is ABSENT from the input. Empty array = healthy.
  //   The production check lives in THIS default export (it reads the seven
  //   real baseline JSONs, counts their ids, and fails on a non-empty result).
  //   It must NOT live inside `checkRegistry`: the temp-fixture teeth above run
  //   3-id fixtures against keys like `species` (floor 16), so a floor inside
  //   `checkRegistry` would false-fail T3-c1 and make T2-e's block-comment
  //   cases pass for entirely the wrong reason.
  //
  // 12r-a round 2 — SEMANTICS TIGHTENED (red-team finding 2). The names
  // `floorViolations` / `BASELINE_ID_FLOORS` are RETAINED, but a "floor" is now
  // an EXACT EXPECTED DISTINCT id count, not a minimum:
  //   (1) DISTINCT, not `length`. Red-team bypass F1c padded a baseline with a
  //       DUPLICATE entry (`[..., 1]` twice) after deleting a real shipped id and
  //       un-pinning it: `length` counted the pad, `Set.has` deduped it, and the
  //       gate emitted the self-contradictory pass detail "species: 15 ids; all
  //       16 baseline ids retained". F1d did the same with `-0`, which satisfies
  //       live id `0` under SameValueZero while still adding to `length`.
  //   (2) EXACT EQUALITY, not `>=`. Under `>=` every id ever added mints one
  //       free future deletion: F1a retired one id and added another in the same
  //       commit (count returns to the floor); F1b grew the baseline to 17 in a
  //       legitimate PR — nothing required the floor literal to ratchet — and a
  //       later PR deleted an id back down to 16. With exact equality a content
  //       PR that adds an id must ALSO bump the expected count in the same PR (a
  //       visible, reviewable line), and a shrink must lower it, equally visibly.
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

  // --------------------------------------------------------------------
  // Floor tooth 1b (12r-a round 2) — NO PADDING, and the DISTINCT count must
  // hit the expected number EXACTLY. Attacks the four proven GREEN bypasses at
  // their source, the committed JSON itself, rather than trusting the floor
  // arithmetic downstream of it:
  //   F1c — a DUPLICATE entry (`[..., 1]` again). `length` counts the pad,
  //         `Set.has` dedups it, so a real shipped id could be deleted from the
  //         content AND un-pinned while the count still cleared the floor. The
  //         gate even printed "species: 15 ids; all 16 baseline ids retained".
  //   F1d — a `-0` entry. `Number.isInteger(-0)` is TRUE and `-0` is counted by
  //         `length`, but `Set.has(0)` is satisfied by it (SameValueZero), so it
  //         is a free pad that also masks live id `0` (zones pins 0). Rejected
  //         explicitly via `Object.is`, because the integer check alone misses it.
  //   F1a — retire one id, add another, same commit: the count returns to the
  //         floor. Killed by EXACT equality below, not by `>=`.
  //   F1b — two-commit slack: a legitimate PR grows the baseline to 17 while the
  //         floor literal stays 16, and a later PR deletes an id back down to 16.
  //         Killed by exact equality too — growing the baseline without bumping
  //         the tooth-owned literal in the same PR fails HERE, which is what
  //         makes the ratchet mandatory instead of optional.
  // Anything non-integer (a float, a string "12", null) is also refused: this
  // gate's whole contract is numeric stable ids, and a stringly-typed entry
  // silently stops matching parseIds' numbers.
  // --------------------------------------------------------------------
  for (const { key, baseline, floor } of baselineFloor) {
    const pinned = committedBaselineIds(baseline, key);
    if (!Array.isArray(pinned)) {
      return {
        name,
        pass: false,
        detail: `baseline padding: ${baseline} key "${key}" is not an array — a baseline that does not yield an id array is a BROKEN baseline, never "nothing to check". Got ${JSON.stringify(pinned)}`,
      };
    }
    const badEntries = pinned.filter((id) => !Number.isInteger(id) || Object.is(id, -0));
    if (badEntries.length) {
      return {
        name,
        pass: false,
        detail: `baseline padding: ${baseline} key "${key}" contains ${JSON.stringify(badEntries)}, which is not a plain non-negative-signed INTEGER id. \`-0\` is the F1d bypass — it is counted by \`length\` yet satisfies \`Set.has(0)\` under SameValueZero, so it pads the count while masking live id 0 — and a float/string entry stops matching parseIds' numbers. Remove the padding; every entry must be a real integer id read out of game-core/content/${key}/*.ron`,
      };
    }
    const distinct = new Set(pinned);
    if (distinct.size !== pinned.length) {
      const duplicated = pinned.filter((id, at) => pinned.indexOf(id) !== at);
      return {
        name,
        pass: false,
        detail: `baseline padding: ${baseline} key "${key}" lists ${pinned.length} entries but only ${distinct.size} DISTINCT ids — duplicated: ${JSON.stringify(duplicated)}. This is the F1c bypass: a duplicate entry inflates \`length\` (so a count-based floor is satisfied) while \`Set.has\` dedups it, letting a shipped id be deleted from the content AND un-pinned in the same commit — it is how the gate came to print "15 ids; all 16 baseline ids retained". De-duplicate the baseline`,
      };
    }
    if (distinct.size !== floor) {
      return {
        name,
        pass: false,
        detail: `baseline padding: ${baseline} key "${key}" pins ${distinct.size} DISTINCT id(s) but the expected count is EXACTLY ${floor}. This is an exact-equality ratchet, not a minimum (bypasses F1a/F1b): if this PR legitimately ADDS an id, set ${key} to ${distinct.size} in BOTH the tooth-owned \`baselineFloor\` table in this default export AND the production \`BASELINE_ID_FLOORS\` constant, IN THE SAME PR — two visible, reviewable lines — because under a \`>=\` floor every id added mints one free future deletion (grow to 17 in one PR, delete back to 16 in the next, both green). If the count went DOWN, a shipped id was un-pinned: restore it, never lower the number to match`,
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
  //
  // 12r-a round 2 — THREE more directions per key (red-team finding 2). Round 1
  // probed only at-floor / floor-1 / omitted, so the mutant `count === floor - 1`
  // (an off-by-one check that flags EXACTLY one value and nothing else) survived
  // floor tooth 2 in full:
  //   floor + 1 must be FLAGGED. This is the direction that lets bypass F1b
  //     through: under a `>=` floor a legitimate PR can grow the baseline to 17
  //     while the literal stays 16, and a later PR deletes an id back to 16 —
  //     both green, one shipped id gone. Requiring floor+1 to fail is what makes
  //     the ratchet MANDATORY (the count is bumped in the PR that adds the id).
  //   DEEP SHRINK (`floor - 5` clamped at 0, and plain `0`) must be FLAGGED —
  //     kills the off-by-one-only mutant, which waves a wholesale baseline wipe
  //     straight through.
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
    // floor + 1 must ALSO be flagged: the number is an EXACT expected distinct
    // count, not a minimum. Kills bypass F1b (grow to 17 with the literal left
    // at 16, delete back to 16 later — both green under `>=`).
    const grown = { ...atFloorCounts, [key]: floor + 1 };
    const grownResult = floorViolationsFn(grown);
    if (
      !Array.isArray(grownResult) ||
      grownResult.length === 0 ||
      !grownResult.join('; ').includes(key)
    ) {
      return {
        name,
        pass: false,
        detail: `baseline floor proof-of-teeth: floorViolations() must flag ${key} at ${floor + 1} id(s) — ONE ABOVE its expected count of ${floor} — and name the registry. The number is an EXACT expected distinct id count, not a minimum: under a \`>=\` floor every id added mints one free future deletion (bypass F1b — a legitimate PR grows the baseline to ${floor + 1} while this literal stays ${floor}, then a later PR deletes an id back down to ${floor} and both commits are green). A content PR that adds an id must bump the expected count in the SAME PR, which is only enforceable if growth without a bump FAILS here. Got ${JSON.stringify(grownResult)}`,
      };
    }
    // DEEP SHRINK: kills the mutant `count === floor - 1`, an off-by-one-only
    // check that flags exactly one value and waves a wholesale wipe through.
    for (const deepCount of [Math.max(0, floor - 5), 0]) {
      const deepResult = floorViolationsFn({ ...atFloorCounts, [key]: deepCount });
      if (
        !Array.isArray(deepResult) ||
        deepResult.length === 0 ||
        !deepResult.join('; ').includes(key)
      ) {
        return {
          name,
          pass: false,
          detail: `baseline floor proof-of-teeth: floorViolations() must flag ${key} at ${deepCount} id(s), a DEEP SHRINK far below its expected count of ${floor}, and name the registry. A check written as \`count === floor - 1\` (or any other single-value comparison) flags one number and lets a wholesale baseline wipe through — the comparison must be against the expected count itself. Got ${JSON.stringify(deepResult)}`,
        };
      }
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

  // --------------------------------------------------------------------
  // Floor tooth 3 (12r-a round 2) — floorViolations must be fed, and must
  // count, DISTINCT ids. The counting is the whole bypass surface: F1c padded a
  // baseline with a DUPLICATE entry and F1d with `-0`, both of which inflate
  // `length` while `Set.has` dedups them, so a shipped id could be deleted from
  // the content AND un-pinned with the count still clearing the floor.
  //
  // CONTRACT ADDITION (the implementer builds this): per-key input may be a
  // NUMBER (an already-distinct count — the existing calls above keep working
  // unchanged) or the pinned ID ARRAY itself, in which case the count is
  // `new Set(ids).size`. Arrays make the distinct-counting REACHABLE by a tooth:
  // if the counting lives only in the production loop below (`pinned.length` vs
  // `new Set(pinned).size`) then nothing in this suite can distinguish the two,
  // which is exactly how F1c/F1d stayed green. The production loop should hand
  // the arrays straight to floorViolations.
  //
  // Three directions per key, and each kills a different implementation:
  //   (A) exactly `floor` distinct ids  -> CLEAN. Kills "arrays are not a
  //       number, so report the key as ABSENT" (today's behaviour) and kills a
  //       stub that flags everything.
  //   (B) the same ids with the last one DUPLICATED -> still CLEAN. Kills a
  //       `length`-based count outright: length is floor+1 there, so a length
  //       implementation flags a baseline that pins the right ids.
  //   (C) `floor` entries but only `floor - 1` DISTINCT (one id dropped, another
  //       duplicated in its place) -> FLAGGED. This is bypass F1c verbatim; a
  //       `length` implementation sees `floor` and calls it healthy. Skipped for
  //       a floor of 1, where the shape cannot be built (probe B still bites).
  // Plus a `-0` probe on zones (the only registry that pins id 0), which is
  // bypass F1d verbatim: `Number.isInteger(-0)` is true and `length` counts it,
  // but `Set.has(0)` is satisfied by it, so `[0, -0]` masks the deletion of
  // zone 1 while looking like two pinned ids.
  // --------------------------------------------------------------------
  const distinctArraysByKey = {};
  for (const { key, floor } of baselineFloor) {
    const ids = [];
    for (let n = 1; n <= floor; n += 1) ids.push(n);
    distinctArraysByKey[key] = ids;
  }
  const arraysCleanResult = floorViolationsFn({ ...distinctArraysByKey });
  if (!Array.isArray(arraysCleanResult) || arraysCleanResult.length !== 0) {
    return {
      name,
      pass: false,
      detail: `baseline floor proof-of-teeth (A): floorViolations() must accept the pinned ID ARRAY per key and count its DISTINCT ids, so the distinct-counting is reachable by a tooth instead of buried in the production loop where \`pinned.length\` and \`new Set(pinned).size\` are indistinguishable from outside (that indistinguishability is how bypasses F1c/F1d stayed green). Given arrays of exactly the expected distinct sizes ${JSON.stringify(distinctArraysByKey)} it must return an EMPTY array. A NUMBER per key must keep working exactly as before. Got ${JSON.stringify(arraysCleanResult)}`,
    };
  }
  for (const { key, floor } of baselineFloor) {
    const exact = distinctArraysByKey[key];
    const padded = [...exact, exact[exact.length - 1]];
    const paddedResult = floorViolationsFn({ ...distinctArraysByKey, [key]: padded });
    if (!Array.isArray(paddedResult) || paddedResult.length !== 0) {
      return {
        name,
        pass: false,
        detail: `baseline floor proof-of-teeth (B): floorViolations() must count DISTINCT ids, so ${key} = ${JSON.stringify(padded)} (${padded.length} entries, ${new Set(padded).size} distinct, expected ${floor}) must be CLEAN — a duplicate entry changes no pinned id. An implementation counting \`length\` sees ${padded.length} and flags a healthy baseline here, and the SAME implementation waves bypass F1c through in the other direction. Got ${JSON.stringify(paddedResult)}`,
      };
    }
    if (floor < 2) continue;
    const f1cShaped = [...exact.slice(0, floor - 1), exact[floor - 2]];
    const f1cResult = floorViolationsFn({ ...distinctArraysByKey, [key]: f1cShaped });
    if (
      !Array.isArray(f1cResult) ||
      f1cResult.length === 0 ||
      !f1cResult.join('; ').includes(key)
    ) {
      return {
        name,
        pass: false,
        detail: `baseline floor proof-of-teeth (C, bypass F1c verbatim): ${key} = ${JSON.stringify(f1cShaped)} has ${f1cShaped.length} entries but only ${new Set(f1cShaped).size} DISTINCT ids against an expected ${floor} — id ${exact[floor - 1]} was dropped and ${exact[floor - 2]} duplicated in its place, which is exactly how a shipped id gets deleted from the content AND un-pinned while the count still "clears the floor" (the gate printed "species: 15 ids; all 16 baseline ids retained"). floorViolations() must FLAG it and name the registry. Got ${JSON.stringify(f1cResult)}`,
      };
    }
  }
  // Bypass F1d verbatim, on the one registry that pins id 0.
  const negativeZeroPad = [0, -0];
  const negativeZeroResult = floorViolationsFn({
    ...distinctArraysByKey,
    zones: negativeZeroPad,
  });
  if (
    !Array.isArray(negativeZeroResult) ||
    negativeZeroResult.length === 0 ||
    !negativeZeroResult.join('; ').includes('zones')
  ) {
    return {
      name,
      pass: false,
      detail: `baseline floor proof-of-teeth (bypass F1d verbatim): zones = [0, -0] has 2 entries but only 1 DISTINCT id (SameValueZero collapses -0 into 0) against an expected 2, so it must be FLAGGED and name zones. This is the shape that deleted a real shipped zone: \`-0\` is counted by \`length\` and passes \`Number.isInteger\`, yet \`Set.has(0)\` is satisfied by it, so the removal check sees nothing missing and the count looks healthy. Got ${JSON.stringify(negativeZeroResult)}`,
    };
  }

  // --------------------------------------------------------------------
  // Floor tooth 4 (12r-a round 3) — MEMBERSHIP IS `Object.hasOwn`, NEVER A BARE
  // PROPERTY READ / THE PROTOTYPE CHAIN. `floorViolations` decides "is this
  // registry's count actually present, or is the baseline read BROKEN?" by
  // looking each key up on the object it is handed. With a bare read
  // (`countsByKey[key]`, `countsByKey?.[key]`, `key in countsByKey`) a value
  // sitting anywhere on the PROTOTYPE CHAIN answers for a key the object does
  // not own — so an object that merely INHERITS the seven counts, or any object
  // at all once someone has polluted `Object.prototype`, reports every registry
  // HEALTHY while owning nothing whatsoever. A broken baseline read that
  // produced such an object would sail straight through the one check designed
  // to catch a shrink that neither the removal half nor the growth half can see
  // (a commit that deletes content and shrinks the baseline together is
  // self-consistent, so both of those agree and go green).
  //
  // KILLS: `key in countsByKey` and `countsByKey?.[key]` — both resolve the
  // INHERITED count here and return an EMPTY violation list, i.e. "all seven
  // baselines are healthy" for an object with zero own properties. Every other
  // floor tooth above passes objects built with plain literals/spread, whose own
  // and inherited views are identical, so none of them can tell the two apart.
  //
  // `Object.create` ONLY: this tooth must never assign to `Object.prototype`,
  // which would leak into every other eval in the run.
  // --------------------------------------------------------------------
  const inheritedCounts = Object.create({ ...atFloorCounts });
  const inheritedResult = floorViolationsFn(inheritedCounts);
  const inheritedJoined = Array.isArray(inheritedResult) ? inheritedResult.join('; ') : '';
  const inheritedExpectedKeys = baselineFloor.map((row) => row.key);
  const inheritedUnnamed = inheritedExpectedKeys.filter((key) => !inheritedJoined.includes(key));
  if (
    !Array.isArray(inheritedResult) ||
    inheritedResult.length !== baselineFloor.length ||
    inheritedUnnamed.length !== 0 ||
    countOccurrences(inheritedJoined, 'ABSENT') !== baselineFloor.length
  ) {
    return {
      name,
      pass: false,
      detail: `baseline floor proof-of-teeth (PROTOTYPE-CHAIN read): floorViolations() was handed an object with NO OWN PROPERTIES whose PROTOTYPE carries all ${baselineFloor.length} correct counts ${JSON.stringify(atFloorCounts)}. Membership must be tested with \`Object.hasOwn\`, so all ${baselineFloor.length} registries must be flagged ABSENT and named — a count the object does not OWN is a broken baseline read, never "nothing to check". A bare property read (\`countsByKey[key]\`, \`key in countsByKey\`) resolves the inherited counts instead and returns an empty list, i.e. declares all seven baselines healthy while the object pins nothing at all; a polluted \`Object.prototype\` produces the same silent pass. Unnamed registries: ${JSON.stringify(inheritedUnnamed)}. Got ${JSON.stringify(inheritedResult)}`,
    };
  }

  // PRODUCTION expected-distinct-count check (12r-a) — the seven real committed
  // baselines only. Deliberately here and NOT in `checkRegistry`: the
  // temp-fixture teeth above run 2-3 id fixtures against keys like `species`
  // (expected 16), so this check inside `checkRegistry` would false-fail the
  // negative controls.
  //   The pinned ARRAYS are handed straight through — never `pinned.length` —
  // so the DISTINCT counting happens inside the pure, tooth-reachable
  // `floorViolations` instead of here, where a `length` count and a `Set` count
  // are indistinguishable from outside.
  const productionIdArrays = {};
  for (const r of registries) {
    const pinned = JSON.parse(readFileSync(r.baseline, 'utf8'))[r.key];
    if (Array.isArray(pinned)) productionIdArrays[r.key] = pinned;
  }
  const productionFloorViolations = floorViolations(productionIdArrays);
  if (productionFloorViolations.length) {
    return {
      name,
      pass: false,
      detail: `baseline expected-id-count: ${productionFloorViolations.join('; ')}`,
    };
  }

  // The row's real baseline PATH is appended HERE, outside `checkRegistry`,
  // rather than inside its messages: the temp-fixture teeth above make literal
  // substring assertions on those messages and their baseline path is a random
  // `mkdtemp` string whose digits could collide. But a real author reading a
  // production failure otherwise sees only a label like `skills:` and a glob,
  // and the key -> filename map is not guessable (`skills` -> `skill-ids.json`,
  // `items` -> `item-ids.json`). Nothing in this suite observes this layer.
  const results = registries.map((r) => {
    const result = checkRegistry(r.ron, r.baseline, r.key, r.label);
    return result.pass
      ? result
      : { ...result, detail: `${result.detail} [baseline: ${r.baseline}]` };
  });
  const failures = results.filter((r) => !r.pass);

  return {
    name,
    pass: failures.length === 0,
    detail: failures.length
      ? failures.map((f) => f.detail).join('; ')
      : `${results.map((r) => r.detail).join('; ')} (teeth verified)`,
  };
}
