// observability/attributes.ts — m20c (ADR-0180 body amendment), OBS-34/35.
//
// The ONE place a datapoint attribute set is constructed. Contract (pinned by the sibling test):
//   1. the key set is a SUBSET of ATTR_KEYS — never a superset, for any input;
//   2. a value the names.ts predicates reject causes its KEY to be OMITTED — never coerced,
//      never trimmed or case-folded into validity, never left for the ingest to filter (what
//      leaves the browser is the criterion, not what the store keeps);
//   3. the returned object is FROZEN — the shell passes this exact object to every instrument
//      call, so no call site can append a per-call dimension;
//   4. it is rebuildable: a zone switch produces a NEW frozen object (AM1), never a mutation.

import { isValidBuildSha, isValidDeviceClass, isValidZoneId } from './names';

export interface AttributeInput {
  readonly zoneId?: number;
  readonly buildSha?: string;
  readonly deviceClass?: string;
}

/** Per-key omit-don't-coerce, mirroring the ingest's three independent delete_key statements. */
export function buildAttributes(input: AttributeInput): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (typeof input.zoneId === 'number') {
    const rendered = String(input.zoneId);
    if (isValidZoneId(rendered)) out.zone_id = rendered;
  }
  if (typeof input.buildSha === 'string' && isValidBuildSha(input.buildSha)) {
    out.build_sha = input.buildSha;
  }
  if (typeof input.deviceClass === 'string' && isValidDeviceClass(input.deviceClass)) {
    out.device_class = input.deviceClass;
  }
  return Object.freeze(out);
}
