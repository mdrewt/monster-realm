// tail.test.mjs — 13r-b U1..U6 plus the AM9 attack suite, for the relay's PURE
// tail state machine (TDD RED).
//
// RED today because './tail.mjs' does not exist. The tester does not implement
// it; the specialist does, to the API pinned in this header.
//
// ===========================================================================
// THE API THIS FILE PINS — tail.mjs exports exactly these four pure functions
// ===========================================================================
//
//   decideRead(prevState, observation) -> { readFrom, readTo, reason }
//
//     prevState    `null` on first sight, else { offset, identity }
//     observation  { size, identity, startAtEnd }; `startAtEnd` is consulted
//                  ONLY on the first-sight branch and defaults to false (the
//                  direction that loses no data).
//     reason       'firstSight' | 'growth' | 'truncated' | 'rotated' | 'noChange'
//
//     INVARIANTS (asserted below in every branch):
//       - the caller's NEXT offset is always `readTo`; there is no separate
//         nextOffset field, and no branch leaves the offset ambiguous;
//       - readFrom <= readTo, always; readFrom === readTo means "read nothing";
//       - the range is HALF-OPEN, [readFrom, readTo). The adapter-side
//         inclusive/exclusive conversion (AM9b) belongs to daemon.mjs and is
//         asserted in daemon.test.mjs, never here.
//
//     PRECEDENCE, pinned because AM9's attacks turn on it:
//       firstSight > rotated (identity) > truncated (size) > growth > noChange.
//       IDENTITY BEATS SIZE. A3 (copytruncate + a fast writer) and A4 (a double
//       rotation inside one poll) both present a size that, compared alone,
//       reads as `growth` while the bytes on disk are a different file.
//
//   sameIdentity(a, b) -> boolean
//
//     Identity is an OPAQUE COMPARABLE VALUE. The shell builds it from
//     { dev, ino, headSample, birthtimeMs } (AM9); tail.mjs only ever COMPARES
//     identities and never reads a field BY NAME. Two structural tests at the
//     bottom assert that: no `node:` import anywhere, and no identity field
//     name (`headSample`, `birthtime`) in tail.mjs's code at all. A hardcoded
//     field list would pass every behavioural test here and still be the wrong
//     module, so the ban is asserted on the source text.
//
//   splitLines(chunk, carry) -> { lines, carry }
//
//     Both arguments and the returned carry are STRINGS; `carry` defaults to
//     ''. `lines` are COMPLETE lines with the trailing '\n' removed; an
//     incomplete final line is returned in `carry` and NEVER emitted. AM16 and
//     the reviewer both put this in tail.mjs and not in the daemon: it is the
//     most bug-prone logic in the slice and it must be pure and directly
//     testable.
//
//   carryAfter(decision, prevCarry) -> string
//
//     '' for firstSight / truncated / rotated; `prevCarry` for growth /
//     noChange. THIS is AM9's highest-value missing test: a held partial line
//     from the OLD file must never splice onto the NEW file's first bytes.
//
// AM9 (explicit): `prevSize` is NOT in the state tuple. The plan carried it as
// a dead field; a second size in the state is a second thing to get wrong.
//
// STATED, DELIBERATE GAPS pinned by tests below rather than left to discovery:
//   - a double rotation inside one poll interval loses the middle file whole
//     (A4): one identity comparison cannot count rotations;
//   - `truncated` restarts at 0 and therefore RE-EMITS the surviving prefix;
//     there is no dedup, by decision.
//
// Discipline: no `new RegExp(`, no dynamic regex, no clock, no timers, no
// sockets. The only I/O is reading tail.mjs's own source, for the two
// structural tests.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { carryAfter, decideRead, sameIdentity, splitLines } from './tail.mjs';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** The identity tuple the SHELL builds; tail.mjs treats it as opaque. */
function identity(ino, headSample, birthtimeMs) {
  return { dev: 2049, ino, headSample, birthtimeMs };
}

/** A real host envelope line — used only as a fixture, never as an oracle. */
function hostLine(fn, ts, message) {
  return JSON.stringify({
    level: 'Info',
    ts: Number(ts),
    target: '__spacetimedb__',
    filename: '__spacetimedb__',
    function: fn,
    message,
  });
}

const ID_A = identity(42, 'AAAAAAAAAAAA', 1000);
// Same device, SAME inode number, different first bytes: the A1 attack.
const ID_A_REUSED_INO = identity(42, 'BBBBBBBBBBBB', 2000);
const ID_B = identity(77, 'CCCCCCCCCCCC', 3000);
const ID_C = identity(91, 'DDDDDDDDDDDD', 4000);

const ALL_REASONS = ['firstSight', 'growth', 'truncated', 'rotated', 'noChange'];

/** Comment-stripped, lowercased source text — used by the structural tests. */
function codeText(source) {
  const kept = [];
  for (const raw of source.split('\n')) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    const cut = raw.indexOf('//');
    kept.push(cut === -1 ? raw : raw.slice(0, cut));
  }
  return kept.join('\n').toLowerCase();
}

const TAIL_SOURCE = readFileSync(path.join(import.meta.dirname, 'tail.mjs'), 'utf8');

// ---------------------------------------------------------------------------
// 1. U1/U2 — first sight
// ---------------------------------------------------------------------------

test('U1: first sight with startAtEnd reads NOTHING and leaves the offset at size (D2)', () => {
  const d = decideRead(null, { size: 4096, identity: ID_A, startAtEnd: true });
  assert.deepEqual(d, { readFrom: 4096, readTo: 4096, reason: 'firstSight' });
  assert.equal(d.readTo - d.readFrom, 0, 'a file present at boot contributes zero bytes');
  assert.equal(
    d.readTo,
    4096,
    'the next offset is readTo — a boot seek that left the offset at 0 would replay the whole file',
  );
});

test('U1: startAtEnd on an EMPTY file is still a zero-byte read at offset 0', () => {
  const d = decideRead(null, { size: 0, identity: ID_A, startAtEnd: true });
  assert.deepEqual(d, { readFrom: 0, readTo: 0, reason: 'firstSight' });
});

test('U2: first sight WITHOUT startAtEnd reads the whole file, [0, size)', () => {
  const d = decideRead(null, { size: 4096, identity: ID_A, startAtEnd: false });
  assert.deepEqual(d, { readFrom: 0, readTo: 4096, reason: 'firstSight' });
});

test('U2: an OMITTED startAtEnd behaves as false — the direction that loses no data', () => {
  // A file first seen AFTER boot has no history to skip, so the default must be
  // "read it all". Defaulting the other way silently drops a whole new replica
  // log the first time it appears.
  const d = decideRead(null, { size: 512, identity: ID_A });
  assert.deepEqual(d, { readFrom: 0, readTo: 512, reason: 'firstSight' });
});

// ---------------------------------------------------------------------------
// 2. U3 — append
// ---------------------------------------------------------------------------

test('U3: an append reads EXACTLY [prevOffset, size) and nothing else', () => {
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 9000, identity: ID_A });
  assert.deepEqual(d, { readFrom: 4096, readTo: 9000, reason: 'growth' });
  assert.equal(d.readTo - d.readFrom, 4904, 'exactly the appended bytes');
});

test('U3: over a run of appends the offsets are monotonic and the reads TILE [0, size)', () => {
  // Coverage AND non-duplication in one assertion: the concatenated ranges must
  // reconstruct the file exactly once. A stale-offset bug shows up as a gap; an
  // off-by-one shows up as an overlap.
  const sizes = [100, 250, 250, 900];
  let state = null;
  const ranges = [];
  const reasons = [];
  for (const size of sizes) {
    const d = decideRead(state, { size, identity: ID_A, startAtEnd: false });
    assert.ok(d.readFrom <= d.readTo, `range [${d.readFrom}, ${d.readTo}) is inverted`);
    if (d.readTo > d.readFrom) ranges.push([d.readFrom, d.readTo]);
    reasons.push(d.reason);
    if (state !== null) {
      assert.ok(d.readTo >= state.offset, 'offsets must never move backwards on an append run');
    }
    state = { offset: d.readTo, identity: ID_A };
  }
  assert.deepEqual(reasons, ['firstSight', 'growth', 'noChange', 'growth']);
  assert.deepEqual(ranges, [
    [0, 100],
    [100, 250],
    [250, 900],
  ]);
  assert.equal(state.offset, 900, 'the final offset is the final size');

  let cursor = 0;
  for (const [from, to] of ranges) {
    assert.equal(from, cursor, `range [${from}, ${to}) leaves a gap or overlaps at ${cursor}`);
    cursor = to;
  }
  assert.equal(cursor, 900, 'the tiled ranges must cover the whole file exactly once');
});

// ---------------------------------------------------------------------------
// 3. U4 — truncation
// ---------------------------------------------------------------------------

test('U4: truncation (size < prevOffset) restarts at 0 with reason `truncated`', () => {
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 120, identity: ID_A });
  assert.deepEqual(d, { readFrom: 0, readTo: 120, reason: 'truncated' });
});

test('U4: truncation to ZERO reads nothing and resets the offset to 0', () => {
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 0, identity: ID_A });
  assert.deepEqual(d, { readFrom: 0, readTo: 0, reason: 'truncated' });
  assert.equal(d.readTo, 0, 'the next offset is 0 — the next append must be read from the start');
});

test('U4 STATED GAP: `truncated` re-emits the surviving prefix; there is no dedup, by decision', () => {
  // Pinned so a duplicate span after a copytruncate is a KNOWN, recorded
  // behaviour (ADR-0191) rather than a mystery in production. If someone adds
  // dedup later, this test is the place the decision is revisited.
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 120, identity: ID_A });
  assert.equal(d.readFrom, 0, 'bytes 0..120 were already read once and WILL be read again');
});

// ---------------------------------------------------------------------------
// 4. U5 — rotation, with the noChange negative control
// ---------------------------------------------------------------------------

test('U5: rotation (identity changed, size >= prevOffset) restarts at 0 with reason `rotated`', () => {
  const grew = decideRead({ offset: 4096, identity: ID_A }, { size: 9000, identity: ID_B });
  assert.deepEqual(grew, { readFrom: 0, readTo: 9000, reason: 'rotated' });

  // size EXACTLY equal to the old offset — the shape a size-only comparison
  // classifies as `noChange`, i.e. reads nothing at all, ever again.
  const equal = decideRead({ offset: 4096, identity: ID_A }, { size: 4096, identity: ID_B });
  assert.deepEqual(equal, { readFrom: 0, readTo: 4096, reason: 'rotated' });
});

test('U5 NEGATIVE CONTROL: identical identity AND identical size is `noChange` and reads nothing', () => {
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 4096, identity: ID_A });
  assert.deepEqual(d, { readFrom: 4096, readTo: 4096, reason: 'noChange' });
  assert.equal(d.readTo - d.readFrom, 0, 'an idle poll must not re-read one byte');
  assert.equal(d.readTo, 4096, 'and must not move the offset');
});

test('U5 NEGATIVE CONTROL: a STRUCTURALLY EQUAL identity object is the same identity', () => {
  // The shell rebuilds the identity object on every poll, so reference equality
  // would classify EVERY poll as a rotation and replay the whole file forever.
  const rebuilt = identity(42, 'AAAAAAAAAAAA', 1000);
  assert.notEqual(rebuilt, ID_A, 'FIXTURE: these must be distinct object references');
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 5000, identity: rebuilt });
  assert.deepEqual(d, { readFrom: 4096, readTo: 5000, reason: 'growth' });
});

// ---------------------------------------------------------------------------
// 5. AM9 attacks A1, A3, A4
// ---------------------------------------------------------------------------

test('A1 (AM9): INODE REUSE — same ino, different head bytes, is `rotated`, never `growth`', () => {
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 9000, identity: ID_A_REUSED_INO });
  assert.equal(d.reason, 'rotated', 'a reused inode is a NEW file, not a grown one');
  assert.deepEqual(d, { readFrom: 0, readTo: 9000, reason: 'rotated' });

  // PROOF OF TEETH — the wrong implementation this kills. With an ino-only
  // identity the two tuples compare EQUAL, so the decider reads [4096, 9000)
  // and the new file's first 4096 bytes are dropped outright; worse, the read
  // starts mid-line, so the first line it does deliver is corrupt.
  const inoOnlySame = ID_A.ino === ID_A_REUSED_INO.ino && ID_A.dev === ID_A_REUSED_INO.dev;
  assert.equal(
    inoOnlySame,
    true,
    'FIXTURE: the ino/dev pair must MATCH, or this tooth is toothless',
  );
  assert.equal(
    sameIdentity(ID_A, ID_A_REUSED_INO),
    false,
    'the head bytes are what separate a reused inode from a grown file',
  );
  assert.notEqual(d.readFrom, 4096, 'an ino-only decider silently drops the first 4096 bytes here');
});

test('A3 (AM9): COPYTRUNCATE + a fast writer — size GREW but the file is new, so not `growth`', () => {
  // The file was truncated to 0 and 5000 fresh bytes were written before the
  // next poll, so `size (5000) > prevOffset (4096)`: the truncation branch
  // (size < prevOffset) never fires and a size comparison alone says `growth`.
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 5000, identity: ID_A_REUSED_INO });
  assert.notEqual(d.reason, 'growth', 'a changed head sample must override the size comparison');
  assert.ok(
    d.reason === 'rotated' || d.reason === 'truncated',
    `expected rotated/truncated, got '${d.reason}'`,
  );
  assert.deepEqual(d, { readFrom: 0, readTo: 5000, reason: 'rotated' });

  // PROOF OF TEETH: the size-only decider's answer, spelled out. It reads
  // [4096, 5000) of a file whose byte 4096 is the middle of a line written
  // after the truncation — 4096 bytes lost and one corrupt line delivered.
  assert.equal(
    5000 > 4096,
    true,
    'FIXTURE: the size must READ as growth, or this tooth is toothless',
  );
  assert.notEqual(d.readFrom, 4096);
});

test('A4 (AM9): DOUBLE ROTATION in one poll is `rotated` from 0 — the middle file is LOST', () => {
  // A -> B -> C between two polls. One identity comparison cannot count
  // rotations: the decider sees only that the identity changed, so it restarts
  // at 0 on file C and file B is never read at all. This is the CHOSEN
  // behaviour and a STATED GAP (ADR-0191), pinned here so it stays a decision.
  const d = decideRead({ offset: 4096, identity: ID_A }, { size: 100, identity: ID_C });
  assert.deepEqual(d, { readFrom: 0, readTo: 100, reason: 'rotated' });
  assert.equal(
    d.reason,
    'rotated',
    'identity precedence: size (100) is BELOW prevOffset (4096) and would read as `truncated`, ' +
      'but the file is a different file and `rotated` is the honest classification',
  );
});

// ---------------------------------------------------------------------------
// 6. sameIdentity — opaque, key-agnostic comparison
// ---------------------------------------------------------------------------

test('sameIdentity: any single differing field makes it a different file', () => {
  assert.equal(sameIdentity(ID_A, ID_A), true);
  assert.equal(sameIdentity(ID_A, identity(42, 'AAAAAAAAAAAA', 1000)), true);
  assert.equal(sameIdentity(ID_A, identity(43, 'AAAAAAAAAAAA', 1000)), false, 'ino');
  assert.equal(sameIdentity(ID_A, identity(42, 'ZAAAAAAAAAAA', 1000)), false, 'headSample');
  assert.equal(sameIdentity(ID_A, identity(42, 'AAAAAAAAAAAA', 9999)), false, 'birthtimeMs');
  assert.equal(sameIdentity(ID_A, { ...ID_A, dev: 2050 }), false, 'dev');
});

test('sameIdentity: comparison is key-AGNOSTIC — field order and extra fields, not field names', () => {
  // tail.mjs must not know what the fields MEAN. Key order is not part of the
  // contract, and a JSON.stringify comparison would make it part of the
  // contract. An extra field the shell starts supplying must be COMPARED, not
  // ignored — an ignored field is a hole in the rotation detector.
  assert.equal(sameIdentity({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameIdentity({ a: 1, b: 2 }, { a: 1, b: 3 }), false);
  assert.equal(sameIdentity({ a: 1 }, { a: 1, b: 2 }), false, 'a new field is a difference');
  assert.equal(
    sameIdentity('opaque-token', 'opaque-token'),
    true,
    'a primitive identity compares too',
  );
  assert.equal(sameIdentity('opaque-token', 'other-token'), false);
});

// ---------------------------------------------------------------------------
// 7. Cross-branch invariants
// ---------------------------------------------------------------------------

test('INVARIANT: every branch returns one of the five reasons, a sane range, and readTo as the next offset', () => {
  const cases = [
    [null, { size: 4096, identity: ID_A, startAtEnd: true }],
    [null, { size: 4096, identity: ID_A, startAtEnd: false }],
    [
      { offset: 4096, identity: ID_A },
      { size: 9000, identity: ID_A },
    ],
    [
      { offset: 4096, identity: ID_A },
      { size: 4096, identity: ID_A },
    ],
    [
      { offset: 4096, identity: ID_A },
      { size: 120, identity: ID_A },
    ],
    [
      { offset: 4096, identity: ID_A },
      { size: 9000, identity: ID_B },
    ],
    [
      { offset: 4096, identity: ID_A },
      { size: 100, identity: ID_C },
    ],
    [
      { offset: 0, identity: ID_A },
      { size: 0, identity: ID_A },
    ],
  ];
  const seen = new Set();
  for (const [prev, obs] of cases) {
    const d = decideRead(prev, obs);
    assert.ok(ALL_REASONS.includes(d.reason), `unknown reason '${d.reason}'`);
    assert.equal(typeof d.readFrom, 'number');
    assert.equal(typeof d.readTo, 'number');
    assert.ok(d.readFrom >= 0, 'readFrom is never negative');
    assert.ok(d.readFrom <= d.readTo, `range [${d.readFrom}, ${d.readTo}) is inverted`);
    assert.ok(d.readTo <= obs.size, 'a decider may never ask for bytes past the observed size');
    assert.deepEqual(
      Object.keys(d).sort(),
      ['readFrom', 'readTo', 'reason'],
      'the decision carries exactly three fields — prevSize is a dead field (AM9)',
    );
    seen.add(d.reason);
  }
  assert.deepEqual([...seen].sort(), [...ALL_REASONS].sort(), 'every branch must be exercised');
});

// ---------------------------------------------------------------------------
// 8. splitLines
// ---------------------------------------------------------------------------

test('splitLines: a chunk boundary splitting a JSON line MID-TOKEN loses nothing', () => {
  const line = hostLine(
    'zone_tick',
    '1782197246181000',
    '{"evt":"span","cause":"zone:a","phase":"enter"}',
  );
  const cutAt = 57;
  assert.ok(cutAt > 0 && cutAt < line.length, 'FIXTURE: the cut must land inside the line');
  const first = splitLines(line.slice(0, cutAt), '');
  assert.deepEqual(first.lines, [], 'no complete line has arrived yet');
  assert.equal(first.carry, line.slice(0, cutAt), 'the partial line is held verbatim');

  const second = splitLines(`${line.slice(cutAt)}\n`, first.carry);
  assert.deepEqual(second.lines, [line], 'the rejoined line is byte-identical to the original');
  assert.equal(second.carry, '');
  assert.deepEqual(JSON.parse(second.lines[0]).function, 'zone_tick', 'and is still valid JSON');
});

test('splitLines: a trailing line WITHOUT a newline is held in carry, never emitted', () => {
  const r = splitLines('alpha\nbravo\ncharlie', '');
  assert.deepEqual(r.lines, ['alpha', 'bravo'], 'charlie is incomplete and must not be emitted');
  assert.equal(r.carry, 'charlie');
});

test('splitLines: multiple complete lines in one chunk ALL emit, in order, with no newlines left', () => {
  const r = splitLines('one\ntwo\nthree\n', '');
  assert.deepEqual(r.lines, ['one', 'two', 'three']);
  assert.equal(r.carry, '', 'a chunk ending on a newline leaves nothing held');
  for (const line of r.lines) {
    assert.equal(
      line.includes('\n'),
      false,
      'the terminator is stripped, not carried into the line',
    );
  }
});

test('splitLines: an EMPTY chunk is a no-op that preserves the carry exactly', () => {
  const r = splitLines('', 'held-partial');
  assert.deepEqual(r.lines, []);
  assert.equal(r.carry, 'held-partial', 'an idle poll must not flush a partial line');

  const empty = splitLines('', '');
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.carry, '');

  // A default carry is '', not undefined — a bare splitLines(chunk) must work.
  const defaulted = splitLines('solo\n');
  assert.deepEqual(defaulted.lines, ['solo']);
  assert.equal(defaulted.carry, '');
});

test('splitLines: a BLANK line between records is a real, emitted empty line, not a dropped one', () => {
  // reconstruct.mjs already ignores blank lines; the splitter must not silently
  // swallow them first, or `linesRead` and the reconstruction disagree.
  const r = splitLines('one\n\ntwo\n', '');
  assert.deepEqual(r.lines, ['one', '', 'two']);
});

test('splitLines: two files each ending MID-LINE never share a buffer (separate carries)', () => {
  // The per-path carry is the whole point: one global buffer splices replica A's
  // half-line onto replica B's next chunk.
  const a1 = splitLines('{"file":"a","half', '');
  const b1 = splitLines('{"file":"b","half', '');
  assert.deepEqual(a1.lines, []);
  assert.deepEqual(b1.lines, []);

  const a2 = splitLines('":1}\n', a1.carry);
  const b2 = splitLines('":2}\n', b1.carry);
  assert.deepEqual(a2.lines, ['{"file":"a","half":1}']);
  assert.deepEqual(b2.lines, ['{"file":"b","half":2}']);
  assert.equal(JSON.parse(a2.lines[0]).file, 'a');
  assert.equal(JSON.parse(b2.lines[0]).file, 'b');
});

// ---------------------------------------------------------------------------
// 9. carryAfter + PARTIAL-LINE x ROTATION (AM9's highest-value missing test)
// ---------------------------------------------------------------------------

test('carryAfter: the carry SURVIVES growth and noChange, and is DROPPED on firstSight/truncated/rotated', () => {
  const held = 'a-held-partial-line';
  assert.equal(carryAfter({ readFrom: 100, readTo: 200, reason: 'growth' }, held), held);
  assert.equal(carryAfter({ readFrom: 200, readTo: 200, reason: 'noChange' }, held), held);
  assert.equal(carryAfter({ readFrom: 0, readTo: 50, reason: 'truncated' }, held), '');
  assert.equal(carryAfter({ readFrom: 0, readTo: 50, reason: 'rotated' }, held), '');
  assert.equal(carryAfter({ readFrom: 0, readTo: 50, reason: 'firstSight' }, held), '');
});

test('AM9 PARTIAL-LINE x ROTATION: a stale carry must NEVER splice onto the new file', () => {
  // Log content is module output: attacker-INFLUENCED. So the two halves here
  // are crafted so that a naive concatenation produces a VALID-LOOKING host
  // envelope carrying a breadcrumb — `cause:zone:forged` — that no file ever
  // contained. This is the forgery the carry reset exists to stop.
  const FORGED = hostLine(
    'zone_tick',
    '1782197246181000',
    '{"evt":"span","cause":"zone:forged","phase":"enter"}',
  );
  const SPLIT_AT = 60;
  const staleCarry = FORGED.slice(0, SPLIT_AT);
  const newFileFirstBytes = FORGED.slice(SPLIT_AT);
  assert.ok(
    staleCarry.length > 0 && newFileFirstBytes.length > 0,
    'FIXTURE: both halves non-empty',
  );

  const genuine = hostLine(
    'zone_tick',
    '1782197246183000',
    '{"evt":"span","cause":"zone:a","phase":"exit"}',
  );
  const newFileChunk = `${newFileFirstBytes}\n${genuine}\n`;

  // The rotation itself: the old file ended mid-line at `staleCarry.length`.
  const decision = decideRead(
    { offset: staleCarry.length, identity: ID_A },
    { size: newFileChunk.length, identity: ID_B },
  );
  assert.equal(decision.reason, 'rotated');
  assert.equal(decision.readFrom, 0);

  const carry = carryAfter(decision, staleCarry);
  assert.equal(carry, '', 'the OLD file’s held partial line must be dropped on rotation');

  const { lines } = splitLines(newFileChunk, carry);
  assert.equal(
    lines.includes(FORGED),
    false,
    'the forged breadcrumb must NEVER appear: it is the old file’s tail spliced onto the new ' +
      'file’s head, and it names a cause key that existed in no file',
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0], newFileFirstBytes, 'the new file’s truncated first line is emitted AS IS');
  assert.equal(lines[1], genuine);
  assert.throws(
    () => JSON.parse(lines[0]),
    'the new file’s own truncated first line is garbage the parser rejects LOUDLY — which is the ' +
      'correct outcome; splicing it onto the old file’s tail is what manufactures a clean forgery',
  );

  // PROOF OF TEETH — the wrong implementation this kills, executed. A splitter
  // keyed on path that does NOT clear the buffer on `rotated` produces exactly
  // the forged line as its FIRST emitted record, and it parses cleanly.
  const naive = splitLines(newFileChunk, staleCarry);
  assert.equal(
    naive.lines[0],
    FORGED,
    'FIXTURE: the naive concatenation must actually forge the line, or this tooth is toothless',
  );
  assert.equal(
    JSON.parse(naive.lines[0]).message.indexOf('zone:forged') !== -1,
    true,
    'FIXTURE: and the forgery must be a VALID-looking breadcrumb, not obvious garbage',
  );
  assert.notDeepEqual(
    lines,
    naive.lines,
    'the two implementations must be separated by this fixture',
  );
});

test('AM9: the carry is also dropped on TRUNCATION — copytruncate loses the partial line too', () => {
  const partial = '{"level":"Info","ts":178219724618100';
  const decision = decideRead(
    { offset: partial.length, identity: ID_A },
    { size: 0, identity: ID_A },
  );
  assert.equal(decision.reason, 'truncated');
  assert.equal(carryAfter(decision, partial), '', 'those bytes no longer exist on disk');
});

// ---------------------------------------------------------------------------
// 10. U6 — structural purity (asserted on the module's own source text)
// ---------------------------------------------------------------------------

test('U6: tail.mjs imports NOTHING — no node: module, no dynamic import, no require', () => {
  const code = codeText(TAIL_SOURCE);
  assert.equal(
    code.indexOf('node:'),
    -1,
    'tail.mjs must reach for no node: builtin at all — not fs, not a clock, not a timer',
  );
  assert.equal(code.indexOf('require('), -1, 'no CommonJS escape hatch');
  assert.equal(code.indexOf('import('), -1, 'no dynamic import');
  assert.equal(code.indexOf('import '), -1, 'a pure decider takes data in and returns data out');
  assert.ok(TAIL_SOURCE.length > 0, 'and the file must actually exist to be scanned');
});

test('U6 (AM9): tail.mjs never INTERPRETS an identity — no field name appears in its code', () => {
  // The wrong implementation this kills: a `sameIdentity` with a hardcoded
  // ['dev','ino','headSample','birthtimeMs'] field list passes every
  // behavioural test above and is still the wrong module — the day the shell
  // adds a fifth discriminator, that list silently ignores it and the rotation
  // detector goes quiet.
  const code = codeText(TAIL_SOURCE);
  assert.equal(code.indexOf('headsample'), -1, 'tail.mjs must not know a head sample exists');
  assert.equal(code.indexOf('birthtime'), -1, 'nor a birth time');
  assert.equal(code.indexOf('statsync'), -1, 'nor how the identity was obtained');
});
