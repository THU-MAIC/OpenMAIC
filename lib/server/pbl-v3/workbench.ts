import 'server-only';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
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
  const canEdit =
    row.state.status !== 'completed' &&
    allowedStudentActions(project.definition, row.state).includes('edit') &&
    !row.evaluation &&
    !(await busy(store, row));
  const planning = stage.kind === 'produce' && stage.writes === 'plan';
  const pending = (await store.roles(row.id)).some(
    (b) => b.stage_key === stageKey(row) && b.guided?.pending,
  );
  return {
    canEdit,
    planning,
    canManageFiles: canEdit && !planning && !!project.sourceRoots?.length,
    canRun: canEdit && !planning && !pending,
    ports: [...(project.previewPorts ?? [8000])],
  };
}
export async function workbenchView(
  principal: OwnerPrincipal,
  id: string,
): Promise<LearningWorkbench> {
  const store = await LearningStore.open(),
    row = await store.get(id, principal.ownerId),
    service = await SandboxService.forOwner(principal);
  assertEnvironmentReady(await touchEnvironment(store, row, service));
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
    ...policy,
    commands,
    terminals,
    checkpoint: await service.checkpoint(environmentId),
  };
}
export async function authorizeLearningPreview(
  ownerId: string,
  studyId: string,
  environmentId: string,
  port: number,
) {
  const store = await LearningStore.open(),
    row = await store.get(studyId, ownerId);
  const policy = await permissions(store, row);
  if (row.environment_id !== environmentId || !policy.canRun || !policy.ports.includes(port))
    throw sandboxConflict('Preview is unavailable at this learning stage.');
}
export interface WorkbenchCommand {
  id: string;
  revision: number;
  environmentId: string;
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
  port?: number;
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
    throw sandboxConflict('The learning environment changed. Refresh before continuing.');
  // Closing/cancelling is control traffic; it must not wait behind a stalled writer.
  if (command.action === 'stop') {
    await service.revokePreviews(command.environmentId);
    for (const cmd of await service.listCommands(command.environmentId))
      if (['starting', 'running', 'unknown'].includes(cmd.state))
        await service.cancelCommand(command.environmentId, cmd.id);
    for (const terminal of await service.listTerminals(command.environmentId))
      if (terminal.state !== 'closed')
        await service.closeTerminal(command.environmentId, terminal.id);
    return { stopped: true };
  }
  return store.exclusive(id, async () => {
    row = await store.get(id, principal.ownerId);
    if (row.environment_id !== command.environmentId)
      throw sandboxConflict('The learning environment changed.');
    const policy = await permissions(store, row),
      project = projectFor(row),
      environmentId = requireEnvironment(row);
    assertEnvironmentReady(await touchEnvironment(store, row, service));
    const input = command.action === 'input';
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
        throw sandboxConflict('This request ID was used for another operation.');
      if (receipt.result !== null) return receipt.result;
      if (receipt.stage_key !== stageKey(row))
        throw sandboxConflict('This operation belongs to an earlier stage.');
    } else if (!input && row.revision !== command.revision)
      throw sandboxConflict('Progress changed. Refresh before continuing.');
    const fileAction = ['create', 'delete', 'rename'].includes(command.action);
    if (fileAction) {
      if (!policy.canManageFiles)
        throw sandboxConflict('File management is unavailable at this stage.');
      assertProjectSource(project, command.path);
      if (command.path === 'PLAN.md') throw sandboxConflict('Keep the project plan.');
      if (command.action === 'rename') {
        assertProjectSource(project, command.destination);
        if (command.destination === 'PLAN.md')
          throw sandboxConflict('The project plan cannot be replaced.');
      }
      if (
        command.action === 'create' &&
        (await projectFiles(service, environmentId, project)).length >= 256
      )
        throw sandboxInvalid(
          'Learning projects support at most 256 source files.',
          'PBL_SOURCE_COUNT',
        );
    } else if (['run', 'terminal', 'input', 'preview'].includes(command.action)) {
      if (!policy.canRun)
        throw sandboxConflict(
          'Stop at the current teaching review before using the terminal or running an application.',
        );
    } else throw sandboxInvalid('Unknown workbench operation.');
    const operation: WorkspaceMutation = fileAction
      ? 'write'
      : command.action === 'run'
        ? 'command'
        : command.action === 'preview'
          ? 'preview'
          : 'terminal';
    if (!receipt && !input)
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
          return service.startCommand(environmentId, {
            requestId: command.id,
            command: command.text,
            timeoutMs: Math.min(300000, (await service.capabilities()).lifetimeMs),
          });
        }
        if (command.action === 'terminal') {
          await invalidate();
          return service.createTerminal(environmentId, {
            requestId: command.id,
            cols: 100,
            rows: 28,
          });
        }
        if (command.action === 'input') {
          if (typeof command.terminalId !== 'string')
            throw sandboxInvalid('A terminal is required.');
          return service.updateTerminal(
            environmentId,
            command.terminalId,
            command.data !== undefined
              ? { action: 'input', data: command.data }
              : { action: 'resize', cols: command.cols, rows: command.rows },
          );
        }
        if (!policy.ports.includes(command.port!))
          throw sandboxInvalid('Select a configured preview port.');
        return service.preview(environmentId, command.port);
      },
    );
    if (!input)
      await store.pool.query('UPDATE pbl_v3_commands SET result=$3 WHERE study_id=$1 AND id=$2', [
        id,
        receiptId,
        JSON.stringify(result),
      ]);
    return result;
  });
}
