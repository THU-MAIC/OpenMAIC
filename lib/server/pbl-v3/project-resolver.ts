import 'server-only';
import type { PBLProjectPackage, PBLV3Reference } from '@openmaic/dsl';
import { isPBLV3Reference } from '@openmaic/dsl';
import { AssetQuotaExceededError } from '@openmaic/storage';
import {
  getServerPersistenceProvider,
  type ServerPersistenceProvider,
} from '@/lib/persistence/server-provider';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { resolveAssetPendingTtlMs } from '@/lib/persistence/asset-pending-ttl';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import { SandboxError, sandboxInvalid } from '@/lib/sandbox/errors';
import { installedProject, type InstalledProject } from './catalog';
import { canonicalJson, packageBuiltin, sha256, validateProjectPackage } from './project-package';

const MIME = 'application/vnd.openmaic.pbl-project+json';
const unavailable = () =>
  new SandboxError(
    'PBL_PROJECT_UNAVAILABLE',
    404,
    'The pinned project resources are unavailable to this classroom.',
  );
const provider = () => getServerPersistenceProvider(process.env.DATABASE_URL ?? '');

export async function installProjectPackage(
  ownerId: string,
  input: unknown,
  persistence?: ServerPersistenceProvider,
): Promise<PBLV3Reference> {
  const { bundle } = validateProjectPackage(input);
  const bytes = canonicalJson(bundle),
    hash = `sha256-${sha256(bytes)}`;
  const store = persistence ?? (await provider());
  return store.withTransaction(async (db) => {
    await fenceOwnerWrite(db, ownerId);
    // Deduplicate only inside this authenticated owner's partition, including retries before publication.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `pbl-package:${ownerId}:${bundle.entry.checksum}`,
    ]);
    const existing = await db.query<{ asset_id: string }>(
      `SELECT p.asset_id FROM pbl_project_installations p JOIN asset_entries e ON e.id=p.asset_id
       WHERE p.checksum=$1 AND p.content_hash=$2 AND e.content_hash=$2 AND e.principal=$3
       AND e.revision=1 AND e.unreferenced_at IS NULL
       AND (e.expires_at IS NULL OR e.expires_at>now())
       ORDER BY e.id LIMIT 1 FOR UPDATE OF e`,
      [bundle.entry.checksum, hash, assetPrincipalForOwner(ownerId).key],
    );
    let assetId: string | undefined = existing.rows[0]?.asset_id;
    if (assetId) {
      const stored = await store.assetStoreIn(db).resolve(assetPrincipalForOwner(ownerId), assetId);
      if (!stored || `sha256-${sha256(stored.bytes)}` !== hash) assetId = undefined;
      else {
        // A retry gets the same publication window as a fresh allocation. The entry lock
        // keeps collection from racing verification and renewal. Previously unreferenced
        // entries take the put path instead, which accounts for their quota again.
        await db.query(
          `UPDATE asset_entries SET expires_at=now()+($2::double precision * interval '1 millisecond')
           WHERE id=$1 AND committed_at IS NULL AND expires_at IS NOT NULL`,
          [assetId, resolveAssetPendingTtlMs()],
        );
      }
    }
    if (!assetId) {
      try {
        assetId = await store
          .assetStoreIn(db)
          .put(assetPrincipalForOwner(ownerId), new Blob([bytes], { type: MIME }), {
            contentType: MIME,
          });
      } catch (error) {
        if (
          error instanceof AssetQuotaExceededError ||
          (error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ASSET_QUOTA_EXCEEDED')
        )
          throw new SandboxError(
            'ASSET_QUOTA_EXCEEDED',
            507,
            'Storage is full. Free storage space before importing this project.',
          );
        throw error;
      }
      await db.query(
        'INSERT INTO pbl_project_installations(asset_id,project_id,project_version,checksum,content_hash) VALUES($1,$2,$3,$4,$5)',
        [assetId, bundle.entry.id, bundle.entry.version, bundle.entry.checksum, hash],
      );
    }
    return {
      id: bundle.entry.id,
      version: bundle.entry.version,
      assetId,
      checksum: bundle.entry.checksum,
    };
  });
}

/** One resolver for built-in and persisted course projects; never caches content in a process Map. */
export async function resolveProject(
  ownerId: string,
  stageId: string,
  ref: PBLV3Reference,
  persistence?: ServerPersistenceProvider,
  sceneId?: string,
): Promise<InstalledProject> {
  return resolveAuthorizedProject(ownerId, stageId, ref, persistence, { sceneId });
}

/** Only a persisted study's own retained reference authorizes this resolution path. */
export async function resolveStudyProject(
  ownerId: string,
  stageId: string,
  ref: PBLV3Reference,
  studyId: string,
  persistence?: ServerPersistenceProvider,
): Promise<InstalledProject> {
  return resolveAuthorizedProject(ownerId, stageId, ref, persistence, { studyId });
}

async function resolveAuthorizedProject(
  ownerId: string,
  stageId: string,
  ref: PBLV3Reference,
  persistence: ServerPersistenceProvider | undefined,
  access: { sceneId?: string; studyId?: string },
): Promise<InstalledProject> {
  if (!isPBLV3Reference(ref) || ref.packageId) throw unavailable();
  // Reads of public courses elsewhere are intentionally broader than project execution.
  const store = persistence ?? (await provider());
  const owned = await store.pool.query(
    'SELECT 1 FROM stage_meta WHERE stage_id=$1 AND owner_id=$2 AND deleted_at IS NULL',
    [stageId, ownerId],
  );
  if (!owned.rows.length) throw unavailable();
  if (!ref.assetId) return installedProject(ref);
  const valid = await store.pool.query(
    `SELECT 1 FROM pbl_project_installations p JOIN asset_entries e ON e.id=p.asset_id
     JOIN document_asset_refs r ON r.asset_id=e.id
     WHERE r.stage_id=$1 AND p.asset_id=$2 AND p.checksum=$3 AND p.project_id=$4 AND p.project_version=$5
       AND e.principal=$6 AND e.content_hash=p.content_hash AND e.revision=1
       AND ${
         access.studyId
           ? "r.scope='retained' AND r.scene_id=$7"
           : `r.scope IN ('stage','scene') AND ($7::text IS NULL OR EXISTS (
         SELECT 1 FROM document_scenes s WHERE s.stage_id=$1 AND s.id=$7
           AND s.data->'content'->'projectV3'->>'assetId'=p.asset_id
           AND s.data->'content'->'projectV3'->>'checksum'=p.checksum
       ))`
       }`,
    [
      stageId,
      ref.assetId,
      ref.checksum,
      ref.id,
      ref.version,
      assetPrincipalForOwner(ownerId).key,
      access.studyId ?? access.sceneId ?? null,
    ],
  );
  if (!valid.rows.length) throw unavailable();
  const asset = await store.assetStore.resolve(assetPrincipalForOwner(ownerId), ref.assetId);
  if (!asset || asset.mime !== MIME || asset.revision !== 1) throw unavailable();
  const { bundle, project } = validateProjectPackage(
    JSON.parse(new TextDecoder().decode(asset.bytes)),
  );
  if (
    bundle.entry.checksum !== ref.checksum ||
    project.ref.id !== ref.id ||
    project.ref.version !== ref.version
  )
    throw unavailable();
  return { ...project, ref };
}

export async function exportProjectPackage(
  ownerId: string,
  stageId: string,
  ref: PBLV3Reference,
): Promise<PBLProjectPackage> {
  const project = await resolveProject(ownerId, stageId, ref);
  return project.coursePackage?.bundle ?? packageBuiltin(project);
}

export function bindPackageReferences<T extends { content: unknown }>(
  scenes: T[],
  refs: ReadonlyMap<string, PBLV3Reference>,
): T[] {
  return scenes.map((scene) => {
    const content = scene.content as { type?: string; projectV3?: PBLV3Reference };
    if (content?.type !== 'pbl' || !content.projectV3) return scene;
    const ref = content.projectV3;
    if (!isPBLV3Reference(ref) || !ref.packageId)
      throw sandboxInvalid('Every PBL v3 scene must bind to a packaged project.');
    const installed = refs.get(ref.packageId);
    if (!installed || installed.id !== ref.id || installed.version !== ref.version)
      throw sandboxInvalid('A PBL scene has no matching project package.');
    return { ...scene, content: { ...content, projectV3: installed } };
  });
}
