/**
 * PBL v2 — file upload type validation.
 *
 * Whitelists text-file extensions accepted for submission upload.
 * The HTML `accept` attribute mirrors this set as a UX hint for the
 * OS file picker; the real enforcement is `isValidTextFile`.
 *
 * `.ipynb` is deliberately excluded — though JSON underneath, it's
 * not a format learners can read or edit as plain text.
 *
 * When multi-format upload support is added (PDF/image/etc.), this
 * module should remain as the "text" filter path; other format
 * handlers will be added alongside it.
 */

/** Whitelist of text-file extensions accepted for upload. */
export const TEXT_FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'go',
  'rs',
  'sql',
  'sh',
  'log',
]);

/** Computed once — the `accept` string for <input type="file">. */
export const TEXT_FILE_ACCEPT = Array.from(TEXT_FILE_EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(',');

/** `accept` string for the upload picker when PDF is also allowed. */
export const TEXT_AND_PDF_ACCEPT = `${TEXT_FILE_ACCEPT},.pdf`;

/** `accept` string for the upload picker: text + PDF + images. */
export const TEXT_PDF_IMAGE_ACCEPT = `${TEXT_FILE_ACCEPT},.pdf,image/*`;

/** Raster image extensions accepted for submission upload (vision-gradeable). */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** True when the file is a PDF (by extension or MIME). PDFs are not read
 *  as text — they go through the PDF parse endpoint, so they are detected
 *  before the text whitelist check. */
export function isPdfFile(file: File): boolean {
  if (file.type === 'application/pdf') return true;
  const dot = file.name.lastIndexOf('.');
  return dot >= 0 && file.name.slice(dot + 1).toLowerCase() === 'pdf';
}

/** True when the file is a raster image (by MIME or extension). Images are
 *  stored as-is (object storage / base64) and fed to a vision-capable
 *  evaluator — they are detected before the text whitelist check. */
export function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase());
}

/**
 * True when the file's extension and MIME type both look text-like.
 * Extension is the primary gate (MIME is often missing/incorrect).
 * MIME check guards against rename attacks (e.g. `malware.exe`
 * renamed to `malware.py` would carry a non-text MIME).
 */
export function isValidTextFile(file: File): boolean {
  // Extension check
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = file.name.slice(dot + 1).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(ext)) return false;
  // MIME check: allow text/*, application/json, application/xml, and
  // empty/octet-stream (many OS/browser combos don't set a useful type)
  const mime = file.type || '';
  if (!mime) return true;
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml') return true;
  if (mime === 'application/octet-stream') return true;
  // Conservative: if the MIME is explicitly non-text, refuse even if
  // the extension looks like a text file (rename-attack guard).
  return false;
}
