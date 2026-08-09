// observability/names.ts — m20c (ADR-0180 body amendment): the S4 wire contract, client side.
//
// ONE mirror of the Alloy ingest policy (ops/observability/alloy/config.alloy:155-158). The
// client must never ship a datapoint attribute the ingest is going to delete: a deleted value
// collapses the point into the unlabelled series while the client believes it reported. So the
// allowlist and the three value-shape predicates live HERE, once, and attributes.ts consumes
// them (omit-don't-coerce).
//
// The predicates are hand-rolled character scans on purpose: the ingest policy is Go/RE2, and a
// second JS regex engine next to it is a second policy that drifts in exactly the places that
// matter (`$` vs trailing newline, Unicode digit classes). Character scans state the rule in one
// engine-neutral form. (The repo also bans dynamic regexes outright — Semgrep.)

/** OBS-25: `mr_client_fps` is load-bearing verbatim — the merged recording rule reads
 *  `mr_client_fps_bucket` (ops/observability/rules/recording.rules.yml:69). */
export const METRIC_FPS = 'mr_client_fps';
/** Worst single frame delta per 1s window (a 250ms stall is invisible in an averaged fps). */
export const METRIC_FRAME_TIME_MAX_MS = 'mr_client_frame_time_max_ms';
/** Reconcile attempts (the denominator of the prediction-divergence rate). */
export const METRIC_RECONCILE = 'mr_client_reconcile';
/** Reconciles whose corrected tile differed from the prediction (the numerator). */
export const METRIC_RECONCILE_CORRECTION = 'mr_client_reconcile_correction';
/** Server-rejected movement intents that dropped a predicted op (visible rubber-band). */
export const METRIC_INTENT_REJECT = 'mr_client_intent_reject';
/** How far in the past the worst remote character is rendered (adaptive interp delay). */
export const METRIC_INTERP_GAP_MS = 'mr_client_interp_gap_ms';
/** enqueueMove round trip: send → server Ok → promise settle. */
export const METRIC_REDUCER_RTT_MS = 'mr_client_reducer_rtt_ms';
/** ms from timeOrigin to the prediction-wasm exports being callable (once per session). */
export const METRIC_WASM_READY_MS = 'mr_client_wasm_ready_ms';

/** The ONLY datapoint attribute keys the S4 ingest keeps — anything else is dropped before
 *  storage, so anything else must never leave the browser (OBS-34). */
export const ATTR_KEYS: readonly string[] = ['zone_id', 'build_sha', 'device_class'];

const CODE_ZERO = 48; // '0'
const CODE_NINE = 57; // '9'
const CODE_LOWER_A = 97; // 'a'
const CODE_LOWER_F = 102; // 'f'

/** Mirrors `^[0-9]{1,4}$`: 1-4 ASCII digits, nothing else — no sign, no trim, no exponent. */
export function isValidZoneId(s: string): boolean {
  if (s.length < 1 || s.length > 4) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < CODE_ZERO || c > CODE_NINE) return false;
  }
  return true;
}

/** Mirrors `^[0-9a-f]{7,40}$`: lowercase hex only, both length bounds enforced. The upper bound
 *  is load-bearing: a 64-hex value is the shape of a per-player key and must never become a
 *  label (OBS-35), and the `'unknown'` dev fallback fails the alphabet check by design. */
export function isValidBuildSha(s: string): boolean {
  if (s.length < 7 || s.length > 40) return false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    const digit = c >= CODE_ZERO && c <= CODE_NINE;
    const lowerHex = c >= CODE_LOWER_A && c <= CODE_LOWER_F;
    if (!digit && !lowerHex) return false;
  }
  return true;
}

/** Mirrors `^(desktop|mobile|tablet)$`: exact, case-sensitive, closed. */
export function isValidDeviceClass(s: string): boolean {
  return s === 'desktop' || s === 'mobile' || s === 'tablet';
}
