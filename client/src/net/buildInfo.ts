// net/buildInfo.ts — pure build-provenance stamp (pt-a1, ADR-0128).
//
// PURE data + formatter. Exposes the git short-SHA + build time captured at BUILD time
// (injected via `client/vite.config.ts` `define`) so a playtest finding can be pinned to the
// exact build across wipe/republish cycles. UNGATED on purpose — the deliberate contrast with
// the DEV-gated `__game`/`__mrTrade`/`__mrPvp` debug hooks: the M-playtest-b F9 bug-report
// bundle runs in the PRODUCTION playtest build and must read the provenance. The stamp carries
// only non-secret build metadata (a short sha + a timestamp), so there is no leak/authz concern.

// Injected by `vite.config.ts` `define` at build time (bareword globals; text-substituted to
// string literals). A module-scoped ambient `declare` satisfies tsc (only this file references
// them). The `typeof … !== 'undefined'` guard keeps the read safe even if the define did not
// fire (a bundler without it): `typeof <undeclared>` is `'undefined'` in JS — never a
// ReferenceError. See ADR-0128 Residuals F-4: this fallback branch is not unit-reachable under
// vitest (the define always fires), so it is covered by `buildInfoFrom('unknown', …)` below.
declare const __MR_BUILD_SHA__: string;
declare const __MR_BUILD_TIME__: string;

export interface BuildInfo {
  readonly sha: string;
  readonly builtAt: string;
  readonly mode: 'dev' | 'production';
}

/** Pure: assemble a BuildInfo from the raw injected values + the dev flag. */
export function buildInfoFrom(sha: string, builtAt: string, isDev: boolean): BuildInfo {
  return { sha, builtAt, mode: isDev ? 'dev' : 'production' };
}

/**
 * Pure, total: a human build stamp that always names the sha AND the mode. The `'unknown'`
 * fallback is rendered verbatim — the F9 bug bundle must never embed a blank build id.
 */
export function formatBuildStamp(info: BuildInfo): string {
  return `monster-realm · ${info.sha} · ${info.builtAt} · ${info.mode}`;
}

/**
 * The live build info for this bundle. Reads the vite-injected globals with a safe fallback to
 * `'unknown'` when git/define is unavailable. NOT DEV-gated (see the module header). Do NOT
 * assert on this constant's VALUE in tests — it is build-time-injected and non-deterministic
 * (ADR-0128 Residuals F-7); test `buildInfoFrom`/`formatBuildStamp` with literal params instead.
 */
export const BUILD_INFO: BuildInfo = buildInfoFrom(
  typeof __MR_BUILD_SHA__ !== 'undefined' ? __MR_BUILD_SHA__ : 'unknown',
  typeof __MR_BUILD_TIME__ !== 'undefined' ? __MR_BUILD_TIME__ : 'unknown',
  import.meta.env.DEV,
);
