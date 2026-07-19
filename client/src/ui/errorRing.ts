// ui/errorRing.ts — bounded, total-normalized error buffer for the F9 bug bundle (pt-b1).
//
// Source-of-truth: M-playtest-b F9 bug-bundle error ring (EARS U-2 bounded FIFO,
// normalizeError totality).
//
// `normalizeError` is PURE and TOTAL — it NEVER throws, even for a hostile input whose
// `toString`/`String()` conversion itself throws (a null-prototype object, a throwing
// toString). The fallback `String(raw)` is wrapped in try/catch for exactly this reason.
// Messages are truncated to a max length so a runaway error string cannot bloat the bundle.

export const ERROR_RING_CAP = 64;
export const ERROR_MSG_MAX_LEN = 512;

export type ErrorSource = 'uncaught' | 'unhandledrejection' | 'reducer';

export interface ErrorRecord {
  readonly tSeq: number;
  readonly tMs: number;
  readonly source: ErrorSource;
  readonly message: string;
}

/**
 * TOTAL, never throws. Error→`.message`; string→itself; anything else→`String(raw)` guarded by
 * try/catch (so a hostile toString / null-proto object cannot throw); then truncate to `maxLen`.
 */
export function normalizeError(
  source: ErrorSource,
  raw: unknown,
  maxLen = ERROR_MSG_MAX_LEN,
): { source: ErrorSource; message: string } {
  let message: string;
  if (raw instanceof Error) {
    message = raw.message;
  } else if (typeof raw === 'string') {
    message = raw;
  } else {
    try {
      message = String(raw);
    } catch {
      message = '[unstringifiable error]';
    }
  }
  if (message.length > maxLen) {
    message = message.slice(0, maxLen);
  }
  return { source, message };
}

/**
 * Bounded FIFO error buffer. `push` normalizes the raw input, stamps a monotonic `tSeq`
 * (from 1, never reused) plus a clock `tMs`, and FIFO-evicts at cap. `snapshot()` returns a
 * fresh defensive copy oldest→newest.
 */
export class ErrorRing {
  readonly #now: () => number;
  readonly #cap: number;
  #buf: ErrorRecord[] = [];
  #seq = 0;

  constructor(now: () => number, cap = ERROR_RING_CAP) {
    this.#now = now;
    this.#cap = cap;
  }

  push(source: ErrorSource, raw: unknown): void {
    const { message } = normalizeError(source, raw);
    this.#seq += 1;
    this.#buf.push({ tSeq: this.#seq, tMs: this.#now(), source, message });
    if (this.#buf.length > this.#cap) {
      this.#buf.shift();
    }
  }

  snapshot(): readonly ErrorRecord[] {
    return this.#buf.slice();
  }

  clear(): void {
    this.#buf = [];
  }
}
