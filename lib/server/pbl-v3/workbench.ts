import 'server-only';
import { notifyDurableAgentEvent } from '@/lib/server/agent-runtime/event-notify-bus';
import { recordLearningEvidence } from './evidence';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import { projectEditAccess } from '@/lib/pbl/v3/edit-access';
import type { LearningWorkbench } from '@/lib/pbl/v3/workbench';
import { allowedStudentActions } from '@/lib/pbl/v3/domain/orchestration/transition';
import { sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';
import { SandboxService } from '@/lib/server/sandbox/service';
import {
  learningWorkspaceId,
  withLearningWorkspaceAccess,
  type WorkspaceMutation,
} from '@/lib/server/sandbox/managed-workspace';
import { LearningStore, type Study } from './store';
import {
  busy,
  digest,
  invalidateWorkspace,
  projectFor,
  requireEnvironment,
  stageFor,
  stageKey,
} from './runtime';
import { assertProjectSource, projectFiles } from './workspace-files';
import { touchEnvironment, assertEnvironmentReady } from './environment';

async function permissions(store: LearningStore, row: Study) {
  const stage = stageFor(row),
    project = projectFor(row);
  const access = projectEditAccess({
    state: row.state,
    stage,
    actions: allowedStudentActions(project.definition, row.state),
    busy: await busy(store, row),
    evaluation: row.evaluation,
  });
  const canEdit = access.canEdit;
  const planning = access.mode === 'plan';
  const pending = (await store.roles(row.id)).some(
    (b) => b.stage_key === stageKey(row) && b.guided?.pending,
  );
  return {
    canEdit,
    editReason: access.reason,
    planning,
    canManageFiles: canEdit && !planning && !!project.sourceRoots?.length,
    canRun: canEdit && !planning && !pending,
  };
}
export async function workbenchView(
  principal: OwnerPrincipal,
  id: string,
  options: { passive?: boolean } = {},
): Promise<LearningWorkbench> {
  const store = await LearningStore.open(),
    row = await store.get(id, principal.ownerId),
    service = await SandboxService.forOwner(principal);
  assertEnvironmentReady(
    options.passive
      ? await service.get(requireEnvironment(row))
      : await touchEnvironment(store, row, service),
  );
  const environmentId = requireEnvironment(row),
    policy = await permissions(store, row);
  const commands = [];
  for (const command of (await service.listCommands(environmentId)).slice(0, 20))
    commands.push(await service.command(environmentId, command.id));
  const terminals = [];
  for (const terminal of await service.listTerminals(environmentId))
    terminals.push(await service.terminal(environmentId, terminal.id));
  return {
    environmentId,
    revision: row.revision,
    epoch: await service.workspaceEpoch(environmentId),
    ...policy,
    commands,
    terminals,
  };
}
export interface WorkbenchCommand {
  id: string;
  revision: number;
  environmentId: string;
  epoch?: number;
  action: string;
  path?: string;
  destination?: string;
  expectedHash?: string;
  text?: string;
  commandId?: string;
  terminalId?: string;
  data?: string;
  cols?: number;
  rows?: number;
}
/** Uses the same study lock, command receipts and sandbox service as the teaching runtime. */
export async function workbenchCommand(
  principal: OwnerPrincipal,
  id: string,
  command: WorkbenchCommand,
) {
  if (
    !command ||
    typeof command !== 'object' ||
    !/^[a-f0-9-]{36}$/.test(command.id ?? '') ||
    !Number.isSafeInteger(command.revision) ||
    command.revision < 0 ||
    typeof command.environmentId !== 'string'
  )
    throw sandboxInvalid('A request ID, environment and revision are required.');
  const store = await LearningStore.open();
  let row = await store.get(id, principal.ownerId);
  const service = await SandboxService.forOwner(principal);
  if (row.environment_id !== command.environmentId)
    throw sandboxConflict(
      'The learning environment changed. Refresh before continuing.',
      'ENVIRONMENT_CHANGED',
    );
  // Closing/cancelling is control traffic; it must not wait behind a stalled writer.
  if (command.action === 'stop') {
    await service.revokePreviews(command.environmentId);
    for (const cmd of await service.listCommands(command.environmentId))
      if (['starting', 'running', 'unknown'].includes(cmd.state))
        await service.cancelCommand(command.environmentId, cmd.id);
    for (const terminal of await service.listTerminals(command.environmentId))
      if (terminal.state !== 'closed')
        await service.closeTerminal(command.environmentId, terminal.id);
    await notifyDurableAgentEvent(store.pool, { kind: 'session', sessionId: id });
    return { stopped: true };
  }
  if (command.action === 'input') {
    if (typeof command.terminalId !== 'string') throw sandboxInvalid('A terminal is required.');
    return withLearningWorkspaceAccess(
      {
        ownerId: principal.ownerId,
        workspaceId: learningWorkspaceId(id),
        environmentIds: () => [command.environmentId],
        operations: ['terminal'],
      },
      () =>
        service.updateTerminal(
          command.environmentId,
          command.terminalId!,
          command.data !== undefined
            ? { action: 'input', data: command.data }
            : { action: 'resize', cols: command.cols, rows: command.rows },
          async () => {
            const current = await store.get(id, principal.ownerId);
            if (current.environment_id !== command.environmentId)
              throw sandboxConflict('The learning environment changed.', 'ENVIRONMENT_CHANGED');
            if (!(await permissions(store, current)).canRun)
              throw sandboxConflict(
                'Terminal input is unavailable at this stage.',
                'WORKBENCH_ACCESS_DENIED',
              );
          },
        ),
    );
  }
  if (
    ['run', 'terminal'].includes(command.action) &&
    (!Number.isSafeInteger(command.epoch) || command.epoch! < 0)
  )
    throw sandboxInvalid('An observed workspace generation is required.');
  return store.exclusive(id, async () => {
    row = await store.get(id, principal.ownerId);
    if (row.environment_id !== command.environmentId)
      throw sandboxConflict('The learning environment changed.', 'ENVIRONMENT_CHANGED');
    const policy = await permissions(store, row),
      project = projectFor(row),
      environmentId = requireEnvironment(row);
    if (
      ['run', 'terminal'].includes(command.action) &&
      (await service.workspaceEpoch(environmentId)) !== command.epoch
    )
      throw sandboxConflict('Workspace was stopped. Retry the operation.', 'WORKSPACE_STOPPED');
    assertEnvironmentReady(await touchEnvironment(store, row, service));
    const receiptId = `workbench:${command.id}`,
      hash = digest(JSON.stringify(command));
    const receipt = (
      await store.pool.query<{ hash: string; result: unknown; stage_key: string }>(
        'SELECT hash,result,stage_key FROM pbl_v3_commands WHERE study_id=$1 AND id=$2',
        [id, receiptId],
      )
    ).rows[0];
    if (receipt) {
      if (receipt.hash !== hash)
        throw sandboxConflict(
          'This request ID was used for another operation.',
          'PROGRESS_CHANGED',
        );
      if (receipt.result !== null) return receipt.result;
      if (receipt.stage_key !== stageKey(row))
        throw sandboxConflict('This operation belongs to an earlier stage.', 'PROGRESS_CHANGED');
    } else if (row.revision !== command.revision)
      throw sandboxConflict('Progress changed. Refresh before continuing.', 'PROGRESS_CHANGED');
    const fileAction = ['create', 'delete', 'rename'].includes(command.action);
    if (fileAction) {
      if (!policy.canManageFiles)
        throw sandboxConflict(
          'File management is unavailable at this stage.',
          'WORKBENCH_ACCESS_DENIED',
        );
      assertProjectSource(project, command.path);
      if (command.path === 'PLAN.md')
        throw sandboxConflict('Keep the project plan.', 'WORKBENCH_ACCESS_DENIED');
      if (command.action === 'rename') {
        assertProjectSource(project, command.destination);
        if (command.destination === 'PLAN.md')
          throw sandboxConflict('The project plan cannot be replaced.', 'WORKBENCH_ACCESS_DENIED');
      }
      if (
        command.action === 'create' &&
        (await projectFiles(service, environmentId, project)).length >= 256
      )
        throw sandboxInvalid(
          'Learning projects support at most 256 source files.',
          'PBL_SOURCE_COUNT',
        );
    } else if (['run', 'terminal'].includes(command.action)) {
      if (!policy.canRun)
        throw sandboxConflict(
          'Stop at the current teaching review before using the terminal or running an application.',
          'WORKBENCH_ACCESS_DENIED',
        );
    } else throw sandboxInvalid('Unknown workbench operation.');
    const operation: WorkspaceMutation = fileAction
      ? 'write'
      : command.action === 'run'
        ? 'command'
        : 'terminal';
    if (!receipt)
      await store.pool.query(
        'INSERT INTO pbl_v3_commands(study_id,id,hash,result,stage_key) VALUES($1,$2,$3,NULL,$4)',
        [id, receiptId, hash, stageKey(row)],
      );
    const invalidate = async () => {
      row = await store.transaction((db) =>
        store.commit(db, row, invalidateWorkspace(row, command.path)),
      );
    };
    const result = await withLearningWorkspaceAccess(
      {
        ownerId: principal.ownerId,
        workspaceId: learningWorkspaceId(id),
        environmentIds: () => [row.environment_id],
        operations: [operation],
      },
      async () => {
        if (fileAction)
          return service.mutateFile(
            environmentId,
            {
              action: command.action as 'create' | 'delete' | 'rename',
              path: command.path!,
              destination: command.destination,
              expectedHash: command.expectedHash,
              text: command.text,
            },
            invalidate,
          );
        if (command.action === 'run') {
          if (
            typeof command.text !== 'string' ||
            !command.text.trim() ||
            command.text.length > 16000
          )
            throw sandboxInvalid('Enter a command of at most 16000 characters.');
          await invalidate();
          return service.startCommand(
            environmentId,
            {
              requestId: command.id,
              command: command.text,
              timeoutMs: Math.min(300000, (await service.capabilities()).lifetimeMs),
            },
            command.epoch,
          );
        }
        if (command.action === 'terminal') {
          await invalidate();
          return service.createTerminal(
            environmentId,
            {
              requestId: command.id,
              cols: 100,
              rows: 28,
            },
            command.epoch,
          );
        }
        throw sandboxInvalid('Unknown workbench operation.');
      },
    );
    if (fileAction || command.action === 'run' || command.action === 'terminal')
      await recordLearningEvidence(
        store.pool,
        row,
        'learner',
        fileAction ? 'file-edit' : 'workspace-run',
        {
          action: command.action,
          path: command.path,
          destination: command.destination,
          text: command.text,
          requestId: command.id,
        },
      );
    await store.pool.query('UPDATE pbl_v3_commands SET result=$3 WHERE study_id=$1 AND id=$2', [
      id,
      receiptId,
      JSON.stringify(result),
    ]);
    await notifyDurableAgentEvent(store.pool, { kind: 'session', sessionId: id });
    return result;
  });
}
