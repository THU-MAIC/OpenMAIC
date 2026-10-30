import type JSZip from 'jszip';
import {
  isPBLV3Reference,
  PBL_PROJECT_PACKAGE_CAPABILITY,
  type PBLProjectPackage,
  type PBLProjectPackageEntry,
  type PBLV3Reference,
} from '@openmaic/dsl';
import type { ClassroomManifest } from '@/lib/export/classroom-zip-types';
import { PROJECT_LIMITS, projectResourcesWithinLimits, safeProjectPath } from './package-policy';
import { projectSchema } from './domain/project/project-schema';

import { APPLICATION_CAPABILITY } from './application';

function needsApplication(projects: readonly PBLProjectPackage[]) {
  return projects.some(
    (project) => JSON.parse(project.files['project.json'])?.runtime?.application !== undefined,
  );
}

export const DECISION_RESPONSE_CAPABILITY = 'pbl-v3-decision-responses@1';
export const PRESENTATION_CAPABILITY = 'pbl-v3-presentation@1';
function needsPresentation(projects: readonly PBLProjectPackage[]) {
  return projects.some(
    (project) => JSON.parse(project.files['project.json'])?.definition?.presentation !== undefined,
  );
}
function needsDecisionResponses(projects: readonly PBLProjectPackage[]) {
  return projects
    .map((project) => {
      let descriptor: unknown;
      try {
        descriptor = JSON.parse(project.files['project.json']);
      } catch {
        throw new Error('Invalid JSON in project.json.');
      }
      const definition = projectSchema.safeParse(
        descriptor && typeof descriptor === 'object' && 'definition' in descriptor
          ? descriptor.definition
          : undefined,
      );
      if (!definition.success) throw new Error('Invalid project definition in project.json.');
      return definition.data;
    })
    .some((definition) =>
      definition.decisions.some(
        (decision) => decision.responseType === 'text' || decision.requiresRationale === true,
      ),
    );
}

async function call(body: unknown) {
  const response = await fetch('/api/pbl/v3/packages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error?.message ?? 'Project resource operation failed.'), {
      code: result.error?.code,
      status: response.status,
    });
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
      manifest.requiredCapabilities.some(
        (c) =>
          ![
            PBL_PROJECT_PACKAGE_CAPABILITY,
            DECISION_RESPONSE_CAPABILITY,
            APPLICATION_CAPABILITY,
            PRESENTATION_CAPABILITY,
          ].includes(c),
      ))
  )
    throw new Error('This classroom requires unsupported import capabilities.');
  if (
    manifest.pblProjects !== undefined &&
    (!Array.isArray(manifest.pblProjects) || manifest.pblProjects.length > PROJECT_LIMITS.projects)
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
  if (scenes.length > PROJECT_LIMITS.scenes)
    throw new Error('Classroom project scenes exceed the export limit.');
  const refs = [
    ...new Map(
      scenes.map((s) => {
        const ref = (s.content as { projectV3: PBLV3Reference }).projectV3;
        return [JSON.stringify(ref), ref] as const;
      }),
    ).values(),
  ];
  if (refs.length > PROJECT_LIMITS.scenes || !refs.every(isPBLV3Reference))
    throw new Error('Invalid or excessive PBL project references.');
  const { projects, projectIndexes }: { projects: PBLProjectPackage[]; projectIndexes?: number[] } =
    await call({
      action: 'export',
      stageId,
      refs,
    });
  // Older servers return one project per reference; current servers deduplicate the payload.
  const indexes = projectIndexes ?? refs.map((_, index) => index);
  if (
    !Array.isArray(projects) ||
    !Array.isArray(indexes) ||
    indexes.length !== refs.length ||
    (projectIndexes === undefined && projects.length !== refs.length) ||
    indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= projects.length)
  )
    throw new Error('Incomplete project export.');
  if (!projectResourcesWithinLimits(projects.map(({ entry }) => entry)))
    throw new Error('Classroom project resource limit exceeded.');
  const byRef = new Map(refs.map((ref, i) => [JSON.stringify(ref), projects[indexes[i]]]));
  manifest.pblProjects = [...new Map(projects.map((p) => [p.entry.checksum, p.entry])).values()];
  manifest.formatVersion = 2;
  manifest.requiredCapabilities = [PBL_PROJECT_PACKAGE_CAPABILITY];
  if (needsDecisionResponses(projects))
    manifest.requiredCapabilities.push(DECISION_RESPONSE_CAPABILITY);
  if (needsApplication(projects)) manifest.requiredCapabilities.push(APPLICATION_CAPABILITY);
  if (needsPresentation(projects)) manifest.requiredCapabilities.push(PRESENTATION_CAPABILITY);
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
        !safeProjectPath(name) ||
        !info ||
        !Number.isSafeInteger(info.size) ||
        info.size < 0 ||
        info.size > PROJECT_LIMITS.fileBytes ||
        !/^[a-f0-9]{64}$/.test(info.sha256)
      )
        throw new Error(`Invalid project file index: ${name}`);
      const path = `${entry.root}/${name}`;
      if (paths.has(path)) throw new Error(`Duplicate project resource: ${path}`);
      paths.add(path);
      count++;
      total += info.size;
      if (count > PROJECT_LIMITS.files || total > PROJECT_LIMITS.bytes)
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
      (!safeProjectPath(original.replace(/\/$/, '')) ||
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
  if (
    needsDecisionResponses(projects) &&
    !manifest.requiredCapabilities?.includes(DECISION_RESPONSE_CAPABILITY)
  )
    throw new Error('Decision response forms require pbl-v3-decision-responses@1.');
  if (
    needsPresentation(projects) &&
    !manifest.requiredCapabilities?.includes(PRESENTATION_CAPABILITY)
  )
    throw new Error('Project presentation requires pbl-v3-presentation@1.');
  if (
    needsApplication(projects) &&
    !manifest.requiredCapabilities?.includes(APPLICATION_CAPABILITY)
  )
    throw new Error('Application previews require pbl-v3-application@1.');
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
