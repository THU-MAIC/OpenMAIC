/**
 * Size limits of the standalone HTML export. App-side only (the player
 * bundle does not import this module).
 */

/**
 * Size above which the export warns about the file's size (it still saves).
 *
 * Opening is not the bottleneck: embedded media sits in data blocks the
 * browser keeps as plain text until a clip plays, and a 400 MB file opened
 * from disk reached the player in about 1.3 s in both desktop Chromium and
 * WebKit (100 MB: under 0.9 s). The limits are elsewhere: the exporting tab
 * holds the media, its base64 and the assembled document at once (roughly
 * three times the file size), a single JavaScript string cannot exceed about
 * 512 MiB in V8, mobile browsers evict tabs far earlier, and files this size
 * no longer fit mail or chat attachments. 100 MB flags the files that are
 * awkward to share while staying well clear of the hard limits.
 */
export const STANDALONE_HTML_SIZE_WARNING_BYTES = 100 * 1024 * 1024;

/**
 * Size above which the classroom is not exported as a single file. The
 * document is assembled as Blob parts, so no single string limit applies;
 * what remains is the exporting tab holding the media and its base64 at once,
 * and the largest file verified to open (400 MB, see above).
 *
 * It is also the point where the export switches, on its own, to the ZIP
 * variant (`classroom.html` plus its media folder): a single file is the
 * better format wherever it works (nothing to extract, opens from mail and
 * chat previews, works on phones), so the ZIP is used only once a single file
 * would not be reliable. The ZIP needs no base64 and copies no media, so it
 * has no ceiling of its own below the ZIP format's 4 GiB.
 */
export const STANDALONE_HTML_MAX_BYTES = 400 * 1024 * 1024;

/** Which limit an export would pass (see {@link StandaloneHtmlTooLargeError}). */
export type StandaloneTooLargeKind = 'single-file' | 'page' | 'archive';

/**
 * The export would exceed what its format can hold:
 * - `single-file`: the single file above {@link STANDALONE_HTML_MAX_BYTES}
 *   (thrown before any media is encoded, so a caller can build the ZIP
 *   variant instead);
 * - `page`: the ZIP variant's `classroom.html` alone above that ceiling
 *   (interactive scenes keep their media inline, see `buildStandaloneZip`);
 * - `archive`: the ZIP above 4 GiB.
 */
export class StandaloneHtmlTooLargeError extends Error {
  readonly name = 'StandaloneHtmlTooLargeError';

  constructor(
    readonly estimatedBytes: number,
    readonly kind: StandaloneTooLargeKind = 'single-file',
  ) {
    super(`Standalone export (${kind}) would be about ${Math.round(estimatedBytes / 1048576)} MB`);
  }
}
