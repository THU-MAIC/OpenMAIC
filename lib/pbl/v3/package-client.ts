import type JSZip from 'jszip';
import {
  isPBLV3Reference,
  PBL_PROJECT_PACKAGE_CAPABILITY,
  type PBLProjectPackage,
  type PBLProjectPackageEntry,
  type PBLV3Reference,
} from '@openmaic/dsl';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';

const safePath = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 240 &&
  !/[\\\x00-\x1f\x7f:%]/.test(v) &&
  !v.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p.trim() !== p);
async function call(body: unknown) {
  const response = await fetch('/api/pbl/v3/packages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Project resource operation failed.');
  return result;
}
function projectScenes(manifest: ClassroomManifest) {
  return manifest.scenes.filter(
    (s) => s.content?.type === 'pbl' && s.content.projectV3 !== undefined,
  );
}
export function validateClassroomPackageCompatibility(manifest: ClassroomManifest) {
  if (![1, 2].includes(manifest.formatVersion))
    throw new Error(`Unsupported classroom format version: ${manifest.formatVersion}`);
  if (
    manifest.requiredCapabilities !== undefined &&
    (!Array.isArray(manifest.requiredCapabilities) ||
      manifest.requiredCapabilities.some((c) => c !== PBL_PROJECT_PACKAGE_CAPABILITY))
  )
    throw new Error('This classroom requires unsupported import capabilities.');
  if (
    manifest.pblProjects !== undefined &&
    (!Array.isArray(manifest.pblProjects) || manifest.pblProjects.length > 16)
  )
    throw new Error('Invalid or excessive project package index.');
  if (
    manifest.pblProjects?.length &&
    (manifest.formatVersion !== 2 ||
      !manifest.requiredCapabilities?.includes(PBL_PROJECT_PACKAGE_CAPABILITY))
  )
    throw new Error('Project packages require classroom v2 and pbl-v3-projects@1.');
  if (
    manifest.formatVersion === 2 &&
    projectScenes(manifest).length &&
    !manifest.pblProjects?.length
  )
    throw new Error('PBL scenes are missing their project resources.');
}
export async function attachClassroomProjects(
  stageId: string,
  manifest: ClassroomManifest,
  files: Map<string, Blob>,
) {
  const scenes = projectScenes(manifest);
  if (!scenes.length) return;
  const refs = [
    ...new Map(
      scenes.map((s) => {
        const ref = (s.content as { projectV3: PBLV3Reference }).projectV3;
        return [JSON.stringify(ref), ref] as const;
      }),
    ).values(),
  ];
  if (refs.length > 16 || !refs.every(isPBLV3Reference))
    throw new Error('Invalid or excessive PBL project references.');
  const { projects }: { projects: PBLProjectPackage[] } = await call({
    action: 'export',
    stageId,
    refs,
  });
  if (!Array.isArray(projects) || projects.length !== refs.length)
    throw new Error('Incomplete project export.');
  const byRef = new Map(refs.map((ref, i) => [JSON.stringify(ref), projects[i]]));
  manifest.pblProjects = [...new Map(projects.map((p) => [p.entry.checksum, p.entry])).values()];
  manifest.formatVersion = 2;
  manifest.requiredCapabilities = [PBL_PROJECT_PACKAGE_CAPABILITY];
  for (const scene of scenes) {
    const content = scene.content as { type: 'pbl'; projectV3: PBLV3Reference };
    const { entry } = byRef.get(JSON.stringify(content.projectV3))!;
    scene.content = {
      ...content,
      projectV3: { id: entry.id, version: entry.version, packageId: entry.checksum },
    };
  }
  for (const project of projects)
    for (const [name, text] of Object.entries(project.files))
      files.set(
        `${project.entry.root}/${name}`,
        new Blob([text], { type: 'text/plain;charset=utf-8' }),
      );
}
/** Bound decompression by the central directory before reading project payloads. */
export async function readClassroomProjects(
  zip: JSZip,
  entries: PBLProjectPackageEntry[],
): Promise<PBLProjectPackage[]> {
  let count = 0,
    total = 0;
  const paths = new Set<string>(),
    projects: PBLProjectPackage[] = [];
  for (const entry of entries) {
    if (
      !entry ||
      !/^[a-f0-9]{64}$/.test(entry.checksum) ||
      entry.root !== `pbl/${entry.checksum}` ||
      entry.entrypoint !== 'project.json' ||
      !entry.files ||
      typeof entry.files !== 'object'
    )
      throw new Error('Invalid project file index.');
    const files: Record<string, string> = {};
    for (const [name, info] of Object.entries(entry.files)) {
      if (
        !safePath(name) ||
        !info ||
        !Number.isSafeInteger(info.size) ||
        info.size < 0 ||
        info.size > 512 * 1024 ||
        !/^[a-f0-9]{64}$/.test(info.sha256)
      )
        throw new Error(`Invalid project file index: ${name}`);
      const path = `${entry.root}/${name}`;
      if (paths.has(path)) throw new Error(`Duplicate project resource: ${path}`);
      paths.add(path);
      count++;
      total += info.size;
      if (count > 512 || total > 8 * 1024 * 1024)
        throw new Error('Classroom project resources exceed the import limit.');
      const file = zip.file(path);
      const internal = file as unknown as {
        unsafeOriginalName?: string;
        _data?: { uncompressedSize?: number };
        unixPermissions?: number;
      };
      if (
        !file ||
        (internal.unsafeOriginalName !== undefined && internal.unsafeOriginalName !== path) ||
        (internal._data?.uncompressedSize !== info.size &&
          !(info.size === 0 && internal._data?.uncompressedSize === undefined)) ||
        (Number(internal.unixPermissions) & 0o170000) === 0o120000
      )
        throw new Error(`Missing, unsafe or oversized project resource: ${path}`);
    }
    for (const name of Object.keys(entry.files)) {
      const bytes = await zip.file(`${entry.root}/${name}`)!.async('uint8array');
      if (bytes.byteLength !== entry.files[name].size)
        throw new Error(`Project file size mismatch: ${name}`);
      files[name] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    projects.push({ entry, files });
  }
  for (const file of Object.values(zip.files)) {
    const original =
      (file as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? file.name;
    if (
      (file.name.startsWith('pbl/') || original.startsWith('pbl/')) &&
      (!safePath(original.replace(/\/$/, '')) ||
        (!file.dir && !paths.has(file.name)) ||
        original !== file.name)
    )
      throw new Error(`Unindexed or unsafe project resource: ${original}`);
  }
  return projects;
}
export async function installClassroomProjects(zip: JSZip, manifest: ClassroomManifest) {
  validateClassroomPackageCompatibility(manifest);
  if (!manifest.pblProjects?.length) {
    if (
      projectScenes(manifest).some((s) => {
        const ref = (s.content as { projectV3: PBLV3Reference }).projectV3;
        return !isPBLV3Reference(ref) || ref.assetId || ref.packageId;
      })
    )
      throw new Error('PBL project resources are missing from this archive.');
    return;
  }
  const projects = await readClassroomProjects(zip, manifest.pblProjects);
  const { references }: { references: PBLV3Reference[] } = await call({
    action: 'install',
    projects,
    scenes: projectScenes(manifest),
  });
  const byChecksum = new Map(references.map((ref) => [ref.checksum, ref]));
  for (const scene of projectScenes(manifest)) {
    const content = scene.content as { type: 'pbl'; projectV3: PBLV3Reference };
    const ref = byChecksum.get(content.projectV3.packageId);
    if (
      !ref ||
      !isPBLV3Reference(ref) ||
      ref.id !== content.projectV3.id ||
      ref.version !== content.projectV3.version
    )
      throw new Error('A scene could not be bound to its installed project.');
    scene.content = { ...content, projectV3: ref };
  }
}
