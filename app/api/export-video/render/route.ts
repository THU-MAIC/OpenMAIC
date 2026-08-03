import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import { capBodyStream } from '@/lib/server/capped-stream';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideo Render API');

// Only forwards the upload to the isolated render service; the render itself
// happens there, so this route stays lightweight despite large ZIP bodies. The
// budget must cover *uploading* up to MAX_UPLOAD_BYTES over a slow link (a
// 300 MB body needs ~40 Mbps to finish in 60s), not the render — so it's sized
// for the transfer, well above the old 60s.
export const maxDuration = 300;

/** Reject uploads larger than this (compressed ZIP bytes), enforced on real bytes. */
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

/** Upload-forwarding budget. Covers a large body over a slow link; the render is async. */
const SUBMIT_TIMEOUT_MS = 300_000;

/**
 * Derive a client identity for the render service's per-identity guard.
 *
 * `x-forwarded-for` / `x-real-ip` are only trustworthy when a trusted reverse
 * proxy sets them; if the app is exposed directly (as the default Compose does),
 * a client can rotate them to defeat the guard. So we only honor them when
 * `TRUST_PROXY_HEADERS=true` is set by the operator (who then must ensure a real
 * proxy overwrites the headers). Otherwise every caller collapses to a single
 * `direct` bucket — a conservative shared limit rather than a spoofable one.
 */
function clientIdentity(req: NextRequest): string {
  if (process.env.TRUST_PROXY_HEADERS !== 'true') return 'direct';
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || 'anonymous';
  return req.headers.get('x-real-ip')?.trim() || 'anonymous';
}

/**
 * Submit an export ZIP for MP4 rendering. Streams the multipart body straight
 * to the render service (no `formData()` buffering here) and relays its
 * `202 { jobId }`. Returns 501 when the service is not configured so the client
 * can degrade to a local ZIP download.
 */
export async function POST(req: NextRequest) {
  const resolved = resolveRenderServiceUrl();
  if ('error' in resolved) {
    return apiError('PROVIDER_DISABLED', 501, 'Render service is not configured');
  }

  // Fast-path reject an oversized body by its declared length. This is only a
  // courtesy 413 for honest clients — `Content-Length` is client-supplied and
  // omitted on chunked uploads, so the real bound is the byte-counting cap on
  // the stream below (belt-and-suspenders with the service's own archive guards).
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    return apiError('INVALID_REQUEST', 413, 'Export archive is too large');
  }

  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data') || !req.body) {
    return apiError('INVALID_REQUEST', 400, 'Expected multipart/form-data');
  }

  // Forward the raw multipart body verbatim, bounded to MAX_UPLOAD_BYTES of
  // actual bytes. We deliberately do NOT parse it: the render service derives
  // identity from the header below and ignores any multipart `userId`, so
  // there's nothing to strip — and re-parsing would defeat the streaming bound.
  const capped = capBodyStream(req.body, MAX_UPLOAD_BYTES);

  try {
    // Long enough for the upload of a multi-MB ZIP; the render is async.
    const upstream = await proxyFetch(`${resolved.url}/render`, {
      method: 'POST',
      body: capped.stream,
      // duplex is required to send a streaming request body via fetch.
      duplex: 'half',
      headers: {
        'content-type': contentType,
        'x-openmaic-client': clientIdentity(req),
      },
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    } as RequestInit);

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
      return apiError(code, status, 'Render service rejected the request', detail);
    }

    return apiSuccess({ jobId: data.jobId, pollIntervalMs: 3000 }, 202);
  } catch (error) {
    // A cap trip aborts the forwarded stream, surfacing here as a fetch error.
    if (capped.exceeded()) {
      return apiError('INVALID_REQUEST', 413, 'Export archive is too large');
    }
    log.error('Failed to submit render job:', error);
    return apiError(
      'UPSTREAM_ERROR',
      502,
      'Failed to reach render service',
      error instanceof Error ? error.message : String(error),
    );
  }
}
