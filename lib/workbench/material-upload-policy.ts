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

const MIME_ALIASES: Readonly<Record<string, (typeof MEDIA_MIME_TYPES)[number]>> = {
  'audio/x-m4a': 'audio/mp4',
};

export function normalizeWorkbenchMaterialMime(mime: string): string {
  const normalized = mime.trim().toLowerCase();
  return MIME_ALIASES[normalized] ?? normalized;
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

const WORKBENCH_MATERIAL_EXTENSIONS = [
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
