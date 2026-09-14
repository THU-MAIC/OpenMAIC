export const MEDIA_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
] as const;

export const MEDIA_MIME_ALIASES = ['audio/x-m4a'] as const;

const MIME_ALIASES: Readonly<Record<string, string>> = {
  'audio/x-m4a': 'audio/mp4',
  'application/wps-office.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/wps-office.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/wps-office.xlsx':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function normalizeWorkbenchMaterialMime(mime: string): string {
  const normalized = mime.trim().toLowerCase();
  return MIME_ALIASES[normalized] ?? normalized;
}

// MIME strings that carry no format specificity, mirroring the document
// path's generic set (lib/document/mime.ts). On Linux, Chrome resolves
// File.type against the XDG shared-mime-info database, and older databases
// (e.g. Kylin OS V10) report every OOXML file as the generic
// `application/vnd.ms-office` container — the filename extension is the
// only signal left. (#1497)
const GENERIC_MATERIAL_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
  'application/vnd.ms-office',
]);

// Canonical MIME per accepted extension (without the leading dot), kept in
// lockstep with WORKBENCH_MATERIAL_EXTENSIONS above.
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

/**
 * Resolve a (mimeType, fileName) pair to the MIME the material API should
 * gate and store on.
 *
 * Known aliases map to their canonical form; a missing or generic MIME falls
 * back to the extension's canonical MIME. Anything else — a specific but
 * unsupported MIME — is returned verbatim so the whitelist can reject it;
 * the extension must not let `application/x-unknown` masquerade as a
 * supported type.
 */
export function resolveWorkbenchMaterialMime(input: {
  mimeType?: string | null;
  fileName?: string | null;
}): string {
  const normalized = normalizeWorkbenchMaterialMime(input.mimeType ?? '');
  if (!normalized || GENERIC_MATERIAL_MIME_TYPES.has(normalized)) {
    const extension = input.fileName?.split('.').pop()?.toLowerCase();
    const fromExtension = extension ? MIME_BY_EXTENSION[extension] : undefined;
    return fromExtension ?? normalized;
  }
  return normalized;
}

export const WORKBENCH_MATERIAL_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
  ...MEDIA_MIME_TYPES,
] as const;

export const WORKBENCH_MATERIAL_EXTENSIONS = [
  '.pdf',
  '.pptx',
  '.docx',
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.mp4',
  '.mov',
  '.webm',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
] as const;

export const WORKBENCH_MATERIAL_ACCEPT = [
  ...WORKBENCH_MATERIAL_EXTENSIONS,
  ...WORKBENCH_MATERIAL_MIME_TYPES,
  ...MEDIA_MIME_ALIASES,
].join(',');

const MIME_SET = new Set<string>(WORKBENCH_MATERIAL_MIME_TYPES);

export function isWorkbenchMaterialMime(mime: string): boolean {
  return MIME_SET.has(normalizeWorkbenchMaterialMime(mime));
}
