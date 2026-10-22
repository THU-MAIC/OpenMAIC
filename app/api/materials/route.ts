/**
 * Shared owner-material upload endpoint. The default keeps the classic
 * attachment: bytes stay in the material byte store and extraction uses the
 * existing classic worker (`extract=false` leaves it idle).
 *
 * The workbench explicitly sends `scope=library`. Its durable upload is
 * published into the owner asset pool with a material root and pending
 * extraction in one transaction. Both upload paths produce durable library
 * sources; only unfinished reservations may expire.
 *
 * Both paths reserve quota before consuming the body and enforce the same
 * per-type byte limits (413 includes maxBytes), MIME policy, owner fence,
 * request-id header and flat 201 response. A stale reservation retains its
 * recorded object key until byte cleanup succeeds.
 *
 * Classic uploads/listing need persistence only. Durable library uploads and
 * session-scoped reads additionally need the agent runtime.
 */
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { createMaterialId } from '@openmaic/storage';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  isAgentRuntimeConfigured,
  isServerPersistenceConfigured,
} from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { resolveOwnedSession } from '@/lib/server/agent-runtime/session-materials';
import { listSessionScopePage } from '@/lib/server/agent-runtime/material-resolver';
import { sessionScopeMaterialView } from '@/lib/server/materials/library-view';
import { AssetQuotaExceededError } from '@openmaic/storage';

import {
  abandonOwnerMaterial,
  allocateOwnerMaterialBytes,
  listOwnerMaterials,
  finalizeOwnerMaterial,
  MaterialQuotaExceededError,
  publicMaterial,
  publishOwnerMaterialUpload,
  reclaimStaleOwnerMaterialUploads,
  registerOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { deleteMaterialObjects, getMaterialByteStore } from '@/lib/server/materials/bytes';
import { wakeOwnerMaterialExtractor } from '@/lib/server/materials/extractor-wake';
import {
  MATERIAL_DOCUMENT_UPLOAD_LIMIT,
  MATERIAL_MEDIA_UPLOAD_LIMIT,
} from '@/lib/server/materials/upload-limits';
import {
  isWorkbenchMaterialMime,
  MEDIA_MIME_TYPES,
  resolveWorkbenchMaterialMime,
} from '@/lib/workbench/material-upload-policy';

export const runtime = 'nodejs';

const MEDIA_MIME_SET = new Set<string>(MEDIA_MIME_TYPES);

/** The store's keyset-paging ceiling (default 50, capped at 200). */
export const MAX_MATERIAL_LIST_LIMIT = 200;

export function ownerMaterialObjectKey(ownerId: string, materialId: string): string {
  return `materials/${ownerId.replace(/[^A-Za-z0-9._-]/g, '_')}/${materialId}`;
}

class MaterialPayloadTooLarge extends Error {}

function materialTooLarge(maxBytes: number) {
  return NextResponse.json(
    {
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: `upload exceeds ${maxBytes} bytes`,
      maxBytes,
    },
    { status: 413 },
  );
}

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

function parseLimit(raw: string | null): { limit?: number } | { invalid: true } {
  if (raw === null || raw === '') return {};
  if (!/^\d+$/.test(raw)) return { invalid: true };
  const parsed = Number(raw);
  if (parsed < 1 || parsed > MAX_MATERIAL_LIST_LIMIT) return { invalid: true };
  return { limit: parsed };
}

// GET /api/materials — the caller's own library uploads, newest first, each
// with its extraction (served with server persistence).
// GET /api/materials?sessionId=&limit=&before= — list one owned session's
// materials: its own rows newest first, then the library materials its links
// reach, on one cursor (the agent-tools list surface).
export async function GET(req: NextRequest) {
  const searchParams = new URL(req.url).searchParams;
  // A session named but empty is a mistake, not a request for the library.
  if (searchParams.has('sessionId') && !searchParams.get('sessionId')?.trim()) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId must not be empty');
  }
  if (!searchParams.has('sessionId')) {
    if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
    return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
      const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      const records = await listOwnerMaterials(provider.pool, ownerId);
      return ownerJson({ materials: records.map(publicMaterial) }, 200, responseHeaders);
    });
  }
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId')!.trim();

  const parsedLimit = parseLimit(url.searchParams.get('limit'));
  if ('invalid' in parsedLimit) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `limit must be an integer between 1 and ${MAX_MATERIAL_LIST_LIMIT}`,
    );
  }
  const before = url.searchParams.get('before')?.trim() || undefined;

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const session = await resolveOwnedSession(sessionId, ownerId);
    if (!session) return ownerNotFound(responseHeaders);
    const materials = await listSessionScopePage(sessionId, {
      ...(parsedLimit.limit === undefined ? {} : { limit: parsedLimit.limit }),
      ...(before ? { before } : {}),
    });
    return ownerJson(
      { materials: materials.map((material) => sessionScopeMaterialView(material)) },
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
  let declaredMime = '';
  let declaredBytes = 0;
  let receivedBytes = 0;
  let failureLogged = false;
  const context = (extra: Record<string, unknown> = {}) => ({
    requestId,
    phase,
    ...(materialId ? { materialId } : {}),
    ...(mime ? { mime } : {}),
    ...(declaredMime && declaredMime !== mime ? { declaredMime } : {}),
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

  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      phase = 'validate_request';
      // Library uploads always enqueue; classic callers may defer extraction.
      const library = new URL(req.url).searchParams.get('scope') === 'library';
      if (library && !isAgentRuntimeConfigured())
        return new Response('Not found', { status: 404, headers: responseHeaders });
      const extract = new URL(req.url).searchParams.get('extract') !== 'false';
      const rawMime = (req.headers.get('content-type') ?? '').split(';', 1)[0];
      declaredMime = rawMime;
      const originalName = materialFilename(req);
      // A generic content-type (empty, octet-stream, zip-family, or the
      // generic Office container some Linux browsers report for OOXML —
      // #1497) is resolved from the filename extension; a specific but
      // unsupported type falls through verbatim for the whitelist to reject.
      mime = resolveWorkbenchMaterialMime({ mimeType: rawMime, fileName: originalName });
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
        ? MATERIAL_MEDIA_UPLOAD_LIMIT
        : MATERIAL_DOCUMENT_UPLOAD_LIMIT;

      declaredBytes = Number(req.headers.get('content-length') ?? 0);
      if (Number.isFinite(declaredBytes) && declaredBytes > uploadLimit) {
        return reject(materialTooLarge(uploadLimit), 'declared_body_too_large', responseHeaders);
      }
      if (!req.body) {
        return reject(
          apiError('INVALID_REQUEST', 400, 'empty body'),
          'empty_body',
          responseHeaders,
        );
      }

      if (!originalName) {
        return reject(
          apiError('MISSING_REQUIRED_FIELD', 400, 'x-material-filename header is required'),
          'missing_filename',
          responseHeaders,
        );
      }
      const createdMaterialId = createMaterialId();
      materialId = createdMaterialId;
      const ossKey = library ? '' : ownerMaterialObjectKey(ownerId, createdMaterialId);

      const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      // Classic attachments and legacy library originals use the byte store.
      const byteStore = getMaterialByteStore();
      const abandon = () =>
        abandonOwnerMaterial(provider, ownerId, createdMaterialId).catch(() => undefined);

      // Browsers send Content-Length for a File body. When an intermediary
      // strips it, reserve the per-file maximum so an unmeasured stream can
      // never bypass the owner byte quota; finalize shrinks the reservation to
      // its actual size.
      const reservedBytes =
        Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : uploadLimit;

      // Reclaim uploads that crashed before they were published and are older
      // than the 24-hour horizon. A pre-pool reservation's byte object is
      // removed first; the reservation is deleted only after that, so a
      // failure here keeps the reservation for the next pass instead of losing
      // the pointer to its bytes.
      phase = 'reclaim_stale_uploads';
      await reclaimStaleOwnerMaterialUploads(provider, ownerId, async (objectKey) => {
        try {
          await deleteMaterialObjects(byteStore, objectKey);
        } catch (error) {
          console.warn(
            'material stale byte deletion failed; keeping its reservation for the next pass',
            context({ objectKey }),
            error,
          );
          throw error;
        }
      }).catch((error) => {
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
            // Library bytes go to the pool; classic bytes keep their reserved key.
            ossKey,
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
        const claimed = ownerWriteErrorResponse(error);
        if (claimed) return reject(claimed, 'owner_claim', responseHeaders);
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
          await abandon();
          return reject(materialTooLarge(uploadLimit), 'streamed_body_too_large', responseHeaders);
        }
        failureLogged = true;
        await abandon();
        throw error;
      }
      if (bytes.byteLength === 0) {
        await abandon();
        return reject(
          apiError('INVALID_REQUEST', 400, 'empty body'),
          'empty_stream',
          responseHeaders,
        );
      }
      if (bytes.byteLength > reservedBytes) {
        await abandon();
        return reject(
          apiError('INVALID_REQUEST', 413, 'upload body exceeds its declared content length'),
          'declared_length_mismatch',
          responseHeaders,
        );
      }

      // Allocate, then publish. Neither step's failure deletes anything that
      // was stored: an allocation nothing published expires like any pending
      // pool entry, and `abandon` only matches a row still `uploading`, so it
      // is safe even when a publication may have committed before its answer
      // was lost -- a published row is `ready` and is left as it is.
      const hash = createHash('sha256').update(bytes).digest('hex');
      let row: Awaited<ReturnType<typeof publishOwnerMaterialUpload>>;
      try {
        if (!library) {
          await byteStore.put(ossKey, bytes, mime);
          row = await finalizeOwnerMaterial(
            provider.pool,
            createdMaterialId,
            bytes.byteLength,
            hash,
            { extract },
          );
          if (extract) wakeOwnerMaterialExtractor();
        } else {
          phase = 'allocate_bytes';
          const assetId = await allocateOwnerMaterialBytes(provider, ownerId, bytes, mime);
          phase = 'publish_material';
          row = await publishOwnerMaterialUpload(provider, ownerId, createdMaterialId, {
            assetId,
            bytes: bytes.byteLength,
            sha256: hash,
          });
        }
      } catch (error) {
        if (library) {
          await abandon();
        } else {
          // A lost finalize response may already have committed. Recheck under
          // the reservation lock before deleting any original bytes.
          await abandonOwnerMaterial(provider, ownerId, createdMaterialId, (key) =>
            byteStore.delete(key),
          );
        }
        if (error instanceof AssetQuotaExceededError) {
          return reject(
            apiError('ASSET_QUOTA_EXCEEDED', 507, 'asset storage quota exceeded'),
            'asset_quota_exceeded',
            responseHeaders,
          );
        }
        const claimed = ownerWriteErrorResponse(error);
        if (claimed) return reject(claimed, 'owner_claim', responseHeaders);
        throw error;
      }
      if (row === 'refused') {
        await abandon();
        failureLogged = true;
        console.error(
          'material upload failed',
          context({ status: 500, reason: 'publication_refused' }),
        );
        const res = apiError('INTERNAL_ERROR', 500, 'material upload failed');
        res.headers.set('x-request-id', requestId);
        for (const [key, value] of responseHeaders) res.headers.append(key, value);
        return res;
      }

      const view = publicMaterial(row);
      const res = NextResponse.json(
        {
          materialId: view.materialId,
          originalName: view.originalName,
          bytes: view.bytes,
          mime: view.mime,
          mediaKind: view.mediaKind,
          extraction: view.extraction,
        },
        { status: 201 },
      );
      res.headers.set('x-request-id', requestId);
      for (const [key, value] of responseHeaders) res.headers.append(key, value);
      console.info('material upload completed', context({ status: 201 }));
      return res;
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
