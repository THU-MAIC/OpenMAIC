import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import type { ApplicationObservation } from '@/lib/pbl/v3/application';
import { SandboxService } from '@/lib/server/sandbox/service';
import {
  learningWorkspaceId,
  withLearningWorkspaceAccess,
} from '@/lib/server/sandbox/managed-workspace';
import { previewConfig } from '@/lib/server/sandbox/preview';
import { SandboxError, sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';
import { LearningStore, type Study } from './store';
import { busy, projectFor, readFiles, requireEnvironment, stageKey } from './runtime';
import {
  assertEnvironmentReady,
  assertEnvironmentWritable,
  environmentReleaseCommitted,
  touchEnvironment,
} from './environment';
import { projectFiles } from './workspace-files';
import type { InstalledProject } from './catalog';
import { applicationLaunchCommand, applicationProbeCommand } from './application-command';
import { additionalBuildSources } from './build-command';
export { applicationProbeCommand } from './application-command';

const active = (state: string) => ['starting', 'running', 'unknown'].includes(state);
export function applicationFingerprint(files: Record<string, string>) {
  const hash = createHash('sha256');
  for (const path of Object.keys(files)
    .filter((path) => path !== 'PLAN.md')
    .sort())
    hash.update(path + '\0' + files[path] + '\0');
  return hash.digest('hex');
}

/** The gateway has a signed grant, not a request-owner context or a teaching scope. */
export async function assertLearningPreview(
  ownerId: string,
  workspaceId: string,
  environmentId: string,
  port: number,
) {
  const row = await (await LearningStore.open()).get(workspaceId.slice(4), ownerId);
  const project = projectFor(row);
  const application = project.application;
  if (!application || application.port !== port)
    throw new SandboxError('PBL_WORKSPACE_MANAGED', 409, 'Application access was revoked.');
  if (
    learningWorkspaceId(row.id) !== workspaceId ||
    row.environment_id !== environmentId ||
    environmentReleaseCommitted(row, environmentId)
  )
    throw sandboxConflict('Application access was revoked.', 'ENVIRONMENT_CHANGED');
  return application.frontendPath ? project.files[application.frontendPath] : undefined;
}

/** Only the authenticated gateway's coalesced, real-input signal calls this. Resolving/polling never does. */
export async function recordLearningPreviewActivity(
  ownerId: string,
  workspaceId: string,
  environmentId: string,
  port: number,
) {
  await assertLearningPreview(ownerId, workspaceId, environmentId, port);
  await (await LearningStore.open()).recordActivity(workspaceId.slice(4), ownerId);
}

interface ApplicationRun {
  environmentId: string;
  epoch: number;
  commandId: string;
  sourceHash: string;
  /** Java inputs are resolved once so a retry dispatches the original command. */
  launchCommand?: string;
  /** Absent on legacy receipts; new launches are ordered under the existing study lock. */
  launchSequence?: number;
  startedAt: string;
}
function launchCommand(project: InstalledProject, argv: string[], paths: readonly string[]) {
  const runtime = project.coursePackage?.descriptor.runtime;
  const sources =
    runtime?.profile === 'java'
      ? [
          ...(runtime.buildSources ??
            Object.keys(project.files).filter((path) => path.endsWith('.java'))),
          ...additionalBuildSources(project, paths, '.java'),
        ]
      : undefined;
  return applicationLaunchCommand(argv, sources);
}

async function lastRun(store: LearningStore, row: Study): Promise<ApplicationRun | null> {
  const result = await store.pool.query<{ result: ApplicationRun }>(
    `SELECT result FROM pbl_v3_commands WHERE study_id=$1 AND id LIKE 'application:%'
       AND result->>'environmentId'=$2
       ORDER BY COALESCE((result->>'launchSequence')::bigint,0) DESC,
         result->>'startedAt' DESC,id DESC LIMIT 1`,
    [row.id, requireEnvironment(row)],
  );
  return result.rows[0]?.result ?? null;
}

/** A start intent can commit before its command reservation. Absence proves no dispatch. */
async function applicationCommand(
  store: LearningStore,
  row: Study,
  run: ApplicationRun,
  service: SandboxService,
  signal?: AbortSignal,
) {
  const recorded = await store.pool.query(
    'SELECT id FROM sandbox_commands WHERE environment_id=$1 AND id=$2',
    [requireEnvironment(row), run.commandId],
  );
  return recorded.rows.length
    ? service.command(requireEnvironment(row), run.commandId, signal)
    : null;
}

/** Runs a fixed probe in a narrow command scope. Never starts an app. */
export async function inspectApplication(
  store: LearningStore,
  row: Study,
  service: SandboxService,
  signal?: AbortSignal,
  capturedRun?: { run: ApplicationRun | null },
): Promise<ApplicationObservation> {
  const application = projectFor(row).application;
  if (!application) throw sandboxInvalid('This project does not declare an application.');
  const observedAt = new Date().toISOString(),
    environmentId = requireEnvironment(row);
  const run = capturedRun ? capturedRun.run : await lastRun(store, row);
  if (!run || run.epoch !== (await service.workspaceEpoch(environmentId)))
    return { observedAt, state: 'stopped' };
  const command = await applicationCommand(store, row, run, service, signal);
  if (!command) return { observedAt, state: 'stopped', commandState: 'not-started' };
  if (!active(command.state))
    return {
      observedAt,
      state:
        command.exitCode === 0 || ['cancelled', 'timed_out'].includes(command.state)
          ? 'stopped'
          : 'failed',
      commandState: command.state,
      exitCode: command.exitCode,
      output: (command.stdout + '\n' + command.stderr).slice(-2000).trim(),
    };
  const paths = await projectFiles(service, environmentId, projectFor(row), signal);
  let stdout: string;
  if (capturedRun) {
    stdout = await service.observeApplication(
      environmentId,
      run.epoch,
      paths,
      application.port,
      application.healthPath,
      signal,
    );
  } else {
    const id = randomUUID();
    let probe = await service.startCommand(
      environmentId,
      {
        requestId: id,
        command: applicationProbeCommand(paths, application.port, application.healthPath),
        timeoutMs: 5_000,
      },
      run.epoch,
    );
    const deadline = Date.now() + 8_000;
    while (active(probe.state) && Date.now() < deadline) {
      await delay(100, undefined, { signal });
      probe = await service.command(environmentId, id, signal);
    }
    if (active(probe.state)) {
      await service.cancelCommand(environmentId, id);
      return { observedAt, state: 'unknown' };
    }
    stdout = probe.stdout;
  }
  try {
    const data = z
      .object({ sourceHash: z.string(), httpStatus: z.number().int().optional() })
      .parse(JSON.parse(stdout));
    return {
      observedAt,
      state: data.httpStatus === undefined ? 'starting' : 'running',
      httpStatus: data.httpStatus,
      sourceChanged: data.sourceHash !== run.sourceHash,
      ...(capturedRun ? { runId: run.commandId } : {}),
    };
  } catch {
    return { observedAt, state: 'unknown' };
  }
}

const requestSchema = z
  .object({
    studyId: z.string().uuid(),
    id: z.string().uuid(),
    environmentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    action: z.enum(['open', 'restart', 'status', 'stop', 'frontend']),
  })
  .strict();
type ApplicationRequest = z.infer<typeof requestSchema>;

function assertObservationRevision(row: Study, request: ApplicationRequest) {
  if (row.environment_id !== request.environmentId || row.revision !== request.revision)
    throw sandboxConflict(
      'The learning workspace changed. Refresh before continuing.',
      'PROGRESS_CHANGED',
    );
  if (row.evaluation) throw sandboxConflict('Wait for the current assessment.', 'STUDY_BUSY');
}

async function observeStandaloneApplication(
  store: LearningStore,
  row: Study,
  service: SandboxService,
  request: ApplicationRequest,
): Promise<ApplicationObservation> {
  const environmentId = request.environmentId;
  const scope = {
    ownerId: row.owner_id,
    workspaceId: learningWorkspaceId(row.id),
    environmentIds: () => [environmentId],
    operations: ['command'] as const,
  };
  const assertCurrent = async () => {
    const current = await store.get(row.id, row.owner_id);
    assertObservationRevision(current, request);
    await assertEnvironmentWritable(store, row.id, row.owner_id, environmentId);
    assertEnvironmentReady(await service.get(environmentId));
    if ((await service.workspaceEpoch(environmentId)) !== request.epoch)
      throw sandboxConflict(
        'Workspace was stopped. Refresh before continuing.',
        'WORKSPACE_STOPPED',
      );
  };
  return withLearningWorkspaceAccess(scope, async () => {
    await assertCurrent();
    const run = await lastRun(store, row);
    const observation = await inspectApplication(store, row, service, undefined, { run });
    // A source writer can stop the application before it commits a new teaching revision.
    // Recheck the process as well as the revision and launch receipt.
    if (run && (observation.state === 'running' || observation.state === 'starting')) {
      const command = await applicationCommand(store, row, run, service);
      if (!command || !active(command.state))
        throw sandboxConflict(
          'The application changed during the status check.',
          'PROGRESS_CHANGED',
        );
    }
    await assertCurrent();
    const currentRun = await lastRun(store, row);
    if (currentRun?.commandId !== run?.commandId)
      throw sandboxConflict('The application changed during the status check.', 'PROGRESS_CHANGED');
    if (run && (observation.state === 'running' || observation.state === 'starting'))
      await service.assertApplicationObservation(environmentId, run.epoch, run.commandId);
    return observation;
  });
}

export async function applicationRequest(principal: OwnerPrincipal, input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success)
    throw sandboxInvalid('A current study, environment, revision and request ID are required.');
  const request = parsed.data,
    store = await LearningStore.open();
  if (request.action === 'frontend') {
    const row = await store.get(request.studyId, principal.ownerId);
    const application = projectFor(row).application;
    if (!application?.frontendPath)
      throw sandboxInvalid('This project has no standalone frontend.');
    if (row.environment_id !== request.environmentId)
      throw sandboxConflict('The learning environment changed.', 'ENVIRONMENT_CHANGED');
    // A document ticket does not start a process or depend on the teaching revision.
    await assertEnvironmentWritable(store, row.id, row.owner_id, request.environmentId);
    const service = await SandboxService.forOwner(principal);
    return withLearningWorkspaceAccess(
      {
        ownerId: row.owner_id,
        workspaceId: learningWorkspaceId(row.id),
        environmentIds: () => [request.environmentId],
        operations: ['preview'],
      },
      async () => ({
        observedAt: new Date().toISOString(),
        state: 'stopped' as const,
        preview: await service.preview(request.environmentId, application.port, request.epoch),
      }),
    );
  }
  if (request.action === 'status') {
    const row = await store.get(request.studyId, principal.ownerId);
    if (projectFor(row).application?.frontendPath)
      return observeStandaloneApplication(
        store,
        row,
        await SandboxService.forOwner(principal),
        request,
      );
  }
  // Standalone startup may wait on a slow provider lease check. Do it before
  // taking the study lock and recheck the learning binding at admission.
  const opening = request.action === 'open' || request.action === 'restart';
  const preflight = opening ? await store.get(request.studyId, principal.ownerId) : null;
  const preflightProject = preflight && projectFor(preflight);
  const standaloneService = preflightProject?.application?.frontendPath
    ? await SandboxService.forOwner(principal)
    : null;
  if (preflight && preflightProject?.application && standaloneService) {
    assertObservationRevision(preflight, request);
    if (request.action === 'restart' && (await busy(store, preflight)))
      throw sandboxConflict('Wait for the current Agent or assessment.', 'STUDY_BUSY');
    await assertEnvironmentWritable(store, preflight.id, preflight.owner_id, request.environmentId);
    assertEnvironmentReady(await touchEnvironment(store, preflight, standaloneService));
    const application = preflightProject.application;
    const paths = await projectFiles(standaloneService, request.environmentId, preflightProject);
    applicationProbeCommand(paths, application.port, application.healthPath);
    if (application.argv[0] === 'java') launchCommand(preflightProject, application.argv, paths);
  }
  const result = await store.exclusive(request.studyId, async () => {
    const row = await store.get(request.studyId, principal.ownerId),
      project = projectFor(row),
      application = project.application;
    if (!application) throw sandboxInvalid('This project does not declare an application.');
    if (row.environment_id !== request.environmentId || row.revision !== request.revision)
      throw sandboxConflict(
        'The learning workspace changed. Refresh before continuing.',
        'PROGRESS_CHANGED',
      );
    if (
      row.evaluation ||
      (['restart', 'stop'].includes(request.action) && (await busy(store, row)))
    )
      throw sandboxConflict('Wait for the current Agent or assessment.', 'STUDY_BUSY');
    const service = standaloneService ?? (await SandboxService.forOwner(principal)),
      environmentId = requireEnvironment(row);
    assertEnvironmentReady(
      standaloneService
        ? await service.get(environmentId)
        : await touchEnvironment(store, row, service),
    );
    if ((await service.workspaceEpoch(environmentId)) !== request.epoch)
      throw sandboxConflict(
        'Workspace was stopped. Refresh before continuing.',
        'WORKSPACE_STOPPED',
      );
    if (request.action === 'open' || request.action === 'restart') previewConfig();
    await assertEnvironmentWritable(store, row.id, row.owner_id, environmentId);
    const scope = {
      ownerId: row.owner_id,
      workspaceId: learningWorkspaceId(row.id),
      environmentIds: () => [environmentId],
      operations: ['command', 'preview'] as const,
    };
    return withLearningWorkspaceAccess(scope, async () => {
      let dispatch: (() => Promise<unknown>) | undefined;
      const launch = async (run: ApplicationRun) => {
        const body = {
          requestId: run.commandId,
          command:
            run.launchCommand ??
            launchCommand(
              project,
              application.argv,
              application.argv[0] === 'java'
                ? await projectFiles(service, environmentId, project)
                : [],
            ),
        };
        if (application.frontendPath)
          dispatch = await service.prepareApplicationCommand(environmentId, body, request.epoch);
        else await service.startApplicationCommand(environmentId, body, request.epoch);
      };
      if (request.action === 'stop') {
        await service.stopApplications(environmentId);
        return {
          observedAt: new Date().toISOString(),
          state: 'stopped',
        } satisfies ApplicationObservation;
      }
      if (request.action !== 'status') {
        // Learner-created/renamed source paths can outgrow the starter budget.
        // Reject before stopping an existing app, reserving a writer or dispatching.
        if (!standaloneService) {
          const paths = await projectFiles(service, environmentId, project);
          applicationProbeCommand(paths, application.port, application.healthPath);
          if (application.argv[0] === 'java') launchCommand(project, application.argv, paths);
        }
        // A durable reservation precedes provider dispatch. A retry cannot restart a lost-ack command.
        const receiptId = `application:${request.id}`,
          hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
        const receipt = (
          await store.pool.query<{ hash: string; result: ApplicationRun }>(
            'SELECT hash,result FROM pbl_v3_commands WHERE study_id=$1 AND id=$2',
            [row.id, receiptId],
          )
        ).rows[0];
        if (receipt && receipt.hash !== hash)
          throw sandboxConflict('Request ID was reused with different input.');
        const previous = await lastRun(store, row);
        const previousCommand =
          previous && previous.epoch === request.epoch
            ? await applicationCommand(store, row, previous, service)
            : null;
        const running = previousCommand && active(previousCommand.state);
        if (!receipt && (request.action === 'restart' || !running)) {
          await service.stopApplications(environmentId);
          const files = await readFiles(service, row);
          // Shutdown hooks can create sources too; check the quiesced snapshot.
          applicationProbeCommand(
            Object.keys(files).sort(),
            application.port,
            application.healthPath,
          );
          const run: ApplicationRun = {
            environmentId,
            epoch: request.epoch,
            commandId: request.id,
            sourceHash: applicationFingerprint(files),
            ...(application.argv[0] === 'java'
              ? { launchCommand: launchCommand(project, application.argv, Object.keys(files)) }
              : {}),
            startedAt: new Date().toISOString(),
          };
          // Invalidate an in-flight archive even if this writer exits before publication.
          await store.markWorkspaceWriter(row);
          // Allocate in the existing receipt under the cross-process study lock.
          // Wall-clock timestamps (even identical ones) never order new launches.
          await store.pool.query(
            `INSERT INTO pbl_v3_commands(study_id,id,hash,result,stage_key)
               SELECT $1,$2,$3,$4::jsonb || jsonb_build_object(
                 'launchSequence',COALESCE(MAX((result->>'launchSequence')::bigint),0)+1),$5
               FROM pbl_v3_commands WHERE study_id=$1 AND id LIKE 'application:%'`,
            [row.id, receiptId, hash, JSON.stringify(run), stageKey(row)],
          );
          await launch(run);
        }
        if (receipt && previous?.commandId === receipt.result.commandId) {
          // A committed intent may not have dispatched yet. Fence archive publication again.
          await store.markWorkspaceWriter(row);
          await launch(receipt.result);
        }
        await store.recordActivity(row.id, row.owner_id);
      }
      if (application.frontendPath)
        return async () => {
          if (dispatch)
            await withLearningWorkspaceAccess(scope, async () => {
              await assertEnvironmentWritable(store, row.id, row.owner_id, environmentId);
              await dispatch!();
            });
          return observeStandaloneApplication(store, row, service, request);
        };
      const observation = await inspectApplication(store, row, service);
      return {
        ...observation,
        ...(request.action !== 'status' && observation.state === 'running'
          ? { preview: await service.preview(environmentId, application.port, request.epoch) }
          : {}),
      };
    });
  });
  return typeof result === 'function' ? result() : result;
}
