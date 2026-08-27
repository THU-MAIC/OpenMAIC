/**
 * /api/materials — the workbench's material list and upload face.
 *
 * The uploader (`uploadWorkbenchMaterial` in `lib/workbench/session-store.ts`)
 * is OWNER-scoped: it posts a file with no session id and expects the flat
 * `{ materialId, originalName, bytes, mime, extraction }` 201 view. This route
 * implements the reference's upload contract on the owner-scoped material
 * library (`lib/persistence/owner-materials.ts`) with the host's asset
 * registry for the bytes.
 *
 * ## Upload contract (the reference's)
 *
 * - `content-type` is the MIME type; it is normalized and validated against
 *   the workbench policy — an unsupported type answers 415.
 * - `x-material-filename` is the display name (required).
 * - Size caps are per class: media (audio/video) uploads cap at
 *   `maxUploadBytes`, documents/images at `min(maxDocumentBytes,
 *   maxUploadBytes)` — both 413 when exceeded, checked on the declared
 *   `content-length` AND on the streamed body.
 * - Lifecycle: the upload reclaims crashed `uploading` leftovers older than
 *   24 hours (their asset entries first, then the reservations), reserves a
 *   quota-checked `uploading` row (429 when the owner's count or byte quota is
 *   exceeded), streams the bytes through a sha256 meter into the asset
 *   registry, records the returned asset id onto the reservation in its own
 *   durable step, and finalizes the row to `ready` with the digest. Failures
 *   abandon the reservation; crash leftovers are reclaimed by the next
 *   upload's 24-hour sweep.
 * - Every response echoes the `x-request-id` header so the uploader can pair
 *   a failure with its log line.
 *
 * The configured runtime gates the family (the workbench is agent-runtime
 * territory): off, or on without a DATABASE_URL, answers the same plain 404.
 */
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { createMaterialId } from '@openmaic/storage';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import {
  resolveOwnedSession,
  listSessionMaterials,
  publicMaterialView,
} from '@/lib/server/agent-runtime/session-materials';
import {
  abandonOwnerMaterial,
  finalizeOwnerMaterial,
  MaterialQuotaExceededError,
  publicMaterial,
  reclaimStaleOwnerMaterialUploads,
  recordOwnerMaterialAsset,
  registerOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  isWorkbenchMaterialMime,
  MEDIA_MIME_TYPES,
  normalizeWorkbenchMaterialMime,
} from '@/lib/workbench/material-upload-policy';

export const runtime = 'nodejs';

const DOCUMENT_UPLOAD_LIMIT = Math.min(
  agentRuntimeConfig.maxDocumentBytes,
  agentRuntimeConfig.maxUploadBytes,
);
const MEDIA_MIME_SET = new Set<string>(MEDIA_MIME_TYPES);

/** The store's keyset-paging ceiling (default 50, capped at 200). */
export const MAX_MATERIAL_LIST_LIMIT = 200;

class MaterialPayloadTooLarge extends Error {}

/** The `x-material-filename` header, sanitized to a bare file name. */
function materialFilename(req: NextRequest): string | null {
  const raw = req.headers.get('x-material-filename');
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Preserve a plain header value; malformed percent escapes are not paths.
  }
  const name = basename(decoded.replace(/\\/g, '/')).trim().slice(0, 512);
  return name || null;
}

function materialUploadRequestId(req: NextRequest): string {
  const upstream = req.headers.get('x-request-id')?.trim();
  return upstream && /^[A-Za-z0-9._:-]{1,128}$/.test(upstream) ? upstream : randomUUID();
}

/** The owner's asset-registry partition for uploaded material bytes. */
function ownerMaterialPrincipal(ownerId: string) {
  return { key: `owner-materials:${ownerId}` };
}

function parseLimit(raw: string | null): { limit?: number } | { invalid: true } {
  if (raw === null || raw === '') return {};
  if (!/^\d+$/.test(raw)) return { invalid: true };
  const parsed = Number(raw);
  if (parsed < 1 || parsed > MAX_MATERIAL_LIST_LIMIT) return { invalid: true };
  return { limit: parsed };
}

// GET /api/materials?sessionId=&limit=&before= — list one owned session's
// materials, newest first, keyset-paged (the agent-tools list surface).
export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId is required');

  const parsedLimit = parseLimit(url.searchParams.get('limit'));
  if ('invalid' in parsedLimit) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `limit must be an integer between 1 and ${MAX_MATERIAL_LIST_LIMIT}`,
    );
  }
  const before = url.searchParams.get('before')?.trim() || undefined;

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const session = await resolveOwnedSession(sessionId, ownerId);
    if (!session) return ownerNotFound(responseHeaders);
    const materials = await listSessionMaterials(sessionId, {
      ...(parsedLimit.limit === undefined ? {} : { limit: parsedLimit.limit }),
      ...(before ? { before } : {}),
    });
    return ownerJson(
      { materials: materials.map((material) => publicMaterialView(material)) },
      200,
      responseHeaders,
    );
  });
}

// POST /api/materials — upload a source file into the caller's durable
// material library. The raw bytes ride the body; `content-type` is the MIME
// type and `x-material-filename` the display name.
export async function POST(req: NextRequest) {
  const requestId = materialUploadRequestId(req);
  const startedAt = Date.now();
  let phase = 'feature_gate';
  let materialId: string | undefined;
  let mime = '';
  let declaredBytes = 0;
  let receivedBytes = 0;
  let failureLogged = false;
  const context = (extra: Record<string, unknown> = {}) => ({
    requestId,
    phase,
    ...(materialId ? { materialId } : {}),
    ...(mime ? { mime } : {}),
    declaredBytes,
    receivedBytes,
    durationMs: Date.now() - startedAt,
    ...extra,
  });
  const reject = (response: Response, reason: string, headers: Headers) => {
    console.warn('material upload rejected', context({ status: response.status, reason }));
    response.headers.set('x-request-id', requestId);
    for (const [key, value] of headers) response.headers.append(key, value);
    return response;
  };

  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      phase = 'validate_request';
      const rawMime = (req.headers.get('content-type') ?? '').split(';', 1)[0];
      mime = normalizeWorkbenchMaterialMime(rawMime);
      if (!isWorkbenchMaterialMime(mime)) {
        return reject(
          apiError(
            'INVALID_REQUEST',
            415,
            `unsupported material mime type: ${mime || '(missing)'}`,
          ),
          'unsupported_mime',
          responseHeaders,
        );
      }
      const uploadLimit = MEDIA_MIME_SET.has(mime)
        ? agentRuntimeConfig.maxUploadBytes
        : DOCUMENT_UPLOAD_LIMIT;

      declaredBytes = Number(req.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredBytes) && declaredBytes > uploadLimit) {
        return reject(
          apiError('INVALID_REQUEST', 413, `upload exceeds ${uploadLimit} bytes`),
          'declared_body_too_large',
          responseHeaders,
        );
      }
      if (!req.body) {
        return reject(
          apiError('INVALID_REQUEST', 400, 'empty body'),
          'empty_body',
          responseHeaders,
        );
      }

      const originalName = materialFilename(req);
      if (!originalName) {
        return reject(
          apiError('MISSING_REQUIRED_FIELD', 400, 'x-material-filename header is required'),
          'missing_filename',
          responseHeaders,
        );
      }
      const createdMaterialId = createMaterialId();
      materialId = createdMaterialId;

      const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      const principal = ownerMaterialPrincipal(ownerId);

      // Browsers send Content-Length for a File body. When an intermediary
      // strips it, reserve the per-file maximum so an unmeasured stream can
      // never bypass the owner byte quota; finalize shrinks the reservation to
      // its actual size.
      const reservedBytes =
        Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : uploadLimit;

      // Reclaim uploads that crashed before finalize and are older than the
      // 24-hour horizon. Each reservation's asset entry (recorded in its own
      // durable step before finalize) is removed first; the reservation is
      // deleted only after that, so a failure here keeps the reservation for
      // the next pass instead of losing the pointer to its bytes.
      phase = 'reclaim_stale_uploads';
      await reclaimStaleOwnerMaterialUploads(
        provider.pool as unknown as ConnectableQueryable,
        ownerId,
        async (assetId) => {
          try {
            await provider.assetStore.remove(principal, assetId);
          } catch (error) {
            console.warn(
              'material stale asset removal failed; keeping its reservation for the next pass',
              context({ assetId }),
              error,
            );
            throw error;
          }
        },
      ).catch((error) => {
        console.warn(
          'material stale-upload reclaim failed; retrying on the next upload',
          context(),
          error,
        );
      });

      phase = 'reserve_material';
      try {
        await registerOwnerMaterial(
          provider.pool as unknown as ConnectableQueryable,
          {
            id: createdMaterialId,
            ownerId,
            kind: 'source',
            mime,
            bytes: reservedBytes,
            originalName,
            assetId: '',
            extraction: { status: 'idle' },
          },
          {
            maxCount: agentRuntimeConfig.maxMaterialsPerOwner,
            maxTotalBytes: agentRuntimeConfig.maxMaterialBytesPerOwner,
          },
        );
      } catch (error) {
        if (error instanceof MaterialQuotaExceededError) {
          return reject(
            apiError('INVALID_REQUEST', 429, error.message),
            'quota_exceeded',
            responseHeaders,
          );
        }
        throw error;
      }

      phase = 'store_bytes';
      // Read the body through a sha256 meter, enforcing the per-class cap on
      // the streamed size (an unmeasured stream cannot bypass the cap).
      let bytes: Buffer;
      try {
        bytes = await readMeteredBody(req, uploadLimit);
        receivedBytes = bytes.byteLength;
      } catch (error) {
        if (error instanceof MaterialPayloadTooLarge) {
          await abandonOwnerMaterial(
            provider.pool as unknown as ConnectableQueryable,
            createdMaterialId,
          ).catch(() => undefined);
          return reject(
            apiError('INVALID_REQUEST', 413, `upload exceeds ${uploadLimit} bytes`),
            'streamed_body_too_large',
            responseHeaders,
          );
        }
        failureLogged = true;
        await abandonOwnerMaterial(
          provider.pool as unknown as ConnectableQueryable,
          createdMaterialId,
        ).catch(() => undefined);
        throw error;
      }
      if (bytes.byteLength === 0) {
        await abandonOwnerMaterial(
          provider.pool as unknown as ConnectableQueryable,
          createdMaterialId,
        ).catch(() => undefined);
        return reject(
          apiError('INVALID_REQUEST', 400, 'empty body'),
          'empty_stream',
          responseHeaders,
        );
      }
      if (bytes.byteLength > reservedBytes) {
        await abandonOwnerMaterial(
          provider.pool as unknown as ConnectableQueryable,
          createdMaterialId,
        ).catch(() => undefined);
        return reject(
          apiError('INVALID_REQUEST', 413, 'upload body exceeds its declared content length'),
          'declared_length_mismatch',
          responseHeaders,
        );
      }

      // Put the bytes into the asset registry, then bind the returned asset id
      // onto the reserved row in its own durable step BEFORE finalize. A crash
      // after the put commits but before finalize therefore leaves the id
      // recorded, so the 24-hour reclaim can remove the bytes when it reclaims
      // the stale reservation.
      const hash = createHash('sha256').update(bytes).digest('hex');
      let assetId: string | null = null;
      try {
        assetId = await provider.assetStore.put(
          principal,
          new Blob([new Uint8Array(bytes)], { type: mime }),
          { contentType: mime },
        );
        await recordOwnerMaterialAsset(
          provider.pool as unknown as ConnectableQueryable,
          createdMaterialId,
          assetId,
        );
        const row = await finalizeOwnerMaterial(
          provider.pool as unknown as ConnectableQueryable,
          createdMaterialId,
          bytes.byteLength,
          hash,
          assetId,
        );
        const view = publicMaterial(row);
        const res = NextResponse.json(
          {
            materialId: view.materialId,
            originalName: view.originalName,
            bytes: view.bytes,
            mime: view.mime,
            extraction: view.extraction,
          },
          { status: 201 },
        );
        res.headers.set('x-request-id', requestId);
        for (const [key, value] of responseHeaders) res.headers.append(key, value);
        console.info('material upload completed', context({ status: 201 }));
        return res;
      } catch (error) {
        if (assetId) {
          await provider.assetStore.remove(principal, assetId).catch(() => undefined);
        }
        await abandonOwnerMaterial(
          provider.pool as unknown as ConnectableQueryable,
          createdMaterialId,
        ).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!failureLogged) console.error('material upload failed', context({ status: 500 }), error);
      const res = apiError('INTERNAL_ERROR', 500, 'material upload failed');
      res.headers.set('x-request-id', requestId);
      for (const [key, value] of responseHeaders) res.headers.append(key, value);
      return res;
    }
  });
}

/** Read the body up to `limit` bytes; throws {@link MaterialPayloadTooLarge} over the cap. */
async function readMeteredBody(req: NextRequest, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = req.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    total += buffer.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new MaterialPayloadTooLarge();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
