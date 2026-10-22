import { isPBLV3Reference, type PBLV3Reference } from '@openmaic/dsl';
import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import { validateProjectPackage } from '@/lib/server/pbl-v3/project-package';
import { PROJECT_LIMITS, projectResourcesWithinLimits } from '@/lib/pbl/v3/package-policy';
import {
  exportProjectPackage,
  installProjectPackage,
  bindPackageReferences,
} from '@/lib/server/pbl-v3/project-resolver';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  return sandboxPrincipalResponse(request, async ({ ownerId }) => {
    const body = await sandboxBody(request, 32 * 1024 * 1024);
    if (body.action === 'export') {
      if (
        typeof body.stageId !== 'string' ||
        !Array.isArray(body.refs) ||
        body.refs.length > PROJECT_LIMITS.scenes ||
        !body.refs.every(isPBLV3Reference)
      )
        throw sandboxInvalid('A classroom and valid project references are required.');
      const projects = [];
      const projectIndexes = [];
      const byReference = new Map<string, number>();
      const byChecksum = new Map<string, number>();
      for (const ref of body.refs as PBLV3Reference[]) {
        const key = JSON.stringify([ref.id, ref.version, ref.assetId, ref.checksum, ref.packageId]);
        let index = byReference.get(key);
        if (index === undefined) {
          // Authorize every distinct pin, but serialize shared content only once.
          const project = await exportProjectPackage(ownerId, body.stageId, ref);
          index = byChecksum.get(project.entry.checksum);
          if (index === undefined) {
            index = projects.length;
            projects.push(project);
            byChecksum.set(project.entry.checksum, index);
          }
          byReference.set(key, index);
        }
        projectIndexes.push(index);
        if (!projectResourcesWithinLimits(projects.map(({ entry }) => entry)))
          throw sandboxInvalid('Classroom project resource limit exceeded.');
      }
      return Response.json({ projects, projectIndexes });
    }
    if (
      body.action !== 'install' ||
      !Array.isArray(body.projects) ||
      !body.projects.length ||
      body.projects.length > PROJECT_LIMITS.projects ||
      !Array.isArray(body.scenes)
    )
      throw sandboxInvalid('Project packages and their scene bindings are required.');
    if (
      !body.scenes.length ||
      body.scenes.length > PROJECT_LIMITS.scenes ||
      body.scenes.some(
        (s) =>
          !s ||
          s.content?.type !== 'pbl' ||
          !isPBLV3Reference(s.content.projectV3) ||
          !s.content.projectV3.packageId,
      )
    )
      throw sandboxInvalid('Valid packaged PBL scene bindings are required.');
    const projects = body.projects.map((input) => validateProjectPackage(input).bundle);
    const refs = new Map(
      projects.map(({ entry }) => [entry.checksum, { id: entry.id, version: entry.version }]),
    );
    if (refs.size !== projects.length)
      throw sandboxInvalid('Project packages must be deduplicated.');
    bindPackageReferences(body.scenes, refs);
    const used = new Set(
      body.scenes.flatMap((s) =>
        s?.content?.projectV3?.packageId ? [s.content.projectV3.packageId] : [],
      ),
    );
    if (used.size !== projects.length)
      throw sandboxInvalid('Unreferenced project resources are not permitted.');
    if (!projectResourcesWithinLimits(projects.map(({ entry }) => entry)))
      throw sandboxInvalid('Classroom project resource limit exceeded.');
    const installed = [];
    for (const project of projects) installed.push(await installProjectPackage(ownerId, project));
    return Response.json({ references: installed });
  });
}
