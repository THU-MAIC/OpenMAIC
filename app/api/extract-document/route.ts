import { NextRequest, NextResponse } from 'next/server';
import { getDocumentExtractorProvider, getMediaExtractorProvider } from '@/lib/document';
import {
  resolveExtractionServices,
  type ExtractionServices,
} from '@/lib/server/material-extraction/services';
import { mediaResolutionResponse } from '@/lib/server/model-config/media';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import { normalizeDocumentMimeType, SUPPORTED_MEDIA_MIME_TYPES } from '@/lib/document/mime';
import { createLogger } from '@/lib/logger';
import {
  resolveServerAsset,
  type ServerAssetResolution,
} from '@/lib/persistence/resolve-server-asset';
import { attachOwnerCookies } from '@/lib/server/identity/with-owner';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  analyzeMaterial,
  type MaterialAnalysisRefusal,
  type MaterialExtractorRequest,
  type MaterialSource,
} from '@/lib/server/generation/steps/material-analysis';

// The asset-id path resolves bytes from the server asset store, which lives in
// the PostgreSQL persistence backend; it needs the Node runtime, not the edge.
export const runtime = 'nodejs';

const log = createLogger('Extract Document');

/** JSON body for the asset-id form: an asset id plus the same provider config. */
interface AssetIdExtractRequest extends MaterialExtractorRequest {
  assetId?: string;
  fileName?: string;
  mimeType?: string;
}

/** String-only fields the JSON path accepts; wrong types are a 400, not a 500. */
const ASSET_ID_EXTRACT_STRING_FIELDS = [
  'fileName',
  'mimeType',
  'providerId',
  'apiKey',
  'baseUrl',
  'accessKeyId',
  'accessKeySecret',
] as const;

/** Mutable logging context shared with the material analysis step. */
interface ExtractLogState {
  fileName?: string;
  resolvedProviderId?: string;
}

/** How each material analysis refusal answers. */
const REFUSAL_RESPONSES: Record<MaterialAnalysisRefusal, [ApiErrorCode, number]> = {
  'provider-cannot-extract': ['INVALID_REQUEST', 400],
  'unknown-provider': ['INVALID_REQUEST', 400],
  'unsupported-type': ['INVALID_REQUEST', 400],
  'endpoint-refused': ['INVALID_URL', 403],
  'no-content': ['PARSE_FAILED', 422],
  'service-required': ['INVALID_REQUEST', 422],
};

/**
 * JSON-path-only pre-validation of a requested provider, run BEFORE the shared
 * extraction. The media branch stays pre-blocked, and so does an unknown
 * document provider: both answer a 400 with a generic static message that
 * never echoes the caller's provider id or MIME type, making the shared path's
 * echoing 400s unreachable from the asset-id form. A known document provider
 * that does not support the effective MIME type is NOT pre-blocked: it is a
 * hint, exactly like multipart, and the shared `analyzeMaterial` auto-selects a
 * compatible provider (that path does not echo caller input). The multipart
 * byte form is untouched and keeps its behavior exactly.
 */
function validateJsonPathProvider(
  providerId: string | undefined,
  mimeType: string,
): NextResponse | null {
  if (!providerId) return null;
  if (SUPPORTED_MEDIA_MIME_TYPES.includes(mimeType)) {
    const mediaProvider = getMediaExtractorProvider(providerId);
    if (!mediaProvider || !mediaProvider.supportedMimeTypes.includes(mimeType)) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'The requested extractor cannot process this course material.',
      );
    }
    return null;
  }
  // Document MIME: reject only a provider that does not exist in the document
  // registry (the shared path would echo its id). A known provider that does
  // not support the MIME passes through so `analyzeMaterial` auto-selects.
  if (!getDocumentExtractorProvider(providerId)) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'The requested document extractor cannot process this course material.',
    );
  }
  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const ownerCookies: OwnerCookies = {};
  // The asset-id form resolves the request owner: every answer after that,
  // success or error, carries the resolution's cookies (the anonymous
  // owner's renewal).
  return attachOwnerCookies(await extract(req, ownerCookies), ownerCookies.setCookies);
}

/** Filled in once the asset-id form has resolved the request owner. */
interface OwnerCookies {
  setCookies?: readonly string[];
}

async function extract(req: NextRequest, ownerCookies: OwnerCookies): Promise<Response> {
  const logState: ExtractLogState = {};
  // Whether this request took the asset-id (JSON) form. The multipart byte
  // form's observable behavior is frozen; a few JSON-path-only responses use
  // this to stay generic (no caller input or raw extractor text echoed).
  let isAssetIdForm = false;
  try {
    const contentType = req.headers.get('content-type') || '';
    let source: MaterialSource;
    let requestConfig: MaterialExtractorRequest;

    if (contentType.includes('multipart/form-data')) {
      // Legacy byte form: the client uploads the original bytes, used by
      // browser-backed (self-deploy) pools where the server cannot resolve a
      // browser-side asset.
      const formData = await req.formData();
      const documentFile = (formData.get('file') || formData.get('pdf')) as File | null;
      requestConfig = {
        providerId: (formData.get('providerId') as string | null) ?? undefined,
        apiKey: (formData.get('apiKey') as string | null) ?? undefined,
        baseUrl: (formData.get('baseUrl') as string | null) ?? undefined,
        accessKeyId: (formData.get('accessKeyId') as string | null) ?? undefined,
        accessKeySecret: (formData.get('accessKeySecret') as string | null) ?? undefined,
      };

      if (!documentFile) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'No course material file provided');
      }

      logState.fileName = documentFile.name;
      const mimeType = normalizeDocumentMimeType({
        mimeType: documentFile.type,
        fileName: documentFile.name,
      });
      if (!mimeType) {
        return apiError(
          'INVALID_REQUEST',
          400,
          `Unsupported course material type for "${documentFile.name}"`,
        );
      }
      if (documentFile.size > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
        return apiError(
          'INVALID_REQUEST',
          413,
          `Course material file is too large. Maximum size is ${Math.floor(
            MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024,
          )}MB.`,
        );
      }

      source = {
        fileName: documentFile.name,
        fileSize: documentFile.size,
        mimeType,
        buffer: Buffer.from(await documentFile.arrayBuffer()),
      };
    } else if (contentType.includes('application/json')) {
      // Asset-id form: the client names the pool asset allocated at upload and
      // the server resolves the bytes from the server asset store. Only used
      // when the deployment's pool is server-backed; the browser-backed
      // client never sends this shape.
      isAssetIdForm = true;
      let body: AssetIdExtractRequest;
      try {
        body = (await req.json()) as AssetIdExtractRequest;
      } catch {
        return apiError('INVALID_REQUEST', 400, 'Invalid JSON body for asset-id extraction.');
      }

      // A parsed JSON body that is not a plain object (null, array, string,
      // number) must not fall through to field access — that would throw a raw
      // TypeError before the first guard. It is a malformed request, not a
      // server error; the message stays generic and static.
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return apiError('INVALID_REQUEST', 400, 'Invalid request body for asset-id extraction');
      }

      // Validate the body's field types before use: a wrong-typed field is a
      // malformed request, not a server error. The 400 stays generic — never
      // echo the offending value back to the caller.
      if (typeof body.assetId !== 'string' || body.assetId.length === 0) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'No asset id provided');
      }
      for (const field of ASSET_ID_EXTRACT_STRING_FIELDS) {
        const value = (body as unknown as Record<string, unknown>)[field];
        if (value !== undefined && typeof value !== 'string') {
          return apiError('INVALID_REQUEST', 400, 'Invalid request body for asset-id extraction');
        }
      }

      let resolution: ServerAssetResolution;
      try {
        resolution = await resolveServerAsset(
          body.assetId,
          req,
          MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES,
        );
        ownerCookies.setCookies = resolution.setCookies;
      } catch (error) {
        // A failure from the server asset store (DB outage, registry failure)
        // must not reach the client as raw `error.message`; log the real error
        // server-side only and answer a fixed generic 500.
        log.error('Failed to resolve course material asset from the server store:', error);
        return apiError(
          'INTERNAL_ERROR',
          500,
          'The server asset store is unavailable. Please try again later.',
        );
      }
      if (resolution.status === 'unconfigured') {
        return apiError(
          'INVALID_REQUEST',
          503,
          'Server persistence is not configured; asset-id extraction requires a server-backed asset pool.',
        );
      }
      if (resolution.status === 'unauthenticated') {
        return apiError(
          'UNAUTHENTICATED',
          401,
          'Asset-id extraction requires a valid owner credential.',
        );
      }
      if (resolution.status === 'missing') {
        return apiError(
          'ASSET_NOT_FOUND',
          404,
          'No course material asset was found for the requested asset id.',
        );
      }
      if (resolution.status === 'too_large') {
        // The asset store reported the recorded byte length above the cap
        // before materializing the bytes; reject without ever reading them.
        return apiError(
          'INVALID_REQUEST',
          413,
          `Course material file is too large. Maximum size is ${Math.floor(
            MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024,
          )}MB.`,
        );
      }

      // The client carries the original display name and normalized MIME type
      // in the session; the asset store records only the blob MIME type, so
      // the request values win and the recorded type is the fallback.
      const fileName = body.fileName || 'document';
      logState.fileName = fileName;
      const mimeType = normalizeDocumentMimeType({
        mimeType: body.mimeType ?? resolution.mimeType,
        fileName,
      });
      if (!mimeType) {
        return apiError('INVALID_REQUEST', 400, 'Unsupported course material type.');
      }
      // JSON-path-only pre-validation: an unknown provider (or a provider that
      // cannot handle a media MIME) is pre-blocked with a generic 400 — the
      // shared path's echoing 400s for these cases are unreachable from the
      // asset-id form. A known document provider that does not support the MIME
      // is passed through as a hint, exactly like multipart (see
      // `validateJsonPathProvider`); multipart keeps its behavior exactly.
      const providerValidationError = validateJsonPathProvider(body.providerId, mimeType);
      if (providerValidationError) return providerValidationError;
      if (resolution.buffer.length > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
        return apiError(
          'INVALID_REQUEST',
          413,
          `Course material file is too large. Maximum size is ${Math.floor(
            MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024,
          )}MB.`,
        );
      }

      source = {
        fileName,
        fileSize: resolution.buffer.length,
        mimeType,
        buffer: resolution.buffer,
      };
      requestConfig = {
        providerId: body.providerId,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        accessKeyId: body.accessKeyId,
        accessKeySecret: body.accessKeySecret,
      };
    } else {
      log.error('Invalid Content-Type for document upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data or application/json, got "${contentType}"`,
      );
    }

    // The document and speech services of the request's workspace (slots).
    // A request's own workspace: never forwarded through a claim.
    let services: ExtractionServices;
    try {
      services = await resolveExtractionServices((await requestWorkspaceId(req)) ?? undefined, {
        forward: false,
      });
    } catch (error) {
      const refused = mediaResolutionResponse(error, 'Document extraction');
      if (refused) return refused;
      throw error;
    }
    try {
      const data = await analyzeMaterial(
        {
          source,
          services,
          request: requestConfig,
          redactCallerInput: isAssetIdForm,
          trace: logState,
        },
        { log },
      );
      return apiSuccess({ data });
    } catch (error) {
      if (!(error instanceof StepRefusal)) throw error;
      const [code, status] = REFUSAL_RESPONSES[error.reason as MaterialAnalysisRefusal];
      return apiError(code, status, error.message);
    }
  } catch (error) {
    log.error(
      `Document extraction failed [provider=${logState.resolvedProviderId ?? 'unknown'}, file="${sanitizeLogValue(
        logState.fileName ?? 'unknown',
      )}"]:`,
      error,
    );
    if (isAssetIdForm) {
      // The asset-id form must not leak raw extractor internals to the caller
      // (a provider outage, a malformed upstream response, …); answer a fixed
      // generic message. Multipart keeps its current behavior exactly.
      return apiError(
        'PARSE_FAILED',
        500,
        'The course material could not be parsed. Please try again later.',
      );
    }
    return apiError('PARSE_FAILED', 500, error instanceof Error ? error.message : 'Unknown error');
  }
}

/** Strip line-breaking control characters from caller-controlled log values. */
function sanitizeLogValue(value: string): string {
  return value.replaceAll('\r', ' ').replaceAll('\n', ' ');
}
