// parse.mjs — relay host-envelope parser (pure core, m20e T1; ADR-0180 D6/D15,
// OBS-42/43/49).
//
// Layer contract (AM4): this module consumes the HOST envelope only. The
// module-rendered JSON inside `message` is lifted byte-exact as `payloadText`
// and parsed as a separate second step; nothing here ever re-serialises it.
//
// `ts` is lifted from the RAW line text as a digit string. The host writes it
// as a JSON number at microsecond magnitude, which is outside the double's
// exact range, so going through the platform parser's Number would silently
// corrupt the low digits (OBS-43).
//
// Discipline: string methods and hand-rolled walkers only — no regex of any
// kind, no clock, no I/O, no filesystem. Text in, data out.

function isWhitespace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

// Walk the TOP LEVEL of a JSON object literal and return its entries as
// { name, start, end } — the raw key text plus the raw-text span of the value.
// Returns null when the text is not an object literal this walker can follow.
// Depth-aware, escape-aware, in-string-aware; never throws.
function scanTopLevelEntries(text) {
  const n = text.length;
  let i = 0;
  while (i < n && isWhitespace(text[i])) i++;
  if (text[i] !== '{') return null;
  i++;
  const entries = [];
  for (;;) {
    while (i < n && isWhitespace(text[i])) i++;
    if (i >= n) return null;
    if (text[i] === '}') return entries;
    if (text[i] !== '"') return null;
    i++;
    const nameStart = i;
    let escaped = false;
    while (i < n) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        break;
      }
      i++;
    }
    if (i >= n) return null;
    const name = text.slice(nameStart, i);
    i++;
    while (i < n && isWhitespace(text[i])) i++;
    if (text[i] !== ':') return null;
    i++;
    while (i < n && isWhitespace(text[i])) i++;
    if (i >= n) return null;
    const valueStart = i;
    const first = text[i];
    if (first === '"') {
      i++;
      let esc = false;
      while (i < n) {
        const ch = text[i];
        if (esc) {
          esc = false;
        } else if (ch === '\\') {
          esc = true;
        } else if (ch === '"') {
          i++;
          break;
        }
        i++;
      }
    } else if (first === '{' || first === '[') {
      let depth = 0;
      let inString = false;
      let esc = false;
      let closed = false;
      while (i < n) {
        const ch = text[i];
        if (inString) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          inString = true;
        } else if (ch === '{' || ch === '[') {
          depth++;
        } else if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            i++;
            closed = true;
            break;
          }
        }
        i++;
      }
      if (!closed) return null;
    } else {
      while (i < n && text[i] !== ',' && text[i] !== '}') i++;
    }
    entries.push({ name, start: valueStart, end: i });
    while (i < n && isWhitespace(text[i])) i++;
    if (text[i] === ',') {
      i++;
      continue;
    }
    if (text[i] === '}') return entries;
    return null;
  }
}

/**
 * True when `jsonText` is an object literal whose TOP LEVEL carries `name`
 * more than once. Nested objects, array elements, and in-string lookalikes
 * never fire; non-object text returns false. Never throws (AM8).
 */
export function hasDuplicateTopLevelKey(jsonText, name) {
  const entries = scanTopLevelEntries(jsonText);
  if (entries === null) return false;
  let seen = 0;
  for (const entry of entries) {
    if (entry.name === name) seen++;
    if (seen > 1) return true;
  }
  return false;
}

// The raw digit string of the top-level `ts` number, lifted from the unparsed
// line text; null when absent or not a plain digit run.
function rawTsDigits(rawLine) {
  const entries = scanTopLevelEntries(rawLine);
  if (entries === null) return null;
  const entry = entries.find((e) => e.name === 'ts');
  if (entry === undefined) return null;
  const raw = rawLine.slice(entry.start, entry.end).trim();
  if (raw.length === 0) return null;
  for (let i = 0; i < raw.length; i++) {
    if (!isDigit(raw[i])) return null;
  }
  return raw;
}

const reject = (reason) => ({ ok: false, reason });

/**
 * Parse one raw host log line into the relay's record shape.
 *
 * Rejections carry ONLY { ok: false, reason } — never partial fields. The
 * reasons, in check order: 'not-json', 'not-object', 'message-not-string',
 * 'ts-missing', 'duplicate-evt' (a forged second top-level `evt` inside the
 * still-unparsed message text, detected BEFORE the inner parse — the platform
 * parser is last-value-wins, which is exactly the forgery AM8 closes).
 */
export function parseHostLine(rawLine) {
  let outer;
  try {
    outer = JSON.parse(rawLine);
  } catch {
    return reject('not-json');
  }
  if (outer === null || typeof outer !== 'object' || Array.isArray(outer)) {
    return reject('not-object');
  }
  if (typeof outer.message !== 'string') {
    return reject('message-not-string');
  }
  const ts = rawTsDigits(rawLine);
  if (ts === null) {
    return reject('ts-missing');
  }
  const payloadText = outer.message;
  if (hasDuplicateTopLevelKey(payloadText, 'evt')) {
    return reject('duplicate-evt');
  }
  let payload = null;
  try {
    const inner = JSON.parse(payloadText);
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      payload = inner;
    }
  } catch {
    payload = null;
  }
  const evt = payload !== null && typeof payload.evt === 'string' ? payload.evt : null;
  return {
    ok: true,
    level: typeof outer.level === 'string' ? outer.level : null,
    ts,
    functionName: typeof outer.function === 'string' ? outer.function : null,
    payloadText,
    payload,
    evt,
  };
}

// The payload's `sched` object, narrowed to exactly the two fields the
// correlation contract uses; null when absent or malformed.
function schedOf(payload) {
  const sched = payload.sched;
  if (sched === null || sched === undefined || typeof sched !== 'object' || Array.isArray(sched)) {
    return null;
  }
  if (typeof sched.target_reducer !== 'string') return null;
  if (typeof sched.scheduled_at !== 'number') return null;
  return { target_reducer: sched.target_reducer, scheduled_at: sched.scheduled_at };
}

/**
 * Narrow a parsed host record to a pairable breadcrumb.
 *
 * The crumb's `reducer` is the HOST `function` field — the host's cross-file
 * attribution to the invoking reducer (OBS-10) — NEVER a payload-supplied
 * `reducer` field, which is caller-authored convenience.
 *
 * Rejections: 'no-payload' (the message was not a JSON object),
 * 'no-phase' (a module event with no phase, e.g. a heartbeat),
 * 'phase-not-pairable' (a real D15 phase such as 'event' that is deliberately
 * not an enter/exit pair member).
 */
export function parseBreadcrumb(record) {
  if (
    record === null ||
    typeof record !== 'object' ||
    record.ok !== true ||
    record.payload === null ||
    typeof record.payload !== 'object'
  ) {
    return reject('no-payload');
  }
  const phase = record.payload.phase;
  if (typeof phase !== 'string') {
    return reject('no-phase');
  }
  if (phase !== 'enter' && phase !== 'exit') {
    return reject('phase-not-pairable');
  }
  const cause = typeof record.payload.cause === 'string' ? record.payload.cause : null;
  return {
    ok: true,
    crumb: {
      reducer: record.functionName,
      ts: record.ts,
      phase,
      cause,
      sched: schedOf(record.payload),
    },
  };
}

/**
 * The correlation key a crumb pairs under (ADR-0180 D15): a non-empty `cause`
 * wins; else the sched identity `target_reducer@scheduled_at`; else null —
 * a keyless crumb is never given a synthesised key.
 */
export function correlationKey(crumb) {
  if (typeof crumb.cause === 'string' && crumb.cause.length > 0) {
    return `cause:${crumb.cause}`;
  }
  const sched = crumb.sched;
  if (sched !== null && sched !== undefined && typeof sched.target_reducer === 'string') {
    return `sched:${sched.target_reducer}@${sched.scheduled_at}`;
  }
  return null;
}
