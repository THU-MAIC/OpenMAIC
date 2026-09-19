// Workbench material upload policy.
//
// Every MIME/extension fact here — the extension→MIME table, alias
// normalization, and the generic-MIME fallback set — derives from the
// document format registry in lib/document/mime.ts, the single source of
// truth shared with the classic upload path, so the two gates cannot drift
// (#1589). What stays policy in this module is WHICH formats the workbench
// accepts: a fixed, extractor-independent list, unlike the classic path's
// provider-scoped whitelist.
import {
  DOCUMENT_MIME_TYPES,
  getExtensionsForMimes,
  normalizeDocumentMimeType,
} from '@/lib/document/mime';

/** Registry format ids the workbench accepts. */
const WORKBENCH_MATERIAL_FORMAT_IDS = [
  'pdf',
  'pptx',
  'docx',
  'xlsx',
  'png',
  'jpeg',
  'webp',
  'txt',
  'markdown',
  'csv',
  'mp4',
  'mov',
  'webm',
  'mp3',
  'wav',
  'm4a',
  'aac',
] as const;

/**
 * Accepted media MIME with no registry format of its own: `.webm` resolves to
 * `video/webm`, so `audio/webm` has no extension to register under.
 */
const WORKBENCH_EXTRA_MEDIA_MIMES = ['audio/webm'] as const;

export const WORKBENCH_MATERIAL_MIME_TYPES: readonly string[] = [
  ...WORKBENCH_MATERIAL_FORMAT_IDS.map((id) => DOCUMENT_MIME_TYPES[id]),
  ...WORKBENCH_EXTRA_MEDIA_MIMES,
];

export const WORKBENCH_MATERIAL_EXTENSIONS: readonly string[] = getExtensionsForMimes(
  WORKBENCH_MATERIAL_MIME_TYPES,
).map((extension) => `.${extension}`);

export const WORKBENCH_MATERIAL_ACCEPT = [
  ...WORKBENCH_MATERIAL_EXTENSIONS,
  ...WORKBENCH_MATERIAL_MIME_TYPES,
  // Real browser-reported aliases of whitelisted formats; the gate
  // normalizes them anyway — listing them here just pre-filters the OS
  // file picker.
  'audio/x-m4a',
  'audio/x-wav',
].join(',');

/** Media (audio/video) formats among the accepted set. */
const WORKBENCH_MEDIA_FORMAT_IDS = ['mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'aac'] as const;

/** The upload route splits its media/document byte limit on this set. */
export const MEDIA_MIME_TYPES: readonly string[] = [
  ...WORKBENCH_MEDIA_FORMAT_IDS.map((id) => DOCUMENT_MIME_TYPES[id]),
  ...WORKBENCH_EXTRA_MEDIA_MIMES,
];

const MIME_SET = new Set<string>(WORKBENCH_MATERIAL_MIME_TYPES);

/**
 * Resolve a (mimeType, fileName) pair to the MIME the material API should
 * gate and store on — the shared document-path normalization (see
 * `normalizeDocumentMimeType`): a missing or generic MIME (octet-stream,
 * zip-family, the generic Office container some Linux browsers report for
 * OOXML — #1497) falls back to the extension's canonical MIME; curated
 * aliases map to their canonical form; anything else is returned verbatim so
 * the whitelist can reject it — the extension must not let
 * `application/x-unknown` masquerade as a supported type.
 */
export function resolveWorkbenchMaterialMime(input: {
  mimeType?: string | null;
  fileName?: string | null;
}): string {
  return normalizeDocumentMimeType(input);
}

export function isWorkbenchMaterialMime(mime: string): boolean {
  return MIME_SET.has(normalizeDocumentMimeType({ mimeType: mime }));
}
