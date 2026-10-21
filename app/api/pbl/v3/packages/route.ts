import { isPBLV3Reference, type PBLV3Reference } from '@openmaic/dsl';
import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import { PROJECT_LIMITS, validateProjectPackage } from '@/lib/server/pbl-v3/project-package';
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
        body.refs.length > PROJECT_LIMITS.projects ||
        !body.refs.every(isPBLV3Reference)
      )
        throw sandboxInvalid('A classroom and valid project references are required.');
      const projects = [];
      for (const ref of body.refs as PBLV3Reference[])
        projects.push(await exportProjectPackage(ownerId, body.stageId, ref));
      return Response.json({ projects });
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
      body.scenes.length > 256 ||
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
    if (
      projects.reduce((n, p) => n + Object.keys(p.files).length, 0) > PROJECT_LIMITS.files ||
      projects.reduce(
        (n, p) => n + Object.values(p.entry.files).reduce((n, f) => n + f.size, 0),
        0,
      ) > PROJECT_LIMITS.bytes
    )
      throw sandboxInvalid('Classroom project resource limit exceeded.');
    const installed = [];
    for (const project of projects) installed.push(await installProjectPackage(ownerId, project));
    return Response.json({ references: installed });
  });
}
