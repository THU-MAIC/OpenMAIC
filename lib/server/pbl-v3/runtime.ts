import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
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
import { isPBLV3Reference, type LearningView } from '@/lib/pbl/v3/types';
import type { AgentRole } from '@/lib/pbl/v3/domain/project/project-schema';
import {
  currentStage,
  currentMilestone,
  projectIntroForSession,
} from '@/lib/pbl/v3/domain/orchestration/state';
import * as transitions from '@/lib/pbl/v3/domain/orchestration/transition';
import { judgeQuiz } from '@/lib/pbl/v3/domain/orchestration/quiz';
import type { EngineTransition } from '@/lib/pbl/v3/domain/orchestration/events';
import { assertProjectSource, projectFiles } from './workspace-files';
import { installedProject } from './catalog';
import { resolveProject } from './project-resolver';
import { startBuild, collectBuild } from './compilation';
import {
  evaluationCommand,
  evaluationFor,
  evaluationPassed,
  evaluationFeedback,
} from './evaluation';
import { LearningStore, type Study, type RoleBinding } from './store';
import {
  learningWorkspaceId,
  withLearningWorkspaceAccess,
  type WorkspaceMutation,
} from '@/lib/server/sandbox/managed-workspace';
import { touchEnvironment, assertEnvironmentReady, recoveredProgress } from './environment';

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function stageKey(row: Study) {
  return `${row.state.introCompleted ? row.state.position.milestoneId : 'intro'}:${row.state.introCompleted ? row.state.position.stageIndex : -1}`;
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
  return row.state.introCompleted
    ? currentStage(project, row.state)!
    : projectIntroForSession(project, row.state);
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
  return null;
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
export async function readFiles(service: SandboxService, row: Study, project = projectFor(row)) {
  const result: Record<string, string> = {};
  const environmentId = requireEnvironment(row);
  // A process can modify files without using our file API. Refuse evidence until managed writers stop.
  await service.assertWorkspaceIdle(environmentId);
  let bytes = 0;
  for (const path of await projectFiles(service, environmentId, project)) {
    const text = await service.readText(environmentId, path);
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
export async function fileSnapshot(service: SandboxService, row: Study) {
  const files = await readFiles(service, row);
  return { files, fingerprint: filesFingerprint(files) };
}
export function invalidateWorkspace(row: Study, changedPath?: string): EngineTransition {
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
  const documents = await getOwnerScopedDocumentStore(principal);
  const scene = await documents.getScene(stageId, sceneId);
  const content = scene?.content as unknown as { type?: string; projectV3?: unknown };
  if (content?.type !== 'pbl' || !isPBLV3Reference(content.projectV3))
    throw new SandboxError(
      'PBL_NOT_FOUND',
      404,
      'The classroom does not contain this learning project.',
    );
  const project = await resolveProject(principal.ownerId, stageId, content.projectV3);
  return (await LearningStore.open()).create(
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
export async function queueRole(store: LearningStore, db: PoolClient, row: Study, text: string) {
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
    'UPDATE pbl_v3_roles SET guided=CASE WHEN stage_key=$2 THEN guided ELSE NULL END,feedback_seq=CASE WHEN stage_key=$2 THEN feedback_seq+1 ELSE 1 END,stage_key=$2 WHERE session_id=$1',
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
  await agents.postUserMessage(binding.session_id, { text }, { expectedOwnerId: row.owner_id });
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
  answers?: number[];
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
      ? ['create', 'restore', 'write']
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
      if (row.revision !== command.revision)
        throw sandboxConflict('Progress changed. Refresh before submitting.');
    }
    const agents = await getAgentSessionStore();
    if (await busy(store, row))
      throw sandboxConflict('Wait for the teaching response, or cancel it first.');
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
    if (command.type === 'chat' || command.type === 'retry') {
      if (!isAgentRuntimeConfigured())
        throw new SandboxError(
          'PBL_RUNNER_DISABLED',
          503,
          'Enable the existing Agent runtime to use project teaching.',
        );
      check('chat');
      requireEnvironment(row);
      if (command.type === 'chat' && !command.text?.trim())
        throw sandboxInvalid('A learning message is required.');
      await assertWorkspaceModelsAuthorized(principal.ownerId, ['agent']);
      if (row.state.status === 'completed') throw sandboxConflict('This project is completed.');
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
          if (!binding || !meta || !['failed', 'cancelled'].includes(meta.status))
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
          // Reuse the actual student turn: retrying is not new feedback or approval.
          result = { sessionId: binding.session_id };
        } else {
          result = { sessionId: await queueRole(store, db, row, command.text!) };
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
      const previous = previousId ? await service.reconcile(previousId) : null;
      if (previous?.state === 'running' && previous.workspaceReady) {
        await service.renew(previous.id);
      } else {
        if (previous && previous.state !== 'destroyed')
          throw sandboxConflict(
            'The environment is not confirmed missing. Refresh or retry preparation.',
          );
        // Store allocation identity before network I/O. Reloads and lost acknowledgements reuse it.
        if (!row.environment_recovery || row.environment_recovery.requestId === previousId) {
          row.environment_recovery = { requestId: previousId ? randomUUID() : row.id };
          row = await store.transaction((db) =>
            store.commit(db, row, { state: row.state, events: [] }),
          );
        }
        let env = await service.create(
          row.environment_recovery!.requestId,
          learningWorkspaceId(row.id),
        );
        env = await service.reconcile(env.id);
        if (env.state === 'destroyed') {
          row.environment_recovery = { requestId: randomUUID() };
          await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
          throw sandboxConflict(
            'The replacement expired before preparation completed. Retry preparation.',
          );
        }
        assertEnvironmentReady(env);
        const checkpoint = await service.checkpoint(env.id);
        // Seed only a new workspace. A restored checkpoint must never be silently patched with starters.
        if (!checkpoint) {
          const existing = new Set((await service.listFiles(env.id)).map((file) => file.path));
          for (const [path, text] of Object.entries(project.files))
            if (!existing.has(path)) await service.writeText(env.id, path, text);
        }
        row.environment_id = env.id;
        const restored = recoveredProgress(row, project, await readFiles(service, row));
        transition = { state: restored.state, events: [] };
        row.evaluation = null;
        row.environment_recovery = {
          requestId: env.id,
          checkpointRevision: checkpoint?.revision ?? 0,
          progressReset: restored.reset,
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
      if (!command.path || command.text === undefined || typeof command.expectedHash !== 'string')
        throw sandboxInvalid('A project file, text and observed file hash are required.');
      assertProjectSource(project, command.path);
      if (stage.kind === 'produce' && stage.writes === 'plan' && command.path !== 'PLAN.md')
        throw sandboxConflict('Only PLAN.md can be edited during planning.');
      if (command.path === 'PLAN.md' && !(stage.kind === 'produce' && stage.writes === 'plan'))
        throw sandboxConflict('The approved plan is read-only during coding.');
      await service.compareAndWriteText(
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
      transition = { state: row.state, events: [] };
    } else if (command.type === 'checkpoint') {
      const checkpoint = await service.checkpoint(requireEnvironment(row));
      await service.saveWorkspace(requireEnvironment(row), checkpoint?.revision ?? 0);
    } else if (command.type === 'decide') {
      check('decide');
      const decision = definition.decisions.find((d) => d.id === command.decisionId);
      if (!decision?.options.some((o) => o.id === command.chosen))
        throw sandboxInvalid('Choose one of the current decision options.');
      transition = transitions.submitDecision(definition, row.state, {
        decisionId: decision.id,
        chosen: command.chosen!,
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
        command:
          project.testCommand ??
          evaluationCommand(evaluationFor(project, row.state.position.milestoneId!), command.id),
        timeoutMs: 60_000,
      });
      transition = { state: row.state, events: [] };
    } else if (command.type === 'collect') {
      if (!row.evaluation) throw sandboxConflict('No test is awaiting collection.');
      if (row.evaluation.purpose === 'compile') {
        const buildResult = await collectBuild(store, row, service);
        if ('pending' in buildResult) return buildResult;
        result = buildResult;
        transition = { state: row.state, events: [] };
        return store.transaction(async (db) => {
          await persist(db);
          return result;
        });
      }
      const evaluation = row.evaluation;
      const observed = await service.command(requireEnvironment(row), evaluation.id);
      if (['starting', 'running', 'unknown'].includes(observed.state))
        return { pending: true, state: observed.state };
      const snapshot = await fileSnapshot(service, row);
      if (
        stageKey(row) !== evaluation.stageKey ||
        snapshot.fingerprint !== evaluation.fingerprint
      ) {
        row.evaluation = null;
        transition = invalidateWorkspace(row);
        result = { stale: true };
      } else {
        const milestone = currentMilestone(definition, row.state)!;
        const collected = row.state.collected[milestone.id]!;
        transition = transitions.recordEvaluation(
          definition,
          row.state,
          {
            id: evaluation.id,
            status:
              observed.state === 'exited'
                ? observed.exitCode === 0 &&
                  (project.testCommand !== undefined ||
                    evaluationPassed(
                      evaluationFor(project, milestone.id),
                      evaluation.id,
                      observed.stdout,
                    ))
                  ? 'passed'
                  : 'failed'
                : 'error',
            evaluator: 'sandbox-command',
            milestoneId: milestone.id,
            stageIndex: row.state.position.stageIndex,
            revision: {
              id: snapshot.fingerprint,
              provider: 'sandbox',
              createdAt: new Date().toISOString(),
            },
            decisionRecordIds: Object.values(collected.decisionRecordIds),
            planArtifactId: collected.plan?.id,
            codeArtifactId: collected.code?.id,
            startedAt: evaluation.startedAt,
            completedAt: new Date().toISOString(),
            publicFeedback: project.testCommand
              ? (observed.stdout + '\n' + observed.stderr).slice(0, 8000)
              : evaluationFeedback(observed.stdout, observed.stderr),
            failureKind: observed.state === 'exited' ? 'assertion' : 'infrastructure',
          },
          { remediationId: randomUUID() },
        );
        row.evaluation = null;
      }
    } else if (command.type === 'next') {
      if (row.evaluation)
        throw sandboxConflict('Collect the pending test result before continuing.');
      check('next');
      const role = roleFor(row);
      if (role && stage.kind !== 'dialogue') {
        const bindings = await store.roles(id);
        const binding = bindings.find((b) => b.role === role && b.stage_key === stageKey(row));
        const meta = binding ? await agents.getSession(binding.session_id) : null;
        const latestUser = binding
          ? (await listAgentUserMessages(agents, binding.session_id)).at(-1)
          : null;
        if (
          meta?.status !== 'succeeded' ||
          ((stage.kind === 'mentor_say' || stage.kind === 'produce') &&
            (binding?.completion?.stageKey !== stageKey(row) ||
              binding.completion.feedbackSeq !== binding.feedback_seq ||
              binding.completion.userMessageSeq !== latestUser?.seq))
        )
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
      }
      if (stage.kind === 'produce') {
        // Establish a durable artifact before acknowledging the student's stage confirmation.
        const checkpoint = await service.checkpoint(requireEnvironment(row));
        await service.saveWorkspace(requireEnvironment(row), checkpoint?.revision ?? 0);
      }
      transition = row.state.introCompleted
        ? transitions.completeCurrentStage(definition, row.state)
        : transitions.completeIntro(row.state);
    } else throw sandboxInvalid('Unknown learning action.');
    return store.transaction(async (db) => {
      await persist(db);
      return result;
    });
  };
  return store.exclusive(id, () =>
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

export async function learningView(principal: OwnerPrincipal, id: string): Promise<LearningView> {
  const store = await LearningStore.open(),
    row = await store.get(id, principal.ownerId);
  const project = projectFor(row),
    stage = stageFor(row),
    role = roleFor(row),
    milestone = currentMilestone(project.definition, row.state)!;
  const binding = (await store.roles(id)).find(
    (b) => b.role === role && b.stage_key === stageKey(row),
  );
  const messages: LearningView['messages'] = [];
  let roleRun: LearningView['roleRun'] = null;
  let latestUserSeq: number | undefined;
  let currentQuestionShown = false;
  if (binding) {
    const agents = await getAgentSessionStore();
    const meta = await agents.getSession(binding.session_id);
    roleRun = {
      status: meta?.status ?? 'missing',
      canRetry: !!meta && ['failed', 'cancelled'].includes(meta.status),
      // Never expose raw provider errors, URLs, or credentials to the browser.
      failure:
        meta?.status === 'failed'
          ? /\b(401|403)\b|unauthori[sz]ed|authentication|api.?key/i.test(meta.error ?? '')
            ? 'authentication'
            : /timed?\s*out|timeout|deadline/i.test(meta.error ?? '')
              ? 'timeout'
              : 'unavailable'
          : null,
    };
    latestUserSeq = (await listAgentUserMessages(agents, binding.session_id)).at(-1)?.seq;
    // Bounded transcript projection; durable role history remains in the runner's entry tree.
    const last = await agents.lastEventSeq(binding.session_id);
    const events = await agents.readEventsAfter(binding.session_id, Math.max(0, last - 1000), 1000);
    for (const event of events) {
      const data = event.data as {
        text?: string;
        toolName?: string;
        isError?: boolean;
        result?: { content?: { type: string; text?: string }[] };
        message?: { role?: string; content?: unknown };
      };
      if (
        event.type === 'tool_execution_end' &&
        data.toolName === 'request_skill_review' &&
        !data.isError
      ) {
        for (const block of data.result?.content ?? []) {
          if (block.type === 'text' && block.text) {
            try {
              const task = JSON.parse(block.text);
              if (typeof task.question === 'string') {
                messages.push({ role: 'assistant', text: task.question });
                if (
                  event.id > (latestUserSeq ?? 0) &&
                  task.question === binding.guided?.pending?.question
                )
                  currentQuestionShown = true;
              }
            } catch {
              /* Only the structured review receipt is a student-facing question. */
            }
          }
        }
      }
      if (event.type === 'user_message' && typeof data.text === 'string') {
        messages.push({ role: 'user', text: data.text });
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
        if (text) messages.push({ role: 'assistant', text });
      }
    }
  }
  // The review transaction can commit before the runner persists its display event.
  const pendingReview = binding?.guided?.pending;
  if (pendingReview?.runId === `${stageKey(row)}:${latestUserSeq ?? 0}` && !currentQuestionShown)
    messages.push({ role: 'assistant', text: pendingReview.question });
  let environment: LearningView['environment'] = null;
  let environmentService: SandboxService | undefined;
  let files = Object.keys(project.files);
  if (row.environment_id) {
    try {
      environmentService = await SandboxService.forOwner(principal);
      const observed = await touchEnvironment(store, row, environmentService);
      environment = observed
        ? { state: observed.state, ready: observed.state === 'running' && observed.workspaceReady }
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
  let evaluation: LearningView['evaluation'] = null;
  if (row.evaluation && row.environment_id) {
    try {
      const observed = await environmentService?.command(row.environment_id, row.evaluation.id);
      if (observed)
        evaluation = {
          id: observed.id,
          state: observed.state,
          stdout:
            row.evaluation.purpose === 'compile' || project.testCommand
              ? observed.stdout.slice(0, 8000)
              : evaluationFeedback(observed.stdout, observed.stderr),
          stderr:
            row.evaluation.purpose === 'compile' || project.testCommand
              ? observed.stderr.slice(0, 8000)
              : '',
        };
    } catch {
      evaluation = { id: row.evaluation.id, state: 'unavailable', stdout: '', stderr: '' };
      environment = { state: environment?.state ?? 'unknown', ready: false };
    }
  }

  const actions: string[] =
    row.state.status === 'completed'
      ? []
      : [...transitions.allowedStudentActions(project.definition, row.state)];
  if (
    actions.includes('edit') &&
    stage.kind === 'produce' &&
    stage.writes === 'code' &&
    project.buildCommand
  )
    actions.push('compile');
  const guided = stage.kind === 'mentor_say' || stage.kind === 'produce';
  const approvalCurrent =
    roleRun?.status === 'succeeded' &&
    binding?.completion?.stageKey === stageKey(row) &&
    binding.completion.feedbackSeq === binding.feedback_seq &&
    binding.completion.userMessageSeq === latestUserSeq;
  return {
    id,
    revision: row.revision,
    title: project.definition.title,
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
    actions:
      row.evaluation || (guided && !approvalCurrent)
        ? actions.filter((action) => action !== 'next')
        : actions,
    files,
    busy: await busy(store, row),
    messages: messages.slice(-60),
    roleRun,
    evaluation,
    decisions:
      stage.kind === 'dialogue'
        ? project.definition.decisions
            .filter((d) => milestone.decisions.includes(d.id))
            .map((d) => ({
              id: d.id,
              prompt: d.decisionPrompt,
              options: d.options.map((o) => ({ id: o.id, label: o.label })),
            }))
        : [],
    questions:
      stage.kind === 'check' && stage.checker === 'quiz'
        ? milestone.quiz.map((q) => ({ q: q.q, options: q.options }))
        : [],
  };
}
