// The hand-off port: what the client hands to the operating system of whatever hosts its page.
//
// Each function holds the browser's code, and every host runs it. The module imports no client
// module and registers nothing on `window` or `document`; it reads those globals, `URL` and `Blob`
// at the moment of each call.

/** A file the client generated, as `saveFile` writes it. */
export interface SavedFile {
  /** The file name the save offers, as given: the caller makes it safe for a filesystem. */
  readonly name: string;
  /** The MIME type the file is written with. */
  readonly mimeType: string;
  /** The file's contents. */
  readonly text: string;
}

/** Open `url` outside the game, in a new browsing context that has no handle back to this page. */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener');
}

/**
 * Save `file` through a blob URL on a hidden download anchor. When the host blocks a step, that
 * throw does not escape: `onBlocked` runs in its place. The anchor and the URL are released
 * afterwards whatever happened; a throw from `onBlocked` itself propagates after that release.
 */
export function saveFile(file: SavedFile, onBlocked: () => void): void {
  // Both declared before the `try` so the `finally` releases exactly what was created.
  // `URL.createObjectURL` is itself one of the calls a CSP or sandbox policy blocks, so it sits
  // inside the `try`.
  let url = '';
  let anchor: HTMLAnchorElement | undefined;
  try {
    url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType }));
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
  } catch {
    onBlocked();
  } finally {
    // In a `finally`: a throw after the URL is made would otherwise pin the object URL, and with
    // it the whole Blob, for the page's lifetime, and leave a stray anchor in the document.
    anchor?.remove();
    if (url !== '') URL.revokeObjectURL(url);
  }
}
