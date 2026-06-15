import { DOCUMENT_MIME_TYPES } from '../mime';
import type { DocumentExtractorProvider } from '../types';

const TEXT_MIME_TYPES = [DOCUMENT_MIME_TYPES.txt, DOCUMENT_MIME_TYPES.markdown, 'text/x-markdown'];

function textDecoderForMimeType(mimeType: string, buffer: Buffer): TextDecoder {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le');
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8');
  }

  const charset = mimeType.match(/charset=([^;]+)/i)?.[1]?.trim();
  try {
    return new TextDecoder(charset || 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

export const textDocumentExtractorProvider: DocumentExtractorProvider = {
  id: 'plain-text',
  displayName: 'Plain Text',
  supportedMimeTypes: TEXT_MIME_TYPES,
  capabilities: {
    text: true,
    images: false,
    tables: false,
    formulas: false,
    layout: false,
    ocr: false,
    async: false,
  },
  async extract(input) {
    const text = textDecoderForMimeType(input.mimeType, input.buffer).decode(input.buffer);
    const isMarkdown =
      input.mimeType === DOCUMENT_MIME_TYPES.markdown || input.mimeType === 'text/x-markdown';
    return {
      metadata: {
        fileName: input.fileName,
        fileSize: input.fileSize,
        mimeType: input.mimeType,
        providerId: 'plain-text',
      },
      blocks: [
        {
          id: 'text_1',
          type: isMarkdown ? 'markdown' : 'text',
          text,
        },
      ],
      assets: [],
      diagnostics: [],
    };
  },
};
