import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import {
  isRenderOwnerBoundResponse,
  renderServiceOwnerHeaders,
  resolveRenderServiceUrl,
  withRenderOwnerResponseHeaders,
} from '@/lib/server/render-service';
import { capBodyStream } from '@/lib/server/capped-stream';
import { clientIdentity } from '@/lib/server/client-identity';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideo Render API');

/** Reject uploads larger than this (compressed ZIP bytes), enforced on real bytes. */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/** Upload-forwarding budget. Covers a large body over a slow link; the render is async. */
const SUBMIT_TIMEOUT_MS = 300_000;

/**
 * Submit an export ZIP for MP4 rendering. Streams the multipart body straight
 * to the render service (no `formData()` buffering here) and relays its
 * `202 { jobId }`. Returns 501 when the service is not configured so the client
 * can degrade to a local ZIP download.
 */
export async function POST(req: NextRequest) {
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const answer = (response: Response) =>
      withRenderOwnerResponseHeaders(response, responseHeaders);
    const resolved = resolveRenderServiceUrl();
    if ('error' in resolved) {
      return answer(apiError('PROVIDER_DISABLED', 501, 'Render service is not configured'));
    }

    // Fast-path reject an oversized body by its declared length. This is only a
    // courtesy 413 for honest clients — `Content-Length` is client-supplied and
    // omitted on chunked uploads, so the real bound is the byte-counting cap on
    // the stream below (belt-and-suspenders with the service's own archive guards).
    const contentLength = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
      return answer(apiError('INVALID_REQUEST', 413, 'Export archive is too large'));
    }

    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data') || !req.body) {
      return answer(apiError('INVALID_REQUEST', 400, 'Expected multipart/form-data'));
    }

    // Forward the raw multipart body verbatim, bounded to MAX_UPLOAD_BYTES of
    // actual bytes. We deliberately do NOT parse it; re-parsing would defeat
    // the streaming bound.
    const capped = capBodyStream(req.body, MAX_UPLOAD_BYTES);

    try {
      // Long enough for the upload of a multi-MB ZIP; the render is async.
      const upstream = await proxyFetch(`${resolved.url}/owner-bound/render`, {
        method: 'POST',
        body: capped.stream,
        // duplex is required to send a streaming request body via fetch.
        duplex: 'half',
        headers: {
          'content-type': contentType,
          'x-openmaic-client': clientIdentity(req),
          ...renderServiceOwnerHeaders(ownerId),
        },
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      } as RequestInit);
      if (!isRenderOwnerBoundResponse(upstream)) {
        return answer(
          apiError('UPSTREAM_ERROR', 502, 'Render service must be upgraded before accepting jobs'),
        );
      }

      const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
      if (!upstream.ok) {
        const detail = typeof data.error === 'string' ? data.error : upstream.statusText;
        const status = upstream.status === 429 ? 429 : upstream.status === 413 ? 413 : 502;
        const code =
          upstream.status === 429
            ? 'RATE_LIMITED'
            : upstream.status === 413
              ? 'INVALID_REQUEST'
              : 'UPSTREAM_ERROR';
        // Keep admission reasons separate from diagnostic prose so clients can
        // localize known rejections and fall back for older/newer services.
        const reason =
          upstream.status === 429 &&
          (data.reason === 'queue_full' || data.reason === 'per_identity_limit')
            ? data.reason
            : undefined;
        return answer(
          apiError(code, status, 'Render service rejected the request', detail, reason),
        );
      }

      return answer(apiSuccess({ jobId: data.jobId, pollIntervalMs: 3000 }, 202));
    } catch (error) {
      // A cap trip aborts the forwarded stream, surfacing here as a fetch error.
      if (capped.exceeded()) {
        return answer(apiError('INVALID_REQUEST', 413, 'Export archive is too large'));
      }
      log.error('Failed to submit render job:', error);
      return answer(
        apiError(
          'UPSTREAM_ERROR',
          502,
          'Failed to reach render service',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  });
}
