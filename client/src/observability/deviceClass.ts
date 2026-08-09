// observability/deviceClass.ts — m20c (ADR-0180 body amendment), OBS-34/35.
//
// Collapses the high-cardinality, fingerprint-grade User-Agent string to one of exactly three
// literals INSIDE the browser, before anything is serialised. TOTAL: any hints object — including
// one assembled from a hostile or spoofed UA — yields one of the three classes, never a derived
// piece of the input.
//
// Host access is INJECTED (AM21): this module never reads the browser globals; main.ts reads the
// host once and passes a plain record in. That is what keeps it unit-testable under the node
// vitest environment.

export type DeviceClass = 'desktop' | 'mobile' | 'tablet';

/** Plain host-read snapshot, assembled by the caller (main.ts). All members optional. */
export interface DeviceHints {
  readonly userAgent?: string;
  readonly maxTouchPoints?: number;
  readonly screenWidthPx?: number;
  readonly isMobileHint?: boolean;
}

/** Platform-convention classifier: iPad and Android-without-`Mobile` are tablets; iPhone and
 *  Android-with-`Mobile` are phones; everything else (including empty hints) is desktop — a
 *  stable, documented default so the attribute is always present rather than splitting series. */
export function classifyDeviceClass(hints: DeviceHints): DeviceClass {
  const ua = typeof hints.userAgent === 'string' ? hints.userAgent : '';
  if (ua.includes('iPad')) return 'tablet';
  if (ua.includes('iPhone') || ua.includes('iPod')) return 'mobile';
  if (ua.includes('Android')) {
    return ua.includes('Mobile') ? 'mobile' : 'tablet';
  }
  if (hints.isMobileHint === true) return 'mobile';
  return 'desktop';
}
