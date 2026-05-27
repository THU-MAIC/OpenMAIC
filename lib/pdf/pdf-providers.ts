/**
 * PDF Parsing Provider Implementation
 *
 * Factory pattern for routing PDF parsing requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - unpdf: Built-in Node.js PDF parser with text and image extraction
 * - MinerU: Advanced commercial service with OCR, formula, and table extraction
 *   (https://mineru.ai or self-hosted)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to PDFProviderId in lib/pdf/types.ts
 *    Example: | 'tesseract-ocr'
 *
 * 2. Add provider configuration to lib/pdf/constants.ts
 *    Example:
 *    'tesseract-ocr': {
 *      id: 'tesseract-ocr',
 *      name: 'Tesseract OCR',
 *      requiresApiKey: false,
 *      icon: '/tesseract.svg',
 *      features: ['text', 'images', 'ocr']
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function parseWithXxx(config, pdfBuffer): Promise<ParsedPdfContent>
 *    - Accept PDF as Buffer
 *    - Extract text, images, tables, formulas as needed
 *    - Return unified format:
 *      {
 *        text: string,               // Markdown or plain text
 *        images: string[],           // Base64 data URLs
 *        metadata: {
 *          pageCount: number,
 *          parser: string,
 *          ...                       // Provider-specific metadata
 *        }
 *      }
 *
 *    Example:
 *    async function parseWithTesseractOCR(
 *      config: PDFParserConfig,
 *      pdfBuffer: Buffer
 *    ): Promise<ParsedPdfContent> {
 *      const { createWorker } = await import('tesseract.js');
 *
 *      // Convert PDF pages to images
 *      const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
 *      const numPages = pdf.numPages;
 *
 *      const texts: string[] = [];
 *      const images: string[] = [];
 *
 *      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
 *        // Render page to canvas/image
 *        const page = await pdf.getPage(pageNum);
 *        const viewport = page.getViewport({ scale: 2.0 });
 *        const canvas = createCanvas(viewport.width, viewport.height);
 *        const context = canvas.getContext('2d');
 *        await page.render({ canvasContext: context, viewport }).promise;
 *
 *        // OCR the image
 *        const worker = await createWorker('eng+chi_sim');
 *        const { data: { text } } = await worker.recognize(canvas.toBuffer());
 *        texts.push(text);
 *        await worker.terminate();
 *
 *        // Save image
 *        images.push(canvas.toDataURL());
 *      }
 *
 *      return {
 *        text: texts.join('\n\n'),
 *        images,
 *        metadata: {
 *          pageCount: numPages,
 *          parser: 'tesseract-ocr',
 *        },
 *      };
 *    }
 *
 * 4. Add case to parsePDF() switch statement
 *    case 'tesseract-ocr':
 *      result = await parseWithTesseractOCR(config, pdfBuffer);
 *      break;
 *
 * 5. Add i18n translations in lib/i18n.ts
 *    providerTesseractOCR: { zh: 'Tesseract OCR', en: 'Tesseract OCR' }
 *
 * 6. Update features in constants.ts to reflect parser capabilities
 *    features: ['text', 'images', 'ocr'] // OCR-capable
 *
 * Provider Implementation Patterns:
 *
 * Pattern 1: Local Node.js Parser (like unpdf)
 * - Import parsing library
 * - Process Buffer directly
 * - Extract text and images synchronously or asynchronously
 * - Convert images to base64 data URLs
 * - Return immediately
 *
 * Pattern 2: Remote API (like MinerU)
 * - Upload PDF or provide URL
 * - Create task and get task ID
 * - Poll for completion (with timeout)
 * - Download results (text, images, metadata)
 * - Parse and convert to unified format
 *
 * Pattern 3: OCR-based Parser (Tesseract, Google Vision)
 * - Render PDF pages to images
 * - Send images to OCR service
 * - Collect text from all pages
 * - Combine with layout analysis if available
 * - Return combined text and original images
 *
 * Image Extraction Best Practices:
 * - Always convert to base64 data URLs (data:image/png;base64,...)
 * - Use PNG for lossless quality
 * - Use sharp for efficient image processing
 * - Handle errors per image (don't fail entire parsing)
 * - Log extraction failures but continue processing
 *
 * Metadata Recommendations:
 * - pageCount: Number of pages in PDF
 * - parser: Provider ID for debugging
 * - processingTime: Time taken (auto-added)
 * - taskId/jobId: For async providers (useful for troubleshooting)
 * - Custom fields: imageMapping, pdfImages, tables, formulas, etc.
 *
 * Error Handling:
 * - Validate API key if requiresApiKey is true
 * - Throw descriptive errors for missing configuration
 * - For async providers, handle timeout and polling errors
 * - Log warnings for non-critical failures (e.g., single page errors)
 * - Always include provider name in error messages
 */

import { extractText, getDocumentProxy, extractImages } from 'unpdf';
import sharp from 'sharp';
import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { PDF_PROVIDERS } from './constants';
import { createLogger } from '@/lib/logger';
import { extractMinerUResult } from './mineru-parser';
import { parseWithMinerUCloud } from './mineru-cloud';

const log = createLogger('PDFProviders');

/**
 * Parse PDF using specified provider
 */
export async function parsePDF(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
): Promise<ParsedPdfContent> {
  const provider = PDF_PROVIDERS[config.providerId];
  if (!provider) {
    throw new Error(`Unknown PDF provider: ${config.providerId}`);
  }

  // Validate API key if required
  if (provider.requiresApiKey && !config.apiKey) {
    throw new Error(`API key required for PDF provider: ${config.providerId}`);
  }

  const startTime = Date.now();

  let result: ParsedPdfContent;

  switch (config.providerId) {
    case 'unpdf':
      result = await parseWithUnpdf(pdfBuffer);
      break;

    case 'mineru':
      result = await parseWithMinerU(config, pdfBuffer);
      break;

    case 'mineru-cloud':
      result = await parseWithMinerUCloud(config, pdfBuffer);
      break;

    default:
      throw new Error(`Unsupported PDF provider: ${config.providerId}`);
  }

  // Add processing time to metadata
  if (result.metadata) {
    result.metadata.processingTime = Date.now() - startTime;
  }

  return result;
}

/**
 * Parse PDF using unpdf (existing implementation)
 */
async function parseWithUnpdf(pdfBuffer: Buffer): Promise<ParsedPdfContent> {
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdf = await getDocumentProxy(uint8Array);
  const numPages = pdf.numPages;

  // Extract text using the document proxy
  const { text: pdfText } = await extractText(pdf, {
    mergePages: true,
  });

  // Extract images using the same document proxy
  const images: string[] = [];
  const pdfImagesMeta: Array<{
    id: string;
    src: string;
    pageNumber: number;
    width: number;
    height: number;
  }> = [];
  let imageCounter = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    try {
      const pageImages = await extractImages(pdf, pageNum);
      for (let i = 0; i < pageImages.length; i++) {
        const imgData = pageImages[i];
        try {
          // Use sharp to convert raw image data to PNG base64
          const pngBuffer = await sharp(Buffer.from(imgData.data), {
            raw: {
              width: imgData.width,
              height: imgData.height,
              channels: imgData.channels,
            },
          })
            .png()
            .toBuffer();

          // Convert to base64
          const base64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
          imageCounter++;
          const imgId = `img_${imageCounter}`;
          images.push(base64);
          pdfImagesMeta.push({
            id: imgId,
            src: base64,
            pageNumber: pageNum,
            width: imgData.width,
            height: imgData.height,
          });
        } catch (sharpError) {
          log.error(`Failed to convert image ${i + 1} from page ${pageNum}:`, sharpError);
        }
      }
    } catch (pageError) {
      log.error(`Failed to extract images from page ${pageNum}:`, pageError);
    }
  }

  return {
    text: pdfText,
    images,
    metadata: {
      pageCount: numPages,
      parser: 'unpdf',
      imageMapping: Object.fromEntries(pdfImagesMeta.map((m) => [m.id, m.src])),
      pdfImages: pdfImagesMeta,
    },
  };
}

/**
 * Parse PDF using self-hosted MinerU service (mineru-api)
 *
 * Official MinerU API endpoint:
 * POST /file_parse  (multipart/form-data)
 *
 * Response format:
 * { results: { "document.pdf": { md_content, images, content_list, ... } } }
 *
 * @see https://github.com/opendatalab/MinerU
 */
async function parseWithMinerU(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
): Promise<ParsedPdfContent> {
  if (!config.baseUrl) {
    throw new Error(
      'MinerU base URL is required. ' +
        'Please deploy MinerU locally or specify the server URL. ' +
        'See: https://github.com/opendatalab/MinerU',
    );
  }

  log.info('[MinerU] Parsing PDF with MinerU server:', config.baseUrl);

  const fileName = 'document.pdf';

  // Create FormData for file upload
  const formData = new FormData();

  // Convert Buffer to Blob
  const arrayBuffer = pdfBuffer.buffer.slice(
    pdfBuffer.byteOffset,
    pdfBuffer.byteOffset + pdfBuffer.byteLength,
  );
  const blob = new Blob([arrayBuffer as ArrayBuffer], {
    type: 'application/pdf',
  });
  formData.append('files', blob, fileName);

  // MinerU API form fields
  // Defaults already: return_md=true, formula_enable=true, table_enable=true
  formData.append('parse_method', 'auto');
  // hybrid-auto-engine: best accuracy, uses VLM for layout understanding (requires GPU)
  // pipeline: basic mode, no VLM, faster but lower quality image extraction
  formData.append('backend', 'hybrid-auto-engine');
  formData.append('return_content_list', 'true');
  formData.append('return_images', 'true');

  // API key (if required by deployment)
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  // POST /file_parse
  const response = await fetch(`${config.baseUrl}/file_parse`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`MinerU API error (${response.status}): ${errorText}`);
  }

  const json = await response.json();

  // Response: { results: { "<fileName>": { md_content, images, content_list, ... } } }
  const fileResult = json.results?.[fileName];
  if (!fileResult) {
    const keys = json.results ? Object.keys(json.results) : [];
    // Try first available key in case filename doesn't match exactly
    const fallback = keys.length > 0 ? json.results[keys[0]] : null;
    if (!fallback) {
      throw new Error(`MinerU returned no results. Response keys: ${JSON.stringify(keys)}`);
    }
    log.warn(`[MinerU] Filename mismatch, using key "${keys[0]}" instead of "${fileName}"`);
    return extractMinerUResult(fallback);
  }

  return extractMinerUResult(fileResult);
}

/**
 * Get current PDF parser configuration from settings store
 * Note: This function should only be called in browser context
 */
export async function getCurrentPDFConfig(): Promise<PDFParserConfig> {
  if (typeof window === 'undefined') {
    throw new Error('getCurrentPDFConfig() can only be called in browser context');
  }

  // Dynamic import to avoid circular dependency
  const { useSettingsStore } = await import('@/lib/store/settings');
  const { pdfProviderId, pdfProvidersConfig } = useSettingsStore.getState();

  const providerConfig = pdfProvidersConfig?.[pdfProviderId];

  return {
    providerId: pdfProviderId,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
  };
}

// Re-export from constants for convenience
export { getAllPDFProviders, getPDFProvider } from './constants';
