/**
 * Self-hosted PaddleOCR document parsing (PaddleX serving).
 *
 * The layout-parsing pipeline is served by PaddleX's basic serving: one
 * `POST /layout-parsing` call with a JSON body whose `file` is the document
 * as a base64 string (or a URL the server can reach — not used here, a
 * caller-supplied URL would be an SSRF vector), `fileType: 0` marking a PDF.
 * The answer is synchronous: `result.layoutParsingResults` carries one entry
 * per page with `markdown: { text, images }`.
 *
 * PaddleX serving defaults to a 10-page cap per PDF; lifting it is a serving
 * configuration change (`Serving.extra.max_num_input_imgs`), not a client
 * option, so nothing here can or should work around it.
 */

import { extractPaddleLayoutParsing } from './paddleocr-parser';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import type { PDFParserConfig } from './types';
import { createLogger } from '@/lib/logger';
import {
  isRejectedRedirectError,
  providerFetch,
  type ProviderFetchPolicy,
} from '@/lib/server/provider-fetch';

const log = createLogger('PaddleOCR');

export const PADDLEOCR_DEFAULT_BASE = 'http://localhost:8080';

export const PADDLEOCR_CONNECTION_FAILED =
  'Cannot connect to the self-hosted PaddleOCR server, please check the Base URL';
export const PADDLEOCR_INVALID_RESPONSE =
  'The self-hosted PaddleOCR server returned an invalid response';

function selfHostedPaddlePolicy(managed: boolean | undefined): ProviderFetchPolicy {
  return { allowLocalNetworks: managed ? true : undefined, rejectRedirects: true };
}

const PADDLE_REQUEST_TIMEOUT_MS = 120_000;

class PADDLE_NO_MARKDOWN extends Error {
  constructor() {
    super('PaddleOCR returned results without markdown; unsupported pipeline');
    this.name = 'PaddleNoMarkdownError';
  }
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}

export async function parseWithPaddleOCR(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
  options?: { mimeType?: string },
): Promise<ParsedPdfContent> {
  if (!config.baseUrl) {
    throw new Error(
      'PaddleOCR base URL is required. ' +
        'Please deploy PaddleOCR via PaddleX serving locally or specify the server URL. ' +
        'See: https://github.com/PaddlePaddle/PaddleX',
    );
  }

  log.info(`[PaddleOCR] Parsing document with PaddleX serving: ${config.baseUrl}`);

  let response: Response;
  try {
    response = await providerFetch(
      `${config.baseUrl.replace(/\/+$/, '')}/layout-parsing`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file: pdfBuffer.toString('base64'),
          // 0 = PDF, 1 = image (PaddleX's own contract).
          fileType: options?.mimeType && options.mimeType !== 'application/pdf' ? 1 : 0,
          // Visualization images are debug overlays; skipping them keeps the
          // response small (documented for PP-StructureV3 / PaddleOCR-VL).
          visualize: false,
        }),
        signal: requestSignal(PADDLE_REQUEST_TIMEOUT_MS, config.signal),
      },
      selfHostedPaddlePolicy(config.managed),
    );
  } catch (error) {
    if (isRejectedRedirectError(error)) throw error;
    log.error('[PaddleOCR] Request to the self-hosted server failed:', error);
    const wrapped = new Error(PADDLEOCR_CONNECTION_FAILED, { cause: error });
    // The owner worker's retry classifier reads the top-level code/name:
    // preserve the transient signal (ECONNRESET, AbortError, ...) through
    // the friendly wrapper so a temporary outage stays retryable.
    const source = error as { code?: unknown; name?: unknown };
    if (typeof source.code === 'string') (wrapped as { code?: unknown }).code = source.code;
    if (source.name === 'AbortError') wrapped.name = 'AbortError';
    throw wrapped;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    log.error(
      `[PaddleOCR] layout-parsing failed [status=${response.status}]: ${errorText.slice(0, 500)}`,
    );
    throw new Error(`PaddleOCR parsing failed (${response.status}): ${errorText.slice(0, 300)}`);
  }

  let json: {
    errorCode?: number;
    errorMsg?: string;
    result?: { layoutParsingResults?: unknown };
  };
  try {
    json = await response.json();
  } catch (error) {
    log.error('[PaddleOCR] layout-parsing returned a non-JSON body:', error);
    throw new Error(PADDLEOCR_INVALID_RESPONSE, { cause: error });
  }

  if (typeof json.errorCode === 'number' && json.errorCode !== 0) {
    throw new Error(`PaddleOCR parsing failed: ${json.errorMsg || `errorCode ${json.errorCode}`}`);
  }

  const results = json.result?.layoutParsingResults;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('PaddleOCR returned no results');
  }
  // The layout-parsing pipelines that document parsing runs on always include
  // the markdown field; a result without it means an unexpected pipeline.
  if (results.some((r) => !(r as { markdown?: unknown })?.markdown)) {
    throw new PADDLE_NO_MARKDOWN();
  }

  return extractPaddleLayoutParsing(results);
}
