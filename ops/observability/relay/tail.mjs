// tail.mjs — the relay's PURE tail state machine (13r-b; ADR-0191, AM9).
//
// A poll observes a file and this module decides what to read from it. It owns
// no state, reaches for no builtin, and never performs I/O: the shell hands it
// the previous state plus one fresh observation, and gets back a half-open byte
// range and the reason it chose that range.
//
//   decideRead(prevState, observation) -> { readFrom, readTo, reason }
//
// The range is HALF-OPEN, [readFrom, readTo). The caller's NEXT offset is
// always `readTo` — there is no separate nextOffset field, and no branch leaves
// the offset ambiguous. The inclusive/exclusive conversion node's read streams
// need belongs to the shell (daemon.mjs -> readRangeOptions), not here.
//
// PRECEDENCE, and why it is not the obvious one:
//
//   firstSight > rotated (identity) > truncated (size) > growth > noChange
//
// IDENTITY BEATS SIZE. Copytruncate followed by a fast writer presents a size
// LARGER than the previous offset while the bytes on disk belong to a different
// file, and an inode reused by the log rotator presents an identical dev/ino
// pair. A size comparison alone calls both of those `growth`, reads from the old
// offset, drops the new file's head and delivers a corrupt first line. So the
// identity is compared FIRST and a mismatch always restarts at byte 0.
//
// The identity is an OPAQUE COMPARABLE VALUE. The shell builds it (dev, inode,
// a head-byte sample, birth time) because building it needs a filesystem; this
// module only ever COMPARES identities, and never reads one BY FIELD NAME. That
// is deliberate and it is asserted on this file's source text: a hardcoded field
// list would pass every behavioural test and still be the wrong module, because
// the day the shell adds a fifth discriminator the list would silently ignore it
// and the rotation detector would go quiet.
//
// `prevSize` is NOT in the state tuple: the state is exactly
// { offset, identity }. A second size in the state is a second thing to get
// wrong, and nothing here needs it.
//
// STATED, DELIBERATE GAPS (ADR-0191), pinned by tests rather than discovered:
//   * a double rotation inside one poll interval loses the middle file whole —
//     one identity comparison cannot count rotations;
//   * `truncated` restarts at 0 and therefore RE-EMITS the surviving prefix;
//     there is no dedup, by decision.
//
// Discipline: no imports of any kind, no regex, no clock, no timers, no
// sockets. Data in, data out.

/**
 * Structural, key-AGNOSTIC comparison of two opaque identity values.
 *
 * Field ORDER is not part of the contract (the shell rebuilds the value every
 * poll, so a serialised comparison would make key order part of it and classify
 * every poll as a rotation). Every field present on either side is compared: an
 * extra field the shell starts supplying is a DIFFERENCE, never something to
 * ignore, because an ignored field is a hole in the rotation detector.
 */
export function sameIdentity(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false;
    if (!sameIdentity(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Decide what to read from one observed file.
 *
 * @param prevState    `null` on first sight, else { offset, identity }.
 * @param observation  { size, identity, startAtEnd }. `startAtEnd` is consulted
 *                     ONLY on the first-sight branch and defaults to false —
 *                     the direction that loses no data, because a file first
 *                     seen AFTER boot has no history to skip.
 */
export function decideRead(prevState, observation) {
  const size = observation.size;
  if (prevState === null || prevState === undefined) {
    const from = observation.startAtEnd === true ? size : 0;
    return { readFrom: from, readTo: size, reason: 'firstSight' };
  }
  if (!sameIdentity(prevState.identity, observation.identity)) {
    return { readFrom: 0, readTo: size, reason: 'rotated' };
  }
  if (size < prevState.offset) {
    return { readFrom: 0, readTo: size, reason: 'truncated' };
  }
  if (size > prevState.offset) {
    return { readFrom: prevState.offset, readTo: size, reason: 'growth' };
  }
  return { readFrom: prevState.offset, readTo: size, reason: 'noChange' };
}

/**
 * Split a freshly-read chunk into COMPLETE lines plus the incomplete remainder.
 *
 * Both arguments and the returned carry are strings; the carry defaults to ''.
 * Lines come back with their terminator removed, a blank line between records
 * is a real emitted empty line rather than a silently dropped one, and an
 * incomplete final line is returned in `carry` and NEVER emitted.
 */
export function splitLines(chunk, carry = '') {
  const buffered = `${carry}${chunk}`;
  const parts = buffered.split('\n');
  const remainder = parts.pop();
  return { lines: parts, carry: remainder };
}

/**
 * The carry a decision leaves behind for the NEXT read of the same file.
 *
 * '' for firstSight / truncated / rotated; the previous carry for growth and
 * noChange. A held partial line from the OLD file must never splice onto the
 * NEW file's first bytes: log content is module output, i.e.
 * attacker-influenced, so the two halves can be crafted so that a naive
 * concatenation yields a valid-looking breadcrumb naming a correlation key that
 * existed in no file. Dropping the carry on every restart is what stops that
 * forgery, and the same argument applies to a truncation — those bytes no
 * longer exist on disk.
 */
export function carryAfter(decision, prevCarry = '') {
  if (decision.reason === 'growth' || decision.reason === 'noChange') return prevCarry;
  return '';
}
