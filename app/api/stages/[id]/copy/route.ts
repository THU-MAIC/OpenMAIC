/**
 * POST /api/stages/[id]/copy — duplicate an existing course into the caller's library.
 *
 * Requirements:
 * - Accepts no request body and returns `{ id }` on success (200).
 * - Same-origin JSON request enforcement via `isSameOriginJsonRequest`.
 * - Resolves copying user through `withRequestOwner`.
 * - 404 when server persistence is disabled or the source course is missing/deleted.
 * - Performs copy using copier's owner-scoped stores.
 * - Mints fresh stage ID, new scene IDs, and new agent IDs.
 * - Rewrites every corresponding agent reference (`agentIds`, `generatedAgentConfigs`,
 *   `multiAgent.agentIds`, and speech/discussion action `agentId`).
 * - Copies referenced media into copier's own asset storage (reading original bytes
 *   and storing independent copies via `storeGeneratedAsset`). Deduplicates repeated
 *   references and rewrites them.
 * - Copies legacy `/api/classroom-media/<id>/...` files from disk using `CLASSROOMS_DIR`.
 * - Leaves external media URLs and data/blob URLs unchanged.
 * - Adds a localized `(copy)` title suffix within STAGE_NAME_MAX_LENGTH.
 * - Saves as a completed classroom through `saveCompletedClassroom`.
 * - Does not copy conversations, generation runs, publish state, folders, material links,
 *   learner progress, or quiz attempts.
 * - Refuses PBL v3 courses with a 400 error.
 * - Enforces 1 copy in flight per owner, total media size limit (500 MiB), and rate limits.
 * - On failure, releases pending asset allocations via `provider.assetStore.releasePending`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { nanoid } from 'nanoid';

import { isDocumentWriteRefusedError, toAssetId } from '@openmaic/storage';
import {
  enumerateAssetManifest,
  isConcreteMediaAddress,
  isPBLV3Reference,
  type AssetKind,
  type Slide,
} from '@openmaic/dsl';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { slideMediaReferenceSlots } from '@/lib/media/slide-media-slots';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import { loadLocaleResource } from '@/lib/i18n/load-resource';
import { matchLocale, resolveRequestLocale, LOCALE_COOKIE } from '@/lib/i18n/resolve-locale';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { resolveOwnedAsset } from '@/lib/persistence/resolve-server-asset';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerApiError, ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { STAGE_NAME_MAX_LENGTH } from '@/lib/server/agent-runtime/stage-limits';
import { generateClassroomId, saveCompletedClassroom } from '@/lib/server/classroom-persistence';
import { CLASSROOMS_DIR, classroomMediaMimeType } from '@/lib/server/classroom-storage';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { resolveStageAccess } from '@/lib/server/stage-access';
import { storeGeneratedAsset, type GeneratedAssetKind } from '@/lib/server/store-generated-asset';
import type { SpeechAction } from '@/lib/types/action';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Maximum total media bytes allowable for a single course copy (500 MiB). */
export const MAX_COPY_MEDIA_BYTES = 500 * 1024 * 1024;

/** Rate limit window in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Maximum copy operations allowed per window per owner. */
const MAX_COPIES_PER_WINDOW = 10;

/** Track active in-flight copies per owner. */
const inFlightCopies = new Set<string>();

/** Sliding window timestamps for rate limiting per owner. */
const copyTimestamps = new Map<string, number[]>();

/** Reset in-memory concurrency and rate limit state (for tests). */
export function _resetCopyLimitsForTesting(): void {
  inFlightCopies.clear();
  copyTimestamps.clear();
}

class CopyStorageFullError extends Error {
  constructor(message = 'Asset storage quota exceeded.') {
    super(message);
    this.name = 'CopyStorageFullError';
  }
}

class CopyPayloadTooLargeError extends Error {
  constructor(message = 'Course media exceeds maximum allowable size for copy (500MB).') {
    super(message);
    this.name = 'CopyPayloadTooLargeError';
  }
}

const LEGACY_MEDIA_PATH = /^\/api\/classroom-media\/([^/]+)\/(media|audio)\/([^/]+)$/;

function legacyMediaFile(value: string | undefined, legacyId: string): string | null {
  if (!value || !value.includes('/api/classroom-media/')) return null;
  let pathname: string;
  try {
    pathname = new URL(value, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const match = LEGACY_MEDIA_PATH.exec(pathname);
  if (!match) return null;
  let classroomId: string;
  let fileName: string;
  try {
    classroomId = decodeURIComponent(match[1]!);
    fileName = decodeURIComponent(match[3]!);
  } catch {
    return null;
  }
  if (classroomId !== legacyId) return null;
  if (fileName === '.' || fileName === '..' || /[/\\\0]/.test(fileName)) return null;
  return path.join(match[2]!, fileName);
}

function assetKindFor(mimeType: string, poster: boolean): GeneratedAssetKind {
  if (poster) return 'poster';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

function hasPblV3Project(scenes: readonly Scene[]): boolean {
  return scenes.some(
    (scene) =>
      scene.content?.type === 'pbl' &&
      isPBLV3Reference((scene.content as { projectV3?: unknown }).projectV3),
  );
}

function resolveRequestLanguage(req: Request): string {
  const userLocaleHeader = req.headers.get('x-user-locale');
  if (userLocaleHeader) {
    const matched = matchLocale(userLocaleHeader);
    if (matched) return matched;
  }
  const cookieHeader = req.headers.get('cookie') ?? '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    }),
  );
  return resolveRequestLocale({
    cookie: cookies[LOCALE_COOKIE],
    acceptLanguage: req.headers.get('accept-language'),
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) {
    return new Response('Not found', { status: 404 });
  }

  if (!isSameOriginJsonRequest(req)) {
    return ownerApiError(
      'CROSS_ORIGIN_REFUSED',
      403,
      'Copy requests must be same-origin JSON requests.',
      new Headers(),
    );
  }

  return withRequestOwner(req, async (principal, responseHeaders) => {
    const { ownerId } = principal;

    // Concurrency limit: 1 copy in flight per owner.
    if (inFlightCopies.has(ownerId)) {
      return ownerApiError(
        'CONCURRENT_COPY_LIMIT',
        429,
        'A copy operation is already in progress for this account.',
        responseHeaders,
      );
    }

    // Rate limit: max per window per owner.
    const now = Date.now();
    const timestamps = (copyTimestamps.get(ownerId) ?? []).filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );
    if (timestamps.length >= MAX_COPIES_PER_WINDOW) {
      return ownerApiError(
        'RATE_LIMITED',
        429,
        'Too many copy requests. Please wait a moment and try again.',
        responseHeaders,
      );
    }

    timestamps.push(now);
    copyTimestamps.set(ownerId, timestamps);
    inFlightCopies.add(ownerId);

    try {
      const { id: sourceStageId } = await params;

      // Check course access and tombstone status.
      const access = await resolveStageAccess(sourceStageId);
      if (!access || access.deletedAt !== null) {
        return ownerNotFound(responseHeaders);
      }

      // Load source document through owner-scoped store.
      const copierStore = await getOwnerScopedDocumentStore(principal);
      const sourceDocument = await copierStore.loadDocument(sourceStageId);
      if (!sourceDocument) {
        return ownerNotFound(responseHeaders);
      }

      // Refuse PBL v3 projects.
      if (hasPblV3Project(sourceDocument.scenes)) {
        return ownerApiError(
          'INVALID_REQUEST',
          400,
          'Courses containing PBL v3 projects cannot be copied.',
          responseHeaders,
        );
      }

      // Determine localized copy suffix and new course title.
      const lang = resolveRequestLanguage(req);
      let copySuffix = '(copy)';
      try {
        const resource = await loadLocaleResource(lang);
        const nav = (resource.edit as Record<string, unknown> | undefined)?.nav;
        if (nav && typeof (nav as Record<string, unknown>).copySuffix === 'string') {
          copySuffix = (nav as Record<string, string>).copySuffix;
        }
      } catch {
        // Fall back to default '(copy)'.
      }

      const suffix = ` ${copySuffix}`;
      let baseName = (sourceDocument.stage.name || '').trim();
      if (baseName.length + suffix.length > STAGE_NAME_MAX_LENGTH) {
        baseName = baseName.slice(0, Math.max(0, STAGE_NAME_MAX_LENGTH - suffix.length)).trim();
      }
      const newStageName = `${baseName}${suffix}`;

      // Generate new IDs.
      const newStageId = generateClassroomId();
      const sceneIdMap = new Map<string, string>();
      for (const scene of sourceDocument.scenes) {
        sceneIdMap.set(scene.id, `scene-${nanoid(12)}`);
      }

      const agentIdMap = new Map<string, string>();
      const getNewAgentId = (oldId: string): string => {
        let mapped = agentIdMap.get(oldId);
        if (!mapped) {
          const prefix = oldId.startsWith('gen-') ? 'gen-' : 'agent-';
          mapped = `${prefix}${nanoid(8)}`;
          agentIdMap.set(oldId, mapped);
        }
        return mapped;
      };

      // Rewrite agent references in stage.
      const newStage: Stage = {
        ...structuredClone(sourceDocument.stage),
        id: newStageId,
        name: newStageName,
        createdAt: now,
        updatedAt: now,
        ...(sourceDocument.stage.agentIds
          ? { agentIds: sourceDocument.stage.agentIds.map(getNewAgentId) }
          : {}),
        ...(sourceDocument.stage.generatedAgentConfigs
          ? {
              generatedAgentConfigs: sourceDocument.stage.generatedAgentConfigs.map((cfg) => ({
                ...cfg,
                id: getNewAgentId(cfg.id),
              })),
            }
          : {}),
      };

      // Clear non-copied properties: folder, public/publish state.
      delete (newStage as Record<string, unknown>).folderId;
      delete (newStage as Record<string, unknown>).isPublic;
      delete (newStage as Record<string, unknown>).publishedAt;

      // Rewrite scenes and their agent references.
      const newScenes: Scene[] = sourceDocument.scenes.map((scene) => {
        const cloned = structuredClone(scene);
        cloned.id = sceneIdMap.get(scene.id) ?? `scene-${nanoid(12)}`;
        cloned.stageId = newStageId;

        if (cloned.multiAgent?.agentIds) {
          cloned.multiAgent = {
            ...cloned.multiAgent,
            agentIds: cloned.multiAgent.agentIds.map(getNewAgentId),
          };
        }

        if (Array.isArray(cloned.actions)) {
          for (const action of cloned.actions) {
            if (typeof (action as { agentId?: unknown }).agentId === 'string') {
              (action as { agentId: string }).agentId = getNewAgentId(
                (action as { agentId: string }).agentId,
              );
            }
          }
        }

        return cloned;
      });

      // Rewrite outlines.
      const newOutlines: SceneOutline[] = (sourceDocument.outline?.outlines ?? []).map(
        (outline) => ({
          ...structuredClone(outline),
          id: sceneIdMap.get(outline.id) ?? outline.id,
        }),
      );

      // Media copying & allocation tracking.
      const connectionString = process.env.DATABASE_URL ?? '';
      const provider = await getServerPersistenceProvider(connectionString);
      const copierAssetPrincipal = assetPrincipalForOwner(ownerId);
      const allocations: string[] = [];
      let totalMediaBytes = 0;
      const refToNewAssetId = new Map<string, string>();

      const cleanupAllocations = async () => {
        for (const assetId of allocations) {
          try {
            await provider.assetStore.releasePending(copierAssetPrincipal, toAssetId(assetId));
          } catch {
            // Best effort release; collector reclaims pending assets after TTL.
          }
        }
      };

      // Helper to copy an individual media reference.
      const copyMediaReference = async (
        ref: string,
        isPoster: boolean,
        kindHint: AssetKind,
      ): Promise<string | null> => {
        if (!ref || ref.trim() === '') return null;

        const cached = refToNewAssetId.get(ref);
        if (cached !== undefined) return cached;

        // Check if it's a legacy classroom-media file.
        const legacyFile = legacyMediaFile(ref, sourceStageId);
        if (legacyFile) {
          let classroomRoot: string | null = null;
          try {
            classroomRoot = await fs.realpath(path.join(CLASSROOMS_DIR, sourceStageId));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            classroomRoot = null;
          }

          if (classroomRoot) {
            try {
              const realPath = await fs.realpath(path.join(classroomRoot, legacyFile));
              if (realPath.startsWith(classroomRoot + path.sep)) {
                const bytes = await fs.readFile(realPath);
                totalMediaBytes += bytes.byteLength;
                if (totalMediaBytes > MAX_COPY_MEDIA_BYTES) {
                  throw new CopyPayloadTooLargeError();
                }

                const mimeType =
                  classroomMediaMimeType(path.extname(realPath)) ?? 'application/octet-stream';
                const stored = await storeGeneratedAsset({
                  ownerId,
                  stageId: newStageId,
                  bytes,
                  mimeType,
                  kind: assetKindFor(mimeType, isPoster),
                });

                if (stored.status === 'refused') {
                  throw new CopyStorageFullError();
                }

                refToNewAssetId.set(ref, stored.assetId);
                allocations.push(stored.assetId);
                return stored.assetId;
              }
            } catch (err) {
              if (err instanceof CopyPayloadTooLargeError || err instanceof CopyStorageFullError) {
                throw err;
              }
              // Missing or unreadable legacy file leaves reference unchanged.
            }
          }
          return null;
        }

        // External URLs (http/https/data/blob) not matching legacy media remain unchanged.
        if (isConcreteMediaAddress(ref)) {
          return null;
        }

        // Dedicated pool asset reference resolution.
        if (mayNameAPoolAsset(ref) || !isConcreteMediaAddress(ref)) {
          let resolution = await resolveOwnedAsset(
            ref,
            access.ownerId,
            connectionString,
            undefined,
          );
          if (resolution.status === 'missing' && access.ownerId !== ownerId) {
            resolution = await resolveOwnedAsset(ref, ownerId, connectionString, undefined);
          }

          if (resolution.status === 'too_large') {
            throw new CopyPayloadTooLargeError();
          }

          if (resolution.status === 'resolved') {
            totalMediaBytes += resolution.buffer.byteLength;
            if (totalMediaBytes > MAX_COPY_MEDIA_BYTES) {
              throw new CopyPayloadTooLargeError();
            }

            const generatedKind: GeneratedAssetKind =
              isPoster || kindHint === 'poster'
                ? 'poster'
                : resolution.mimeType.startsWith('video/')
                  ? 'video'
                  : resolution.mimeType.startsWith('audio/')
                    ? 'audio'
                    : 'image';

            const stored = await storeGeneratedAsset({
              ownerId,
              stageId: newStageId,
              bytes: resolution.buffer,
              mimeType: resolution.mimeType,
              kind: generatedKind,
            });

            if (stored.status === 'refused') {
              throw new CopyStorageFullError();
            }

            refToNewAssetId.set(ref, stored.assetId);
            allocations.push(stored.assetId);
            return stored.assetId;
          }
        }

        return null;
      };

      try {
        // Enumerate manifest to discover all referenced media and pre-copy them.
        const manifest = enumerateAssetManifest({
          stage: newStage,
          scenes: newScenes,
        });

        for (const entry of manifest.entries) {
          const isPoster = entry.kind === 'poster';
          await copyMediaReference(entry.ref, isPoster, entry.kind);
        }

        // Collect slides for media slot processing and rewriting.
        const slides: Pick<Slide, 'background' | 'elements'>[] = [...(newStage.whiteboard ?? [])];
        for (const scene of newScenes) {
          if (scene.content?.type === 'slide') slides.push(scene.content.canvas);
          slides.push(...(scene.whiteboards ?? []));
        }

        for (const slide of slides) {
          const slots = [...slideMediaReferenceSlots(slide)];
          const rewrittenVideos = new Map<number, string>();

          for (const slot of slots) {
            const currentRef = slot.read();
            if (!currentRef) continue;
            const isPoster = slot.kind === 'video-poster';
            const kindHint: AssetKind =
              slot.kind === 'video-poster'
                ? 'poster'
                : slot.kind === 'video-src' || slot.kind === 'video-media-ref'
                  ? 'video'
                  : slot.kind === 'audio-src'
                    ? 'audio'
                    : 'image';

            const newAssetId = await copyMediaReference(currentRef, isPoster, kindHint);
            if (newAssetId) {
              slot.write(newAssetId);
              if (slot.kind === 'video-src' && slot.elementIndex !== undefined) {
                rewrittenVideos.set(slot.elementIndex, newAssetId);
              }
            }
          }

          for (const slot of slots) {
            if (slot.kind !== 'video-media-ref' || slot.elementIndex === undefined) continue;
            const assetId = rewrittenVideos.get(slot.elementIndex);
            if (assetId && isGeneratedMediaPlaceholder(slot.read())) {
              slot.write(assetId);
            }
          }
        }

        // Process speech actions.
        for (const scene of newScenes) {
          for (const action of scene.actions ?? []) {
            if (action.type !== 'speech') continue;
            const speech = action as SpeechAction & { audioUrl?: string };
            const currentRef = speech.audioUrl ?? speech.audioId;
            if (currentRef) {
              const newAssetId = await copyMediaReference(currentRef, false, 'audio');
              delete speech.audioUrl;
              if (newAssetId) {
                speech.audioId = newAssetId;
              }
            }
          }
        }

        // Process stage videoManifest.
        if (newStage.videoManifest) {
          const rewrittenManifest: Stage['videoManifest'] = {};
          for (const [oldRef, entry] of Object.entries(newStage.videoManifest)) {
            const newAssetId = await copyMediaReference(oldRef, false, 'video');
            rewrittenManifest[newAssetId ?? oldRef] = entry;
          }
          newStage.videoManifest = rewrittenManifest;
        }

        // Save through normal creation path.
        await saveCompletedClassroom(principal, {
          stage: newStage,
          scenes: newScenes,
          outlines: newOutlines,
        });

        return ownerJson({ id: newStageId }, 200, responseHeaders);
      } catch (error) {
        await cleanupAllocations();

        if (error instanceof CopyStorageFullError) {
          return ownerApiError(
            'ASSET_QUOTA_EXCEEDED',
            507,
            'Asset storage quota exceeded.',
            responseHeaders,
          );
        }

        if (error instanceof CopyPayloadTooLargeError) {
          return ownerApiError('INVALID_REQUEST', 413, error.message, responseHeaders);
        }

        const claimed = ownerWriteErrorResponse(error, responseHeaders);
        if (claimed) return claimed;

        if (isDocumentWriteRefusedError(error)) {
          return ownerApiError('CREATE_REFUSED', 403, error.message, responseHeaders);
        }

        throw error;
      }
    } finally {
      inFlightCopies.delete(ownerId);
    }
  });
}
