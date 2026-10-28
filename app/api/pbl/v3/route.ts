import { canViewProjectReport } from '@/lib/server/pbl-v3/stage-progress';
import { latestFileChanges } from '@/lib/server/pbl-v3/file-changes';
import { isPBLV3Reference } from '@/lib/pbl/v3/types';
import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { SandboxService } from '@/lib/server/sandbox/service';
import { sandboxInvalid, SandboxError } from '@/lib/sandbox/errors';
import {
  openStudy,
  commandStudy,
  learningView,
  digest,
  projectFor,
  requireEnvironment,
} from '@/lib/server/pbl-v3/runtime';
import type { LearningCommand } from '@/lib/server/pbl-v3/runtime';
import { LearningStore } from '@/lib/server/pbl-v3/store';
import { InvalidEngineTransitionError } from '@/lib/pbl/v3/domain/orchestration/transition';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { touchEnvironment, assertEnvironmentReady } from '@/lib/server/pbl-v3/environment';
import { assertProjectSource } from '@/lib/server/pbl-v3/workspace-files';
import { resolveProject } from '@/lib/server/pbl-v3/project-resolver';
import { projectHeroDetails } from '@/lib/server/pbl-v3/project-hero';
import { installedProject, publicProjects } from '@/lib/server/pbl-v3/catalog';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    if (new URL(request.url).searchParams.get('samples') === '1')
      return Response.json(publicProjects());
    const params = new URL(request.url).searchParams,
      id = params.get('id');
    if (params.get('project') === '1') {
      const stageId = params.get('stageId'),
        sceneId = params.get('sceneId');
      if (!stageId || !sceneId) throw sandboxInvalid('A classroom and scene are required.');
      const studies = await LearningStore.open();
      const existing = await studies.findForScene(principal.ownerId, stageId, sceneId);
      let project;
      if (existing) project = projectFor(existing);
      else {
        const documents = await getOwnerScopedDocumentStore(principal);
        const scene = await documents.getScene(stageId, sceneId);
        const content = scene?.content as { type?: string; projectV3?: unknown } | undefined;
        if (content?.type !== 'pbl' || !isPBLV3Reference(content.projectV3))
          throw new SandboxError(
            'PBL_NOT_FOUND',
            404,
            'The classroom does not contain this learning project.',
          );
        project = await resolveProject(
          principal.ownerId,
          stageId,
          content.projectV3,
          undefined,
          sceneId,
        );
      }
      return Response.json({
        hero: projectHeroDetails(project.definition),
        started: !!existing,
        studyId: existing?.id ?? null,
        reportAvailable: existing ? canViewProjectReport(existing.state) : false,
      });
    }
    if (!id) throw sandboxInvalid('A learning session is required.');
    const path = params.get('file');
    if (path !== null) {
      const store = await LearningStore.open();
      const row = await store.get(id, principal.ownerId);
      assertProjectSource(projectFor(row), path);
      const service = await SandboxService.forOwner(principal);
      assertEnvironmentReady(await touchEnvironment(store, row, service, false));
      const text = await service.readText(requireEnvironment(row), path);
      const hash = digest(text);
      const changes = await latestFileChanges(store.pool, row.id, path, hash);
      return Response.json({ text, hash, changes });
    }
    return Response.json(await learningView(principal, id));
  });
}
export async function POST(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const body = await sandboxBody(request, 256_000);
    try {
      if (body.action === 'sample') {
        if (typeof body.id !== 'string' || !/^pbl-[a-f0-9-]{36}$/.test(body.id))
          throw sandboxInvalid('A stable classroom ID is required.');
        const ref = body.project ?? { id: 'greeting-python', version: '1.0.0' };
        if (!isPBLV3Reference(ref)) throw sandboxInvalid('Select an installed sample.');
        const project = installedProject(ref);
        const documents = await getOwnerScopedDocumentStore(principal);
        const existing = await documents.loadDocument(body.id);
        if (!existing)
          await documents.createDocument({
            stage: {
              id: body.id,
              name: project.definition.title,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            scenes: [
              {
                id: `${body.id}-scene`,
                stageId: body.id,
                title: project.definition.title,
                type: 'pbl',
                order: 0,
                content: { type: 'pbl', projectV3: project.ref },
                actions: [],
              },
            ],
            outline: {
              outlines: [],
              generationComplete: true,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          });
        return Response.json({ classroomId: body.id });
      }
      if (body.action === 'open') {
        if (typeof body.stageId !== 'string' || typeof body.sceneId !== 'string')
          throw sandboxInvalid('A classroom and scene are required.');
        const study = await openStudy(principal, body.stageId, body.sceneId);
        return Response.json(await learningView(principal, study.id));
      }
      if (typeof body.studyId !== 'string') throw sandboxInvalid('A learning session is required.');
      const result = await commandStudy(principal, body.studyId, body.command as LearningCommand);
      return Response.json({ result, view: await learningView(principal, body.studyId) });
    } catch (error) {
      if (error instanceof InvalidEngineTransitionError)
        throw new SandboxError(error.code, 409, error.message);
      throw error;
    }
  });
}
