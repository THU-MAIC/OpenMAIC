/**
 * What the material library shows outside the agent: the public view of one
 * library material, and the limits and usage the page and the composer show
 * (RFC #1716 §8). Pool pointers, object keys and digests never leave the
 * server.
 */
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { ownerLibraryUsage } from '@/lib/persistence/material-library';
import type { OwnerMaterialEntry } from '@/lib/persistence/session-material-links';
import type { ResolvedMaterial } from '@/lib/server/agent-runtime/material-resolver';
import { publicMaterialView } from '@/lib/server/agent-runtime/session-materials';
import type { Queryable } from '@openmaic/storage/document/pg';
import { resolveAssetQuotaBytes } from '@/lib/persistence/asset-quota';
import { agentRuntimeConfig } from '@/lib/server/agent-runtime/config';

export interface LibraryMaterialView {
  materialId: string;
  kind: OwnerMaterialEntry['kind'];
  /** The display name, or the uploaded file name until it is renamed. */
  name: string;
  originalName?: string;
  mime?: string;
  bytes: number;
  folderId: string | null;
  /** The folder's name, when the listing knows it. */
  folderName?: string;
  /** Attached to the conversation the listing was asked about, when it was asked. */
  attached?: boolean;
  derivedFrom?: string;
  pageNumber?: number;
  timeMs?: number;
  /** A source's extraction; `reason` says why it failed, quota refusals included. */
  extraction?: { status: string; reason?: string };
  createdAt: string;
}

export function libraryMaterialView(
  entry: OwnerMaterialEntry,
  context: { folderNames?: ReadonlyMap<string, string>; attached?: ReadonlySet<string> } = {},
): LibraryMaterialView {
  const status = entry.extraction?.status ?? 'idle';
  const folderName = entry.folderId ? context.folderNames?.get(entry.folderId) : undefined;
  return {
    materialId: entry.id,
    kind: entry.kind,
    name: entry.displayName ?? entry.originalName ?? entry.id,
    ...(entry.originalName ? { originalName: entry.originalName } : {}),
    ...(entry.mime ? { mime: entry.mime } : {}),
    bytes: entry.bytes,
    folderId: entry.folderId,
    ...(folderName ? { folderName } : {}),
    ...(context.attached ? { attached: context.attached.has(entry.id) } : {}),
    ...(entry.derivedFrom ? { derivedFrom: entry.derivedFrom } : {}),
    ...(entry.lineage ?? {}),
    ...(entry.kind === 'source'
      ? {
          extraction: {
            status,
            ...(status === 'failed' && entry.extractionError
              ? { reason: entry.extractionError }
              : {}),
          },
        }
      : {}),
    createdAt: new Date(entry.createdAt).toISOString(),
  };
}

/**
 * The public view of one material a conversation reaches, for the session
 * material routes: a session row as it always was, an owner material as the
 * library shows it.
 */
export function sessionScopeMaterialView(material: ResolvedMaterial): Record<string, unknown> {
  return material.origin === 'session'
    ? publicMaterialView(material.record)
    : { ...libraryMaterialView(material.entry) };
}

export interface LibraryLimits {
  /** Largest document or image upload, in bytes. */
  documentMaxBytes: number;
  /** Largest audio or video upload, in bytes. */
  mediaMaxBytes: number;
  /** Most active sources, and their most bytes in total. */
  maxCount: number;
  maxTotalBytes: number;
  usedCount: number;
  usedBytes: number;
  /** The owner's pool quota, or `null` when the deployment has none. */
  assetQuotaBytes: number | null;
  assetUsedBytes: number;
}

/** The limits upload admission applies to the owner, and what the owner uses of them. */
export async function libraryLimits(queryable: Queryable, ownerId: string): Promise<LibraryLimits> {
  const usage = await ownerLibraryUsage(queryable, ownerId, assetPrincipalForOwner(ownerId).key);
  return {
    documentMaxBytes: Math.min(
      agentRuntimeConfig.maxDocumentBytes,
      agentRuntimeConfig.maxUploadBytes,
    ),
    mediaMaxBytes: agentRuntimeConfig.maxUploadBytes,
    maxCount: agentRuntimeConfig.maxMaterialsPerOwner,
    maxTotalBytes: agentRuntimeConfig.maxMaterialBytesPerOwner,
    usedCount: usage.usedCount,
    usedBytes: usage.usedBytes,
    assetQuotaBytes: resolveAssetQuotaBytes() ?? null,
    assetUsedBytes: usage.assetUsedBytes,
  };
}
