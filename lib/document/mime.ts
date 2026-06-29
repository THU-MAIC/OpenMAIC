export const DOCUMENT_MIME_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  markdown: 'text/markdown',
} as const;

export const SUPPORTED_COURSE_MATERIAL_MIME_TYPES = [
  DOCUMENT_MIME_TYPES.pdf,
  DOCUMENT_MIME_TYPES.docx,
  DOCUMENT_MIME_TYPES.pptx,
  DOCUMENT_MIME_TYPES.txt,
  DOCUMENT_MIME_TYPES.markdown,
  'text/x-markdown',
] as const;

export const COURSE_MATERIAL_ACCEPT = [
  '.pdf',
  '.docx',
  '.pptx',
  '.txt',
  '.md',
  '.markdown',
  ...SUPPORTED_COURSE_MATERIAL_MIME_TYPES,
].join(',');

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: DOCUMENT_MIME_TYPES.pdf,
  docx: DOCUMENT_MIME_TYPES.docx,
  pptx: DOCUMENT_MIME_TYPES.pptx,
  txt: DOCUMENT_MIME_TYPES.txt,
  md: DOCUMENT_MIME_TYPES.markdown,
  markdown: DOCUMENT_MIME_TYPES.markdown,
};

const GENERIC_DOCUMENT_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
]);

export function normalizeDocumentMimeType(input: {
  mimeType?: string | null;
  fileName?: string | null;
}): string {
  const mimeType = input.mimeType?.split(';')[0]?.trim().toLowerCase();
  const extension = input.fileName?.split('.').pop()?.toLowerCase();
  const mimeTypeFromExtension = extension ? MIME_BY_EXTENSION[extension] : undefined;

  if (mimeTypeFromExtension && (!mimeType || GENERIC_DOCUMENT_MIME_TYPES.has(mimeType))) {
    return mimeTypeFromExtension;
  }

  if (mimeType) {
    if (mimeType === 'text/x-markdown') return DOCUMENT_MIME_TYPES.markdown;
    return mimeType;
  }

  return mimeTypeFromExtension || '';
}

export function isSupportedCourseMaterial(input: {
  mimeType?: string | null;
  fileName?: string | null;
}): boolean {
  const normalized = normalizeDocumentMimeType(input);
  return SUPPORTED_COURSE_MATERIAL_MIME_TYPES.includes(
    normalized as (typeof SUPPORTED_COURSE_MATERIAL_MIME_TYPES)[number],
  );
}
