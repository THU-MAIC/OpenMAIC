import { recordLearningEvidence } from './evidence';
import {
  projectConversation,
  learningRunFailure,
  boundConversation,
  latestMessagePartIds,
} from './conversation';
import { executionFailureCode } from '@/lib/agent/runtime/request-failure';
import { readConversationHistory, CONVERSATION_BYTES } from './conversation-history';
import 'server-only';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { projectEditAccess } from '@/lib/pbl/v3/edit-access';
import { learnerActions } from '@/lib/pbl/v3/learner-actions';
import { handoffEchoes, deduplicateHandoffs } from '@/lib/pbl/v3/conversation';
import { reviewQuestions } from './review-question';
import { createHash, randomUUID } from 'node:crypto';
import { checkpointIO, checkpointStep } from '@/lib/server/sandbox/checkpoint-errors';
import { CHECKPOINT_TIMEOUT_MS } from '@/lib/server/sandbox/checkpoint-policy';
import type { PoolClient } from 'pg';
import type { OwnerPrincipal } from '@/lib/server/identity/types';
import { writeSessionGrant } from '@/lib/server/sandbox/store';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxError, sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';
import { getAgentSessionStore } from '@/lib/server/agent-runtime/store';
import { listAgentUserMessages } from '@/lib/server/agent-runtime/user-messages';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { assertWorkspaceModelsAuthorized } from '@/lib/server/model-config/runtime';
import { stageStep } from '@/lib/pbl/v3/presentation';
import { isPBLV3Reference, type LearningView } from '@/lib/pbl/v3/types';
import type { AgentRole } from '@/lib/pbl/v3/domain/project/project-schema';
import { currentStage, currentMilestone } from '@/lib/pbl/v3/domain/orchestration/state';
import * as transitions from '@/lib/pbl/v3/domain/orchestration/transition';
import { judgeQuiz } from '@/lib/pbl/v3/domain/orchestration/quiz';
import {
  decisionResponseLabel,
  isDecisionResponseValid,
} from '@/lib/pbl/v3/domain/orchestration/decisions';
import type { EngineTransition } from '@/lib/pbl/v3/domain/orchestration/events';
import { assertProjectSource, projectFiles } from './workspace-files';
import { assertLearningPlan } from './plan';
import { startBuild, collectBuild, executionCommand, executionSnapshot } from './compilation';
import { evaluationCommand, evaluationFor, evaluationOutcome } from './evaluation';
import { installedProject } from './catalog';
import { resolveProject } from './project-resolver';
import { LearningStore, type Study, type RoleBinding } from './store';
import {
  canViewProjectReport,
  hasStageCompletion,
  succeededWithoutTeachingReceipt,
} from './stage-progress';
import {
  learningWorkspaceId,
  withLearningWorkspaceAccess,
  type WorkspaceMutation,
} from '@/lib/server/sandbox/managed-workspace';
import {
  touchEnvironment,
  assertEnvironmentReady,
  environmentReleaseCommitted,
  recoveredProgress,
  renewPreparationLease,
} from './environment';

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function stageKey(row: Study) {
  return `${row.state.position.milestoneId}:${row.state.position.stageIndex}`;
}
export function projectFor(row: Study) {
  if (row.project) return row.project;
  if (row.project_reference?.assetId)
    throw sandboxConflict(
      'Pinned project resources have not been resolved. Reopen the learning session.',
    );
  return installedProject({ id: row.project_id, version: row.project_version });
}
export function stageFor(row: Study) {
  const project = projectFor(row).definition;
  return currentStage(project, row.state)!;
}
export function roleFor(row: Study): AgentRole | null {
  const stage = stageFor(row);
  if ('agent' in stage) return stage.agent;
  if (
    stage.kind === 'check' &&
    stage.checker === 'tests' &&
    row.state.collected[row.state.position.milestoneId!]?.remediation
  )
    return 'coder';
  return stage.kind === 'check' ? 'mentor' : null;
}
export async function busy(store: LearningStore, row: Study) {
  const agents = await getAgentSessionStore();
  for (const role of await store.roles(row.id)) {
    const meta = await agents.getSession(role.session_id);
    if (meta && ['queued', 'running'].includes(meta.status)) return true;
  }
  return false;
}
export function requireEnvironment(row: Study): string {
  if (!row.environment_id) throw sandboxConflict('Prepare the project environment first.');
  return row.environment_id;
}
export async function readFiles(
  service: SandboxService,
  row: Study,
  project = projectFor(row),
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const result: Record<string, string> = {};
  const environmentId = requireEnvironment(row);
  // A process can modify files without using our file API. Refuse evidence until managed writers stop.
  await service.assertWorkspaceIdle(environmentId, signal);
  let bytes = 0;
  const paths = await checkpointIO(
    () => projectFiles(service, environmentId, project, signal),
    signal,
  );
  for (const path of paths) {
    signal?.throwIfAborted();
    const text = await checkpointIO(() => service.readText(environmentId, path, signal), signal);
    signal?.throwIfAborted();
    bytes += Buffer.byteLength(text);
    if (bytes > 1_048_576)
      throw sandboxInvalid('Project source snapshots are limited to 1 MiB.', 'PBL_SOURCE_SIZE');
    result[path] = text;
  }
  return result;
}
export function filesFingerprint(files: Record<string, string>) {
  return digest(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}
export async function fileSnapshot(service: SandboxService, row: Study, signal?: AbortSignal) {
  const files = await readFiles(service, row, projectFor(row), signal);
  return { files, fingerprint: filesFingerprint(files) };
}
export async function saveStudyCheckpoint(service: SandboxService, row: Study) {
  const signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS);
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const current = (
    await pool.query<Pick<Study, 'idle_turn_cleanup' | 'archive_discard'> & { now: Date }>(
      'SELECT clock_timestamp() AS now,idle_turn_cleanup,archive_discard FROM pbl_v3_studies WHERE id=$1 AND owner_id=$2 AND environment_id=$3',
      [row.id, row.owner_id, row.environment_id],
    )
  ).rows[0];
  if (
    !current ||
    current.archive_discard?.environmentId === row.environment_id ||
    current.idle_turn_cleanup?.releasing
  )
    throw new SandboxError('CHECKPOINT_CHANGED', 409, 'Workspace was released.');
  const renew = !(
    current.idle_turn_cleanup?.environmentId === row.environment_id &&
    current.now.getTime() >= Date.parse(current.idle_turn_cleanup.releaseAt)
  );
  const snapshot = await checkpointStep('snapshot', async () => {
    if (renew) await service.renewForCheckpoint(requireEnvironment(row), signal);
    return fileSnapshot(service, row, signal);
  });
  const previous = await service.checkpoint(requireEnvironment(row));
  const prepared = await checkpointStep('archive', () =>
    service.prepareWorkspaceCheckpoint(requireEnvironment(row), previous?.revision ?? 0, signal, {
      renew: false,
    }),
  );
  try {
    await prepared.commit(async (db) => {
      const valid = await db.query(
        `SELECT id FROM pbl_v3_studies WHERE id=$1 AND owner_id=$2 AND environment_id=$3
         AND (archive_discard IS NULL OR archive_discard->>'environmentId'<>$3)
         AND idle_turn_cleanup->>'releasing' IS DISTINCT FROM 'true' FOR SHARE`,
        [row.id, row.owner_id, row.environment_id],
      );
      if (!valid.rows.length)
        throw new SandboxError('CHECKPOINT_CHANGED', 409, 'Workspace was released.');
    });
    checkpointRecovery(row, prepared.checkpoint.revision, snapshot.fingerprint);
  } finally {
    await prepared.discard().catch(() => {});
  }
}

export function checkpointRecovery(row: Study, revision: number, fingerprint: string) {
  row.environment_recovery = {
    ...row.environment_recovery,
    requestId: row.environment_id!,
    savedPosition: {
      revision,
      milestoneIndex: row.state.position.milestoneIndex,
      stageIndex: row.state.position.stageIndex,
      fingerprint,
    },
  };
  row.workspace_dirty_at = null;
  row.lifecycle_error = null;
}
export function invalidateWorkspace(row: Study, changedPath?: string): EngineTransition {
  row.workspace_dirty_at ??= new Date();
  const state = structuredClone(row.state);
  const collected = state.collected[state.position.milestoneId ?? ''];
  if (collected) {
    if (!changedPath || changedPath === 'PLAN.md') collected.planReviewCompleted = false;
    collected.codeReviewCompleted = false;
    collected.tests = null;
    collected.quiz = null;
    collected.recapCompleted = false;
  }
  return { state, events: [] };
}
export async function openStudy(principal: OwnerPrincipal, stageId: string, sceneId: string) {
  // Identity must be eligible for execution before any learning instance is created.
  await SandboxService.forOwner(principal);
  const studies = await LearningStore.open();
  const existing = await studies.findForScene(principal.ownerId, stageId, sceneId);
  if (existing) return existing;
  const documents = await getOwnerScopedDocumentStore(principal);
  const scene = await documents.getScene(stageId, sceneId);
  const content = scene?.content as unknown as { type?: string; projectV3?: unknown };
  if (content?.type !== 'pbl' || !isPBLV3Reference(content.projectV3))
    throw new SandboxError(
      'PBL_NOT_FOUND',
      404,
      'The classroom does not contain this learning project.',
    );
  const project = await resolveProject(
    principal.ownerId,
    stageId,
    content.projectV3,
    undefined,
    sceneId,
  );
  return studies.create(
    {
      ownerId: principal.ownerId,
      stageId,
      sceneId,
      projectId: project.ref.id,
      version: project.ref.version,
      projectRef: project.ref,
    },
    transitions.startOrchestration(project.definition),
  );
}
export async function queueRole(
  store: LearningStore,
  db: PoolClient,
  row: Study,
  text: string,
  opening = false,
  commandId?: string,
) {
  await fenceOwnerWrite(db, row.owner_id);
  const role = roleFor(row);
  if (!role) throw sandboxConflict('This stage does not accept a teaching message.');
  const context = role === 'mentor' ? 'project' : row.state.position.milestoneId!;
  let binding: RoleBinding | undefined = (
    await db.query<RoleBinding>(
      'SELECT * FROM pbl_v3_roles WHERE study_id=$1 AND role=$2 AND context_key=$3',
      [row.id, role, context],
    )
  ).rows[0];
  const agents = store.agentStore(db);
  if (binding && !(await agents.getSession(binding.session_id))) {
    // Repair old/deleted bindings without resetting learning progress or resurrecting a deleted chat.
    await db.query('DELETE FROM sandbox_session_grants WHERE session_id=$1', [binding.session_id]);
    await db.query('DELETE FROM pbl_v3_roles WHERE session_id=$1', [binding.session_id]);
    binding = undefined;
  }
  if (!binding) {
    const id = `pbl-role-${randomUUID()}`;
    await agents.createSession({
      id,
      ownerId: row.owner_id,
      stageId: row.stage_id,
      prompt: 'PBL teaching session',
      existingCourse: true,
      status: 'succeeded',
    });
    binding = (
      await db.query<RoleBinding>(
        'INSERT INTO pbl_v3_roles(session_id,study_id,role,context_key,stage_key) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [id, row.id, role, context, stageKey(row)],
      )
    ).rows[0]!;
  }
  await db.query(
    'UPDATE pbl_v3_roles SET guided=CASE WHEN stage_key=$2 THEN guided ELSE NULL END,feedback_seq=CASE WHEN stage_key=$2 THEN feedback_seq+1 ELSE 1 END,stage_key=$2,turn_started_at=clock_timestamp(),execution_progress_at=clock_timestamp() WHERE session_id=$1',
    [binding.session_id, stageKey(row)],
  );
  if (row.environment_id)
    await writeSessionGrant(
      db,
      { owner_id: row.owner_id, id: row.environment_id },
      binding.session_id,
      randomUUID(),
      role === 'planner' || role === 'coder',
      false,
    );
  if (binding.stage_key !== stageKey(row) || binding.feedback_seq === 0) {
    const milestone = currentMilestone(projectFor(row).definition, row.state)!;
    await agents.appendControlEvent(binding.session_id, {
      ts: Date.now(),
      type: 'pbl_stage_entered',
      data: {
        milestoneId: milestone.id,
        milestoneTitle: milestone.title,
        milestoneIndex: row.state.position.milestoneIndex,
        stageIndex: row.state.position.stageIndex,
        step: stageStep(stageFor(row)),
        total: milestone.stages.length,
      },
    });
  }
  if (opening) {
    // A transport wakeup explicitly marked as system-originated. PBL never treats it as feedback.
    await agents.appendControlEvent(binding.session_id, {
      ts: Date.now(),
      type: 'user_message',
      data: { text, delivery: 'queued', pblOpening: true },
    });
    await agents.requeueSession(binding.session_id);
  } else {
    const input = await agents.postUserMessage(
      binding.session_id,
      { text },
      { expectedOwnerId: row.owner_id },
    );
    // Annotate the staged input in this same transaction, before either the input
    // or its wakeup becomes visible. No historical events are rewritten.
    if (commandId)
      await db.query(
        `UPDATE agent_session_events SET data=data || jsonb_build_object('pblCommandId',$3::text)
         WHERE session_id=$1 AND seq=$2`,
        [binding.session_id, input.seq, commandId],
      );
  }
  return binding.session_id;
}
export interface LearningCommand {
  id: string;
  revision: number;
  type: string;
  text?: string;
  path?: string;
  expectedHash?: string;
  decisionId?: string;
  chosen?: string;
  rationale?: string;
  answers?: number[];
  evaluationId?: string;
}
function validateCommand(command: LearningCommand) {
  if (
    !command ||
    typeof command !== 'object' ||
    typeof command.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(command.id) ||
    !Number.isSafeInteger(command.revision) ||
    command.revision < 0
  )
    throw sandboxInvalid('A request ID and progress revision are required.');
  if (
    command.text !== undefined &&
    (typeof command.text !== 'string' || command.text.length > 64_000)
  )
    throw sandboxInvalid('Text is limited to 64000 characters.');
  if (
    command.evaluationId !== undefined &&
    (typeof command.evaluationId !== 'string' || !/^[a-f0-9-]{36}$/.test(command.evaluationId))
  )
    throw sandboxInvalid('A valid evaluation ID is required.');
}
/** Caller holds the study lock. The browser and lifecycle worker commit the same verdict. */
export async function collectStudyExecution(
  store: LearningStore,
  row: Study,
  service: SandboxService,
): Promise<{ result: Record<string, unknown>; transition: EngineTransition }> {
  if (!row.evaluation) throw sandboxConflict('No test is awaiting collection.');
  const unchanged = { state: row.state, events: [] };
  if (row.evaluation.purpose === 'compile') {
    const result = await collectBuild(store, row, service);
    return { result, transition: { state: row.state, events: [] } };
  }
  const project = projectFor(row),
    definition = project.definition;
  let transition: EngineTransition = unchanged;
  let result: Record<string, unknown> = { collected: true };
  const evaluation = row.evaluation;
  const observed = await executionCommand(store, row, service);
  if (observed && ['starting', 'running', 'unknown'].includes(observed.state))
    return { result: { pending: true, state: observed.state }, transition };
  const snapshot = observed ? await executionSnapshot(service, row) : null;
  if (
    stageKey(row) !== evaluation.stageKey ||
    (snapshot && snapshot.fingerprint !== evaluation.fingerprint)
  ) {
    row.evaluation = null;
    transition = invalidateWorkspace(row);
    result = { stale: true };
  } else {
    if (!snapshot || !observed) {
      row.workspace_dirty_at ??= await store.now();
      result = { collected: true, interrupted: true };
    }
    const milestone = currentMilestone(definition, row.state)!;
    const collected = row.state.collected[milestone.id]!;
    transition = transitions.recordEvaluation(
      definition,
      row.state,
      {
        id: evaluation.id,
        ...evaluationOutcome(
          evaluationFor(project, milestone.id),
          evaluation.id,
          snapshot && observed
            ? observed
            : {
                id: evaluation.id,
                state: 'failed',
                exitCode: null,
                stdout: '',
                stderr: '',
                truncated: false,
              },
          snapshot ? Object.keys(snapshot.files) : [],
        ),
        evaluator: 'sandbox-command',
        milestoneId: milestone.id,
        stageIndex: row.state.position.stageIndex,
        revision: {
          id: snapshot?.fingerprint ?? evaluation.fingerprint,
          provider: 'sandbox',
          createdAt: new Date().toISOString(),
        },
        decisionRecordIds: Object.values(collected.decisionRecordIds),
        planArtifactId: collected.plan?.id,
        codeArtifactId: collected.code?.id,
        startedAt: evaluation.startedAt,
        completedAt: new Date().toISOString(),
      },
      { remediationId: randomUUID() },
    );
    row.evaluation = null;
  }
  return { result, transition };
}

export async function commandStudy(
  principal: OwnerPrincipal,
  id: string,
  command: LearningCommand,
) {
  validateCommand(command);
  const store = await LearningStore.open();
  // Check ownership before admitting a lock, including read/retry paths.
  let row = await store.get(id, principal.ownerId);
  if (command.type === 'cancel') {
    // Control traffic must not wait behind the remote tool it is trying to stop.
    const agents = await getAgentSessionStore();
    for (const role of await store.roles(id)) await agents.requestCancel(role.session_id);
    return { cancelRequested: true };
  }
  const operations: WorkspaceMutation[] =
    command.type === 'prepare'
      ? ['create', 'restore', 'write', 'destroy']
      : command.type === 'save'
        ? ['write']
        : command.type === 'evaluate' || command.type === 'compile'
          ? ['command']
          : command.type === 'checkpoint' || command.type === 'next'
            ? ['checkpoint']
            : [];
  const execute = async () => {
    row = await store.get(id, principal.ownerId);
    const project = projectFor(row),
      definition = project.definition;
    const agents = await getAgentSessionStore();
    let alreadyStarted = false;
    if (command.type === 'begin') {
      const bound = (await store.roles(id)).find(
        (b) => b.role === roleFor(row) && b.stage_key === stageKey(row),
      );
      alreadyStarted = !!bound && !!(await agents.getSession(bound.session_id));
    }
    // Refreshes and multiple tabs may observe the same terminal run. Its durable
    // result is the idempotence receipt; never collect a newer run by accident.
    const collecting = command.type === 'collect' && !!command.evaluationId;
    if (collecting) {
      const saved = row.state.collected[row.state.position.milestoneId ?? '']?.tests;
      if (!row.evaluation && saved?.id === command.evaluationId) return { collected: true };
      if (
        !row.evaluation &&
        (
          await store.pool.query(
            'SELECT 1 FROM pbl_v3_commands WHERE study_id=$1 AND id=$2 AND result IS NOT NULL',
            [id, `build:${command.evaluationId}`],
          )
        ).rows.length
      )
        return { collected: true };
      if (row.evaluation?.id !== command.evaluationId)
        throw sandboxConflict('The pending evaluation changed. Refresh before collecting.');
    }
    const hash = digest(JSON.stringify(command));
    const receipt = (
      await store.pool.query<{ hash: string; result: unknown; stage_key: string }>(
        'SELECT hash,result,stage_key FROM pbl_v3_commands WHERE study_id=$1 AND id=$2',
        [id, command.id],
      )
    ).rows[0];
    if (receipt) {
      if (receipt.hash !== hash)
        throw sandboxConflict('This request ID was already used for a different operation.');
      if (receipt.result !== null) return receipt.result;
      if (receipt.stage_key !== stageKey(row))
        throw sandboxConflict('This unfinished request belongs to an earlier learning stage.');
      // Remote operation retries below reuse the original environment / command ID.
    } else {
      if (row.revision !== command.revision && !alreadyStarted && !collecting)
        throw sandboxConflict('Progress changed. Refresh before submitting.', 'PROGRESS_CHANGED');
    }
    if (row.state.status === 'completed' && !['prepare', 'checkpoint'].includes(command.type))
      throw sandboxConflict('This project is completed.');
    if (alreadyStarted) return { alreadyStarted: true };
    if (await busy(store, row))
      throw sandboxConflict('Wait for the teaching response, or cancel it first.');
    // Browsers collect finished runs automatically; a manual collect click is already reported
    // as frame input. Completion is not learner activity, as with background collection.
    if (command.type !== 'collect')
      row = { ...row, ...(await store.recordActivity(id, row.owner_id)) };
    const service = await SandboxService.forOwner(principal);
    if (command.type !== 'prepare')
      assertEnvironmentReady(await touchEnvironment(store, row, service));
    const stage = stageFor(row);
    const allowed = transitions.allowedStudentActions(definition, row.state);
    const check = (action: Parameters<typeof transitions.assertStudentActionAllowed>[2]) => {
      if (!allowed.includes(action))
        throw sandboxConflict('This action is not available at the current stage.');
    };
    let transition: EngineTransition = { state: row.state, events: [] };
    let result: unknown = { accepted: true };
    const persist = async (db: PoolClient) => {
      row = await store.commit(db, row, transition);
      await db.query('UPDATE pbl_v3_commands SET result=$3 WHERE study_id=$1 AND id=$2', [
        id,
        command.id,
        JSON.stringify(result),
      ]);
    };
    if (command.type === 'chat' || command.type === 'retry' || command.type === 'begin') {
      if (!isAgentRuntimeConfigured())
        throw new SandboxError(
          'PBL_RUNNER_DISABLED',
          503,
          'Enable the existing Agent runtime to use project teaching.',
        );
      if (command.type === 'chat') check('chat');
      requireEnvironment(row);
      if (command.type === 'chat' && !command.text?.trim())
        throw sandboxInvalid('A learning message is required.');
      await assertWorkspaceModelsAuthorized(principal.ownerId, ['agent']);
      return store.transaction(async (db) => {
        await fenceOwnerWrite(db, row.owner_id);
        await db.query(
          'INSERT INTO pbl_v3_commands(study_id,id,hash,result,stage_key) VALUES($1,$2,$3,NULL,$4) ON CONFLICT DO NOTHING',
          [id, command.id, hash, stageKey(row)],
        );
        if (command.type === 'retry') {
          const binding = (await store.roles(id, db)).find(
            (binding) => binding.role === roleFor(row) && binding.stage_key === stageKey(row),
          );
          const sessionStore = store.agentStore(db);
          const meta = binding ? await sessionStore.getSession(binding.session_id) : null;
          const unclosed =
            binding &&
            meta &&
            succeededWithoutTeachingReceipt(
              row,
              stage,
              binding,
              meta.status,
              (await listAgentUserMessages(sessionStore, binding.session_id)).at(-1)?.seq,
            );
          if (!binding || !meta || (!['failed', 'cancelled'].includes(meta.status) && !unclosed))
            throw sandboxConflict('Only a failed or cancelled teaching turn can be retried.');
          await writeSessionGrant(
            db,
            { owner_id: row.owner_id, id: requireEnvironment(row) },
            binding.session_id,
            randomUUID(),
            binding.role === 'planner' || binding.role === 'coder',
            false,
          );
          if (!(await sessionStore.requeueSession(binding.session_id)))
            throw sandboxConflict('The teaching turn changed. Refresh before retrying.');
          await db.query(
            'UPDATE pbl_v3_roles SET turn_started_at=clock_timestamp(),execution_progress_at=clock_timestamp() WHERE session_id=$1',
            [binding.session_id],
          );
          await sessionStore.appendControlEvent(binding.session_id, {
            ts: Date.now(),
            type: 'pbl_turn_retried',
            data: {},
          });
          // Reuse the actual student turn: retrying is not new feedback or approval.
          result = { sessionId: binding.session_id };
        } else {
          result = {
            sessionId: await queueRole(
              store,
              db,
              row,
              command.type === 'begin'
                ? 'System stage entry: open the current learning step using its teaching protocol. This is not learner feedback. Introduce the project when entering its first step, and wait for the learner.'
                : command.text!,
              command.type === 'begin',
              command.id,
            ),
          };
        }
        await persist(db);
        return result;
      });
    }
    // Persist remote intent before crossing the network. An uncertain operation remains recoverable.
    if (!receipt)
      await store.pool.query(
        'INSERT INTO pbl_v3_commands(study_id,id,hash,result,stage_key) VALUES($1,$2,$3,NULL,$4)',
        [id, command.id, hash, stageKey(row)],
      );
    if (command.type === 'prepare') {
      const previousId = row.environment_id;
      if (
        previousId &&
        (row.archive_discard?.environmentId === previousId ||
          (row.idle_turn_cleanup?.environmentId === previousId && row.idle_turn_cleanup.releasing))
      )
        await service.destroy(previousId);
      const previous = previousId ? await service.reconcile(previousId) : null;
      if (previous?.state === 'running' && previous.workspaceReady) {
        assertEnvironmentReady(await touchEnvironment(store, row, service));
      } else {
        if (previous && previous.state !== 'destroyed')
          throw sandboxConflict(
            'The environment is not confirmed missing. Refresh or retry preparation.',
          );
        // Store allocation identity before network I/O. Reloads and lost acknowledgements reuse it.
        if (!row.environment_recovery || row.environment_recovery.requestId === previousId) {
          row.environment_recovery = {
            ...row.environment_recovery,
            requestId: previousId ? randomUUID() : row.id,
          };
          row = await store.transaction((db) =>
            store.commit(db, row, { state: row.state, events: [] }),
          );
        }
        let env = await service.create(
          row.environment_recovery!.requestId,
          learningWorkspaceId(row.id),
        );
        env = await service.reconcile(env.id);
        for (let replacements = 0; env.state === 'destroyed'; replacements++) {
          // Only confirmed expiry permits a new allocation. Continue the same
          // preparation instead of requiring another learner click, but do not
          // loop indefinitely if replacements themselves keep expiring.
          const requestId = randomUUID();
          row.environment_recovery = { ...row.environment_recovery, requestId };
          row = await store.transaction((db) =>
            store.commit(db, row, { state: row.state, events: [] }),
          );
          if (replacements >= 1)
            throw sandboxConflict(
              'The replacement expired before preparation completed. Retry preparation.',
            );
          env = await service.create(requestId, learningWorkspaceId(row.id));
          env = await service.reconcile(env.id);
        }
        assertEnvironmentReady(env);
        // Pending allocations are not renewed by background maintenance. The
        // foreground preparation protects its own I/O, including retries of an
        // already-initialized allocation and larger starter packages.
        let renewedAt = 0;
        const renewPreparation = async (force = false) => {
          if (!force && Date.now() - renewedAt < 20_000) return;
          await renewPreparationLease(service, env.id);
          renewedAt = Date.now();
        };
        await renewPreparation(true);
        const checkpoint = await service.checkpoint(env.id);
        // Seed only a new workspace. A restored checkpoint must never be silently patched with starters.
        if (!checkpoint) {
          const existing = new Set((await service.listFiles(env.id)).map((file) => file.path));
          for (const [path, text] of Object.entries(project.files)) {
            if (existing.has(path)) continue;
            await renewPreparation();
            await service.writeText(env.id, path, text);
          }
        }
        await renewPreparation(true);
        row.environment_id = env.id;
        row.lifecycle_error = null;
        // Old dirty edits belonged to the lost resource; restored bytes are the durable version.
        row.workspace_dirty_at = null;
        const restored = recoveredProgress(
          row,
          project,
          await readFiles(service, row, project, AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS)),
          checkpoint?.revision ?? 0,
        );
        transition = { state: restored.state, events: [] };
        row.evaluation = null;
        row.environment_recovery = {
          ...row.environment_recovery,
          requestId: env.id,
          checkpointRevision: checkpoint?.revision ?? 0,
          progressReset: restored.reset,
          // Database time, comparable with role turn starts; earlier turns keep their verdict.
          ...(restored.reset ? { progressResetAt: (await store.now()).toISOString() } : {}),
        };
        // No role may keep a grant to the old environment, or a completion receipt for invalidated work.
        await store.transaction(async (db) => {
          await db.query(
            'DELETE FROM sandbox_session_grants WHERE session_id IN (SELECT session_id FROM pbl_v3_roles WHERE study_id=$1)',
            [row.id],
          );
          if (restored.reset)
            await db.query(
              'UPDATE pbl_v3_roles SET guided=NULL,completion=NULL WHERE study_id=$1',
              [row.id],
            );
          await persist(db);
        });
        return result;
      }
    } else if (command.type === 'save') {
      check('edit');
      if (
        !projectEditAccess(
          { state: row.state, stage, actions: allowed, busy: false, evaluation: row.evaluation },
          command.path,
        ).canEdit
      )
        throw sandboxConflict(
          'Project files are read-only at this time.',
          'WORKBENCH_ACCESS_DENIED',
        );
      if (!command.path || command.text === undefined || typeof command.expectedHash !== 'string')
        throw sandboxInvalid('A project file, text and observed file hash are required.');
      assertProjectSource(project, command.path);
      if (stage.kind === 'produce' && stage.writes === 'plan' && command.path !== 'PLAN.md')
        throw sandboxConflict('Only PLAN.md can be edited during planning.');
      if (command.path === 'PLAN.md' && !(stage.kind === 'produce' && stage.writes === 'plan'))
        throw sandboxConflict('The approved plan is read-only during coding.');
      if (command.path === 'PLAN.md') await assertLearningPlan(store, row, command.text);
      const changed = await service.compareAndWriteText(
        requireEnvironment(row),
        command.path,
        command.text,
        command.expectedHash,
        async () => {
          row = await store.transaction((db) =>
            store.commit(db, row, invalidateWorkspace(row, command.path)),
          );
        },
      );
      if (changed)
        await recordLearningEvidence(store.pool, row, 'learner', 'file-edit', {
          path: command.path,
          text: command.text,
          previousHash: command.expectedHash,
        });
      transition = { state: row.state, events: [] };
    } else if (command.type === 'checkpoint') {
      await saveStudyCheckpoint(service, row);
    } else if (command.type === 'decide') {
      check('decide');
      const decision = definition.decisions.find((d) => d.id === command.decisionId);
      if (!decision || !isDecisionResponseValid(decision, command))
        throw sandboxInvalid('Provide a valid decision response and its required rationale.');
      transition = transitions.submitDecision(definition, row.state, {
        decisionId: decision.id,
        chosen: command.chosen!,
        ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
        recordId: command.id,
      });
    } else if (command.type === 'quiz') {
      check('quiz');
      const milestone = currentMilestone(definition, row.state)!;
      if (
        !Array.isArray(command.answers) ||
        command.answers.length !== milestone.quiz.length ||
        !command.answers.every(Number.isInteger)
      )
        throw sandboxInvalid('Provide one answer per question.');
      const judged = judgeQuiz(milestone.quiz, command.answers);
      transition = transitions.recordQuiz(definition, row.state, {
        id: command.id,
        attempt: (row.state.collected[milestone.id]!.quiz?.attempt ?? 0) + 1,
        passed: judged.ok,
        score: judged.score,
        total: judged.total,
        wrong: judged.wrong,
      });
    } else if (command.type === 'compile') {
      check('edit');
      result = await startBuild(store, row, service, command.id);
      transition = { state: row.state, events: [] };
    } else if (command.type === 'evaluate') {
      check('evaluate');
      if (row.evaluation && row.evaluation.id !== command.id)
        throw sandboxConflict('Collect the existing test result before starting another run.');
      const snapshot = await fileSnapshot(service, row);
      row.evaluation ??= {
        id: command.id,
        fingerprint: snapshot.fingerprint,
        stageKey: stageKey(row),
        startedAt: new Date().toISOString(),
      };
      row = await store.transaction((db) =>
        store.commit(db, row, { state: row.state, events: [] }),
      );
      result = await service.startCommand(requireEnvironment(row), {
        requestId: command.id,
        command: evaluationCommand(
          evaluationFor(project, row.state.position.milestoneId!),
          command.id,
        ),
        timeoutMs: 60_000,
      });
      transition = { state: row.state, events: [] };
    } else if (command.type === 'collect') {
      const collected = await collectStudyExecution(store, row, service);
      if ('pending' in collected.result) return collected.result;
      transition = collected.transition;
      result = collected.result;
    } else if (command.type === 'next') {
      if (row.evaluation)
        throw sandboxConflict('Collect the pending test result before continuing.');
      check('next');
      const role = roleFor(row);
      if (role && (stage.kind === 'mentor_say' || stage.kind === 'produce')) {
        const bindings = await store.roles(id);
        const binding = bindings.find((b) => b.role === role && b.stage_key === stageKey(row));
        if (!hasStageCompletion(row, stage, binding))
          throw sandboxConflict('Complete the current teaching interaction first.');
      }
      if (stage.kind === 'produce' || (stage.kind === 'check' && stage.checker === 'tests')) {
        const snapshot = await fileSnapshot(service, row);
        const collected = row.state.collected[row.state.position.milestoneId!]!;
        const expected =
          stage.kind === 'check'
            ? collected.tests?.revision.id
            : collected[stage.writes]?.workspaceRevisionId;
        if (expected !== snapshot.fingerprint)
          throw sandboxConflict(
            'Files changed after review or testing. Review and test the current files first.',
          );
        if (stage.kind === 'produce' && stage.writes === 'plan')
          await assertLearningPlan(store, row, snapshot.files['PLAN.md']!, true);
      }
      const endingMilestone =
        row.state.position.stageIndex ===
        currentMilestone(definition, row.state)!.stages.length - 1;
      if (stage.kind === 'produce' || endingMilestone) {
        // Establish a durable artifact before acknowledging the student's stage confirmation.
        await saveStudyCheckpoint(service, row);
      }
      transition = transitions.completeCurrentStage(definition, row.state);
    } else throw sandboxInvalid('Unknown learning action.');
    return store.transaction(async (db) => {
      await persist(db);
      return result;
    });
  };
  return store.waitForExclusive(id, () =>
    withLearningWorkspaceAccess(
      {
        ownerId: principal.ownerId,
        workspaceId: learningWorkspaceId(id),
        environmentIds: () => [row.environment_id, row.environment_recovery?.requestId],
        operations,
      },
      execute,
    ),
  );
}

export type LearningObservation = Pick<LearningView, 'environment' | 'files' | 'evaluation'> & {
  revision: number;
  environmentId: string | null;
};
export async function learningView(
  principal: OwnerPrincipal,
  id: string,
  options: { passive?: boolean; checkHealth?: boolean; observation?: LearningObservation } = {},
): Promise<LearningView> {
  const store = await LearningStore.open(),
    row = await store.get(id, principal.ownerId);
  const project = projectFor(row),
    stage = stageFor(row),
    role = roleFor(row),
    milestone = currentMilestone(project.definition, row.state)!;
  const bindings = await store.roles(id);
  const binding = bindings.find((b) => b.role === role && b.stage_key === stageKey(row));
  const messages: Array<
    LearningView['messages'][number] & {
      scope: string;
      inputId?: number;
      messageId?: number;
      handoff: boolean;
    }
  > = [];
  let conversation: LearningView['conversation'] = [];
  const conversationHistory: NonNullable<LearningView['conversationHistory']> = [];
  let activitySequence = 0;
  let roleRun: LearningView['roleRun'] = null;
  let latestUserSeq: number | undefined;
  let currentQuestionShown = false;
  if (binding) {
    const agents = await getAgentSessionStore();
    const meta = await agents.getSession(binding.session_id);
    latestUserSeq =
      (
        await store.pool.query<{ seq: number | null }>(
          "SELECT max(seq) AS seq FROM agent_session_events WHERE session_id=$1 AND type='user_message'",
          [binding.session_id],
        )
      ).rows[0]?.seq ?? undefined;
    const unclosed = succeededWithoutTeachingReceipt(
      row,
      stage,
      binding,
      meta?.status,
      latestUserSeq,
    );
    roleRun = {
      status: unclosed ? 'failed' : (meta?.status ?? 'missing'),
      canRetry: !!meta && (unclosed || ['failed', 'cancelled'].includes(meta.status)),
      failureCode: meta?.status === 'failed' ? executionFailureCode(meta.error) : null,
      // Never expose raw provider errors, URLs, or credentials to the browser.
      failure: unclosed
        ? 'incomplete'
        : meta?.status === 'failed'
          ? learningRunFailure(meta.error)
          : null,
    };
    // Bounded transcript projection; durable role history remains in the runner's entry tree.
    const last = await agents.lastEventSeq(binding.session_id);
    if (last)
      conversationHistory.push({
        sessionId: binding.session_id,
        through: last,
        role: binding.role,
      });
    activitySequence = last;
    const events = await readConversationHistory(store.pool, binding.session_id, last, 1000);
    conversation = projectConversation(
      events,
      binding.role,
      meta?.status === 'running' || meta?.status === 'queued',
      roleRun.status,
    );
    const questions = reviewQuestions(events);
    for (const event of events) {
      const data = event.data as {
        text?: string;
        toolName?: string;
        isError?: boolean;
        result?: { content?: { type: string; text?: string }[] };
        message?: { role?: string; content?: unknown };
        pblInputId?: number;
        pblMessageId?: number;
      };
      const question = questions.get(event.id);
      if (question !== undefined) {
        messages.push({
          role: 'assistant',
          text: question,
          scope: binding.session_id,
          inputId: data.pblInputId,
          handoff: true,
        });
        if (
          event.id > (latestUserSeq ?? 0) &&
          question === (binding.guided?.handoff?.question ?? binding.guided?.pending?.question)
        )
          currentQuestionShown = true;
      }
      if (
        event.type === 'user_message' &&
        !(event.data as { pblOpening?: boolean }).pblOpening &&
        typeof data.text === 'string'
      ) {
        messages.push({ role: 'user', text: data.text, scope: binding.session_id, handoff: false });
      }
      if (
        event.type === 'message_end' &&
        data.message?.role === 'assistant' &&
        Array.isArray(data.message.content)
      ) {
        const text = data.message.content
          .filter(
            (p): p is { type: 'text'; text: string } =>
              p?.type === 'text' && typeof p.text === 'string',
          )
          .map((p) => p.text)
          .join('\n');
        if (text)
          messages.push({
            role: 'assistant',
            text,
            scope: binding.session_id,
            inputId: data.pblInputId,
            messageId: data.pblMessageId ?? event.id,
            handoff: false,
          });
      }
    }
  }
  // At most the current milestone's three roles and the project mentor. Keep the
  // host event log authoritative; no second chat store or subscription protocol.
  const agents = await getAgentSessionStore();
  conversation = conversation.map((entry) => ({
    ...entry,
    id: `${binding?.session_id}:${entry.id}`,
  }));
  // Capture identity before merging other roles and the pending-question fallback.
  // Display order alone does not identify the current assistant response.
  const currentPartIds = latestMessagePartIds(conversation);
  for (const previous of bindings.filter(
    (item) =>
      item.session_id !== binding?.session_id &&
      (item.context_key === milestone.id || item.context_key === 'project'),
  )) {
    const last = await agents.lastEventSeq(previous.session_id);
    if (last)
      conversationHistory.push({
        sessionId: previous.session_id,
        through: last,
        role: previous.role,
      });
    activitySequence += last;
    const events = await readConversationHistory(store.pool, previous.session_id, last, 500, false);
    conversation.push(
      ...projectConversation(events, previous.role, false).map((entry) => ({
        ...entry,
        id: `${previous.session_id}:${entry.id}`,
      })),
    );
  }
  conversation.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  conversation = conversation.slice(-60);
  // The review transaction can commit before the runner persists its display event.
  const pendingReview = binding?.guided?.handoff ?? binding?.guided?.pending;
  if (pendingReview?.runId === `${stageKey(row)}:${latestUserSeq ?? 0}` && !currentQuestionShown) {
    messages.push({
      role: 'assistant',
      text: pendingReview.question,
      scope: binding!.session_id,
      inputId: latestUserSeq,
      handoff: true,
    });
    conversation.push({
      id: `pending-${pendingReview.runId}`,
      speaker: binding!.role,
      inputId: latestUserSeq,
      parts: [
        {
          kind: 'text',
          id: `question-pending-${pendingReview.runId}`,
          text: pendingReview.question,
        },
      ],
    });
  }
  conversation = boundConversation(
    deduplicateHandoffs(conversation),
    4 * CONVERSATION_BYTES,
    currentPartIds,
  );
  const cached =
    options.observation?.revision === row.revision &&
    options.observation.environmentId === row.environment_id
      ? options.observation
      : undefined;
  // A committed release fences new work before the provider confirms deletion. Passive views
  // must not offer it as ready, or retry is enabled only to fail and the next input cannot restore.
  const released = !!row.environment_id && environmentReleaseCommitted(row, row.environment_id);
  let environment: LearningView['environment'] = cached?.environment
    ? { ...cached.environment, ready: cached.environment.ready && !released }
    : null;
  let environmentService: SandboxService | undefined;
  let files = cached?.files ?? Object.keys(project.files);
  if (row.environment_id && !cached) {
    try {
      environmentService = await SandboxService.forOwner(principal);
      const observed = options.passive
        ? options.checkHealth === false
          ? await environmentService.get(row.environment_id)
          : await environmentService.reconcile(row.environment_id, false)
        : await touchEnvironment(store, row, environmentService, false);
      environment = observed
        ? {
            state: observed.state,
            ready: !released && observed.state === 'running' && observed.workspaceReady,
          }
        : null;
      if (environment?.ready)
        files = await projectFiles(environmentService, row.environment_id, project);
    } catch (error) {
      if (
        error instanceof SandboxError &&
        (error.reason === 'PBL_SOURCE_COUNT' || error.reason === 'PBL_SOURCE_PATH')
      )
        throw error;
      // Provider uncertainty must not hide durable teaching progress or cause another allocation.
      environment = { state: 'unknown', ready: false };
    }
  }
  let evaluation: LearningView['evaluation'] = cached?.evaluation ?? null;
  if (row.evaluation && row.environment_id && !cached) {
    try {
      const observed = await environmentService?.command(row.environment_id, row.evaluation.id);
      if (observed)
        evaluation = {
          id: observed.id,
          state: observed.state,
          ...(row.evaluation.purpose ? { purpose: row.evaluation.purpose } : {}),
          stdout: row.evaluation.purpose === 'compile' ? observed.stdout.slice(0, 8000) : '',
          stderr: row.evaluation.purpose === 'compile' ? observed.stderr.slice(0, 8000) : '',
        };
    } catch {
      evaluation = {
        id: row.evaluation.id,
        state: 'unavailable',
        stdout: '',
        stderr: '',
        ...(row.evaluation.purpose ? { purpose: row.evaluation.purpose } : {}),
      };
      // A missing command observation does not contradict the workspace health probe.
      // Keep the execution lock until collection confirms that its writer has stopped.
    }
  }

  const approvalCurrent = hasStageCompletion(row, stage, binding);
  const actions = learnerActions({
    definition: project.definition,
    state: row.state,
    stage,
    evaluation: row.evaluation,
    completionRecorded: approvalCurrent,
    buildAvailable: !!project.buildCommand,
  });
  const duplicateMessages = handoffEchoes(messages);
  return {
    id,
    revision: row.revision,
    title: project.definition.title,
    reportAvailable: canViewProjectReport(row.state),
    lifecycleError: row.lifecycle_error ?? null,
    checkpointFailure: row.checkpoint_failure ?? null,
    archiveDiscard: row.archive_discard ?? null,
    environmentId: row.environment_id,
    environment,
    recovery:
      row.environment_recovery?.requestId === row.environment_id && row.environment_id !== row.id
        ? {
            checkpointRevision: row.environment_recovery.checkpointRevision ?? 0,
            progressReset: row.environment_recovery.progressReset ?? false,
          }
        : null,
    state: row.state,
    stage,
    role,
    milestones: project.definition.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      optional: !!m.optional,
      stages: m.stages.map(stageStep),
    })),
    actions,
    files,
    busy: roleRun?.status === 'running' || roleRun?.status === 'queued' || (await busy(store, row)),
    messages: messages
      .filter((message) => !duplicateMessages.has(message))
      .slice(-60)
      .map(({ role, text }) => ({ role, text })),
    conversation,
    conversationHistory,
    activitySequence,
    task: { title: milestone.title, goal: milestone.goal ?? milestone.title },
    roleRun,
    needsOpening: !!role && !binding && row.state.status !== 'completed',
    evaluation,
    decisionSummary:
      stage.kind === 'produce'
        ? (row.state.collected[milestone.id]?.decisions ?? []).map((selected) => {
            const definition = project.definition.decisions.find((d) => d.id === selected.id);
            return {
              id: selected.id,
              prompt: definition?.desc ?? selected.id,
              choice: decisionResponseLabel(definition, selected.chosen),
              ...(selected.rationale === undefined ? {} : { rationale: selected.rationale }),
            };
          })
        : [],
    decisions:
      stage.kind === 'dialogue'
        ? project.definition.decisions
            .filter((d) => milestone.decisions.includes(d.id))
            .map((d) => ({
              id: d.id,
              prompt: d.decisionPrompt,
              ...(d.responseType === undefined ? {} : { responseType: d.responseType }),
              ...(d.requiresRationale === undefined
                ? {}
                : { requiresRationale: d.requiresRationale }),
              options: d.options.map((o) => ({ id: o.id, label: o.label })),
            }))
        : [],
    questions:
      stage.kind === 'check' && stage.checker === 'quiz'
        ? milestone.quiz.map((q) => ({ q: q.q, options: q.options }))
        : [],
  };
}
