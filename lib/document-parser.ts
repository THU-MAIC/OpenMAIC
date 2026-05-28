/**
 * Document Parser
 * Supports: PDF, TXT, DOCX files
 */

import { createLogger } from '@/lib/logger';
import { parsePDF } from './pdf/pdf-providers';
import type { PDFParserConfig } from './pdf/types';
import type { ParsedPdfContent } from './types/pdf';

const log = createLogger('DocumentParser');

export type DocumentType = 'pdf' | 'txt' | 'docx';

export interface DocumentParserConfig extends PDFParserConfig {
  documentType: DocumentType;
}

/**
 * Detect document type from MIME type or file extension
 */
export function detectDocumentType(file: File): DocumentType {
  const mimeType = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  if (mimeType === 'text/plain' || name.endsWith('.txt')) return 'txt';
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword' ||
    name.endsWith('.docx') ||
    name.endsWith('.doc')
  )
    return 'docx';
  if (mimeType === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';

  // Fallback: try to infer from extension
  if (name.endsWith('.txt')) return 'txt';
  if (name.endsWith('.docx') || name.endsWith('.doc')) return 'docx';
  if (name.endsWith('.pdf')) return 'pdf';

  throw new Error(`Unsupported document type: ${mimeType} (${file.name})`);
}

/**
 * Parse a document file (PDF, TXT, or DOCX)
 */
export async function parseDocument(
  file: File,
  buffer: Buffer,
  config: DocumentParserConfig,
): Promise<ParsedPdfContent> {
  const documentType = config.documentType || detectDocumentType(file);

  log.info(`Parsing document: ${file.name}, type: ${documentType}, size: ${file.size} bytes`);

  switch (documentType) {
    case 'txt':
      return parseTxt(buffer, file);
    case 'docx':
      return parseDocx(buffer, file);
    case 'pdf':
      return parsePDF(config, buffer);
    default:
      throw new Error(`Unsupported document type: ${documentType}`);
  }
}

/**
 * Parse TXT file - simple text extraction
 */
function parseTxt(buffer: Buffer, file: File): ParsedPdfContent {
  const text = buffer.toString('utf-8');

  return {
    text,
    images: [],
    metadata: {
      pageCount: 1,
      parser: 'txt',
      fileName: file.name,
      fileSize: file.size,
    },
  };
}

/**
 * Parse DOCX file using mammoth
 */
async function parseDocx(buffer: Buffer, file: File): Promise<ParsedPdfContent> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });

  return {
    text: result.value,
    images: [],
    metadata: {
      pageCount: 1, // DOCX doesn't have a direct page count concept
      parser: 'docx',
      fileName: file.name,
      fileSize: file.size,
    },
  };
}

export { parsePDF };
