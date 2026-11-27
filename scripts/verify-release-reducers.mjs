// verify-release-reducers.mjs — prove a published module exposes no dev-only reducers.
//
// Proves the PUBLISHED playtest module carries NONE of the cfg-gated dev-only
// reducers. It introspects the live module via `spacetime describe --json <db>`
// (NOT a source grep — a wrong `--features`/`--bin-path` in the publish path is
// exactly the failure this guards) and fails loud (non-zero exit) if any
// forbidden reducer appears OR if the introspection itself failed / returned no
// reducers (a published module always has join_game/sync_content, so an empty
// parse means the check did not actually run and must never read as green).
//
// Functional-core / imperative-shell: the pure checkers below are exported and
// unit-gated by evals/playtest-verify.eval.mjs; the live CLI I/O runs only in
// the main-guarded driver at the bottom.
//
// NO `new RegExp(...)` anywhere (Semgrep detect-non-literal-regexp — 3x bites):
// literal patterns + String methods only.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The forbidden reducer set: every dev reducer name. Two functions carry both
// `#[cfg(feature = "dev_reducers")]` and `#[spacetimedb::reducer]`: `grant_bait` (taming.rs) and
// `dev_expire_tactical_window` (dev_clock.rs). `dev_place_in_load_zone` (load_dev.rs) is gated on
// `load_test_zones`, a feature that implies `dev_reducers`. No source defines `start_wild_battle`;
// a module exporting it is an old dev build and is refused. `grant_item` (inventory.rs) is a
// `pub(crate)` helper, NOT a reducer — it can never surface in `describe`, so including it would
// guard a non-existent surface. A new dev reducer joins this list in the change that adds it.
export const FORBIDDEN_REDUCERS = [
  'start_wild_battle',
  'grant_bait',
  'dev_expire_tactical_window',
  'dev_place_in_load_zone',
];

// parseReducerNames(describeOutput) -> string[]
//
// Parses `spacetime describe --json <db>` stdout and returns the reducer names.
// THROWS on empty/whitespace input, JSON.parse failure, or a zero-length reducer
// list (§K B-1/H-2: zero reducers means the introspection failed or the JSON
// path is wrong — a published module always has join_game/sync_content).
//
// TWO WIRE SHAPES. The shape is chosen by the CLI, NOT the host:
// `crates/cli/src/api.rs::module_def` requests schema `version=9` at CLI <= 2.7.1
// and `version=10` at CLI >= 2.8.0 (falling back to v9 and UPGRADING the result to
// V10 before printing). So a 2.8.x CLI emits V10 even against an old host.
// Branch on the PAYLOAD SHAPE, never on a probed CLI/host version.
//
//   V9  (CLI <= 2.7.1): { "reducers": [ { "name": "join_game", ... } ], ... }
//   V10 (CLI >= 2.8.0): { "sections": [ … , { "Reducers": [ { "source_name": "join_game", … } ] } ] }
//
// V10 renamed the field `name` -> `source_name` and moved reducers into an
// externally-tagged `sections` array. Both verified against a live 2.8.1 instance.
export function parseReducerNames(describeOutput) {
  if (!describeOutput?.trim()) {
    throw new Error('parseReducerNames: empty output — describe may have failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(describeOutput);
  } catch {
    throw new Error('parseReducerNames: output is not valid JSON — describe may have failed');
  }
  // Candidate paths, in order: V9 flat `reducers`; V9 nested `schema.reducers`
  // (path robustness, §K F8); V10 `sections[].Reducers`.
  let reducers = null;
  if (Array.isArray(parsed.reducers)) {
    reducers = parsed.reducers;
  } else if (parsed.schema && Array.isArray(parsed.schema.reducers)) {
    reducers = parsed.schema.reducers;
  } else if (Array.isArray(parsed.sections)) {
    const section = parsed.sections.find(
      (s) => s !== null && typeof s === 'object' && Array.isArray(s.Reducers),
    );
    if (section) reducers = section.Reducers;
  }
  if (!reducers || reducers.length === 0) {
    throw new Error(
      'parseReducerNames: zero reducers — introspection may have failed or the JSON path is wrong',
    );
  }
  // V9 spells it `name`; V10 spells it `source_name`. Accept either, per entry.
  const names = reducers.map((r) => r?.name ?? r?.source_name).filter(Boolean);
  if (names.length === 0) {
    // Reducer entries exist but none has a usable name under EITHER spelling —
    // the field may have been renamed again by a spacetime version bump. Fail
    // loud rather than return an empty list (which findForbiddenReducers would
    // read as "clean").
    throw new Error(
      'parseReducerNames: reducer entries present but all lack a name/source_name field — the describe --json schema may have changed',
    );
  }
  return names;
}

// findForbiddenReducers(reducerNames, forbidden) -> string[]
//
// Exact-name membership (NOT substring): a name like `grant_item_helper_log`
// containing a forbidden token as a substring must NOT flag (§K F1).
export function findForbiddenReducers(reducerNames, forbidden) {
  return reducerNames.filter((n) => forbidden.includes(n));
}

// findDefinitionViolations(extractSchemaOutput) -> string[]
//
// Parses what `spacetimedb-standalone extract-schema <wasm>` prints, one JSON object
// `{"V10":{"sections":[{"<Kind>": <payload>}, …]}}`, and returns one line for each HTTP handler,
// HTTP route and row filter it declares, for each procedure that is not one of
// ALLOWED_PROCEDURES, for each schedule that is not a pair of ALLOWED_SCHEDULES, at any
// submodule depth, and for each section kind this check does not know. The host serves a
// module's HTTP handlers without authentication and without the connect reducer, so the module
// declares none, and no row filter either. A procedure can send HTTP requests and a schedule
// runs code with no caller, so each is one this list names or the definition is refused.
// `just module-definition` applies it to the default build and `just release-module` to each
// artefact it makes.
//
// THROWS on output it cannot use: empty, not JSON, not `{"V10": …}`, a section that is not an
// object of one kind, a checked section whose payload is not an array, a submodule without a
// namespace or sections, or a definition with no reducer (a module always has one, so none
// means the extraction did not work).

// The procedures the module declares, all in server-module/src/account_checks.rs: a world's
// own checks of a player's account against the account service, and of the account its host
// plays under.
export const ALLOWED_PROCEDURES = [
  'check_account',
  'check_account_for',
  'recheck_account',
  'host_account_check',
];

// Every scheduled table of the module and the function it runs. A new schedule joins this list
// in the change that adds it.
export const ALLOWED_SCHEDULES = {
  guest_claim_reaper_schedule: 'guest_claim_reaper',
  account_deletion_reaper_schedule: 'account_deletion_reaper',
  trade_session_reaper_schedule: 'trade_session_reaper',
  playtest_reaper_schedule: 'playtest_reaper',
  export_bundle_reaper_schedule: 'export_bundle_reaper',
  battle_summary_reaper_schedule: 'battle_summary_reaper',
  tactical_deadline_sched: 'tactical_deadline_fire',
  tactical_advance_sched: 'tactical_advance',
  battle_gc_sched: 'battle_gc',
  movement_tick_schedule: 'movement_tick',
  mr_heartbeat_schedule: 'mr_heartbeat',
  pvp_deadline_schedule: 'pvp_deadline_reaper',
  battle_challenge_reaper_schedule: 'battle_challenge_reaper',
  trade_offer_reaper_schedule: 'trade_offer_reaper',
  recheck_schedule: 'recheck_account',
  host_check_schedule: 'host_account_check',
};

const KNOWN_SECTION_KINDS = [
  'Typespace',
  'Types',
  'Tables',
  'Reducers',
  'Procedures',
  'Views',
  'Schedules',
  'LifeCycleReducers',
  'RowLevelSecurity',
  'CaseConversionPolicy',
  'ExplicitNames',
  'HttpHandlers',
  'HttpRoutes',
  'ViewPrimaryKeys',
  'Submodules',
  'Environment',
  'Outboxes',
  'TableCachePolicies',
];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function arrayPayload(kind, payload) {
  if (!Array.isArray(payload)) {
    throw new Error(`findDefinitionViolations: the ${kind} section is not an array`);
  }
  return payload;
}

function sectionViolations(sections, prefix) {
  if (!Array.isArray(sections)) {
    throw new Error(`findDefinitionViolations: ${prefix}the definition has no sections array`);
  }
  const found = [];
  for (const section of sections) {
    const kinds = isPlainObject(section) ? Object.keys(section) : [];
    if (kinds.length !== 1) {
      throw new Error(
        `findDefinitionViolations: ${prefix}a section is not an object of exactly one kind`,
      );
    }
    const [kind] = kinds;
    const payload = section[kind];
    if (kind === 'HttpHandlers') {
      for (const h of arrayPayload(kind, payload)) {
        found.push(`${prefix}HTTP handler \`${h?.source_name}\``);
      }
    } else if (kind === 'HttpRoutes') {
      for (const r of arrayPayload(kind, payload)) {
        found.push(`${prefix}HTTP route \`${r?.path}\` to handler \`${r?.handler_function}\``);
      }
    } else if (kind === 'RowLevelSecurity') {
      for (const f of arrayPayload(kind, payload)) {
        found.push(`${prefix}row filter \`${f?.sql}\``);
      }
    } else if (kind === 'Procedures') {
      for (const p of arrayPayload(kind, payload)) {
        if (!ALLOWED_PROCEDURES.includes(p?.source_name)) {
          found.push(`${prefix}procedure \`${p?.source_name}\``);
        }
      }
    } else if (kind === 'Schedules') {
      for (const s of arrayPayload(kind, payload)) {
        const allowed =
          typeof s?.table_name === 'string' &&
          Object.hasOwn(ALLOWED_SCHEDULES, s.table_name) &&
          ALLOWED_SCHEDULES[s.table_name] === s?.function_name;
        if (!allowed) {
          found.push(`${prefix}schedule \`${s?.table_name}\` to \`${s?.function_name}\``);
        }
      }
    } else if (kind === 'Submodules') {
      for (const sub of arrayPayload(kind, payload)) {
        if (typeof sub?.namespace !== 'string' || !Array.isArray(sub?.module?.sections)) {
          throw new Error(
            `findDefinitionViolations: ${prefix}a submodule has no namespace or no sections`,
          );
        }
        found.push(
          ...sectionViolations(sub.module.sections, `${prefix}submodule \`${sub.namespace}\`: `),
        );
      }
    } else if (!KNOWN_SECTION_KINDS.includes(kind)) {
      found.push(`${prefix}unknown section kind \`${kind}\``);
    }
  }
  return found;
}

export function findDefinitionViolations(extractSchemaOutput) {
  if (!extractSchemaOutput?.trim()) {
    throw new Error('findDefinitionViolations: empty output — extract-schema may have failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(extractSchemaOutput);
  } catch {
    throw new Error('findDefinitionViolations: output is not valid JSON');
  }
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).join() !== 'V10' ||
    !isPlainObject(parsed.V10)
  ) {
    throw new Error('findDefinitionViolations: output is not one V10 module definition');
  }
  const { sections } = parsed.V10;
  const found = sectionViolations(sections, '');
  const hasReducer = sections.some((s) => Array.isArray(s.Reducers) && s.Reducers.length > 0);
  if (!hasReducer) {
    throw new Error('findDefinitionViolations: the definition declares no reducer');
  }
  return found;
}

// ---------------------------------------------------------------------------
// Main-guarded driver (live CLI I/O). Not run on import.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = process.env.STDB_SERVER || 'http://127.0.0.1:3000';
  const db = process.env.MR_PLAYTEST_DB || 'monster-realm-playtest';

  let out;
  try {
    // execFileSync (array args, no shell) is the safest child-process form and
    // is not flagged by the `semgrep --config auto` ruleset (confirmed locally).
    // The `WARNING: UNSTABLE` line goes to stderr; stdout carries only the JSON.
    out = execFileSync('spacetime', ['describe', '--json', '-s', server, db], {
      encoding: 'utf8',
    });
  } catch (e) {
    console.error(
      `verify-release-reducers: \`spacetime describe --json -s ${server} ${db}\` failed — is the instance running and the module published? (${e?.message ?? String(e)})`,
    );
    process.exit(1);
  }

  let names;
  try {
    names = parseReducerNames(out);
  } catch (e) {
    console.error(`verify-release-reducers: ${e?.message ?? String(e)}`);
    process.exit(1);
  }

  const offenders = findForbiddenReducers(names, FORBIDDEN_REDUCERS);
  if (offenders.length > 0) {
    console.error(
      `verify-release-reducers: FAIL — forbidden dev reducer(s) present in published module "${db}": ${offenders.join(', ')}. The publish must NOT carry --features dev_reducers or load_test_zones.`,
    );
    process.exit(1);
  }

  console.log(
    `verify-release-reducers: OK — ${names.length} reducer(s) in published module "${db}"; no dev reducers (${FORBIDDEN_REDUCERS.join('/')}) present.`,
  );
  process.exit(0);
}
