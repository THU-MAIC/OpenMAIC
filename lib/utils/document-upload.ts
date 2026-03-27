const TEXT_DOCUMENT_EXTENSIONS = ['md', 'markdown', 'txt'] as const;

export const SUPPORTED_DOCUMENT_ACCEPT = ['.pdf', '.md', '.txt', '.markdown'].join(',');

export type SupportedDocumentType = 'pdf' | 'text';

export function getSupportedDocumentType(
  file: Pick<File, 'name' | 'type'>,
): SupportedDocumentType | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  if ((TEXT_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return 'text';
  }

  if (ext === 'pdf' || file.type === 'application/pdf') {
    return 'pdf';
  }

  return null;
}

export async function readTextFileContent(file: Blob): Promise<string> {
  return file.text();
}
