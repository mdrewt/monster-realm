// parse.test.mjs — m20e T1 gate for the relay's host-envelope parser (TDD RED).
//
// Encodes OBS-42/43/49 + ADR-0180 D6/D15 against the NOT-YET-WRITTEN './parse.mjs'.
// This suite is intentionally RED today because that module does not exist. The
// tester does not implement it; the specialist does.
//
// THE ONE RULE THIS FILE OBEYS (anti-pattern 4, "relay tests re-implementing the
// parser"): every expectation is a LITERAL value read out of
// fixtures/breadcrumb-golden.json. Nowhere does an expected value come from
// calling parse.mjs. The fixture's `expected_module_json` is byte-compared to the
// parser's extracted payload text; the fixture's `expect_*` fields are compared
// field by field.
//
// THE FIXTURE HAS TWO LAYERS (AM4) AND THIS FILE ONLY EVER CONSUMES LAYER 2.
// `host_line` is the raw host envelope; `expected_module_json` is what
// server-module's `build_log_line` produced INSIDE it. The Rust mirror in
// observability_tests.rs owns layer 1 and never reads `host_line`; this file
// never calls build_log_line. A drift in either direction reddens exactly one
// side, which is the point of a cross-language golden.
//
// FIXTURE INTEGRITY IS CHECKED WITH AN INDEPENDENT ORACLE. `JSON.parse` (the
// platform, not the implementation under test) re-derives the message string
// from `host_line` and it must equal `expected_module_json`. That assertion
// cannot make a wrong parser look right — it can only catch a hand-escaping
// mistake in the fixture, and it says FIXTURE so the failure is never mistaken
// for an implementation bug.
//
// Discipline: no `new RegExp(`, no regex literals, String methods only; every
// fixture is the committed JSON or an inline template string; no clock, no I/O
// beyond reading the committed fixture relative to import.meta.dirname.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  correlationKey,
  hasDuplicateTopLevelKey,
  parseBreadcrumb,
  parseHostLine,
} from './parse.mjs';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
const FIXTURE_PATH = path.join(import.meta.dirname, 'fixtures', 'breadcrumb-golden.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const CASES = FIXTURE.cases;
const BY_ID = new Map(CASES.map((c) => [c.id, c]));

/** Ids this suite has actually exercised — the anti-vacuity ledger (AM13). */
const CONSUMED = new Set();

function useCase(id) {
  const c = BY_ID.get(id);
  assert.ok(c !== undefined, `FIXTURE: no case with id '${id}'`);
  CONSUMED.add(id);
  return c;
}

// AM13: required CATEGORIES, each asserted present BY ID. A bare case count is
// satisfiable by 19 copies of the easy case; naming the ids is not.
const REQUIRED_CATEGORIES = {
  escaping: ['escaping-quote-backslash', 'escaping-control-chars', 'escaping-nested-evt-in-string'],
  'duplicate-key-forgery': [
    'forged-duplicate-evt',
    'nested-evt-object',
    'escaping-nested-evt-in-string',
  ],
  'i64-content-version-bounds': ['content-version-i64-max', 'content-version-i64-min'],
  'non-json-and-malformed': ['non-json-line', 'json-array-line', 'missing-message', 'missing-ts'],
  'mixed-length-ts': ['ts-short', 'ts-precision'],
  'cause-keyed': ['cause-enter', 'cause-exit'],
  'sched-keyed': ['sched-enter', 'sched-exit'],
};

// ---------------------------------------------------------------------------
// 0. Fixture shape + category completeness
// ---------------------------------------------------------------------------

test('FIXTURE: schema 1, unique ids, and every AM13 category is present BY ID', () => {
  assert.equal(FIXTURE.schema, 1, 'fixture schema must be 1');
  assert.ok(Array.isArray(CASES), 'fixture.cases must be an array');
  assert.equal(BY_ID.size, CASES.length, 'fixture case ids must be unique');
  for (const [category, ids] of Object.entries(REQUIRED_CATEGORIES)) {
    for (const id of ids) {
      assert.ok(
        BY_ID.has(id),
        `FIXTURE: category '${category}' requires a case with id '${id}', which is absent — ` +
          'the golden fixture may not be thinned below its declared coverage',
      );
    }
  }
});

test('FIXTURE INTEGRITY: host_line re-derives expected_module_json under the platform JSON parser', () => {
  // Independent oracle. Not a test of parse.mjs — a test of THIS FILE'S fixture.
  let checked = 0;
  for (const c of CASES) {
    if (c.expected_module_json === null) continue;
    const outer = JSON.parse(c.host_line);
    assert.equal(
      outer.message,
      c.expected_module_json,
      `FIXTURE '${c.id}': host_line's message does not re-derive expected_module_json — the ` +
        'fixture is self-inconsistent (report to the tester; do NOT adjust parse.mjs to match)',
    );
    checked++;
  }
  assert.ok(
    checked >= 12,
    `FIXTURE INTEGRITY checked only ${checked} module cases — expected >= 12`,
  );
});

// ---------------------------------------------------------------------------
// 1. parseHostLine over every golden case
// ---------------------------------------------------------------------------

test('parseHostLine: every golden case yields exactly its pinned literal fields', () => {
  for (const c of CASES) {
    const r = parseHostLine(useCase(c.id).host_line);
    assert.equal(typeof r, 'object', `${c.id}: result must be an object`);
    assert.equal(r.ok, c.expect_ok, `${c.id}: ok`);

    if (!c.expect_ok) {
      assert.equal(r.reason, c.expect_reason, `${c.id}: reason code`);
      continue;
    }

    assert.equal(r.level, c.expect_level, `${c.id}: level`);
    assert.equal(r.functionName, c.expect_function, `${c.id}: functionName`);
    // OBS-43: `ts` is an unmodified DIGIT STRING, never a JS Number.
    assert.equal(typeof r.ts, 'string', `${c.id}: ts must be a string, never a Number`);
    assert.equal(r.ts, c.expect_ts, `${c.id}: ts digits`);
    assert.equal(r.evt, c.expect_evt, `${c.id}: evt`);

    const expectedPayloadText = c.expected_module_json ?? c.expect_payload_text;
    assert.equal(r.payloadText, expectedPayloadText, `${c.id}: payloadText (byte-for-byte)`);

    if (c.expected_module_json === null) {
      assert.equal(r.payload, null, `${c.id}: a non-object message must yield payload === null`);
    } else {
      assert.equal(typeof r.payload, 'object', `${c.id}: payload must be the parsed object`);
      assert.notEqual(r.payload, null, `${c.id}: payload must not be null`);
    }
  }
});

test('parseHostLine: a prose message parses OK with evt null — it is not an error (config.alloy:58)', () => {
  const c = useCase('prose-message');
  const r = parseHostLine(c.host_line);
  assert.equal(r.ok, true, 'a line whose message is prose is a VALID host line');
  assert.equal(r.evt, null, 'evt is empty, which is a bounded value — not a rejection');
  assert.equal(r.payload, null);
  assert.equal(r.payloadText, 'panicked at src/lib.rs:42: index out of bounds');
});

test('parseHostLine: never throws, never returns partial — the four reject codes are distinct', () => {
  const codes = ['non-json-line', 'json-array-line', 'missing-message', 'missing-ts'].map((id) => {
    const r = parseHostLine(useCase(id).host_line);
    assert.equal(r.ok, false, `${id} must be rejected`);
    assert.equal(typeof r.reason, 'string', `${id} must carry a reason code`);
    assert.equal(r.payloadText, undefined, `${id}: a rejection must not carry a partial payload`);
    return r.reason;
  });
  assert.equal(
    new Set(codes).size,
    4,
    `the four rejection codes must be distinct, got ${codes.join(', ')}`,
  );
  assert.deepEqual(codes, ['not-json', 'not-object', 'message-not-string', 'ts-missing']);
});

// ---------------------------------------------------------------------------
// 2. ts precision + ordering (OBS-43, AM6)
// ---------------------------------------------------------------------------

test('parseHostLine: a 16-digit ts round-trips byte-identically', () => {
  const r = parseHostLine(useCase('heartbeat-plain').host_line);
  assert.equal(r.ts, '1782197246180474');
});

test('parseHostLine: BITES the Number path — a ts above 2^53 keeps every digit', () => {
  const c = useCase('ts-precision');
  const r = parseHostLine(c.host_line);
  assert.equal(
    r.ts,
    '9007199254740993',
    'ts must be lifted from the raw text, not from JSON.parse',
  );
  // Independent oracle proving this assertion has teeth: the obvious
  // implementation (JSON.parse then String(obj.ts)) silently loses the last
  // digit, so the literal above is unreachable for it.
  const viaNumber = String(JSON.parse(c.host_line).ts);
  assert.notEqual(
    viaNumber,
    '9007199254740993',
    'FIXTURE: ts-precision must be a value the Number path corrupts, or this tooth is toothless',
  );
});

test('parseHostLine: a short ts is carried verbatim, not zero-padded or normalised (AM6)', () => {
  const r = parseHostLine(useCase('ts-short').host_line);
  assert.equal(r.ts, '999');
  // Lexicographic vs numeric disagreement is the whole point of the case.
  assert.ok('999' > '1782197246180474', 'FIXTURE: ts-short must sort WRONG lexicographically');
  assert.ok(BigInt('999') < BigInt('1782197246180474'), 'and RIGHT as a BigInt');
});

// ---------------------------------------------------------------------------
// 3. payloadText is lifted, never re-serialised (i64 bounds)
// ---------------------------------------------------------------------------

test('parseHostLine: payloadText is the raw message, not JSON.stringify(payload) — i64 bounds', () => {
  for (const id of ['content-version-i64-max', 'content-version-i64-min']) {
    const c = useCase(id);
    const r = parseHostLine(c.host_line);
    assert.equal(r.payloadText, c.expected_module_json, `${id}: payloadText must be byte-exact`);
    // BITES a parser that returns JSON.stringify(JSON.parse(message)): both i64
    // bounds are outside the double's exact range, so the re-serialised form
    // differs in its last digit.
    assert.notEqual(
      JSON.stringify(r.payload),
      c.expected_module_json,
      `FIXTURE ${id}: the value must be one a JSON round-trip corrupts, or this tooth is toothless`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Escaping (json_escape survives both layers)
// ---------------------------------------------------------------------------

test('parseHostLine: quote + backslash survive both escaping layers intact', () => {
  const c = useCase('escaping-quote-backslash');
  const r = parseHostLine(c.host_line);
  assert.equal(r.payloadText, c.expected_module_json);
  assert.equal(r.payload.cause, 'a"b\\c', 'the decoded cause is the ORIGINAL 5 characters');
});

test('parseHostLine: control characters survive as their two-character escapes', () => {
  const c = useCase('escaping-control-chars');
  const r = parseHostLine(c.host_line);
  assert.equal(r.payloadText, c.expected_module_json);
  assert.equal(r.payload.cause, '\t\n');
});

// ---------------------------------------------------------------------------
// 5. AM8 — two-stage duplicate-key detection, with BOTH counter-teeth
//
// Stage 1 is the outer JSON.parse of the raw line. Stage 2 is a raw character
// walk of the STILL-UNPARSED message string. Parsing the message with JSON.parse
// is exactly what must not happen: JS object construction is last-key-wins, so a
// smuggled second "evt" silently forges the event type (the AM6 threat that
// server-module only debug_asserts against — the assert is compiled out of the
// release wasm, so the relay is the only remaining defence).
// ---------------------------------------------------------------------------

test('hasDuplicateTopLevelKey: FIRES on a genuine top-level duplicate (under-broad killer)', () => {
  assert.equal(hasDuplicateTopLevelKey('{"evt":"a","evt":"b"}', 'evt'), true);
  assert.equal(hasDuplicateTopLevelKey('{"evt":"a","content_version":7,"evt":"b"}', 'evt'), true);
  assert.equal(hasDuplicateTopLevelKey('{"cause":"a","cause":"b"}', 'cause'), true);
});

test('hasDuplicateTopLevelKey: does NOT fire on nested or in-string lookalikes (over-broad killer)', () => {
  // A nested object legitimately carries its own `evt`.
  assert.equal(hasDuplicateTopLevelKey('{"evt":"a","inner":{"evt":"b"}}', 'evt'), false);
  // Inside an array element.
  assert.equal(hasDuplicateTopLevelKey('{"evt":"a","list":[{"evt":"b"}]}', 'evt'), false);
  // Inside a STRING VALUE — kills `text.split(\'"evt":\').length > 2`.
  assert.equal(hasDuplicateTopLevelKey('{"evt":"a","cause":"\\"evt\\":1"}', 'evt'), false);
  // A longer key that merely starts with the needle.
  assert.equal(hasDuplicateTopLevelKey('{"evtx":"a","evt":"b"}', 'evt'), false);
  // Single occurrence, and no occurrence.
  assert.equal(hasDuplicateTopLevelKey('{"evt":"a"}', 'evt'), false);
  assert.equal(hasDuplicateTopLevelKey('{"a":1}', 'evt'), false);
  // Non-object text is not a duplicate; the walker returns false, never throws.
  assert.equal(hasDuplicateTopLevelKey('not json at all', 'evt'), false);
});

test('parseHostLine: a forged duplicate-evt payload is REJECTED, not last-key-wins', () => {
  const c = useCase('forged-duplicate-evt');
  const r = parseHostLine(c.host_line);
  assert.equal(r.ok, false, 'the forged line must be rejected outright');
  assert.equal(r.reason, 'duplicate-evt');
  // Independent oracle: JSON.parse would happily hand back the SECOND value,
  // which is the forgery this rejection exists to stop.
  const forgedPayload = JSON.parse(JSON.parse(c.host_line).message);
  assert.equal(forgedPayload.evt, 'reject', 'FIXTURE: the forgery must actually flip evt');
});

test('parseHostLine: the two over-broad counter-cases are ACCEPTED, not swept up by the detector', () => {
  for (const id of ['nested-evt-object', 'escaping-nested-evt-in-string']) {
    const c = useCase(id);
    const r = parseHostLine(c.host_line);
    assert.equal(r.ok, true, `${id}: a nested/in-string evt is legitimate and must parse`);
    assert.equal(r.evt, 'span', `${id}: the TOP-LEVEL evt is the one that counts`);
    assert.equal(r.payloadText, c.expected_module_json);
  }
});

// ---------------------------------------------------------------------------
// 6. parseBreadcrumb + correlationKey
// ---------------------------------------------------------------------------

test('parseBreadcrumb: a cause-keyed enter yields the pinned crumb shape', () => {
  const c = useCase('cause-enter');
  const r = parseBreadcrumb(parseHostLine(c.host_line));
  assert.equal(r.ok, true);
  assert.deepEqual(r.crumb, {
    reducer: 'sync_content',
    ts: '1782197246181000',
    phase: 'enter',
    cause: 'zone:42',
    sched: null,
  });
  assert.equal(correlationKey(r.crumb), 'cause:zone:42');
});

test('parseBreadcrumb: a sched-keyed exit yields the pinned crumb shape', () => {
  const c = useCase('sched-exit');
  const r = parseBreadcrumb(parseHostLine(c.host_line));
  assert.equal(r.ok, true);
  assert.deepEqual(r.crumb, {
    reducer: 'init',
    ts: '1782197246184200',
    phase: 'exit',
    cause: null,
    sched: { target_reducer: 'sync_content', scheduled_at: 1782197250000 },
  });
  assert.equal(correlationKey(r.crumb), 'sched:sync_content@1782197250000');
});

test('parseBreadcrumb: the reducer is the HOST `function` field, not a module-supplied one', () => {
  // config.alloy:34-37 — `function` is the HOST's cross-file attribution: it
  // names the invoking reducer even when the emission happens in a helper in
  // another file (OBS-10), and it is always present. A module-rendered
  // "reducer" field inside the payload is a caller-authored convenience and is
  // NOT authoritative. This record makes the two disagree, which is the only
  // shape that can tell the two readings apart.
  const disagreeing = {
    ok: true,
    level: 'Info',
    ts: '1782197246196000',
    functionName: 'init',
    payloadText: '{"evt":"span","reducer":"sync_content","cause":"zone:42","phase":"enter"}',
    payload: { evt: 'span', reducer: 'sync_content', cause: 'zone:42', phase: 'enter' },
    evt: 'span',
  };
  const r = parseBreadcrumb(disagreeing);
  assert.equal(r.ok, true);
  assert.equal(
    r.crumb.reducer,
    'init',
    'the crumb reducer must be the host `function`, not the payload-supplied `reducer`',
  );
  assert.notEqual(r.crumb.reducer, 'sync_content');

  // ...and the same rule holds on a real golden line, where the payload also
  // carries a `sched.target_reducer` that must not be mistaken for the reducer.
  const c = useCase('sched-enter');
  const real = parseBreadcrumb(parseHostLine(c.host_line));
  assert.equal(real.crumb.reducer, 'init');
  assert.equal(real.crumb.sched.target_reducer, 'sync_content');
});

test('parseBreadcrumb: rejects, with distinct reasons, everything that is not a pairable phase', () => {
  const noPayload = parseBreadcrumb(parseHostLine(useCase('prose-message').host_line));
  assert.equal(noPayload.ok, false);
  assert.equal(noPayload.reason, 'no-payload');

  const noPhase = parseBreadcrumb(parseHostLine(useCase('heartbeat-plain').host_line));
  assert.equal(noPhase.ok, false);
  assert.equal(noPhase.reason, 'no-phase');

  // `phase:"event"` is a real D15 value that is deliberately NOT pairable.
  const eventRecord = {
    ok: true,
    level: 'Info',
    ts: '1782197246195000',
    functionName: 'talk',
    payloadText: '{"evt":"span","cause":"npc:9","phase":"event"}',
    payload: { evt: 'span', cause: 'npc:9', phase: 'event' },
    evt: 'span',
  };
  const eventPhase = parseBreadcrumb(eventRecord);
  assert.equal(eventPhase.ok, false);
  assert.equal(eventPhase.reason, 'phase-not-pairable');

  assert.equal(
    new Set([noPayload.reason, noPhase.reason, eventPhase.reason]).size,
    3,
    'the three non-breadcrumb reasons must be distinguishable',
  );
});

test('correlationKey: cause wins over sched, and a keyless crumb is null — never guessed', () => {
  const both = {
    reducer: 'sync_content',
    ts: '1782197246181000',
    phase: 'enter',
    cause: 'zone:42',
    sched: { target_reducer: 'other', scheduled_at: 7 },
  };
  assert.equal(correlationKey(both), 'cause:zone:42', 'cause takes precedence (ADR-0180 D15)');

  const keyless = {
    reducer: 'sync_content',
    ts: '1782197246181000',
    phase: 'enter',
    cause: null,
    sched: null,
  };
  assert.equal(
    correlationKey(keyless),
    null,
    'a keyless crumb must NOT be given a synthesised key',
  );

  const emptyCause = { ...keyless, cause: '' };
  assert.equal(correlationKey(emptyCause), null, 'an empty cause is not a key');
});

// ---------------------------------------------------------------------------
// 7. Non-vacuity — every committed case was actually exercised
// ---------------------------------------------------------------------------

test('NON-VACUITY: every case id in the committed fixture was consumed by this suite', () => {
  const all = CASES.map((c) => c.id).sort();
  const used = [...CONSUMED].sort();
  assert.deepEqual(
    used,
    all,
    'a fixture case nothing reads is decoration; add an assertion or delete the case',
  );
  assert.ok(all.length >= 19, `expected >= 19 golden cases, found ${all.length}`);
});
