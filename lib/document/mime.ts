// ─── Format registry ─────────────────────────────────────────────────────────
// Single source of truth for every document format the app knows about.
// All lookup maps (MIME→ext, ext→MIME, label, accept string) derive from here,
// so adding a format is a one-line change and per-format lists cannot drift.

interface DocumentFormat {
  /** Short identifier used as a key in DOCUMENT_MIME_TYPES. */
  id: string;
  /** Canonical MIME type. */
  mime: string;
  /** File extensions (leading dot). First entry is the canonical extension. */
  extensions: readonly string[];
  /** Additional MIME strings a browser might report for this format. */
  aliasMimes?: readonly string[];
  /** Human-readable label shown in the Settings "Supported Formats" badges. */
  label: string;
}

const DOCUMENT_FORMATS: readonly DocumentFormat[] = [
  { id: 'pdf', mime: 'application/pdf', extensions: ['.pdf'], label: 'PDF' },
  {
    id: 'doc',
    mime: 'application/msword',
    extensions: ['.doc'],
    aliasMimes: ['application/x-msword'],
    label: 'DOC',
  },
  {
    id: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['.docx'],
    label: 'DOCX',
  },
  { id: 'ppt', mime: 'application/vnd.ms-powerpoint', extensions: ['.ppt'], label: 'PPT' },
  {
    id: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['.pptx'],
    label: 'PPTX',
  },
  { id: 'xls', mime: 'application/vnd.ms-excel', extensions: ['.xls'], label: 'XLS' },
  {
    id: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['.xlsx'],
    label: 'XLSX',
  },
  { id: 'txt', mime: 'text/plain', extensions: ['.txt'], label: 'TXT' },
  {
    id: 'markdown',
    mime: 'text/markdown',
    extensions: ['.md', '.markdown'],
    aliasMimes: ['text/x-markdown'],
    label: 'MD',
  },
  { id: 'png', mime: 'image/png', extensions: ['.png'], label: 'PNG' },
  {
    id: 'jpeg',
    mime: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    aliasMimes: ['image/jpg'],
    label: 'JPG',
  },
  { id: 'webp', mime: 'image/webp', extensions: ['.webp'], label: 'WebP' },
  { id: 'gif', mime: 'image/gif', extensions: ['.gif'], label: 'GIF' },
  {
    id: 'bmp',
    mime: 'image/bmp',
    extensions: ['.bmp'],
    aliasMimes: ['image/x-ms-bmp'],
    label: 'BMP',
  },
  {
    id: 'jp2',
    mime: 'image/jp2',
    extensions: ['.jp2'],
    aliasMimes: ['image/jpeg2000'],
    label: 'JP2',
  },
  // ─── Media formats (audio/video) ───
  // Handled by the media extraction path (MediaArtifact), not the document
  // extractors. Listed here so the upload picker's accept string, extension
  // map, and format badges resolve for them.
  { id: 'mp4', mime: 'video/mp4', extensions: ['.mp4'], label: 'MP4' },
  { id: 'mov', mime: 'video/quicktime', extensions: ['.mov'], label: 'MOV' },
  { id: 'avi', mime: 'video/x-msvideo', extensions: ['.avi'], label: 'AVI' },
  { id: 'mkv', mime: 'video/x-matroska', extensions: ['.mkv'], label: 'MKV' },
  { id: 'wmv', mime: 'video/x-ms-wmv', extensions: ['.wmv'], label: 'WMV' },
  {
    id: 'mp3',
    mime: 'audio/mpeg',
    extensions: ['.mp3'],
    aliasMimes: ['audio/mp3'],
    label: 'MP3',
  },
  { id: 'm4a', mime: 'audio/mp4', extensions: ['.m4a'], label: 'M4A' },
  {
    id: 'wav',
    mime: 'audio/wav',
    extensions: ['.wav'],
    aliasMimes: ['audio/x-wav'],
    label: 'WAV',
  },
  { id: 'aac', mime: 'audio/aac', extensions: ['.aac'], label: 'AAC' },
] as const;

export const DOCUMENT_MIME_TYPES: Record<(typeof DOCUMENT_FORMATS)[number]['id'], string> =
  Object.fromEntries(DOCUMENT_FORMATS.map((f) => [f.id, f.mime])) as Record<string, string>;

// ─── Derived lookup tables ───────────────────────────────────────────────────

const MIME_BY_EXTENSION: Record<string, string> = {};
const EXTENSIONS_BY_MIME: Record<string, readonly string[]> = {};
const FORMAT_LABEL_BY_MIME: Record<string, string> = {};

for (const f of DOCUMENT_FORMATS) {
  EXTENSIONS_BY_MIME[f.mime] = f.extensions;
  FORMAT_LABEL_BY_MIME[f.mime] = f.label;
  for (const alias of f.aliasMimes ?? []) {
    EXTENSIONS_BY_MIME[alias] = f.extensions;
    FORMAT_LABEL_BY_MIME[alias] = f.label;
  }
  for (const ext of f.extensions) {
    // MIME_BY_EXTENSION is keyed on extension WITHOUT the leading dot.
    MIME_BY_EXTENSION[ext.slice(1)] = f.mime;
  }
}

// ─── Provider capability matrix ──────────────────────────────────────────────
// Every provider's supported set of formats. This is the ONLY place these
// lists live — `lib/document/extractors/pdf.ts` and `lib/pdf/mineru-cloud.ts`
// import from here. Verified against mineru.net /file-urls/batch by probing
// each format; self-host support tracks MinerU v3.1+ (no legacy .doc/.ppt/.xls).

const M = DOCUMENT_MIME_TYPES;

/** MinerU image formats — supported by both self-host (v3.1+) and cloud. */
export const MINERU_IMAGE_MIMES: readonly string[] = [M.png, M.jpeg, M.webp, M.gif, M.bmp, M.jp2];

/** MinerU self-host: modern Office + images. Legacy OLE is cloud-only. */
export const MINERU_SELFHOST_MIMES: readonly string[] = [
  M.pdf,
  M.docx,
  M.pptx,
  M.xlsx,
  ...MINERU_IMAGE_MIMES,
];

/** MinerU Cloud: everything self-host supports PLUS legacy Office (.doc/.ppt/.xls). */
export const MINERU_CLOUD_MIMES: readonly string[] = [
  ...MINERU_SELFHOST_MIMES,
  M.doc,
  M.ppt,
  M.xls,
];

/** Local text extractor — no external dependency. */
export const PLAIN_TEXT_MIMES: readonly string[] = [M.txt, M.markdown, 'text/x-markdown'];

/**
 * AliDocMind (LLM version) image formats per the official contract:
 * JPG/JPEG/PNG/BMP/GIF. Note: no WebP or JP2 (unlike MinerU).
 * https://help.aliyun.com/zh/document-mind/developer-reference/document-parsing-large-model-version
 */
export const ALIDOCMIND_IMAGE_MIMES: readonly string[] = [M.png, M.jpeg, M.bmp, M.gif];

/**
 * AliDocMind (LLM version): pdf + modern Office + its supported image set.
 */
export const ALIDOCMIND_MIMES: readonly string[] = [
  M.pdf,
  M.docx,
  M.pptx,
  M.xlsx,
  ...ALIDOCMIND_IMAGE_MIMES,
];

export const PROVIDER_SUPPORTED_MIME_TYPES: Record<string, readonly string[]> = {
  unpdf: [M.pdf],
  mineru: MINERU_SELFHOST_MIMES,
  'mineru-cloud': MINERU_CLOUD_MIMES,
  alidocmind: ALIDOCMIND_MIMES,
  'plain-text': PLAIN_TEXT_MIMES,
};

// ─── Media (audio/video) provider capability matrix ──────────────────────────
// Kept separate from PROVIDER_SUPPORTED_MIME_TYPES (which the drift-guard pins
// to the document extractor registry). Media flows through extractMedia() and
// yields a MediaArtifact rather than a DocumentArtifact.

/**
 * AliDocMind audio/video support per the official contract:
 * MP4/MKV/AVI/MOV/WMV (video) and MP3/WAV/AAC (audio). Note: no M4A.
 */
export const ALIDOCMIND_MEDIA_MIMES: readonly string[] = [
  M.mp4,
  M.mov,
  M.avi,
  M.mkv,
  M.wmv,
  M.mp3,
  M.wav,
  M.aac,
];

export const MEDIA_PROVIDER_SUPPORTED_MIME_TYPES: Record<string, readonly string[]> = {
  alidocmind: ALIDOCMIND_MEDIA_MIMES,
};

/** All audio/video MIME types any media provider accepts. */
export const SUPPORTED_MEDIA_MIME_TYPES: readonly string[] = Array.from(
  new Set(Object.values(MEDIA_PROVIDER_SUPPORTED_MIME_TYPES).flat()),
);

// ─── Global course-material whitelist (derived) ──────────────────────────────
// Union of every provider's supported set — the widest possible list. Used by
// the legacy `isSupportedCourseMaterial` gate and the API-layer MIME check.
// Prefer `isMimeSupportedByProviders` for provider-scoped filtering.

export const SUPPORTED_COURSE_MATERIAL_MIME_TYPES: readonly string[] = Array.from(
  new Set(Object.values(PROVIDER_SUPPORTED_MIME_TYPES).flat()),
);

export const COURSE_MATERIAL_ACCEPT: string = (() => {
  const extensions = new Set<string>();
  for (const mime of SUPPORTED_COURSE_MATERIAL_MIME_TYPES) {
    for (const ext of EXTENSIONS_BY_MIME[mime] ?? []) extensions.add(ext);
  }
  return [...extensions, ...SUPPORTED_COURSE_MATERIAL_MIME_TYPES].join(',');
})();

// ─── MIME normalization ──────────────────────────────────────────────────────

const GENERIC_DOCUMENT_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
]);

/**
 * Normalize a (mimeType, fileName) pair to a canonical MIME string.
 *
 * Precedence:
 *   1. mimeType is missing or a generic upload fallback (octet-stream,
 *      zip-family): use the extension. Handles the common case where a
 *      browser has no more specific MIME to offer for Office/ZIP-based
 *      formats.
 *   2. mimeType is a known alias (canonical MIME, or one of the
 *      registry's curated `aliasMimes` — e.g. `image/jpeg2000`,
 *      `text/x-markdown`, `application/x-msword`): map to the canonical
 *      MIME.
 *   3. Otherwise: return the reported mimeType verbatim. We do NOT trust
 *      the extension for arbitrary unknown MIMEs — a
 *      `{mime: 'application/x-msdownload', fileName: 'lesson.pdf'}` pair
 *      must not spoof its way to `application/pdf`. If a real-world
 *      browser MIME shows up that legitimately maps to a known format,
 *      add it to that format's `aliasMimes`.
 */
export function normalizeDocumentMimeType(input: {
  mimeType?: string | null;
  fileName?: string | null;
}): string {
  const mimeType = input.mimeType?.split(';')[0]?.trim().toLowerCase();
  const extension = input.fileName?.split('.').pop()?.toLowerCase();
  const mimeTypeFromExtension = extension ? MIME_BY_EXTENSION[extension] : undefined;

  if (!mimeType || GENERIC_DOCUMENT_MIME_TYPES.has(mimeType)) {
    return mimeTypeFromExtension ?? mimeType ?? '';
  }

  return canonicalFromAlias(mimeType) ?? mimeType;
}

function canonicalFromAlias(mimeType: string): string | undefined {
  for (const f of DOCUMENT_FORMATS) {
    if (f.mime === mimeType) return f.mime;
    if (f.aliasMimes?.includes(mimeType)) return f.mime;
  }
  return undefined;
}

export function isSupportedCourseMaterial(input: {
  mimeType?: string | null;
  fileName?: string | null;
}): boolean {
  const normalized = normalizeDocumentMimeType(input);
  return SUPPORTED_COURSE_MATERIAL_MIME_TYPES.includes(normalized);
}

// ─── Provider-scoped helpers ────────────────────────────────────────────────

function mimesForProviders(providerIds: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const id of providerIds) {
    for (const mime of PROVIDER_SUPPORTED_MIME_TYPES[id] ?? []) {
      seen.add(mime);
    }
    // A provider may also handle audio/video through the media extraction path;
    // fold those in so the upload picker / badges / validation cover them too.
    for (const mime of MEDIA_PROVIDER_SUPPORTED_MIME_TYPES[id] ?? []) {
      seen.add(mime);
    }
  }
  return [...seen];
}

export function getFormatLabelsForProviders(providerIds: readonly string[]): string[] {
  const labels = new Set<string>();
  for (const mime of mimesForProviders(providerIds)) {
    const label = FORMAT_LABEL_BY_MIME[mime];
    if (label) labels.add(label);
  }
  return [...labels];
}

export function getAcceptStringForProviders(providerIds: readonly string[]): string {
  const mimes = mimesForProviders(providerIds);
  const extensions = new Set<string>();
  for (const mime of mimes) {
    for (const ext of EXTENSIONS_BY_MIME[mime] ?? []) {
      extensions.add(ext);
    }
  }
  return [...extensions, ...mimes].join(',');
}

/** Extensions (without leading dot) accepted by the given providers. */
export function getExtensionsForProviders(providerIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const mime of mimesForProviders(providerIds)) {
    for (const ext of EXTENSIONS_BY_MIME[mime] ?? []) {
      out.add(ext.slice(1));
    }
  }
  return [...out];
}

/** Extensions (without leading dot) for the given MIME types. */
export function getExtensionsForMimes(mimes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const mime of mimes) {
    for (const ext of EXTENSIONS_BY_MIME[mime] ?? []) {
      out.add(ext.slice(1));
    }
  }
  return [...out];
}

export function isMimeSupportedByProviders(
  input: { mimeType?: string | null; fileName?: string | null },
  providerIds: readonly string[],
): boolean {
  const normalized = normalizeDocumentMimeType(input);
  if (!normalized) return false;
  return mimesForProviders(providerIds).includes(normalized);
}
