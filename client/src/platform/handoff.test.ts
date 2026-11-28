// @vitest-environment happy-dom
// The hand-off port: `openExternal` opens a URL in a new, opener-less browsing context, and
// `saveFile` offers a generated file through a temporary object URL and download anchor, calls
// its blocked handler when the host refuses any step, and always releases the anchor and the URL.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternal, saveFile } from './handoff';

type SavedFile = Parameters<typeof saveFile>[0];

const EXPORT_FILE: SavedFile = {
  name: 'monster-realm-export-req7-20261128.json',
  mimeType: 'application/json',
  text: '{"party":[{"species":"emberkit","level":5}]}',
};

const NOTES_FILE: SavedFile = {
  name: 'field notes 2.csv',
  mimeType: 'text/csv',
  text: 'route,seen\nmeadow,3\n',
};

interface HostFaults {
  readonly createUrl?: boolean;
  readonly createElement?: boolean;
  readonly append?: boolean;
  readonly click?: boolean;
}

interface ClickView {
  readonly inBody: boolean;
  readonly href: string | null;
  readonly download: string;
}

interface HostLog {
  readonly events: string[];
  readonly blobs: unknown[];
  readonly urls: string[];
  readonly revoked: string[];
  readonly appended: Node[];
  readonly clicks: ClickView[];
}

/** Spies the host globals `saveFile` touches, recording every call into one ordered log. */
function installHost(faults: HostFaults = {}): HostLog {
  const log: HostLog = { events: [], blobs: [], urls: [], revoked: [], appended: [], clicks: [] };

  vi.spyOn(URL, 'createObjectURL').mockImplementation(((blob: unknown): string => {
    log.events.push('createObjectURL');
    if (faults.createUrl === true) throw new Error('object URLs blocked (test)');
    log.blobs.push(blob);
    const url = `blob:handoff-test-${log.urls.length}`;
    log.urls.push(url);
    return url;
  }) as unknown as typeof URL.createObjectURL);

  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(((url: string): void => {
    log.events.push('revokeObjectURL');
    log.revoked.push(url);
  }) as unknown as typeof URL.revokeObjectURL);

  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ): HTMLElement => {
    if (faults.createElement === true && tag.toLowerCase() === 'a') {
      throw new Error('anchor creation blocked (test)');
    }
    return realCreate(tag, options);
  }) as unknown as typeof document.createElement);

  const realAppend = document.body.appendChild.bind(document.body);
  vi.spyOn(document.body, 'appendChild').mockImplementation(((node: Node): Node => {
    log.events.push(`appendChild:${node instanceof HTMLElement ? node.tagName : node.nodeName}`);
    if (faults.append === true) throw new Error('append blocked (test)');
    log.appended.push(node);
    return realAppend(node);
  }) as unknown as typeof document.body.appendChild);

  const realClick = HTMLElement.prototype.click;
  vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement): void {
    if (this.tagName !== 'A') {
      realClick.call(this);
      return;
    }
    log.events.push('click');
    log.clicks.push({
      inBody: this.parentNode === document.body,
      href: this.getAttribute('href'),
      download: (this as HTMLAnchorElement).download,
    });
    if (faults.click === true) throw new Error('download blocked (test)');
  } as unknown as HTMLElement['click']);

  const realRemove = Element.prototype.remove;
  vi.spyOn(Element.prototype, 'remove').mockImplementation(function (this: Element): void {
    if (this.tagName === 'A') log.events.push('remove');
    realRemove.call(this);
  } as unknown as Element['remove']);

  return log;
}

function recordingBlocked(log: HostLog): () => void {
  return vi.fn((): void => {
    log.events.push('onBlocked');
  });
}

function anchorsInBody(): number {
  return document.body.querySelectorAll('a').length;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const anchor of Array.from(document.body.querySelectorAll('a'))) anchor.remove();
});

describe('openExternal', () => {
  // The URL is passed through as given, in a new tab with no opener.
  it.each([
    'https://store.example/monster-realm',
    'https://example.org/other/page?ref=menu',
  ])('opens %s with exactly one window.open(url, "_blank", "noopener") call', (url) => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    openExternal(url);
    expect(open.mock.calls).toEqual([[url, '_blank', 'noopener']]);
  });

  // A blocked popup (window.open returning null) is not an error.
  it('returns undefined and does not throw when window.open returns null', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    let result: unknown = 'not called';
    expect(() => {
      result = openExternal('https://store.example/monster-realm');
    }).not.toThrow();
    expect(result).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('saveFile on a host that allows the download', () => {
  // The steps run once each, in order, and the anchor is removed before the URL is revoked.
  it('makes one URL, appends one anchor, clicks it, removes it, then revokes the URL', () => {
    const log = installHost();
    saveFile(EXPORT_FILE, recordingBlocked(log));
    expect(log.events).toEqual([
      'createObjectURL',
      'appendChild:A',
      'click',
      'remove',
      'revokeObjectURL',
    ]);
  });

  // The object URL wraps a real Blob carrying the file's type and text.
  it.each([
    EXPORT_FILE,
    NOTES_FILE,
  ])('hands createObjectURL a Blob of type $mimeType holding the file text', async (file) => {
    const log = installHost();
    saveFile(file, recordingBlocked(log));
    expect(log.blobs).toHaveLength(1);
    const blob = log.blobs[0];
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe(file.mimeType);
    expect(await (blob as Blob).text()).toBe(file.text);
  });

  it('uses the literal application/json type for a JSON file', () => {
    const log = installHost();
    saveFile(EXPORT_FILE, recordingBlocked(log));
    expect((log.blobs[0] as Blob).type).toBe('application/json');
  });

  // Read at click time: the removed anchor keeps its attributes, so only the click shows the live state.
  it.each([
    EXPORT_FILE,
    NOTES_FILE,
  ])('clicks an anchor in document.body whose href is the object URL and download is "$name"', (file) => {
    const log = installHost();
    saveFile(file, recordingBlocked(log));
    expect(log.clicks).toEqual([
      { inBody: true, href: 'blob:handoff-test-0', download: file.name },
    ]);
  });

  it('leaves no anchor behind, revokes the same URL once and never calls onBlocked', () => {
    const log = installHost();
    const onBlocked = recordingBlocked(log);
    saveFile(EXPORT_FILE, onBlocked);
    expect(log.appended).toHaveLength(1);
    const anchor = log.appended[0] as HTMLAnchorElement;
    expect(anchor.isConnected).toBe(false);
    expect(anchorsInBody()).toBe(0);
    expect(log.revoked).toEqual([log.urls[0]]);
    expect(log.revoked).toEqual(['blob:handoff-test-0']);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  // Each call releases its own URL; no state carries over between saves.
  it('revokes each save its own URL across two consecutive saves', () => {
    const log = installHost();
    saveFile(EXPORT_FILE, recordingBlocked(log));
    saveFile(NOTES_FILE, recordingBlocked(log));
    expect(log.revoked).toEqual(['blob:handoff-test-0', 'blob:handoff-test-1']);
    expect(log.clicks.map((c) => c.download)).toEqual([EXPORT_FILE.name, NOTES_FILE.name]);
    expect(anchorsInBody()).toBe(0);
  });
});

describe('saveFile on a host that blocks the download', () => {
  // No URL exists, so nothing is created, appended or revoked.
  it('calls onBlocked once and revokes nothing when createObjectURL throws', () => {
    const log = installHost({ createUrl: true });
    const onBlocked = recordingBlocked(log);
    expect(() => {
      saveFile(EXPORT_FILE, onBlocked);
    }).not.toThrow();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(log.events).toEqual(['createObjectURL', 'onBlocked']);
    expect(log.appended).toEqual([]);
    expect(log.revoked).toEqual([]);
    expect(anchorsInBody()).toBe(0);
  });

  it('calls onBlocked once and still revokes the URL when the anchor cannot be created', () => {
    const log = installHost({ createElement: true });
    const onBlocked = recordingBlocked(log);
    expect(() => {
      saveFile(EXPORT_FILE, onBlocked);
    }).not.toThrow();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(log.appended).toEqual([]);
    expect(log.events).toEqual(['createObjectURL', 'onBlocked', 'revokeObjectURL']);
    expect(log.revoked).toEqual(['blob:handoff-test-0']);
  });

  // Positive control for the fault above: the spy refuses only anchors.
  it('creates non-anchor elements normally under the anchor-creation fault', () => {
    installHost({ createElement: true });
    expect(document.createElement('div').tagName).toBe('DIV');
  });

  it('calls onBlocked once, leaves no anchor and revokes the URL when appendChild throws', () => {
    const log = installHost({ append: true });
    const onBlocked = recordingBlocked(log);
    expect(() => {
      saveFile(EXPORT_FILE, onBlocked);
    }).not.toThrow();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(anchorsInBody()).toBe(0);
    expect(log.clicks).toEqual([]);
    expect(log.revoked).toEqual(['blob:handoff-test-0']);
  });

  // The blocked handler runs where the catch runs: before the finally's remove and revoke.
  it('calls onBlocked before removing the anchor and revoking the URL when click throws', () => {
    const log = installHost({ click: true });
    const onBlocked = recordingBlocked(log);
    expect(() => {
      saveFile(EXPORT_FILE, onBlocked);
    }).not.toThrow();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(log.events).toEqual([
      'createObjectURL',
      'appendChild:A',
      'click',
      'onBlocked',
      'remove',
      'revokeObjectURL',
    ]);
    expect((log.appended[0] as HTMLAnchorElement).isConnected).toBe(false);
    expect(anchorsInBody()).toBe(0);
    expect(log.revoked).toEqual(['blob:handoff-test-0']);
  });

  // The finally still releases everything, and the handler's own error escapes unchanged.
  it('rethrows the error onBlocked throws, after removing the anchor and revoking the URL', () => {
    const log = installHost({ click: true });
    const boom = new Error('handler failed (test)');
    const onBlocked = vi.fn((): void => {
      log.events.push('onBlocked');
      throw boom;
    });
    let caught: unknown;
    try {
      saveFile(EXPORT_FILE, onBlocked);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(log.events.slice(-3)).toEqual(['onBlocked', 'remove', 'revokeObjectURL']);
    expect(anchorsInBody()).toBe(0);
    expect(log.revoked).toEqual(['blob:handoff-test-0']);
  });
});

describe('importing the hand-off module', () => {
  it('registers no listener on window or document', async () => {
    const onWindow = vi.spyOn(window, 'addEventListener');
    const onDocument = vi.spyOn(document, 'addEventListener');
    vi.resetModules();
    const fresh = await import('./handoff');
    expect(typeof fresh.saveFile).toBe('function');
    expect(typeof fresh.openExternal).toBe('function');
    expect(onWindow).not.toHaveBeenCalled();
    expect(onDocument).not.toHaveBeenCalled();
  });
});
