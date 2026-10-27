/** Real PG + local Python execution. Model decisions are driven explicitly through the role tools. No cloud or live model calls. */
import { beforeAll, afterAll, describe, expect, it, vi, onTestFinished } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { PgAssetStore, ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import { PgDocumentStore, ensureDocumentSchema } from '@openmaic/storage/document/pg';
import { ensureStageMetaSchema, claimStageMeta } from '@/lib/persistence/stage-meta';
import { ensurePBLProjectSchema } from '@/lib/persistence/pbl-projects';
import { installProjectPackage } from '@/lib/server/pbl-v3/project-resolver';
import {
  packageBuiltin,
  indexProjectFiles,
  type ProjectDescriptor,
} from '@/lib/server/pbl-v3/project-package';
import { WORKSPACE_FILE_RUNNER } from '@/lib/server/sandbox/workspace-archive';
import { workbenchCommand, workbenchView } from '@/lib/server/pbl-v3/workbench';
import { issuePreviewGrant } from '@/lib/server/sandbox/preview';
import type { ModelMessage } from 'ai';
import { PgAgentSessionStore, ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
import { listAgentUserMessages } from '@/lib/server/agent-runtime/user-messages';
vi.mock('server-only', () => ({}));
const mocked = vi.hoisted(() => ({
  pool: undefined as unknown,
  agents: undefined as unknown,
  root: '',
  missing: new Set<string>(),
  failInspect: false,
  failImport: false,
  failExport: false,
  loseWriteAck: false,
  loseCreateAck: false,
  hideDiscovery: false,
  creates: [] as string[],
  renewals: [] as string[],
  lifetimeMs: 300_000,
  terminals: new Map<string, number>(),
  inputs: [] as string[],
  objects: new Map<string, Uint8Array>(),
  responses: [] as Array<Array<Record<string, unknown>>>,
  reportAnalysis: vi.fn(),
  liveNotifications: false,
  modelCalls: 0,
  modelRequests: [] as ModelMessage[][],
  modelSystems: [] as (string | undefined)[],
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: mocked.pool,
    assetStore: new PgAssetStore(mocked.pool as Pool, {
      withTransaction: async (fn) => {
        const db = await (mocked.pool as Pool).connect();
        try {
          await db.query('BEGIN');
          const result = await fn(db);
          await db.query('COMMIT');
          return result;
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        } finally {
          db.release();
        }
      },
      byteStore: new PgAssetByteStore(mocked.pool as Pool),
    }),
    assetStoreIn: (db: Pool) =>
      new PgAssetStore(db, {
        withTransaction: (fn) => fn(db),
        byteStore: new PgAssetByteStore(mocked.pool as Pool),
      }),
    withTransaction: async (fn: (db: unknown) => Promise<unknown>) => {
      const db = await (mocked.pool as Pool).connect();
      try {
        await db.query('BEGIN');
        const result = await fn(db);
        await db.query('COMMIT');
        return result;
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
    },
  }),
}));
vi.mock('@/lib/server/pbl-v3/report-analysis', () => ({
  analyzeLearningReport: mocked.reportAnalysis,
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => mocked.agents,
}));
vi.mock('@/lib/server/model-config/runtime', () => ({
  assertWorkspaceModelsAuthorized: async () => {},
  backgroundWorkspaceId: async (owner: string) => owner,
}));
vi.mock('@/lib/persistence/asset-byte-store', () => ({
  configuredS3Bucket: () => null,
  resolveConfiguredAssetByteStore: async () => ({
    writesOutsideRegistryDatabase: true,
    withPrefix: (prefix: string) => ({
      write: async (hash: string, bytes: Uint8Array) => {
        mocked.objects.set(prefix + hash, Uint8Array.from(bytes));
      },
      read: async (hash: string) => mocked.objects.get(prefix + hash) ?? null,
      delete: async (hash: string) => {
        mocked.objects.delete(prefix + hash);
      },
    }),
  }),
}));
vi.mock('@/lib/server/sandbox/settings', () => ({
  assertSandboxSettingsRevision: async () => {},
  resolvedSandboxConfig: async () => ({
    fingerprint: 'test',
    settingsRevision: 0,
    lifetimeMs: mocked.lifetimeMs,
    maxActive: 100,
    maxActivePerOwner: 100,
  }),
}));
vi.mock('@/lib/server/sandbox/providers/e2b-compatible', () => ({
  E2BCompatibleSandboxProvider: class {
    async create(id: string) {
      mocked.creates.push(id);
      await mkdir(join(mocked.root, id), { recursive: true });
      if (mocked.loseCreateAck) throw new Error('Create acknowledgement lost');
      return { id, state: 'running' };
    }
    async find(id: string) {
      return mocked.hideDiscovery ? [] : [{ id, state: 'running' }];
    }
    async inspect(id: string) {
      if (mocked.failInspect) throw new Error('Provider unavailable');
      return mocked.missing.has(id) ? null : { id, state: 'running' };
    }
    async renew(id: string) {
      if (mocked.missing.has(id)) throw new Error('Environment missing');
      mocked.renewals.push(id);
    }
    async *exportWorkspace(id: string) {
      if (mocked.failExport) throw new Error('Checkpoint export unavailable');
      const files: Record<string, string> = {};
      const walk = async (dir: string, prefix = '') => {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          if (
            entry.name.startsWith('.command-') ||
            ['__pycache__', 'target', '.venv'].includes(entry.name)
          )
            continue;
          const path = prefix + entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), path + '/');
          else files[path] = await readFile(join(dir, entry.name), 'utf8');
        }
      };
      await walk(join(mocked.root, id));
      yield Buffer.from(JSON.stringify(files));
    }
    async destroy(id: string) {
      mocked.missing.add(id);
    }
    async importWorkspace(id: string, _operation: string, source: AsyncIterable<Uint8Array>) {
      if (mocked.failImport) throw new Error('Interrupted restore');
      const chunks = [];
      for await (const chunk of source) chunks.push(chunk);
      const files = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>;
      for (const [name, text] of Object.entries(files)) {
        await mkdir(dirname(join(mocked.root, id, name)), { recursive: true });
        await writeFile(join(mocked.root, id, name), text);
      }
    }
    async initializeWorkspace() {}
    async readText(id: string, _operation: string, path: string) {
      path = path.replace(/^\/home\/user\/project\//, '');
      return readFile(join(mocked.root, id, path), 'utf8');
    }
    async writeText(id: string, _operation: string, path: string, text: string) {
      path = path.replace(/^\/home\/user\/project\//, '');
      await mkdir(dirname(join(mocked.root, id, path)), { recursive: true });
      await writeFile(join(mocked.root, id, path), text);
      if (mocked.loseWriteAck) throw new Error('Write acknowledgement lost');
    }
    async listWorkspace(id: string) {
      const result: { path: string; kind: string; size: number }[] = [];
      const walk = async (dir: string, prefix = '') => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (
            entry.name.startsWith('.command-') ||
            ['__pycache__', 'target', '.venv'].includes(entry.name)
          )
            continue;
          const path = prefix + entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), path + '/');
          else result.push({ path, kind: 'file', size: 0 });
        }
      };
      await walk(join(mocked.root, id));
      return result;
    }
    async mutateFile(
      id: string,
      _operation: string,
      input: {
        action: string;
        path: string;
        destination?: string;
        text?: string;
        expectedHash?: string;
      },
    ) {
      const transfer = join(mocked.root, `mutation-${randomUUID()}`);
      await writeFile(transfer, JSON.stringify(input));
      await promisify(execFile)('python3', [
        '-c',
        WORKSPACE_FILE_RUNNER.replace(
          "root='/home/user/project'",
          `root=${JSON.stringify(join(mocked.root, id))}`,
        ),
        input.action,
        Buffer.from(input.path).toString('base64'),
        transfer,
      ]);
    }
    async previewLifetime() {
      return Date.now() + 60000;
    }
    async nativePreview() {
      return {
        url: 'https://8000-example.provider.test',
        headers: { 'e2b-traffic-access-token': 'test' },
      };
    }
    async createTerminal(_id: string, _op: string, terminal: string) {
      mocked.terminals.set(terminal, 123);
      return 123;
    }
    async findTerminal(_id: string, _op: string, terminal: string) {
      return mocked.terminals.get(terminal) ?? null;
    }
    async terminalInput(_id: string, _op: string, _pid: number, data: string) {
      mocked.inputs.push(data);
    }
    async resizeTerminal() {}
    async closeTerminal() {
      mocked.terminals.clear();
    }
    async startCommand(id: string, _operation: string, input: { id: string; command: string }) {
      let stdout = '',
        stderr = '',
        exitCode = 0;
      try {
        const result = await promisify(execFile)('/bin/sh', ['-c', input.command], {
          cwd: join(mocked.root, id),
          timeout: 10000,
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (e) {
        const error = e as { stdout?: string; stderr?: string; code?: number };
        stdout = error.stdout ?? '';
        stderr = error.stderr ?? '';
        exitCode = typeof error.code === 'number' ? error.code : 1;
      }
      await writeFile(
        join(mocked.root, id, `.command-${input.id}`),
        JSON.stringify({
          id: input.id,
          state: 'exited',
          stdout,
          stderr,
          exitCode,
          truncated: false,
        }),
      );
    }
    async readCommand(id: string, _operation: string, commandId: string) {
      return JSON.parse(await readFile(join(mocked.root, id, `.command-${commandId}`), 'utf8'));
    }
    async cancelCommand() {}
  },
}));
vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: async () => ({
    connection: { model: {} },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'test-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  }),
}));
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/agent-runtime/owner-scoped-documents')>()),
  getBackgroundDocumentStore: async () => ({}),
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/agent-runtime/event-notify-bus')>();
  return {
    ...actual,
    notifyDurableAgentEvent: (...args: Parameters<typeof actual.notifyDurableAgentEvent>) =>
      mocked.liveNotifications ? actual.notifyDurableAgentEvent(...args) : Promise.resolve(),
    subscribeAgentEventWakeup: (...args: Parameters<typeof actual.subscribeAgentEventWakeup>) =>
      mocked.liveNotifications ? actual.subscribeAgentEventWakeup(...args) : () => {},
  };
});
vi.mock('@/lib/ai/llm', () => ({
  streamLLM: (options: { messages: ModelMessage[]; system?: string }) => {
    mocked.modelSystems.push(options.system);
    mocked.modelRequests.push(structuredClone(options.messages));
    return {
      fullStream: (async function* () {
        mocked.modelCalls += 1;
        for (const part of mocked.responses.shift() ?? []) yield part;
      })(),
      usage: new Promise(() => {}),
    };
  },
}));
import { runSession, startAgentRunner } from '@/lib/server/agent-runtime/runner';
import { ensureOwnerMergeSchema } from '@/lib/persistence/owner-merges';
import { ensureSandboxEnvironmentSchema } from '@/lib/persistence/sandbox-environments';
import {
  learningReport,
  learningEvidence,
  generateLearningReport,
} from '@/lib/server/pbl-v3/report';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import * as catalog from '@/lib/server/pbl-v3/catalog';
import { SandboxError } from '@/lib/sandbox/errors';
import { LearningStore } from '@/lib/server/pbl-v3/store';
import { maintainLearningEnvironments, maintainStudy } from '@/lib/server/pbl-v3/lifecycle';
import { pblIdleTimeoutMs } from '@/lib/server/pbl-v3/lifecycle-config';
import {
  commandStudy,
  openStudy,
  learningView,
  digest,
  stageFor,
  stageKey,
  saveStudyCheckpoint,
} from '@/lib/server/pbl-v3/runtime';
import { teachingRunnerConfig } from '@/lib/server/pbl-v3/runner-tools';
import { touchEnvironment } from '@/lib/server/pbl-v3/environment';
import { recordLearningEvidence } from '@/lib/server/pbl-v3/evidence';
import { reportConversationMessages } from '@/lib/pbl/v3/report';
import { createThinkingTimingTracker } from '@/lib/server/pbl-v3/thinking-timing';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxStore } from '@/lib/server/sandbox/store';
import {
  withLearningWorkspaceAccess,
  learningWorkspaceId,
} from '@/lib/server/sandbox/managed-workspace';
import { E2BCompatibleSandboxProvider } from '@/lib/server/sandbox/providers/e2b-compatible';
import type { OwnerPrincipal } from '@/lib/server/identity/types';

const url = process.env.PG_CONTRACT_URL,
  schema = `pbl_v3_${randomUUID().replaceAll('-', '')}`;
let admin: Pool, pool: Pool, store: LearningStore, agents: PgAgentSessionStore;
const principal: OwnerPrincipal = {
  ownerId: 'learner-a',
  kind: 'user',
  assurance: 'verified',
  roles: new Set(['sandbox:use']),
};
const project = installedProject({ id: 'greeting-python', version: '1.0.0' });
let studyId: string;
async function command(type: string, payload: Record<string, unknown> = {}) {
  const row = await store.get(studyId, principal.ownerId);
  return commandStudy(principal, studyId, {
    id: randomUUID(),
    revision: row.revision,
    type,
    ...payload,
  });
}
async function freshStudy(definition = project) {
  const row = await store.create(
    {
      ownerId: principal.ownerId,
      stageId: randomUUID(),
      sceneId: 'scene',
      projectId: definition.ref.id,
      version: definition.ref.version,
    },
    startOrchestration(definition.definition),
  );
  const send = async (type: string) =>
    commandStudy(principal, row.id, {
      id: randomUUID(),
      revision: (await store.get(row.id, principal.ownerId)).revision,
      type,
      ...(type === 'chat' ? { text: 'Please start.' } : {}),
    });
  await send('prepare');
  return { id: row.id, send };
}
async function freshTeachingStudy() {
  const original = studyId;
  const study = await freshStudy();
  studyId = study.id;
  try {
    await runTools('Introduce the project.', async (config) => {
      await invoke(config, 'request_skill_review', { question: 'Ready to begin?' });
    });
    await runTools('Ready, please begin teaching.', async (config) => {
      await invoke(config, 'read_next_skill', { studentFeedback: 'The learner is ready.' });
    });
  } finally {
    studyId = original;
  }
  return study;
}
function modelFinish(finishReason: string) {
  return {
    type: 'finish',
    finishReason,
    totalUsage: {
      inputTokens: 1,
      outputTokens: 1,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { reasoningTokens: 0 },
      totalTokens: 2,
    },
  };
}
function textResponse(text: string) {
  return [{ type: 'text-delta', text }, modelFinish('stop')];
}
function toolResponse(calls: { name: string; input: Record<string, unknown> }[]) {
  return [
    ...calls.map((call) => ({
      type: 'tool-call',
      toolCallId: randomUUID(),
      toolName: call.name,
      input: call.input,
    })),
    modelFinish('tool-calls'),
  ];
}
async function runTools(
  instruction: string,
  steps: (config: Awaited<ReturnType<typeof teachingRunnerConfig>>) => Promise<void>,
) {
  const queued = (await command('chat', { text: instruction })) as { sessionId: string };
  const meta = await agents.claimNextSession('test-worker', process.pid, {
    sessionId: queued.sessionId,
    leaseTtlMs: 10000,
    maxAttempts: 5,
  });
  expect(meta).toBeTruthy();
  const config = await teachingRunnerConfig({
    sessionId: queued.sessionId,
    ownerId: principal.ownerId,
    workerId: 'test-worker',
    attempt: meta!.attempt,
    signal: new AbortController().signal,
  });
  expect(config.allowedToolNames.has('patch_stage')).toBe(false);
  await steps(config);
  await agents.finishSession(queued.sessionId, 'test-worker', {
    status: 'succeeded',
    expectedAttempt: meta!.attempt,
  });
}
async function invoke(
  config: Awaited<ReturnType<typeof teachingRunnerConfig>>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = config.tools.find((t) => t.name === name)!;
  expect(tool).toBeDefined();
  return tool.execute(randomUUID(), args);
}
async function guided(role: 'teaching' | 'plan' | 'code') {
  const current = await store.get(studyId, principal.ownerId);
  const welcome =
    role === 'teaching' &&
    current.state.position.milestoneIndex === 0 &&
    current.state.position.stageIndex === 0;
  if (welcome)
    await runTools('Please introduce this project.', async (config) => {
      const opening = await invoke(config, 'read_next_skill');
      expect(JSON.stringify(opening)).toContain('Welcome only');
      await invoke(config, 'request_skill_review', {
        question: 'Any process questions? Ready to begin?',
      });
    });
  const parts = role === 'teaching' ? 3 : 4;
  for (let index = 0; index < parts; index++)
    await runTools(
      index === 0
        ? welcome
          ? 'Ready, please begin teaching.'
          : 'Please start.'
        : 'I checked the current part and understand it.',
      async (config) => {
        await invoke(config, 'read_next_skill', {
          ...(index
            ? { studentFeedback: 'I checked the current part' }
            : welcome
              ? { studentFeedback: 'The learner explicitly asks to begin teaching.' }
              : {}),
        });
        expect(config.thinkingConfig()).toEqual({ mode: 'enabled', effort: 'low', level: 'low' });
        if (index === 0 && role !== 'teaching') {
          const path = role === 'plan' ? 'PLAN.md' : 'greeting.py';
          const service = await SandboxService.forOwner(principal),
            row = await store.get(studyId, principal.ownerId);
          const text = await service.readText(row.environment_id!, path);
          await invoke(config, 'write_file', {
            path,
            text:
              role === 'plan'
                ? 'Use a formatted string to return the greeting.'
                : 'def greet(name):\n    return f"Hello, {name}!"\n',
            expectedHash: digest(text),
          });
        }
        if (index === 0 && role !== 'teaching') {
          const before = await store.get(studyId, principal.ownerId);
          const path = role === 'plan' ? 'PLAN.md' : 'greeting.py';
          const text = await (
            await SandboxService.forOwner(principal)
          ).readText(before.environment_id!, path);
          await invoke(config, 'write_file', { path, text, expectedHash: digest(text) });
          expect((await store.get(studyId, principal.ownerId)).revision).toBe(before.revision);
        }
        if (index === 0 && role === 'code') {
          await invoke(config, 'manage_file', {
            action: 'create',
            path: 'src/helper.py',
            text: '# helper',
          });
          const listed = await invoke(config, 'list_files');
          expect(JSON.stringify(listed)).toContain('src/helper.py');
          await invoke(config, 'manage_file', {
            action: 'rename',
            path: 'src/helper.py',
            destination: 'src/moved.py',
            expectedHash: digest('# helper'),
          });
          await expect(
            invoke(config, 'manage_file', {
              action: 'delete',
              path: 'PLAN.md',
              expectedHash: digest(''),
            }),
          ).rejects.toThrow('read-only');
          await invoke(config, 'manage_file', {
            action: 'delete',
            path: 'src/moved.py',
            expectedHash: digest('# helper'),
          });
        }
        await invoke(config, 'request_skill_review', {
          question: 'Explain and check the current part.',
        });
        if (index === 0 && role === 'plan') {
          const binding = (await store.roles(studyId)).find((b) => b.role === 'planner')!;
          const meta = (await agents.getSession(binding.session_id))!;
          const resumed = await teachingRunnerConfig({
            sessionId: binding.session_id,
            ownerId: principal.ownerId,
            workerId: 'test-worker',
            attempt: meta.attempt,
            signal: new AbortController().signal,
          });
          expect(resumed.isTurnComplete()).toBe(true);
          await expect(
            invoke(resumed, 'write_file', {
              path: 'PLAN.md',
              text: 'Changed without a new reply',
              expectedHash: digest('Use a formatted string to return the greeting.'),
            }),
          ).rejects.toThrow('必须结束本轮');
        }
      },
    );
  await runTools('I checked the current part and confirm it.', async (config) => {
    await invoke(config, 'complete_stage', { studentFeedback: 'I checked the current part' });
  });
  if ((await store.get(studyId, principal.ownerId)).state.status === 'completed') return;
  if (role !== 'teaching') {
    const row = await store.get(studyId, principal.ownerId);
    const path = role === 'plan' ? 'PLAN.md' : 'greeting.py';
    const service = await SandboxService.forOwner(principal);
    const text = await service.readText(row.environment_id!, path);
    await command('save', { path, text, expectedHash: digest(text) });
    const saved = await store.get(studyId, principal.ownerId);
    expect(saved.state.collected).toEqual(row.state.collected);
    expect((await learningView(principal, studyId)).actions).toContain('next');
    await expect(command('save', { path, text, expectedHash: digest('outdated') })).rejects.toThrow(
      'changed',
    );
    expect((await store.get(studyId, principal.ownerId)).state.collected).toEqual(
      row.state.collected,
    );
  }
  // Generic Agent messages also preserve a valid stage approval; they cannot advance it.
  const approved = await store.get(studyId, principal.ownerId);
  const key = `${approved.state.position.milestoneId}:${approved.state.position.stageIndex}`;
  const binding = (await store.roles(studyId)).find((binding) => binding.stage_key === key)!;
  await agents.postUserMessage(
    binding.session_id,
    { text: 'I still have a question.' },
    { expectedOwnerId: principal.ownerId },
  );
  const meta = await agents.claimNextSession('direct-worker', process.pid, {
    sessionId: binding.session_id,
    leaseTtlMs: 10000,
    maxAttempts: 5,
  });
  const followUp = await teachingRunnerConfig({
    sessionId: binding.session_id,
    ownerId: principal.ownerId,
    workerId: 'direct-worker',
    attempt: meta!.attempt,
    signal: new AbortController().signal,
  });
  expect(followUp.systemPrompt).toContain('"completionRecorded":true');
  await agents.finishSession(binding.session_id, 'direct-worker', {
    status: 'succeeded',
    expectedAttempt: meta!.attempt,
  });
  expect((await learningView(principal, studyId)).actions).toContain('next');
  expect((await store.get(studyId, principal.ownerId)).state.position).toEqual(
    approved.state.position,
  );
  await command('next');
}
describe.skipIf(!url)('PBL v3 teaching runtime with real PG', () => {
  beforeAll(async () => {
    mocked.root = await mkdtemp(join(tmpdir(), 'pbl-v3-test-'));
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
    mocked.pool = pool;
    await ensureOwnerMergeSchema(pool);
    await ensureDocumentSchema(pool);
    await ensureStageMetaSchema(pool);
    await ensureAssetSchema(pool);
    await ensurePBLProjectSchema(pool);
    await ensureSandboxEnvironmentSchema(pool);
    await ensureAgentSessionSchema(pool);
    agents = new PgAgentSessionStore(pool, {
      withTransaction: async (fn) => {
        const db = await pool.connect();
        try {
          await db.query('BEGIN');
          const result = await fn(db);
          await db.query('COMMIT');
          return result;
        } catch (e) {
          await db.query('ROLLBACK');
          throw e;
        } finally {
          db.release();
        }
      },
    });
    mocked.agents = agents;
    vi.stubEnv('DATABASE_URL', url!);
    vi.stubEnv('OPENMAIC_AGENT_RUNTIME_ENABLED', 'true');
    store = await LearningStore.open();
    studyId = (
      await store.create(
        {
          ownerId: principal.ownerId,
          stageId: 'classroom',
          sceneId: 'scene',
          projectId: project.ref.id,
          version: project.ref.version,
        },
        startOrchestration(project.definition),
      )
    ).id;
  }, 30000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
    if (mocked.root) await rm(mocked.root, { recursive: true, force: true });
  });
  it('leaves study admission available for unrelated interaction during slow maintenance archives', async () => {
    const previousMax = pool.options.max;
    pool.options.max = 10; // The production pool's default admits two study operations.
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Set<string>();
    let scanning: Promise<void> | undefined;
    let maintaining: Promise<void> | undefined;
    const originalExport = E2BCompatibleSandboxProvider.prototype.exportWorkspace;
    const archive = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'exportWorkspace');
    try {
      const first = await freshStudy(),
        second = await freshStudy(),
        interactive = await freshStudy();
      const interactiveEnvironment = (await store.get(interactive.id, principal.ownerId))
        .environment_id!;
      const environments = new Set([
        (await store.get(first.id, principal.ownerId)).environment_id!,
        (await store.get(second.id, principal.ownerId)).environment_id!,
      ]);
      await ageStudy(first.id);
      await ageStudy(second.id);
      archive.mockImplementation(async function* (this: E2BCompatibleSandboxProvider, ...args) {
        if (environments.has(args[0])) {
          started.add(args[0]);
          entered();
          await gate;
        }
        yield* originalExport.apply(this, args);
      });
      const renewals = mocked.renewals.length;
      // Establish the slow archive before scanning. A scan may legitimately defer every
      // archive when a lightweight recent-study renewal wins the maintenance slot.
      maintaining = maintainStudy(store, first.id, principal.ownerId);
      await Promise.race([
        ready,
        maintaining.then(() => {
          throw new Error('Maintenance completed before entering the archive.');
        }),
      ]);
      scanning = maintainLearningEnvironments();
      await expect(
        store.waitForExclusive(interactive.id, () =>
          store.recordActivity(interactive.id, principal.ownerId),
        ),
      ).resolves.toMatchObject({ id: interactive.id });
      await expect(interactive.send('checkpoint')).resolves.toBeDefined();
      await scanning;
      expect(mocked.renewals.slice(renewals)).toContain(interactiveEnvironment);
      expect(started.size).toBe(1);
      release();
      await maintaining;
      // With no recent-use competitor, successive scans reclaim the two remaining idle
      // candidates regardless of the database's UPDATE ... RETURNING order.
      await ageStudy(interactive.id);
      for (let pass = 0; pass < 2 && started.size < 2; pass++) await maintainLearningEnvironments();
      expect(started.size).toBe(2);
    } finally {
      release();
      try {
        await Promise.allSettled([maintaining, scanning]);
      } finally {
        archive.mockRestore();
        pool.options.max = previousMax;
      }
    }
  }, 15000);

  it.each([
    ['reading', true],
    ['agent', true],
    ['completed-agent', true],
    ['running-command', true],
    ['completed-command', true],
    ['overdue-command', false],
    ['idle', false],
    ['expired-failure', false],
    ['discard-intent', false],
    ['queued-dirty', true],
    ['queued-clean', true],
  ] as const)('keeps deferred %s work leased only while protected', async (kind, renewed) => {
    const fresh = await freshStudy();
    const row = await store.get(fresh.id, principal.ownerId);
    if (kind === 'agent' || kind === 'completed-agent') {
      const queued = (await fresh.send('chat')) as { sessionId: string };
      if (kind === 'completed-agent')
        await pool.query("UPDATE agent_sessions SET status='succeeded' WHERE id=$1", [
          queued.sessionId,
        ]);
    }
    if (kind.endsWith('command'))
      await pool.query(
        `INSERT INTO sandbox_commands(environment_id,id,request_fingerprint,result_json,created_at)
         VALUES($1,$2,'fixture',$3,$4)`,
        [
          row.environment_id,
          randomUUID(),
          JSON.stringify({ state: kind === 'completed-command' ? 'exited' : 'running' }),
          new Date(Date.now() - (kind === 'overdue-command' ? 20 * 60_000 : 60_000)),
        ],
      );
    if (!['reading', 'agent', 'discard-intent'].includes(kind)) await ageStudy(fresh.id);
    if (kind.startsWith('queued-'))
      await pool.query(
        "UPDATE pbl_v3_studies SET last_used_at=now()-interval '6 minutes',workspace_dirty_at=CASE WHEN $2 THEN now()-interval '2 minutes' ELSE NULL END WHERE id=$1",
        [fresh.id, kind === 'queued-dirty'],
      );
    if (kind === 'expired-failure')
      await store.recordCheckpointFailure(await store.get(fresh.id, principal.ownerId), {
        environmentId: row.environment_id!,
        reason: 'unavailable',
        stage: 'archive',
        retryable: true,
        dirtyAt: null,
        firstIdleFailureAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      });
    if (kind === 'discard-intent')
      await store.recordArchiveDiscard(row, {
        environmentId: row.environment_id!,
        at: new Date().toISOString(),
        checkpointRevision: 0,
        checkpointAt: null,
        reason: 'unavailable',
      });
    const previousMax = pool.options.max;
    pool.options.max = 10;
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = store.exclusive(
      randomUUID(),
      async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      'maintenance',
    );
    try {
      await ready;
      const renewals = mocked.renewals.length;
      const before = await store.get(fresh.id, principal.ownerId);
      const maintenance = maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId);
      if (kind === 'agent' || kind === 'discard-intent') await maintenance;
      else await expect(maintenance).rejects.toMatchObject({ code: 'PBL_BUSY' });
      expect(mocked.renewals.slice(renewals).includes(row.environment_id!)).toBe(renewed);
      const after = await store.get(fresh.id, principal.ownerId);
      expect(after.revision).toBe(before.revision);
      expect(after.last_used_at).toEqual(before.last_used_at);
    } finally {
      release();
      await held;
      pool.options.max = previousMax;
    }
  });
  it.each(['greeting-python-lab', 'greeting-java'])(
    'completes both seven-step milestones with a tool-completed final recap and no appended exploration for %s',
    async (projectId) => {
      const selected = installedProject({ id: projectId, version: '1.1.0' });
      const created = await store.create(
        {
          ownerId: principal.ownerId,
          stageId: randomUUID(),
          sceneId: 'scene',
          projectId,
          version: '1.1.0',
        },
        startOrchestration(selected.definition),
      );
      const id = created.id;
      const send = async (type: string, payload: Record<string, unknown> = {}) =>
        commandStudy(principal, id, {
          id: randomUUID(),
          revision: (await store.get(id, principal.ownerId)).revision,
          type,
          ...payload,
        });
      const roleTurn = async (
        text: string,
        body: (config: Awaited<ReturnType<typeof teachingRunnerConfig>>) => Promise<void>,
      ) => {
        const queued = (await send('chat', { text })) as { sessionId: string };
        const claimed = await agents.claimNextSession('journey-worker', process.pid, {
          sessionId: queued.sessionId,
          leaseTtlMs: 30000,
          maxAttempts: 5,
        });
        const config = await teachingRunnerConfig({
          sessionId: queued.sessionId,
          ownerId: principal.ownerId,
          workerId: 'journey-worker',
          attempt: claimed!.attempt,
          signal: new AbortController().signal,
        });
        await body(config);
        const inputs = await agents.listUserMessages(queued.sessionId);
        await agents.markUserMessageDelivered(
          queued.sessionId,
          'journey-worker',
          claimed!.attempt,
          inputs.at(-1)!.seq,
        );
        await agents.finishSession(queued.sessionId, 'journey-worker', {
          status: 'succeeded',
          expectedAttempt: claimed!.attempt,
        });
      };
      const guidedStage = async (
        write?: { path: string; text: string },
        repairEmptyPlan = false,
      ) => {
        const stage = (await learningView(principal, id)).stage;
        const position = (await learningView(principal, id)).state.position;
        const welcome = position.milestoneIndex === 0 && position.stageIndex === 0;
        if (welcome)
          await roleTurn('Introduce the project.', async (config) => {
            expect(JSON.stringify(await invoke(config, 'read_next_skill'))).toContain(
              'Welcome only',
            );
            await invoke(config, 'request_skill_review', { question: 'Ready to begin?' });
          });
        const parts = stage.kind === 'produce' ? 4 : 3;
        for (let part = 0; part < parts; part++)
          await roleTurn(
            part
              ? 'I checked this part and understand it.'
              : welcome
                ? 'Ready, please begin teaching.'
                : 'Please begin.',
            async (config) => {
              const section = await invoke(
                config,
                'read_next_skill',
                part
                  ? { studentFeedback: 'I checked this part' }
                  : welcome
                    ? { studentFeedback: 'The learner is ready to begin teaching.' }
                    : {},
              );
              expect(JSON.stringify(section)).not.toContain('PBL_RESULT');
              if (part === 0 && write && !repairEmptyPlan) {
                const row = await store.get(id, principal.ownerId);
                const current = await (
                  await SandboxService.forOwner(principal)
                ).readText(row.environment_id!, write.path);
                await invoke(config, 'write_file', { ...write, expectedHash: digest(current) });
              }
              if (part === 0 && stage.kind === 'produce' && stage.compileBeforeReview) {
                await expect(
                  invoke(config, 'request_skill_review', { question: 'Review the code.' }),
                ).rejects.toThrow('successful build');
                await invoke(config, 'run_build');
                await invoke(config, 'collect_build');
              }
              if (stage.kind === 'produce' && part === parts - 1) {
                await expect(
                  invoke(config, 'complete_stage', {
                    studentFeedback: 'Earlier understanding is not final approval.',
                    reuseFeedback: true,
                  }),
                ).rejects.toThrow('understanding feedback');
                expect(config.isTurnComplete()).toBe(false);
              }
              await invoke(config, 'request_skill_review', {
                question: 'Explain the current work and confirm what to change.',
              });
              expect(config.isTurnComplete()).toBe(true);
            },
          );
        if (repairEmptyPlan && write)
          await roleTurn('I checked this part and approve the current version.', async (config) => {
            await expect(
              invoke(config, 'complete_stage', { studentFeedback: 'I checked this part' }),
            ).rejects.toThrow('PLAN.md must contain');
            expect(config.isTurnComplete()).toBe(false);
            await invoke(config, 'write_file', { ...write, expectedHash: digest('') });
            await invoke(config, 'request_skill_review', { question: 'Review the repaired plan.' });
          });
        const queued = (await send('chat', {
          text: 'I checked this part and approve the current version.',
        })) as { sessionId: string };
        const handle = startAgentRunner();
        await handle.stop();
        const meta = await agents.claimNextSession(handle.workerId, process.pid, {
          sessionId: queued.sessionId,
          leaseTtlMs: 30000,
          maxAttempts: 5,
        });
        // Reproduce a fluent but uncommitted handoff for EVERY guided stage.
        // The runner must close the same real turn, never fabricate learner input.
        mocked.responses = [
          textResponse('All done. Click Continue.'),
          toolResponse([
            { name: 'complete_stage', input: { studentFeedback: 'I checked this part' } },
          ]),
        ];
        const beforeCalls = mocked.modelCalls;
        const realInputs = await agents.listUserMessages(queued.sessionId);
        await runSession({ running: new Map(), shuttingDown: false }, meta!);
        expect(mocked.modelCalls - beforeCalls).toBe(2);
        const settled = await agents.getSession(queued.sessionId);
        expect(settled?.status, settled?.error).toBe('succeeded');
        expect(await agents.listUserMessages(queued.sessionId)).toEqual(realInputs);
        const request = mocked.modelRequests.at(-1)!;
        expect(request.at(-1)?.role).not.toBe('assistant');
        expect(mocked.modelSystems.at(-1)).toContain('Runtime continuation:');
        const approved = await learningView(principal, id);
        if (approved.state.status === 'completed') return;
        expect(approved.actions).toContain('next');
        const completedPosition = approved.state.position;
        // A normal follow-up is not a request to revoke an already recorded review.
        await roleTurn('What should I do next?', async (config) => {
          expect(config.systemPrompt).toContain('"completionRecorded":true');
          expect(config.systemPrompt).toContain('ALREADY complete');
          expect(config.isTurnComplete()).toBe(false); // Answer the new question normally.
        });
        const afterFollowUp = await learningView(principal, id);
        expect(afterFollowUp.actions).toContain('next');
        expect(afterFollowUp.state.position).toEqual(completedPosition);
        await send('next');
        const entered = await learningView(principal, id);
        if (entered.state.status !== 'completed') {
          expect(entered.state.position).not.toEqual(completedPosition);
          expect(entered.needsOpening).toBe(true);
          const opening = (await send('begin')) as { sessionId: string };
          const openingEvents = await agents.readEventsAfter(opening.sessionId, 0, 1000);
          expect(openingEvents.some((event) => event.type === 'pbl_stage_entered')).toBe(true);
          expect(openingEvents.at(-1)?.data).toMatchObject({ pblOpening: true });
          const claimed = await agents.claimNextSession('opening-check-worker', process.pid, {
            sessionId: opening.sessionId,
            leaseTtlMs: 30000,
            maxAttempts: 5,
          });
          const config = await teachingRunnerConfig({
            sessionId: opening.sessionId,
            ownerId: principal.ownerId,
            workerId: 'opening-check-worker',
            attempt: claimed!.attempt,
            signal: new AbortController().signal,
          });
          if (entered.stage.kind === 'check') {
            expect(config.systemPrompt).toContain('Do not ask a warm-up');
            expect(config.systemPrompt).not.toContain('每次回复只执行当前已披露部分');
            expect(config.allowedToolNames.has('request_skill_review')).toBe(false);
            expect(config.allowedToolNames.has('complete_stage')).toBe(false);
          }
          expect(config.systemPrompt).toContain('"automatic":true');
          expect(config.systemPrompt).toContain(
            `"currentStep":"${entered.milestones![entered.state.position.milestoneIndex]!.stages[entered.state.position.stageIndex]}"`,
          );
          const inputs = await agents.listUserMessages(opening.sessionId);
          await agents.markUserMessageDelivered(
            opening.sessionId,
            'opening-check-worker',
            claimed!.attempt,
            inputs.at(-1)!.seq,
          );
          await agents.finishSession(opening.sessionId, 'opening-check-worker', {
            status: 'succeeded',
            expectedAttempt: claimed!.attempt,
          });
        }
      };
      await send('prepare');
      const initialEnv = (await store.get(id, principal.ownerId)).environment_id!;
      for (let milestone = 0; milestone < 2; milestone++) {
        await guidedStage();
        if (milestone === 0) {
          expect((await learningView(principal, id)).actions).not.toContain('next');
          await expect(send('next')).rejects.toThrow('not available');
          await send('decide', { decisionId: 'format', chosen: 'concat' });
          expect((await learningView(principal, id)).actions).toContain('next');
          await send('next');
        }
        if (milestone === 1) await send('next'); // the normal decision step has no new required choices
        const oldPlan = await (
          await SandboxService.forOwner(principal)
        ).readText(initialEnv, 'PLAN.md');
        if (milestone === 1)
          await expect(
            send('save', {
              path: 'PLAN.md',
              text: 'Erase the previous plan',
              expectedHash: digest(oldPlan),
            }),
          ).rejects.toThrow('Preserve');
        await guidedStage(
          {
            path: 'PLAN.md',
            text:
              oldPlan +
              `\n## Milestone ${milestone + 1}\n${milestone ? 'Trim the name and preserve the greeting.' : 'Return a greeting for the supplied name.'}\n`,
          },
          milestone === 0,
        );
        const java = projectId === 'greeting-java';
        const code = java
          ? `public class Greeting { public static String greet(String name) { return "Hello, " + name${milestone ? '.trim()' : ''} + "!"; } public static void main(String[] args) { System.out.println(greet(args[0])); } }`
          : `def greet(name):\n    return f"Hello, {${milestone ? 'name.strip()' : 'name'}}!"\n`;
        await guidedStage({ path: java ? 'src/Greeting.java' : 'src/greeting.py', text: code });
        await send('evaluate');
        await send('collect');
        expect(
          (await store.get(id, principal.ownerId)).state.collected[
            milestone ? 'normalize' : 'greeting'
          ]?.tests?.status,
        ).toBe('passed');
        await send('next');
        await send('quiz', { answers: [0] });
        await send('next');
        await guidedStage();
      }
      const completed = await learningView(principal, id);
      expect(completed.state.status).toBe('completed');
      expect(completed.milestones).toHaveLength(2);
      expect(completed.milestones!.every((m) => m.stages.length === 7)).toBe(true);
      expect(completed.actions).not.toContain('next');
      const before = await store.get(id, principal.ownerId);
      const report = await learningReport(principal, id);
      expect(report.requiredComplete).toBe(true);
      expect(report.outcomes).toEqual([
        {
          milestoneId: 'greeting',
          tests: 'passed',
          quiz: { score: 1, total: 1, attempt: 1 },
          reflected: true,
        },
        {
          milestoneId: 'normalize',
          tests: 'passed',
          quiz: { score: 1, total: 1, attempt: 1 },
          reflected: true,
        },
      ]);
      expect(report.evidence.filter((e) => e.kind === 'evaluation.recorded')).toHaveLength(2);
      expect(
        report.evidence.some(
          (e) => e.kind === 'artifact.recorded' && e.detail.includes('Milestone 2'),
        ),
      ).toBe(true);
      expect((await store.get(id, principal.ownerId)).revision).toBe(before.revision);
      await expect(
        learningReport({ ...principal, ownerId: 'someone-else' }, id),
      ).rejects.toMatchObject({ status: 404 });
      await expect(send('chat', { text: 'I want another stage' })).rejects.toThrow();
      const bindings = await store.roles(id);
      expect(bindings.filter((b) => b.role === 'mentor')).toHaveLength(1);
      expect(bindings.filter((b) => b.role === 'planner')).toHaveLength(2);
    },
    120000,
  );
  it('pins project identity and isolates learners', async () => {
    const same = await store.create(
      {
        ownerId: principal.ownerId,
        stageId: 'classroom',
        sceneId: 'scene',
        projectId: project.ref.id,
        version: project.ref.version,
      },
      startOrchestration(project.definition),
    );
    expect(same.id).toBe(studyId);
    await expect(store.get(studyId, 'learner-b')).rejects.toMatchObject({ status: 404 });
    await expect(
      commandStudy({ ...principal, ownerId: 'learner-b' }, studyId, {
        id: randomUUID(),
        revision: 0,
        type: 'next',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rejects student advancement before teaching, and gates new feedback', async () => {
    await command('prepare');
    await expect(command('next')).rejects.toThrow('not available');
    await runTools('Please start.', async (config) => {
      expect(config.systemPrompt).toContain(
        JSON.stringify({ title: project.definition.title, language: project.definition.language }),
      );
      expect(config.systemPrompt).toContain(
        JSON.stringify({
          id: project.definition.milestones[0]!.id,
          title: project.definition.milestones[0]!.title,
        }),
      );
      await expect(
        invoke(config, 'complete_stage', { studentFeedback: 'Please start.' }),
      ).rejects.toThrow();
    });
  });
  it.each([true, false])(
    'persists welcome and waits for readiness (read first: %s)',
    async (readFirst) => {
      const original = studyId;
      const study = await freshStudy();
      studyId = study.id;
      try {
        const opening = (await study.send('begin')) as { sessionId: string };
        const claimed = await agents.claimNextSession('welcome-worker', process.pid, {
          sessionId: opening.sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
        const config = await teachingRunnerConfig({
          sessionId: opening.sessionId,
          ownerId: principal.ownerId,
          workerId: 'welcome-worker',
          attempt: claimed!.attempt,
          signal: new AbortController().signal,
        });
        expect(config.thinkingConfig()).toEqual({ mode: 'disabled' });
        if (readFirst) {
          const welcome = JSON.stringify(await invoke(config, 'read_next_skill'));
          expect(welcome).toContain('Welcome only');
          expect(welcome).toContain('how learning works');
        }
        expect(config.systemPrompt).not.toContain('"teaching":{');
        await invoke(config, 'request_skill_review', {
          question: 'Any process questions? Ready to begin?',
        });
        await expect(
          invoke(config, 'read_next_skill', {
            studentFeedback: 'An automatic entry is not readiness.',
          }),
        ).rejects.toThrow();
        expect(config.isTurnComplete()).toBe(true);
        expect(config.needsTurnReceipt()).toBe(false);
        await agents.finishSession(opening.sessionId, 'welcome-worker', {
          status: 'succeeded',
          expectedAttempt: claimed!.attempt,
        });
        expect((await store.binding(opening.sessionId))?.guided?.welcome).toBe('pending');
        await runTools('Will an Agent help with the implementation?', async (next) => {
          expect(next.thinkingConfig()).toEqual({ mode: 'disabled' });
          expect(next.liveContext()).toContain('"welcomePresented":true');
          expect(JSON.stringify(await invoke(next, 'read_next_skill'))).toContain('Welcome only');
          await invoke(next, 'request_skill_review', {
            question: 'Yes, you work together and review it. Ready to start?',
          });
        });
        const before = await learningView(principal, study.id);
        expect(before.state.position.stageIndex).toBe(0);
        expect(before.actions).not.toContain('next');
        expect((await store.binding(opening.sessionId))?.guided?.welcome).toBe('pending');
        await runTools('Ready, please begin the lesson.', async (next) => {
          expect(next.thinkingConfig()).toEqual({ mode: 'disabled' });
          const lesson = JSON.stringify(
            await invoke(next, 'read_next_skill', {
              studentFeedback: 'The learner explicitly asks to begin.',
            }),
          );
          expect(lesson).not.toContain('Welcome only');
          expect(next.liveContext()).toContain('"welcome":"ready"');
          expect(next.thinkingConfig()).toEqual({ mode: 'enabled', effort: 'low', level: 'low' });
          expect(next.liveContext()).toContain('"activeSection":"A-teach.md"');
          await expect(
            invoke(next, 'read_next_skill', {
              studentFeedback: 'Readiness is not understanding.',
              reuseFeedback: true,
            }),
          ).rejects.toThrow();
          await invoke(next, 'request_skill_review', { question: 'Explain returning a value.' });
        });
        await runTools(
          'Return sends the value to the caller; printing does not. I also understand the consequences and am ready to continue.',
          async (next) => {
            expect(next.thinkingConfig()).toEqual({ mode: 'enabled', effort: 'low', level: 'low' });
            await invoke(next, 'read_next_skill', {
              studentFeedback: 'The reply explains the concept and its consequences.',
            });
            await invoke(next, 'read_next_skill', {
              studentFeedback: 'The same correct answer already covers the reflection goal.',
              reuseFeedback: true,
            });
            await invoke(next, 'complete_stage', {
              studentFeedback:
                'The learner already explained the goal and confirms understanding without unresolved errors.',
              reuseFeedback: true,
            });
          },
        );
        const finished = await learningView(principal, study.id);
        expect(finished.state.position.stageIndex).toBe(0);
        expect(finished.actions).toContain('next');
      } finally {
        studyId = original;
      }
    },
  );

  it('accepts wrapped and multi-message review feedback from durable student turns', async () => {
    const original = studyId;
    studyId = (await freshStudy()).id;
    const answer = 'It returns a string to the caller; print returns None.';
    const first = 'The caller receives the return value.';
    const second = 'Printing only displays the value.';
    try {
      await runTools('Introduce the project.', async (config) => {
        await invoke(config, 'read_next_skill');
        await invoke(config, 'request_skill_review', { question: 'Ready to begin teaching?' });
      });
      await runTools('Ready to begin.', async (config) => {
        await invoke(config, 'read_next_skill', { studentFeedback: 'The learner is ready.' });
        await invoke(config, 'request_skill_review', {
          question: 'Any question about the concept?',
        });
      });
      await runTools('Please start.', async (config) => {
        await invoke(config, 'read_next_skill');
        await invoke(config, 'request_skill_review', { question: 'Compare return and print.' });
      });
      await runTools(answer, async (config) => {
        expect(config.systemPrompt).toContain('"studentResponseCount":1');
        expect(config.systemPrompt).not.toContain(answer);
        await invoke(config, 'read_next_skill', { studentFeedback: `Student reply: "${answer}"` });
        await invoke(config, 'request_skill_review', {
          question: 'Explain how the caller uses it.',
        });
        await expect(
          invoke(config, 'read_next_skill', { studentFeedback: answer }),
        ).rejects.toThrow();
      });
      await runTools(first, async (config) => {
        expect(config.systemPrompt).toContain('"studentResponseCount":1');
        expect(config.systemPrompt).not.toContain(first);
        expect(config.systemPrompt).not.toContain(answer);
        // A clarification turn does not replace the pending review or discard its first reply.
        await invoke(config, 'read_next_skill');
      });
      await runTools(second, async (config) => {
        expect(config.systemPrompt).toContain('"studentResponseCount":2');
        expect(config.systemPrompt).not.toContain(first);
        expect(config.systemPrompt).not.toContain(second);
        expect(config.systemPrompt).not.toContain(answer);
        const sessionId = (await store.roles(studyId))[0]!.session_id;
        expect((await agents.listUserMessages(sessionId)).map(({ text }) => text)).toEqual(
          expect.arrayContaining([answer, first, second]),
        );
        await invoke(config, 'read_next_skill', {
          studentFeedback:
            'Across both replies, the learner distinguishes returning from displaying.',
        });
        await invoke(config, 'request_skill_review', { question: 'Confirm your understanding.' });
        await expect(
          invoke(config, 'complete_stage', { studentFeedback: second }),
        ).rejects.toThrow();
      });
      await runTools('确认', async (config) => {
        expect(config.systemPrompt).not.toContain(first);
        expect(config.systemPrompt).not.toContain(second);
        await invoke(config, 'complete_stage', { studentFeedback: 'Student reply: "确认"' });
      });
      expect((await learningView(principal, studyId)).actions).toContain('next');
    } finally {
      studyId = original;
    }
  });
  it('retries a chat receipt without duplicating a student turn', async () => {
    const before = await store.get(studyId, principal.ownerId);
    const input = {
      id: randomUUID(),
      revision: before.revision,
      type: 'chat',
      text: 'Please start.',
    };
    const first = (await commandStudy(principal, studyId, input)) as { sessionId: string };
    const after = await store.get(studyId, principal.ownerId);
    const binding = await store.binding(first.sessionId);
    expect(await commandStudy(principal, studyId, input)).toEqual(first);
    expect((await store.get(studyId, principal.ownerId)).revision).toBe(after.revision);
    expect((await store.binding(first.sessionId))?.feedback_seq).toBe(binding?.feedback_seq);
    await expect(
      commandStudy(principal, studyId, { ...input, text: 'Different request' }),
    ).rejects.toThrow('different operation');
    const meta = await agents.claimNextSession('receipt-worker', process.pid, {
      sessionId: first.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const abort = new AbortController();
    const config = await teachingRunnerConfig({
      sessionId: first.sessionId,
      ownerId: principal.ownerId,
      workerId: 'receipt-worker',
      attempt: meta!.attempt,
      signal: abort.signal,
    });
    abort.abort();
    await expect(invoke(config, 'read_next_skill')).rejects.toThrow('cancelled');
    await agents.finishSession(first.sessionId, 'receipt-worker', {
      status: 'succeeded',
      expectedAttempt: meta!.attempt,
    });
  });
  it('opens each stage once without fabricating student feedback', async () => {
    const study = await freshStudy();
    const original = await store.get(study.id, principal.ownerId);
    expect(original.state.position.stageIndex).toBe(0);
    const started = (await study.send('begin')) as { sessionId: string };
    const state = await store.get(study.id, principal.ownerId);
    expect(state.state.position).toEqual(original.state.position);
    const initial = await agents.readEventsAfter(started.sessionId, 0, 100);
    expect(initial.filter((event) => event.type === 'pbl_stage_entered')).toHaveLength(1);
    expect(
      initial.filter((event) => event.type === 'user_message').map((event) => event.data),
    ).toMatchObject([{ pblOpening: true }]);
    expect(await study.send('begin')).toEqual({ alreadyStarted: true });
    expect(
      await commandStudy(principal, study.id, {
        id: randomUUID(),
        revision: original.revision,
        type: 'begin',
      }),
    ).toEqual({ alreadyStarted: true });
    expect(
      (await learningView(principal, study.id)).conversation?.some(
        (entry) => entry.speaker === 'user',
      ),
    ).toBe(false);
    const meta = await agents.claimNextSession('opening-worker', process.pid, {
      sessionId: started.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const config = await teachingRunnerConfig({
      sessionId: started.sessionId,
      ownerId: principal.ownerId,
      workerId: 'opening-worker',
      attempt: meta!.attempt,
      signal: new AbortController().signal,
    });
    expect(config.systemPrompt).toContain('"automatic":true');
    await invoke(config, 'read_next_skill');
    await invoke(config, 'request_skill_review', { question: 'What will the project do?' });
    await expect(
      invoke(config, 'complete_stage', { studentFeedback: 'System entry is approval' }),
    ).rejects.toThrow();
    await agents.finishSession(started.sessionId, 'opening-worker', {
      status: 'succeeded',
      expectedAttempt: meta!.attempt,
    });
    expect(await study.send('begin')).toEqual({ alreadyStarted: true });
    expect((await learningView(principal, study.id)).actions).not.toContain('next');
    // A real answer after automatic delivery is eligible, and preserves the question on replay.
    await study.send('chat');
    const reply = await agents.claimNextSession('reply-worker', process.pid, {
      sessionId: started.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const replyConfig = await teachingRunnerConfig({
      sessionId: started.sessionId,
      ownerId: principal.ownerId,
      workerId: 'reply-worker',
      attempt: reply!.attempt,
      signal: new AbortController().signal,
    });
    expect(replyConfig.systemPrompt).toContain('"automatic":false');
    expect(replyConfig.systemPrompt).toContain('"studentResponseCount":1');
    await agents.finishSession(started.sessionId, 'reply-worker', {
      status: 'succeeded',
      expectedAttempt: reply!.attempt,
    });
  });
  it('hides automatic stage inputs in reports while preserving questions and real learner replies', async () => {
    const study = await freshStudy();
    const started = (await study.send('begin')) as { sessionId: string };
    const meta = await agents.claimNextSession('report-worker', process.pid, {
      sessionId: started.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const config = await teachingRunnerConfig({
      sessionId: started.sessionId,
      ownerId: principal.ownerId,
      workerId: 'report-worker',
      attempt: meta!.attempt,
      signal: new AbortController().signal,
    });
    const question = 'What will this project do?';
    await invoke(config, 'read_next_skill');
    await invoke(config, 'request_skill_review', { question });
    const before = await store.get(study.id, principal.ownerId);
    const binding = await store.binding(started.sessionId);
    const events = await agents.readEventsAfter(started.sessionId, 0, 100);
    expect(events.some((entry) => (entry.data as { pblOpening?: boolean }).pblOpening)).toBe(true);

    // The review is committed before its tool display event exists. Hiding the
    // wakeup must retain this recoverable Agent question without inventing a learner.
    await expect(learningReport(principal, study.id)).rejects.toMatchObject({ status: 409 });
    await expect(
      generateLearningReport(principal, study.id, new AbortController().signal),
    ).rejects.toMatchObject({ status: 409 });
    const pending = await learningEvidence(principal, study.id);
    expect(pending.conversations[0]!.messages).toEqual([
      expect.objectContaining({ role: 'assistant', text: question }),
    ]);
    expect(JSON.stringify(pending)).not.toContain('System stage entry:');
    expect(await store.get(study.id, principal.ownerId)).toEqual(before);
    expect(await store.binding(started.sessionId)).toEqual(binding);
    expect(await agents.readEventsAfter(started.sessionId, 0, 100)).toEqual(events);

    await agents.appendControlEvent(started.sessionId, {
      ts: Date.now(),
      type: 'tool_execution_end',
      data: {
        toolName: 'request_skill_review',
        isError: false,
        result: { content: [{ type: 'text', text: JSON.stringify({ question }) }] },
      },
    });
    const displayed = await learningEvidence(principal, study.id);
    expect(displayed.conversations[0]!.messages).toEqual([
      expect.objectContaining({ role: 'assistant', text: question }),
    ]);
    await agents.finishSession(started.sessionId, 'report-worker', {
      status: 'succeeded',
      expectedAttempt: meta!.attempt,
    });
    const text = 'What does System stage entry mean?';
    await commandStudy(principal, study.id, {
      id: randomUUID(),
      revision: before.revision,
      type: 'chat',
      text,
    });
    const answered = await learningEvidence(principal, study.id);
    expect(answered.conversations[0]!.messages).toEqual([
      expect.objectContaining({ role: 'assistant', text: question }),
      expect.objectContaining({ role: 'user', text }),
    ]);
    await expect(
      learningReport({ ...principal, ownerId: 'another-owner' }, study.id),
    ).rejects.toMatchObject({ status: 404 });
    await agents.softDeleteSession(started.sessionId, principal.ownerId);
  });
  it('generates only after completion, saves one report and safely retries a failed analysis', async () => {
    const { id } = await freshStudy();
    await expect(learningReport(principal, id)).rejects.toMatchObject({ status: 409 });
    await pool.query(
      "UPDATE pbl_v3_studies SET state=jsonb_set(state,'{status}','\"completed\"') WHERE id=$1",
      [id],
    );
    mocked.reportAnalysis.mockReset().mockRejectedValueOnce(new Error('PRIVATE MODEL FAILURE'));
    const signal = new AbortController().signal;
    expect((await learningReport(principal, id)).analysis?.status).toBe('not_generated');
    expect(mocked.reportAnalysis).not.toHaveBeenCalled();
    const failed = await generateLearningReport(principal, id, signal);
    expect(failed.analysis?.status).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE MODEL');
    let release!: (value: { findings: never[]; omitted: boolean }) => void;
    mocked.reportAnalysis.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const generation = generateLearningReport(principal, id, signal);
    await vi.waitFor(() => expect(mocked.reportAnalysis).toHaveBeenCalledTimes(2));
    expect((await generateLearningReport(principal, id, signal)).analysis?.status).toBe(
      'generating',
    );
    release({ findings: [], omitted: false });
    const ready = await generation;
    expect(ready.analysis?.status).toBe('ready');
    expect(await learningReport(principal, id)).toEqual(ready);
    expect(await generateLearningReport(principal, id, signal)).toEqual(ready);
    expect(mocked.reportAnalysis).toHaveBeenCalledTimes(2);
    await expect(
      learningReport({ ...principal, ownerId: 'another-owner' }, id),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('waits for final Agent persistence, saves a stable report, and fences late retry results', async () => {
    const study = await freshStudy();
    const started = (await study.send('begin')) as { sessionId: string };
    await pool.query(
      "UPDATE pbl_v3_studies SET state=jsonb_set(state,'{status}','\"completed\"') WHERE id=$1",
      [study.id],
    );
    const signal = new AbortController().signal;
    await expect(learningReport(principal, study.id)).rejects.toMatchObject({
      reason: 'PBL_REPORT_PENDING',
    });
    await expect(generateLearningReport(principal, study.id, signal)).rejects.toMatchObject({
      reason: 'PBL_REPORT_PENDING',
    });
    await agents.appendControlEvent(started.sessionId, {
      ts: Date.now(),
      type: 'message_end',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The final reflection is saved.' }],
        },
      },
    });
    await pool.query("UPDATE agent_sessions SET status='succeeded' WHERE id=$1", [
      started.sessionId,
    ]);
    mocked.reportAnalysis.mockReset();
    let finishOld!: (value: { findings: never[]; omitted: boolean }) => void;
    mocked.reportAnalysis.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const older = generateLearningReport(principal, study.id, signal);
    await vi.waitFor(() => expect(mocked.reportAnalysis).toHaveBeenCalledTimes(1));
    expect((await generateLearningReport(principal, study.id, signal)).analysis?.status).toBe(
      'generating',
    );
    await pool.query(
      "UPDATE pbl_v3_reports SET updated_at=now()-interval '3 minutes' WHERE study_id=$1",
      [study.id],
    );
    mocked.reportAnalysis.mockResolvedValueOnce({ findings: [], omitted: false });
    const newer = await generateLearningReport(principal, study.id, signal);
    finishOld({ findings: [], omitted: false });
    expect(await older).toEqual(newer);
    expect(
      newer.conversations
        .flatMap((c) => c.messages)
        .some((m) => m.text === 'The final reflection is saved.'),
    ).toBe(true);
    expect(await generateLearningReport(principal, study.id, signal)).toEqual(newer);
    expect(mocked.reportAnalysis).toHaveBeenCalledTimes(2);
    await agents.softDeleteSession(started.sessionId, principal.ownerId);
    expect(await learningReport(principal, study.id)).toEqual(newer);
  });
  it('labels reviewed revisions chronologically and reuses labels in saved source evidence', async () => {
    const study = await freshStudy();
    const row = await store.get(study.id, principal.ownerId);
    for (const [i, hash] of ['first', 'second', 'first'].entries()) {
      await pool.query('INSERT INTO pbl_v3_events(study_id,sequence,event) VALUES($1,$2,$3)', [
        study.id,
        row.state.lastSequence + i + 1,
        JSON.stringify({
          type: 'artifact.recorded',
          artifact: {
            id: `plan-${i}`,
            kind: 'plan',
            milestoneId: 'greeting',
            workspaceRevisionId: hash,
          },
          content: `plan ${i}`,
        }),
      ]);
    }
    await pool.query(
      "UPDATE pbl_v3_studies SET state=jsonb_set(state,'{lastSequence}',to_jsonb($2::int)) WHERE id=$1",
      [study.id, row.state.lastSequence + 3],
    );
    for (const hash of ['first', 'second', 'unreviewed'])
      await recordLearningEvidence(pool, row, 'coder', 'artifact', {
        fingerprint: hash,
        text: `snapshot ${hash}`,
      });
    const report = await learningEvidence(principal, study.id);
    expect(
      report.evidence.filter((e) => e.kind === 'artifact.recorded').map((e) => e.version),
    ).toEqual(['v1', 'v2', 'v1']);
    expect(report.evidence.filter((e) => e.kind === 'artifact').map((e) => e.version)).toEqual([
      'v1',
      'v2',
      undefined,
    ]);
    expect(JSON.stringify(report)).not.toContain('fingerprint');
  });
  it('interleaves saved edits and snapshots with orchestration evidence using persisted times', async () => {
    const study = await freshStudy();
    const row = await store.get(study.id, principal.ownerId);
    const base = 2_000_000_000_000;
    const events = [
      {
        type: 'artifact.recorded',
        artifact: { kind: 'plan', milestoneId: 'greeting' },
        content: 'plan',
      },
      {
        type: 'evaluation.recorded',
        evaluation: { milestoneId: 'greeting', status: 'failed', revision: { id: 'one' } },
      },
      {
        type: 'evaluation.recorded',
        evaluation: { milestoneId: 'greeting', status: 'passed', revision: { id: 'two' } },
      },
      { type: 'recap.completed', milestoneId: 'greeting' },
    ];
    for (const [i, event] of events.entries())
      await pool.query(
        'INSERT INTO pbl_v3_events(study_id,sequence,event,recorded_at) VALUES($1,$2,$3,to_timestamp($4::float8/1000))',
        [
          study.id,
          row.state.lastSequence + i + 1,
          JSON.stringify(event),
          base + (i * 2 + 2) * 1000,
        ],
      );
    await pool.query(
      "UPDATE pbl_v3_studies SET state=jsonb_set(state,'{lastSequence}',to_jsonb($2::int)) WHERE id=$1",
      [study.id, row.state.lastSequence + events.length],
    );
    for (const [i, kind] of ['file-edit', 'artifact', 'file-edit', 'final-artifact'].entries()) {
      await recordLearningEvidence(pool, row, 'learner', kind, { text: `saved-${i}` });
      await pool.query(
        "UPDATE pbl_v3_evidence SET created_at=to_timestamp($3::float8/1000) WHERE study_id=$1 AND detail->>'text'=$2",
        [study.id, `saved-${i}`, base + (i === 3 ? 9 : i * 2 + 1) * 1000],
      );
    }
    const report = await learningEvidence(principal, study.id);
    const timeline = report.evidence.filter((e) => e.at >= base);
    expect(timeline.map((e) => e.kind)).toEqual([
      'file-edit',
      'artifact.recorded',
      'artifact',
      'evaluation.recorded',
      'file-edit',
      'evaluation.recorded',
      'recap.completed',
      'final-artifact',
    ]);
    expect(timeline.map((e) => (e.at - base) / 1000)).toEqual([1, 2, 3, 4, 5, 6, 8, 9]);
    expect(report.counts['evaluation.recorded']).toBe(2);
    expect(report.facts?.fileEdits).toBe(2);
    const again = await learningEvidence(principal, study.id);
    expect(again.evidence.map((e) => e.sequence)).toEqual(report.evidence.map((e) => e.sequence));
  });
  it('orders retained role history by message time despite updated-session order and a shared mentor', async () => {
    const study = await freshStudy();
    const base = 2_000_000_000_000;
    const roles = [
      { role: 'planner', milestone: 'greeting', times: [2, 3, 6] },
      { role: 'coder', milestone: 'next', times: [4, 5] },
      { role: 'mentor', milestone: 'project', times: [1, 8] },
    ];
    for (const [i, role] of roles.entries()) {
      const session = await agents.createSession({
        ownerId: principal.ownerId,
        prompt: role.role,
        status: 'succeeded',
      });
      await pool.query(
        'INSERT INTO pbl_v3_roles(session_id,study_id,role,context_key,stage_key) VALUES($1,$2,$3,$4,$5)',
        [session.id, study.id, role.role, role.milestone, `${role.milestone}:0`],
      );
      for (const time of role.times)
        await agents.appendControlEvent(session.id, {
          ts: base + time * 1000,
          type: 'user_message',
          data: { text: `${role.role}-${time}` },
        });
      await pool.query(
        'UPDATE agent_sessions SET updated_at=to_timestamp($2::float8/1000) WHERE id=$1',
        [session.id, base + (i + 1) * 100000],
      );
    }
    const report = await learningEvidence(principal, study.id);
    expect(report.conversations.map((c) => c.role)).toEqual(['mentor', 'planner', 'coder']);
    expect(reportConversationMessages(report).map((m) => m.text)).toEqual([
      'mentor-1',
      'planner-2',
      'planner-3',
      'coder-4',
      'coder-5',
      'planner-6',
      'mentor-8',
    ]);
    const again = await learningEvidence(principal, study.id);
    expect(reportConversationMessages(again)).toEqual(reportConversationMessages(report));
  });
  it('bounds raw tool replay before projection and preserves the latest reply and normal full result', async () => {
    const study = await freshStudy();
    const started = (await study.send('begin')) as { sessionId: string };
    for (let i = 0; i < 30; i++)
      await agents.appendControlEvent(started.sessionId, {
        ts: Date.now(),
        type: 'tool_execution_end',
        data: {
          toolName: 'read_file',
          toolCallId: `tool-${i}`,
          isError: false,
          result: {
            content: [{ type: 'text', text: 'normal payload '.repeat(6000) }],
            details: { index: i },
          },
        },
      });
    await agents.appendControlEvent(started.sessionId, {
      ts: Date.now(),
      type: 'tool_execution_end',
      data: {
        toolName: 'read_file',
        toolCallId: 'huge',
        isError: false,
        result: { content: [{ type: 'text', text: 'OVERSIZED_TOOL_' + 'x'.repeat(1000000) }] },
      },
    });
    await agents.appendControlEvent(started.sessionId, {
      ts: Date.now(),
      type: 'message_end',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The latest reply is visible.' }],
        },
      },
    });
    const read = vi.spyOn(agents, 'readEventsAfter');
    onTestFinished(() => read.mockRestore());
    const view = await learningView(principal, study.id);
    expect(read).not.toHaveBeenCalled();
    expect(view.conversation?.some((e) => e.omitted)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(4 * 1024 * 1024);
    expect(JSON.stringify(view)).not.toContain('OVERSIZED_TOOL_');
    expect(JSON.stringify(view)).toContain('The latest reply is visible.');
    expect(
      view.conversation
        ?.flatMap((e) => e.parts)
        .findLast(
          (p) =>
            p.kind === 'tool' &&
            p.result &&
            (p.result as { details?: { index?: number } }).details?.index === 29,
        ),
    ).toBeDefined();
    const stored = (
      await pool.query(
        "SELECT data FROM agent_session_events WHERE session_id=$1 AND data->>'toolCallId'='huge'",
        [started.sessionId],
      )
    ).rows[0].data;
    expect(stored.result.content[0].text.length).toBeGreaterThan(1000000);
    await agents.softDeleteSession(started.sessionId, principal.ownerId);
  });
  it('shows long current text and thinking whole while compacting repeated stream snapshots', async () => {
    const study = await freshStudy();
    const queued = (await study.send('begin')) as { sessionId: string };
    const text = 'Detailed explanation. '.repeat(40_000),
      thinking = 'Reasoning. '.repeat(60_000);
    const track = createThinkingTimingTracker();
    const at = Date.now();
    const snapshot = (text: string) => ({
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking }, ...(text ? [{ type: 'text', text }] : [])],
      },
    });
    await agents.appendControlEvent(queued.sessionId, {
      ts: at,
      type: 'message_start',
      data: track('message_start', { message: { role: 'assistant', content: [] } }, at),
    });
    await agents.appendControlEvent(queued.sessionId, {
      ts: at + 10,
      type: 'message_update',
      data: track('message_update', snapshot(''), at + 10),
    });
    const firstView = await learningView(principal, study.id, { passive: true });
    const firstThinking = firstView.conversation?.at(-1)?.parts.find((p) => p.kind === 'thinking');
    for (let i = 0; i < 4; i++)
      await agents.appendControlEvent(queued.sessionId, {
        ts: at + 20 + i,
        type: 'message_update',
        data: track('message_update', snapshot(text + ' ' + i), at + 20 + i),
      });
    const { readConversationHistory } = await import('@/lib/server/pbl-v3/conversation-history');
    const events = await readConversationHistory(
      pool,
      queued.sessionId,
      await agents.lastEventSeq(queued.sessionId),
      1000,
    );
    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(1);
    const view = await learningView(principal, study.id, { passive: true });
    expect(view.conversation?.at(-1)?.parts.find((p) => p.kind === 'text')).toMatchObject({
      text: text + ' 3',
    });
    expect(view.conversation?.at(-1)?.parts.find((p) => p.kind === 'thinking')).toMatchObject({
      text: thinking,
      id: firstThinking!.id,
      startedAt: at + 10,
      endedAt: at + 20,
      streaming: false,
    });
    await agents.appendControlEvent(queued.sessionId, {
      ts: at + 30,
      type: 'message_end',
      data: track('message_end', snapshot(text + ' completed'), at + 30),
    });
    const completed = await learningView(principal, study.id, { passive: true });
    expect(
      completed.conversation?.at(-1)?.parts.find((part) => part.kind === 'thinking'),
    ).toMatchObject({
      id: firstThinking!.id,
      startedAt: at + 10,
      endedAt: at + 20,
      streaming: false,
    });
    const compacted = await readConversationHistory(
      pool,
      queued.sessionId,
      await agents.lastEventSeq(queued.sessionId),
      1000,
    );
    expect(compacted.filter((event) => event.type === 'message_end')).toHaveLength(1);
    expect(
      compacted.some((event) => event.type === 'message_update' || event.type === 'message_start'),
    ).toBe(false);
    // Local stop receipts and tool-call-only messages must not displace visible text/thinking.
    for (const content of [
      [],
      [
        {
          type: 'toolCall',
          id: 'tool-only',
          name: 'read_file',
          arguments: { padding: 'z'.repeat(700000) },
        },
      ],
    ]) {
      await agents.appendControlEvent(queued.sessionId, {
        ts: at + 40,
        type: 'message_start',
        data: { message: { role: 'assistant', content: [] } },
      });
      await agents.appendControlEvent(queued.sessionId, {
        ts: at + 50,
        type: 'message_end',
        data: { message: { role: 'assistant', content, stopReason: 'stop' } },
      });
    }
    const afterControl = await learningView(principal, study.id, { passive: true });
    const visibleParts = afterControl.conversation!.flatMap((entry) => entry.parts);
    expect(
      visibleParts.some((part) => part.kind === 'text' && part.text === text + ' completed'),
    ).toBe(true);
    expect(visibleParts.some((part) => part.kind === 'thinking' && part.text === thinking)).toBe(
      true,
    );
    expect(Buffer.byteLength(JSON.stringify(afterControl.conversation))).toBeLessThan(2_000_000);
    const row = await store.get(study.id, principal.ownerId);
    await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
      row.environment_id,
    ]);
  });

  it('keeps frozen history retries and older cursors stable after a message ends', async () => {
    const study = await freshStudy();
    onTestFinished(async () => {
      const own = await store.get(study.id, principal.ownerId);
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        own.environment_id,
      ]);
    });
    const { sessionId } = (await study.send('begin')) as { sessionId: string };
    const { readConversationPage } = await import('@/lib/server/pbl-v3/conversation-history');
    const append = (type: string, text: string) =>
      agents.appendControlEvent(sessionId, {
        ts: Date.now(),
        type,
        data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
      });
    await append('message_start', '');
    await append('message_update', 'earlier snapshot');
    await append('message_update', 'frozen snapshot:' + 'x'.repeat(600000));
    const through = await agents.lastEventSeq(sessionId);
    const page = await readConversationPage(pool, sessionId, through, null);
    expect(page.events).toHaveLength(1);
    expect(page.nextBefore).not.toBeNull();
    const older = await readConversationPage(pool, sessionId, through, page.nextBefore);
    await append('message_update', 'later snapshot');
    await append('message_update', 'last snapshot');
    await append('message_end', 'final message');
    expect(digest(JSON.stringify(await readConversationPage(pool, sessionId, through, null)))).toBe(
      digest(JSON.stringify(page)),
    );
    expect(JSON.stringify(page).includes('frozen snapshot')).toBe(true);
    expect(
      digest(JSON.stringify(await readConversationPage(pool, sessionId, through, page.nextBefore))),
    ).toBe(digest(JSON.stringify(older)));
  });

  it('merges history tools and handoff questions across oversized page boundaries', async () => {
    const study = await freshStudy();
    onTestFinished(async () => {
      const own = await store.get(study.id, principal.ownerId);
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        own.environment_id,
      ]);
    });
    const { sessionId } = (await study.send('begin')) as { sessionId: string };
    const { conversationPage } = await import('@/lib/server/pbl-v3/conversation-page');
    const { mergeConversationHistory } = await import('@/lib/pbl/v3/conversation');
    const question = 'Which requirement should we clarify?';
    for (const [type, data] of [
      [
        'tool_execution_start',
        { toolName: 'request_learner_help', toolCallId: 'split-help', args: { question } },
      ],
      ['pbl_learner_handoff', { toolCallId: 'split-help', question }],
      [
        'tool_execution_end',
        {
          toolName: 'request_learner_help',
          toolCallId: 'split-help',
          isError: false,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ question, padding: 'x'.repeat(600000) }) },
            ],
          },
        },
      ],
      ['session_end', { status: 'succeeded' }],
    ] as const)
      await agents.appendControlEvent(sessionId, { ts: Date.now(), type, data });
    const through = await agents.lastEventSeq(sessionId);
    const pages = [];
    let before: number | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await conversationPage(
        principal,
        new URLSearchParams({
          id: study.id,
          sessionId,
          through: String(through),
          ...(before ? { before: String(before) } : {}),
        }),
      );
      pages.unshift(page.conversation);
      if (!page.nextBefore) break;
      before = page.nextBefore;
      if (i === 9) throw new Error('History did not terminate');
    }
    expect(pages.length).toBeGreaterThan(1);
    const cached = JSON.stringify(pages);
    const parts = mergeConversationHistory(pages).flatMap((entry) => entry.parts);
    const tools = parts.filter((part) => part.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      status: 'succeeded',
      args: { question },
      result: expect.any(Object),
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
    });
    expect(parts.filter((part) => part.kind === 'text' && part.text === question)).toHaveLength(1);
    expect(JSON.stringify(pages)).toBe(cached);
  });

  async function executionFixture() {
    const study = await freshStudy();
    onTestFinished(async () => {
      const own = await store.get(study.id, principal.ownerId);
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        own.environment_id,
      ]);
    });
    const { sessionId } = (await study.send('begin')) as { sessionId: string };
    return { study, sessionId };
  }
  const expireExecution = async (sessionId: string) =>
    pool.query(
      "UPDATE pbl_v3_roles SET execution_progress_at=clock_timestamp()-interval '16 minutes' WHERE session_id=$1",
      [sessionId],
    );
  it.each(['queued', 'exhausted', 'live-worker', 'orphaned', 'reclaimed'] as const)(
    'settles a stalled %s execution without requiring a runner or learner departure',
    async (kind) => {
      const { study, sessionId } = await executionFixture();
      const { expireStalledTeachingTurns, recordTeachingProgress } =
        await import('@/lib/server/pbl-v3/execution-watchdog');
      const { AGENT_EXECUTION_IDLE_TIMEOUT } = await import('@/lib/agent/runtime/request-failure');
      let attempt = 0,
        workerId = 'stalled-worker';
      if (!['queued', 'exhausted'].includes(kind)) {
        const claim = await agents.claimNextSession(workerId, process.pid, {
          sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
        expect(claim).toBeTruthy();
        attempt = claim!.attempt;
      }
      if (kind === 'exhausted')
        await pool.query('UPDATE agent_sessions SET attempt=999 WHERE id=$1', [sessionId]);
      await expireExecution(sessionId);
      if (kind === 'live-worker') await agents.heartbeat(sessionId, workerId);
      if (kind === 'orphaned') await agents.releaseLease(sessionId, workerId);
      if (kind === 'reclaimed') {
        await pool.query('UPDATE agent_sessions SET lease_heartbeat_at=0 WHERE id=$1', [sessionId]);
        workerId = 'replacement-worker';
        const replacement = await agents.claimNextSession(workerId, process.pid, {
          sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
        expect(replacement).toBeTruthy();
        attempt = replacement!.attempt;
      }
      const input = await agents.listUserMessages(sessionId);
      const position = (await store.get(study.id, principal.ownerId)).state.position;
      await Promise.all([expireStalledTeachingTurns(), expireStalledTeachingTurns()]);
      const ended = await agents.getSession(sessionId);
      expect(ended).toMatchObject({
        status: 'failed',
        error: expect.stringContaining(AGENT_EXECUTION_IDLE_TIMEOUT),
      });
      expect(ended!.lease).toBeUndefined();
      expect(
        (await agents.readEventsAfter(sessionId, 0, 100)).filter(
          (event) => event.type === 'session_end',
        ),
      ).toHaveLength(1);
      expect(await agents.heartbeat(sessionId, workerId)).toBe(false);
      expect(
        await agents.appendRunEvent(sessionId, workerId, {
          ts: Date.now(),
          attempt,
          type: 'message_end',
          data: {},
        }),
      ).toBeNull();
      expect(
        await agents.finishSession(sessionId, workerId, {
          status: 'succeeded',
          expectedAttempt: attempt,
        }),
      ).toBe(false);
      expect(
        await recordTeachingProgress({ sessionId, ownerId: principal.ownerId, workerId, attempt }),
      ).toBe(false);
      expect(
        (await pool.query('SELECT 1 FROM sandbox_session_grants WHERE session_id=$1', [sessionId]))
          .rows,
      ).toHaveLength(0);
      const view = await learningView(principal, study.id, { passive: true });
      expect(view.roleRun).toMatchObject({
        status: 'failed',
        failureCode: AGENT_EXECUTION_IDLE_TIMEOUT,
        failure: 'timeout',
        canRetry: true,
      });
      expect(view.state.position).toEqual(position);
      await study.send('retry');
      expect((await agents.getSession(sessionId))!.status).toBe('queued');
      expect(await agents.listUserMessages(sessionId)).toEqual(input);
      await expireStalledTeachingTurns();
      expect((await agents.getSession(sessionId))!.status).toBe('queued');
    },
  );

  it.each([0, 2, 3, 6])(
    'records assistance in guided step %s without losing the pending review or crediting its input',
    async (stageIndex) => {
      const study = await freshStudy();
      const row = await store.get(study.id, principal.ownerId);
      onTestFinished(async () => {
        await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
          row.environment_id,
        ]);
      });
      row.state.position.stageIndex = stageIndex;
      row.state.milestones[0]!.stageIndex = stageIndex;
      await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
      const { sessionId } = (await study.send('chat')) as { sessionId: string };
      async function claim(workerId: string) {
        const claimed = await agents.claimNextSession(workerId, process.pid, {
          sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
        const lastInput = (await agents.listUserMessages(sessionId)).at(-1)!;
        await agents.markUserMessageDelivered(sessionId, workerId, claimed!.attempt, lastInput.seq);
        return {
          claimed: claimed!,
          config: await teachingRunnerConfig({
            sessionId,
            ownerId: principal.ownerId,
            workerId,
            attempt: claimed!.attempt,
            signal: new AbortController().signal,
          }),
        };
      }
      async function send(text: string) {
        await commandStudy(principal, study.id, {
          id: randomUUID(),
          revision: (await store.get(study.id, principal.ownerId)).revision,
          type: 'chat',
          text,
        });
      }
      const first = await claim('before-support');
      await invoke(first.config, 'read_next_skill');
      await invoke(first.config, 'request_skill_review', {
        question:
          stageIndex === 0 ? 'Ready to begin?' : 'Review this artifact or explain this step.',
        approval: stageIndex === 2 || stageIndex === 3,
      });
      await agents.finishSession(sessionId, 'before-support', {
        status: 'succeeded',
        expectedAttempt: first.claimed.attempt,
      });
      const pending = structuredClone((await store.binding(sessionId))!.guided!.pending);
      const position = structuredClone(
        (await store.get(study.id, principal.ownerId)).state.position,
      );
      await send('Where is the file? I cannot find the control.');
      const help = await claim('support-worker');
      const response =
        'Use the Project files tree in the IDE. If the IDE is hidden, use its workspace toggle. The task bar is not a contract editor.';
      if (stageIndex === 2) {
        await pool.query(
          `CREATE FUNCTION reject_support() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'support commit failed'; END $$`,
        );
        await pool.query(
          `CREATE TRIGGER reject_support BEFORE INSERT ON agent_session_events FOR EACH ROW WHEN (NEW.type='pbl_learner_handoff') EXECUTE FUNCTION reject_support()`,
        );
        try {
          await expect(invoke(help.config, 'respond_to_learner', { response })).rejects.toThrow(
            'support commit failed',
          );
          expect(help.config.isTurnComplete()).toBe(false);
          expect((await store.binding(sessionId))!.guided!.handoff).toBeUndefined();
          expect((await store.binding(sessionId))!.guided!.pending).toEqual(pending);
        } finally {
          await pool.query('DROP TRIGGER reject_support ON agent_session_events');
          await pool.query('DROP FUNCTION reject_support()');
        }
      }
      await invoke(help.config, 'respond_to_learner', { response });
      const guided = (await store.binding(sessionId))!.guided!;
      expect(guided.pending).toEqual(pending);
      expect(guided.coverage).toBeUndefined();
      expect(guided.approval).toBeUndefined();
      expect(help.config.isTurnComplete()).toBe(true);
      expect(help.config.needsTurnReceipt()).toBe(false);
      await expect(
        invoke(help.config, 'complete_stage', {
          studentFeedback: 'A navigation request is approval.',
          reuseFeedback: true,
        }),
      ).rejects.toThrow();
      expect((await store.get(study.id, principal.ownerId)).state.position).toEqual(position);
      const event = (await agents.readEventsAfter(sessionId, 0, 1000)).find(
        (e) => e.type === 'pbl_learner_handoff',
      )!;
      expect(event.data).toMatchObject({
        kind: 'support',
        stageKey: `${project.definition.milestones[0]!.id}:${stageIndex}`,
        sourceUserSeq: expect.any(Number),
      });
      const beforeDisplay = await learningView(principal, study.id, { passive: true });
      expect(
        beforeDisplay
          .conversation!.flatMap((e) => e.parts)
          .filter((p) => p.kind === 'text' && p.text === response),
      ).toHaveLength(1);
      await agents.appendControlEvent(sessionId, {
        ts: Date.now(),
        type: 'tool_execution_end',
        data: {
          toolName: 'respond_to_learner',
          toolCallId: (event.data as { toolCallId: string }).toolCallId,
          result: { content: [{ type: 'text', text: JSON.stringify({ response }) }] },
        },
      });
      expect(
        (await learningView(principal, study.id, { passive: true }))
          .conversation!.flatMap((e) => e.parts)
          .filter((p) => p.kind === 'text' && p.text === response),
      ).toHaveLength(1);
      await agents.releaseLease(sessionId, 'support-worker');
      const recovered = await claim('support-recovery');
      expect(recovered.config.isTurnComplete()).toBe(true);
      expect(JSON.parse(recovered.config.liveContext()).currentReview.studentResponseCount).toBe(0);
      const calls = mocked.modelCalls;
      await runSession({ running: new Map(), shuttingDown: false }, recovered.claimed);
      expect(mocked.modelCalls).toBe(calls);
      expect((await agents.getSession(sessionId))!.status).toBe('succeeded');
      expect((await learningView(principal, study.id, { passive: true })).roleRun).toMatchObject({
        status: 'succeeded',
        canRetry: false,
      });
      await send(
        stageIndex === 0
          ? 'Ready to begin teaching.'
          : 'I have now reviewed this version and approve it.',
      );
      const next = await claim('after-support');
      expect(JSON.parse(next.config.liveContext()).currentReview.studentResponseCount).toBe(1);
      await invoke(next.config, 'read_next_skill', {
        studentFeedback:
          stageIndex === 0
            ? 'The learner is ready.'
            : 'The learner reviewed and approved this version.',
      });
      const nextState = (await store.binding(sessionId))!.guided!;
      if (stageIndex === 0) expect(nextState.welcome).toBe('ready');
      else {
        expect(nextState.coverage!.studentSeq).not.toBe(
          (event.data as { sourceUserSeq: number }).sourceUserSeq,
        );
        if (stageIndex === 2 || stageIndex === 3) expect(nextState.approval).toBeTruthy();
      }
      await agents.finishSession(sessionId, 'after-support', {
        status: 'succeeded',
        expectedAttempt: next.claimed.attempt,
      });
    },
    30_000,
  );

  it('answers pre-lesson assistance without opening a Skill or a fake readiness review', async () => {
    const study = await freshStudy();
    const row = await store.get(study.id, principal.ownerId);
    onTestFinished(async () => {
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        row.environment_id,
      ]);
    });
    const { sessionId } = (await study.send('chat')) as { sessionId: string };
    const claimed = await agents.claimNextSession('early-support', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const request = {
      sessionId,
      ownerId: principal.ownerId,
      workerId: 'early-support',
      attempt: claimed!.attempt,
      signal: new AbortController().signal,
    };
    const config = await teachingRunnerConfig(request);
    await invoke(config, 'respond_to_learner', {
      response: 'Files are in the project IDE; edits save automatically.',
    });
    const guided = (await store.binding(sessionId))!.guided!;
    expect(guided.activeFile).toBe('');
    expect(guided.welcome).toBe('pending');
    expect(guided.pending).toBeUndefined();
    expect((await teachingRunnerConfig(request)).isTurnComplete()).toBe(true);
    expect(
      (await store.get(study.id, principal.ownerId)).state.collected[
        row.state.position.milestoneId!
      ]!.teachingCompleted,
    ).not.toBe(true);
    await agents.finishSession(sessionId, 'early-support', {
      status: 'succeeded',
      expectedAttempt: claimed!.attempt,
    });
    expect((await learningView(principal, study.id, { passive: true })).roleRun).toMatchObject({
      status: 'succeeded',
      canRetry: false,
    });
  }, 30_000);

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'reconciles an already persisted %s terminal frame without publishing it twice',
    async (status) => {
      const { study, sessionId } = await executionFixture();
      const claim = await agents.claimNextSession('flushed-terminal', process.pid, {
        sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const error =
        status === 'failed' ? '[MODEL_REQUEST_FAILED] A durable request failure.' : undefined;
      await agents.appendRunEvent(sessionId, 'flushed-terminal', {
        ts: Date.now(),
        attempt: claim!.attempt,
        type: 'session_end',
        data: { status, ...(error ? { error } : {}) },
      });
      await expireExecution(sessionId);
      const { expireStalledTeachingTurns } = await import('@/lib/server/pbl-v3/execution-watchdog');
      await Promise.all([expireStalledTeachingTurns(), expireStalledTeachingTurns()]);
      expect(await agents.getSession(sessionId)).toMatchObject({ status });
      expect((await agents.getSession(sessionId))?.error).toBe(error);
      expect(
        (await agents.readEventsAfter(sessionId, 0, 100)).filter((e) => e.type === 'session_end'),
      ).toHaveLength(1);
      if (status !== 'succeeded') {
        await study.send('retry');
        const next = await agents.claimNextSession('retried-terminal', process.pid, {
          sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
        expect(next!.attempt).toBe(claim!.attempt);
        await expireExecution(sessionId);
        await expireStalledTeachingTurns();
        expect(await agents.getSession(sessionId)).toMatchObject({
          status: 'failed',
          error: expect.stringContaining('AGENT_EXECUTION_IDLE_TIMEOUT'),
        });
        expect(
          (await agents.readEventsAfter(sessionId, 0, 100)).filter((e) => e.type === 'session_end'),
        ).toHaveLength(2);
      }
    },
  );

  it('forwards progress after a committed anonymous-owner claim without reviving an old grant', async () => {
    const { study, sessionId } = await executionFixture();
    const claim = await agents.claimNextSession('claimed-owner', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const formerOwner = `anon:${randomUUID()}`;
    // The committed claim has moved these rows to the account; the live runner still has its old owner.
    await pool.query('INSERT INTO owner_merges(from_owner_id,to_owner_id) VALUES($1,$2)', [
      formerOwner,
      principal.ownerId,
    ]);
    await pool.query(
      "UPDATE sandbox_session_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
      [sessionId],
    );
    const { recordTeachingProgress, expireStalledTeachingTurns } =
      await import('@/lib/server/pbl-v3/execution-watchdog');
    const input = {
      sessionId,
      ownerId: formerOwner,
      workerId: 'claimed-owner',
      attempt: claim!.attempt,
    };
    await pool.query(
      "UPDATE pbl_v3_roles SET execution_progress_at=clock_timestamp()-interval '14 minutes' WHERE session_id=$1",
      [sessionId],
    );
    expect(await recordTeachingProgress(input)).toBe(true);
    const grant = (
      await pool.query(
        'SELECT grant_id,owner_id,expires_at>clock_timestamp() AS renewed FROM sandbox_session_grants WHERE session_id=$1',
        [sessionId],
      )
    ).rows[0];
    expect(grant).toMatchObject({ owner_id: principal.ownerId, renewed: true });
    await expireStalledTeachingTurns();
    expect((await agents.getSession(sessionId))!.status).toBe('running');
    await pool.query('DELETE FROM sandbox_session_grants WHERE session_id=$1', [sessionId]);
    expect(await recordTeachingProgress(input)).toBe(true);
    expect(
      (await pool.query('SELECT 1 FROM sandbox_session_grants WHERE session_id=$1', [sessionId]))
        .rows,
    ).toHaveLength(0);
    await agents.finishSession(sessionId, 'claimed-owner', {
      status: 'succeeded',
      expectedAttempt: claim!.attempt,
    });
    expect((await store.get(study.id, principal.ownerId)).owner_id).toBe(principal.ownerId);
  });

  it('honors short waits both at owner fencing and at grant renewal', async () => {
    const { sessionId } = await executionFixture();
    const claim = await agents.claimNextSession('short-progress', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const { recordTeachingProgress } = await import('@/lib/server/pbl-v3/execution-watchdog');
    const { ownerIdentityLockKey, OwnerBusyError } = await import('@/lib/persistence/owner-merges');
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      await held.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        ownerIdentityLockKey(principal.ownerId).toString(),
      ]);
      await expect(
        recordTeachingProgress({
          sessionId,
          ownerId: principal.ownerId,
          workerId: 'short-progress',
          attempt: claim!.attempt,
        }),
      ).rejects.toBeInstanceOf(OwnerBusyError);
      await held.query('ROLLBACK');
      await held.query('BEGIN');
      await held.query(
        'SELECT session_id FROM sandbox_session_grants WHERE session_id=$1 FOR UPDATE',
        [sessionId],
      );
      await expect(
        recordTeachingProgress({
          sessionId,
          ownerId: principal.ownerId,
          workerId: 'short-progress',
          attempt: claim!.attempt,
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
  });

  it('advances past a deferred hundred candidates and revisits them on the next pass', async () => {
    const { study, sessionId: seed } = await executionFixture();
    await pool.query("UPDATE agent_sessions SET status='succeeded' WHERE id=$1", [seed]);
    const ids: string[] = [];
    for (let i = 0; i < 101; i++) {
      const id = `pbl-role-${randomUUID()}`;
      ids.push(id);
      await agents.createSession({
        id,
        ownerId: principal.ownerId,
        stageId: (await store.get(study.id, principal.ownerId)).stage_id,
        prompt: 'watchdog fairness',
        status: 'queued',
      });
      await pool.query(
        `INSERT INTO pbl_v3_roles(session_id,study_id,role,context_key,stage_key,execution_progress_at)
        SELECT $1,$2,'mentor',$1,stage_key,clock_timestamp()-interval '20 minutes'+$3::integer*interval '1 millisecond'
        FROM pbl_v3_roles WHERE session_id=$4`,
        [id, study.id, i, seed],
      );
      await pool.query(
        `INSERT INTO sandbox_session_grants(session_id,owner_id,environment_id,grant_id,allow_writes,allow_commands,expires_at)
        SELECT $1,owner_id,environment_id,$2,allow_writes,allow_commands,expires_at FROM sandbox_session_grants WHERE session_id=$3`,
        [id, randomUUID(), seed],
      );
    }
    const held = await pool.connect();
    const { expireStalledTeachingTurns } = await import('@/lib/server/pbl-v3/execution-watchdog');
    try {
      await held.query('BEGIN');
      await held.query(
        'SELECT session_id FROM sandbox_session_grants WHERE session_id=ANY($1::text[]) FOR UPDATE',
        [ids.slice(0, 100)],
      );
      // Keep the real 250 ms lock policy: a full deferred batch must still yield to the next page.
      await expireStalledTeachingTurns();
      expect((await agents.getSession(ids[100]!))!.status).toBe('queued');
      await expireStalledTeachingTurns();
      expect((await agents.getSession(ids[100]!))!.status).toBe('failed');
      await held.query('ROLLBACK');
      await expireStalledTeachingTurns();
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM agent_sessions WHERE id=ANY($1::text[]) AND status='failed'",
            [ids],
          )
        ).rows[0].count,
      ).toBe(101);
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
  }, 45000);

  it.each(['write', 'manage', 'command'] as const)(
    'fences %s dispatch after durable retirement before the worker observes abort',
    async (operation) => {
      const previous = project.buildCommand;
      project.buildCommand = 'python3 -m py_compile greeting.py';
      onTestFinished(() => {
        project.buildCommand = previous;
      });
      const study = await freshStudy();
      const row = await store.get(study.id, principal.ownerId);
      onTestFinished(async () => {
        await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
          row.environment_id,
        ]);
      });
      row.state.position.stageIndex = 3;
      row.state.milestones[0]!.stageIndex = 3;
      await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
      const { sessionId } = (await study.send('chat')) as { sessionId: string };
      const claim = await agents.claimNextSession('dispatch-race', process.pid, {
        sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const controller = new AbortController();
      const config = await teachingRunnerConfig({
        sessionId,
        ownerId: principal.ownerId,
        workerId: 'dispatch-race',
        attempt: claim!.attempt,
        signal: controller.signal,
      });
      await invoke(config, 'read_next_skill');
      const text = await (
        await SandboxService.forOwner(principal)
      ).readText(row.environment_id!, 'greeting.py');
      const write = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'writeText');
      const manage = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'mutateFile');
      const command = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'startCommand');
      const original = agents.assertActiveLease.bind(agents);
      let release!: () => void,
        entered = false,
        checks = 0;
      const fence = vi.spyOn(agents, 'assertActiveLease').mockImplementation(async (...args) => {
        // Outer tool admission and evidence/build invalidation have already committed.
        if (++checks === 3) {
          entered = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return original(...args);
      });
      const pending = (
        operation === 'write'
          ? invoke(config, 'write_file', {
              path: 'greeting.py',
              text: '# retired',
              expectedHash: digest(text),
            })
          : operation === 'manage'
            ? invoke(config, 'manage_file', {
                action: 'create',
                path: 'src/retired.py',
                text: '# retired',
              })
            : invoke(config, 'run_build')
      ).catch((error) => error);
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        await expireExecution(sessionId);
        await (await import('@/lib/server/pbl-v3/execution-watchdog')).expireStalledTeachingTurns();
        expect((await agents.getSession(sessionId))!.status).toBe('failed');
        expect(controller.signal.aborted).toBe(false);
        release();
        expect(await pending).toBeInstanceOf(Error);
        expect(write).not.toHaveBeenCalled();
        expect(manage).not.toHaveBeenCalled();
        expect(command).not.toHaveBeenCalled();
        expect(
          await (
            await SandboxService.forOwner(principal)
          ).readText(row.environment_id!, 'greeting.py'),
        ).toBe(text);
        if (operation === 'command') {
          expect(
            (
              await pool.query(
                "SELECT result_json->>'state' AS state FROM sandbox_commands WHERE environment_id=$1",
                [row.environment_id],
              )
            ).rows,
          ).toEqual([{ state: 'cancelled' }]);
        }
        fence.mockRestore();
        await study.send('retry');
        const next = await agents.claimNextSession('dispatch-retry', process.pid, {
          sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
        const resumed = await teachingRunnerConfig({
          sessionId,
          ownerId: principal.ownerId,
          workerId: 'dispatch-retry',
          attempt: next!.attempt,
          signal: new AbortController().signal,
        });
        await invoke(resumed, 'read_next_skill');
        if (operation === 'command') await invoke(resumed, 'collect_build');
        await invoke(resumed, 'write_file', {
          path: 'greeting.py',
          text: '# fresh',
          expectedHash: digest(text),
        });
        expect(write).toHaveBeenCalledTimes(1);
        await agents.finishSession(sessionId, 'dispatch-retry', {
          status: 'succeeded',
          expectedAttempt: next!.attempt,
        });
      } finally {
        release?.();
        fence.mockRestore();
        write.mockRestore();
        manage.mockRestore();
        command.mockRestore();
      }
    },
  );

  it('releases the dispatch lease before a slow provider responds while retaining the environment lock', async () => {
    const study = await freshStudy();
    const row = await store.get(study.id, principal.ownerId);
    onTestFinished(async () => {
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        row.environment_id,
      ]);
    });
    row.state.position.stageIndex = 3;
    row.state.milestones[0]!.stageIndex = 3;
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    const { sessionId } = (await study.send('chat')) as { sessionId: string };
    const claim = await agents.claimNextSession('slow-dispatch', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const controller = new AbortController();
    const config = await teachingRunnerConfig({
      sessionId,
      ownerId: principal.ownerId,
      workerId: 'slow-dispatch',
      attempt: claim!.attempt,
      signal: controller.signal,
    });
    await invoke(config, 'read_next_skill');
    const service = await SandboxService.forOwner(principal);
    const text = await service.readText(row.environment_id!, 'greeting.py');
    let release!: () => void,
      entered = false,
      underlying!: Promise<unknown>;
    const originalWrite = E2BCompatibleSandboxProvider.prototype.writeText;
    const writer = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'writeText')
      .mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return originalWrite.apply(this, args);
      });
    const originalCompare = SandboxService.prototype.compareAndWriteText;
    const compare = vi
      .spyOn(SandboxService.prototype, 'compareAndWriteText')
      .mockImplementation(function (this: SandboxService, ...args) {
        const work = originalCompare.apply(this, args);
        underlying = work;
        void work.catch(() => {});
        return work;
      });
    const pending = invoke(config, 'write_file', {
      path: 'greeting.py',
      text: '# in flight',
      expectedHash: digest(text),
    }).catch((error) => error);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      await expireExecution(sessionId);
      await (await import('@/lib/server/pbl-v3/execution-watchdog')).expireStalledTeachingTurns();
      expect((await agents.getSession(sessionId))!.status).toBe('failed');
      controller.abort();
      await pending;
      await expect(
        (await SandboxStore.open()).exclusive(row.environment_id!, async () => {}),
      ).rejects.toMatchObject({ reason: 'ENVIRONMENT_BUSY' });
      release();
      await underlying;
      await expect(
        (await SandboxStore.open()).exclusive(row.environment_id!, async () => true),
      ).resolves.toBe(true);
      expect((await agents.getSession(sessionId))!.status).toBe('failed');
    } finally {
      release?.();
      writer.mockRestore();
      compare.mockRestore();
    }
  });

  it.each(['start', 'collect-missing', 'collect-finished', 'collect-source-limit'] as const)(
    'fences a late %s build commit after watchdog failure and explicit retry',
    async (phase) => {
      const previous = project.buildCommand;
      project.buildCommand = 'python3 -m py_compile greeting.py';
      onTestFinished(() => {
        project.buildCommand = previous;
      });
      const study = await freshStudy();
      onTestFinished(async () => {
        const own = await store.get(study.id, principal.ownerId);
        await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
          own.environment_id,
        ]);
      });
      const row = await store.get(study.id, principal.ownerId);
      row.state.position.stageIndex = 3;
      row.state.milestones[0]!.stageIndex = 3;
      await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
      const { sessionId } = (await study.send('chat')) as { sessionId: string };
      const claim = await agents.claimNextSession('late-build', process.pid, {
        sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const controller = new AbortController();
      const config = await teachingRunnerConfig({
        sessionId,
        ownerId: principal.ownerId,
        workerId: 'late-build',
        attempt: claim!.attempt,
        signal: controller.signal,
      });
      await invoke(config, 'read_next_skill');
      if (phase === 'collect-missing') {
        const current = await store.get(study.id, principal.ownerId);
        current.evaluation = {
          id: randomUUID(),
          fingerprint: 'missing',
          stageKey: stageKey(current),
          startedAt: new Date().toISOString(),
          purpose: 'compile',
        };
        await store.transaction((db) =>
          store.commit(db, current, { state: current.state, events: [] }),
        );
      } else if (phase !== 'start') await invoke(config, 'run_build');
      const before = (await store.get(study.id, principal.ownerId)).evaluation;
      let release!: () => void,
        entered = false;
      const pause = async () => {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      let io: { mockRestore(): void };
      if (phase === 'collect-missing') {
        const original = pool.query;
        io = vi.spyOn(pool, 'query').mockImplementation((async (...args: unknown[]) => {
          const result = await Reflect.apply(original, pool, args);
          if (String(args[0]).includes('SELECT 1 FROM sandbox_commands')) await pause();
          return result;
        }) as typeof pool.query);
      } else {
        const original = E2BCompatibleSandboxProvider.prototype.readText;
        io = vi
          .spyOn(E2BCompatibleSandboxProvider.prototype, 'readText')
          .mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
            const result = await original.apply(this, args);
            if (args[2].endsWith('greeting.py')) {
              await pause();
              if (phase === 'collect-source-limit') return 'x'.repeat(1_048_577);
            }
            return result;
          });
      }
      const compilation = await import('@/lib/server/pbl-v3/compilation');
      const originalStart = compilation.startBuild,
        originalCollect = compilation.collectBuild;
      let underlying!: Promise<unknown>;
      const helper =
        phase === 'start'
          ? vi.spyOn(compilation, 'startBuild').mockImplementation((...args) => {
              const work = originalStart(...args);
              underlying = work;
              void work.catch(() => {});
              return work;
            })
          : vi.spyOn(compilation, 'collectBuild').mockImplementation((...args) => {
              const work = originalCollect(...args);
              underlying = work;
              void work.catch(() => {});
              return work;
            });
      const pending = invoke(config, phase === 'start' ? 'run_build' : 'collect_build').catch(
        (error) => error,
      );
      try {
        await vi.waitFor(() => expect(entered).toBe(true));
        await expireExecution(sessionId);
        await (await import('@/lib/server/pbl-v3/execution-watchdog')).expireStalledTeachingTurns();
        expect((await agents.getSession(sessionId))!.status).toBe('failed');
        controller.abort();
        await pending;
        await study.send('retry');
        release();
        await expect(underlying).rejects.toThrow();
        expect((await store.get(study.id, principal.ownerId)).evaluation).toEqual(before);
        expect((await agents.getSession(sessionId))!.status).toBe('queued');
        expect(
          (
            await pool.query(
              "SELECT 1 FROM pbl_v3_commands WHERE study_id=$1 AND id LIKE 'build:%'",
              [study.id],
            )
          ).rows,
        ).toHaveLength(0);
        if (phase === 'start')
          expect(
            (
              await pool.query('SELECT 1 FROM sandbox_commands WHERE environment_id=$1', [
                row.environment_id,
              ])
            ).rows,
          ).toHaveLength(0);
        io.mockRestore();
        helper.mockRestore();
        const next = await agents.claimNextSession('recovered-build', process.pid, {
          sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
        const resumed = await teachingRunnerConfig({
          sessionId,
          ownerId: principal.ownerId,
          workerId: 'recovered-build',
          attempt: next!.attempt,
          signal: new AbortController().signal,
        });
        await invoke(resumed, 'read_next_skill');
        if (phase === 'start') await invoke(resumed, 'run_build');
        await invoke(resumed, 'collect_build');
        expect((await store.get(study.id, principal.ownerId)).evaluation).toBeNull();
        await agents.finishSession(sessionId, 'recovered-build', {
          status: 'succeeded',
          expectedAttempt: next!.attempt,
        });
      } finally {
        release?.();
        io.mockRestore();
        helper.mockRestore();
        await pending;
      }
    },
    15000,
  );

  it('keeps healthy long execution active and renews only its existing bound grant', async () => {
    const { study, sessionId } = await executionFixture();
    const { expireStalledTeachingTurns, recordTeachingProgress } =
      await import('@/lib/server/pbl-v3/execution-watchdog');
    const claim = await agents.claimNextSession('healthy-worker', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const input = {
      sessionId,
      ownerId: principal.ownerId,
      workerId: 'healthy-worker',
      attempt: claim!.attempt,
    };
    await pool.query(
      "UPDATE pbl_v3_roles SET turn_started_at=clock_timestamp()-interval '2 hours' WHERE session_id=$1",
      [sessionId],
    );
    await pool.query(
      "UPDATE sandbox_session_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
      [sessionId],
    );
    const original = (
      await pool.query('SELECT grant_id FROM sandbox_session_grants WHERE session_id=$1', [
        sessionId,
      ])
    ).rows[0].grant_id;
    for (let i = 0; i < 3; i++) {
      await pool.query(
        "UPDATE pbl_v3_roles SET execution_progress_at=clock_timestamp()-interval '14 minutes' WHERE session_id=$1",
        [sessionId],
      );
      expect(await recordTeachingProgress(input)).toBe(true);
      await expireStalledTeachingTurns();
      expect((await agents.getSession(sessionId))!.status).toBe('running');
    }
    expect(
      await (await SandboxStore.open()).sessionGrant(sessionId, principal.ownerId),
    ).toMatchObject({ grant_id: original });
    // Explicit revocation cannot be undone by later progress.
    await pool.query('DELETE FROM sandbox_session_grants WHERE session_id=$1', [sessionId]);
    expect(await recordTeachingProgress(input)).toBe(true);
    expect(await (await SandboxStore.open()).sessionGrant(sessionId, principal.ownerId)).toBeNull();
    const row = await store.get(study.id, principal.ownerId);
    expect(row.state.position.stageIndex).toBe(0);
  });

  it('expires without the study lock, preserves explicit cancellation, and ignores terminal/unbound sessions', async () => {
    const { study, sessionId } = await executionFixture();
    const { expireStalledTeachingTurns } = await import('@/lib/server/pbl-v3/execution-watchdog');
    const claim = await agents.claimNextSession('hung-worker', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    expect(claim).toBeTruthy();
    await agents.requestCancel(sessionId);
    await expireExecution(sessionId);
    let release!: () => void;
    const locked = store.exclusive(
      study.id,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    try {
      await expireStalledTeachingTurns();
      expect((await agents.getSession(sessionId))!.status).toBe('cancelled');
    } finally {
      release();
      await locked;
    }
    const ordinary = await agents.createSession({
      ownerId: principal.ownerId,
      prompt: 'ordinary',
      stageId: 'ordinary',
    });
    await expireStalledTeachingTurns();
    expect((await agents.getSession(ordinary.id))!.status).toBe('queued');
    const ended = await agents.getSession(sessionId);
    await expireStalledTeachingTurns();
    expect(await agents.getSession(sessionId)).toEqual(ended);
  });

  it.each(['setup', 'tool', 'settlement'] as const)(
    'retires a stalled %s claim, frees admission and refuses late completion',
    async (phase) => {
      const { study, sessionId } = await executionFixture();
      const { expireStalledTeachingTurns } = await import('@/lib/server/pbl-v3/execution-watchdog');
      let release!: () => void;
      let entered = false;
      const paused = () => {
        entered = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      let restore: () => void;
      if (phase === 'setup') {
        const driver = await import('@/lib/server/agent-runtime/agent-driver-model');
        const original = driver.resolveAgentDriverModel;
        const hook = vi
          .spyOn(driver, 'resolveAgentDriverModel')
          .mockImplementation(async (...args) => {
            await paused();
            return original(...args);
          });
        restore = () => hook.mockRestore();
      } else if (phase === 'tool') {
        const row = await store.get(study.id, principal.ownerId);
        row.state.position.stageIndex = 3;
        row.state.milestones[0]!.stageIndex = 3;
        await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
        // Replace the welcome binding with the actual coding role.
        await pool.query("UPDATE agent_sessions SET status='succeeded' WHERE id=$1", [sessionId]);
        const queued = (await study.send('chat')) as { sessionId: string };
        return stalledCodingTool(study, queued.sessionId);
      } else {
        const original = agents.appendRunEvent.bind(agents);
        const hook = vi.spyOn(agents, 'appendRunEvent').mockImplementation(async (...args) => {
          if (args[2].type === 'session_end') await paused();
          return original(...args);
        });
        restore = () => hook.mockRestore();
      }
      const claim = await agents.claimNextSession('blocked-execution', process.pid, {
        sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      mocked.responses = [
        toolResponse([{ name: 'request_skill_review', input: { question: 'Ready to learn?' } }]),
      ];
      const ctx = { running: new Map(), shuttingDown: false };
      const run = runSession(ctx, claim!);
      try {
        await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
        await expireExecution(sessionId);
        await vi.waitFor(
          async () => {
            await expireStalledTeachingTurns();
            expect((await agents.getSession(sessionId))!.status).toBe('failed');
          },
          { timeout: 5000 },
        );
        await vi.waitFor(() => expect(ctx.running.size).toBe(0), { timeout: 5000 });
        await run;
        expect((await agents.getSession(sessionId))!.status).toBe('failed');
        await study.send('retry');
        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect((await agents.getSession(sessionId))!.status).toBe('queued');
      } finally {
        release?.();
        restore!();
        await run;
        mocked.responses = [];
      }
    },
    20000,
  );

  async function stalledCodingTool(
    study: Awaited<ReturnType<typeof freshStudy>>,
    sessionId: string,
  ) {
    const { expireStalledTeachingTurns } = await import('@/lib/server/pbl-v3/execution-watchdog');
    let release!: () => void,
      entered = false;
    const original = E2BCompatibleSandboxProvider.prototype.readText;
    const hook = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'readText')
      .mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
        if (args[2].endsWith('greeting.py')) {
          entered = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return original.apply(this, args);
      });
    const claim = await agents.claimNextSession('blocked-code', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    mocked.responses = [
      toolResponse([{ name: 'read_next_skill', input: {} }]),
      toolResponse([{ name: 'read_file', input: { path: 'greeting.py' } }]),
    ];
    const ctx = { running: new Map(), shuttingDown: false };
    const run = runSession(ctx, claim!);
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
      await expireExecution(sessionId);
      // The scan skips short progress-publication locks instead of blocking.
      await vi.waitFor(
        async () => {
          await expireStalledTeachingTurns();
          expect((await agents.getSession(sessionId))!.status).toBe('failed');
        },
        { timeout: 5000 },
      );
      await vi.waitFor(() => expect(ctx.running.size).toBe(0), { timeout: 5000 });
      await run;
      expect((await agents.getSession(sessionId))!.status).toBe('failed');
      await study.send('retry'); // The hung tool must have released the study lock.
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await agents.getSession(sessionId))!.status).toBe('queued');
    } finally {
      release?.();
      hook.mockRestore();
      await run;
      mocked.responses = [];
    }
  }

  it('does not expire a claim while fresh progress is being committed', async () => {
    const { sessionId } = await executionFixture();
    const { expireStalledTeachingTurns } = await import('@/lib/server/pbl-v3/execution-watchdog');
    await agents.claimNextSession('progress-race', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await expireExecution(sessionId);
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT id FROM agent_sessions WHERE id=$1 FOR SHARE', [sessionId]);
      await db.query(
        'UPDATE pbl_v3_roles SET execution_progress_at=clock_timestamp() WHERE session_id=$1',
        [sessionId],
      );
      await expireStalledTeachingTurns();
      expect((await agents.getSession(sessionId))!.status).toBe('running');
      await db.query('COMMIT');
      await expireStalledTeachingTurns();
      expect((await agents.getSession(sessionId))!.status).toBe('running');
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });

  it.each(['discarded', 'releasing'] as const)(
    'never renews a grant for a %s environment even if an old worker reports progress',
    async (intent) => {
      const { study, sessionId } = await executionFixture();
      const { recordTeachingProgress } = await import('@/lib/server/pbl-v3/execution-watchdog');
      const claim = await agents.claimNextSession('retired-environment', process.pid, {
        sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const row = await store.get(study.id, principal.ownerId);
      await pool.query(
        "UPDATE sandbox_session_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
        [sessionId],
      );
      if (intent === 'discarded')
        await pool.query('UPDATE pbl_v3_studies SET archive_discard=$2 WHERE id=$1', [
          study.id,
          JSON.stringify({ environmentId: row.environment_id }),
        ]);
      else
        await pool.query('UPDATE pbl_v3_studies SET idle_turn_cleanup=$2 WHERE id=$1', [
          study.id,
          JSON.stringify({ environmentId: row.environment_id, releasing: true }),
        ]);
      await recordTeachingProgress({
        sessionId,
        ownerId: principal.ownerId,
        workerId: 'retired-environment',
        attempt: claim!.attempt,
      });
      expect(
        await (await SandboxStore.open()).sessionGrant(sessionId, principal.ownerId),
      ).toBeNull();
    },
  );

  it('bounds a multi-call turn and pages every saved message without replaying snapshots', async () => {
    const study = await freshStudy();
    onTestFinished(async () => {
      const own = await store.get(study.id, principal.ownerId);
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        own.environment_id,
      ]);
    });
    const queued = (await study.send('begin')) as { sessionId: string };
    const { readConversationHistory, readConversationPage, CONVERSATION_BYTES } =
      await import('@/lib/server/pbl-v3/conversation-history');
    const { conversationPage } = await import('@/lib/server/pbl-v3/conversation-page');
    const bodies = Array.from(
      { length: 115 },
      (_, index) => `Message ${index}: ` + 'x'.repeat(index === 15 ? 1_200_000 : 14_000),
    );
    bodies.push('Current complete reply: ' + 'y'.repeat(700_000));
    const largeToolResult = { content: [{ type: 'text', text: 'tool output '.repeat(60_000) }] };
    // This contract measures history reads, not per-event commit throughput. Keep the
    // real append/sequence path, but commit each fixture phase once rather than 1,389 times.
    await store.transaction(async (db) => {
      const events = new PgAgentSessionStore(db, { withTransaction: (body) => body(db) });
      for (const [index, text] of bodies.entries()) {
        for (const [type, content] of [
          ['message_start', ''],
          ['message_update', text.slice(0, 30)],
          [index === bodies.length - 1 ? 'message_update' : 'message_end', text],
        ])
          await events.appendControlEvent(queued.sessionId, {
            ts: Date.now(),
            type,
            data: { message: { role: 'assistant', content: [{ type: 'text', text: content }] } },
          });
      }
      await events.appendControlEvent(queued.sessionId, {
        ts: Date.now(),
        type: 'tool_execution_end',
        data: { toolName: 'read_file', toolCallId: 'large-history-tool', result: largeToolResult },
      });
    });
    const initial = await learningView(principal, study.id, { passive: true });
    const initialPart = initial.conversation
      ?.flatMap((entry) => entry.parts)
      .findLast((part) => part.kind === 'text');
    await store.transaction(async (db) => {
      const events = new PgAgentSessionStore(db, { withTransaction: (body) => body(db) });
      for (let index = 0; index < 1040; index++)
        await events.appendControlEvent(queued.sessionId, {
          ts: Date.now(),
          type: 'tool_execution_update',
          data: {
            toolName: 'list_files',
            toolCallId: 'many-tool-events',
            partialResult: { index },
          },
        });
    });
    const through = await agents.lastEventSeq(queued.sessionId);
    const live = await readConversationHistory(pool, queued.sessionId, through, 30);
    expect(live.length).toBeLessThanOrEqual(32); // durable learner and current-message anchors
    expect(
      live.some((event) => (event.data as { pblHistoryBefore?: boolean }).pblHistoryBefore),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(live))).toBeLessThan(CONVERSATION_BYTES + 750_000);
    expect(JSON.stringify(live).includes(bodies.at(-1)!)).toBe(true);
    const view = await learningView(principal, study.id, { passive: true });
    expect(Buffer.byteLength(JSON.stringify(view.conversation))).toBeLessThan(
      CONVERSATION_BYTES + 750_000,
    );
    expect(JSON.stringify(view.conversation).includes(bodies.at(-1)!)).toBe(true);
    expect(
      view.conversation?.flatMap((entry) => entry.parts).findLast((part) => part.kind === 'text')
        ?.id,
    ).toBe(initialPart?.id);
    expect(view.conversationHistory).toContainEqual({
      sessionId: queued.sessionId,
      through,
      role: 'discussion',
    });

    // New updates must not move the frozen history window or change its cursors.
    await agents.appendControlEvent(queued.sessionId, {
      ts: Date.now(),
      type: 'message_update',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'NEWER_UPDATE_NOT_IN_SNAPSHOT' }],
        },
      },
    });
    const seen = new Set<number>();
    const restored: string[] = [];
    let before: number | null = null;
    for (let count = 0; count < 40; count++) {
      const page = await readConversationPage(pool, queued.sessionId, through, before);
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.events.length).toBeLessThanOrEqual(80);
      if (Buffer.byteLength(JSON.stringify(page.events)) > CONVERSATION_BYTES + 10_000)
        expect(page.events).toHaveLength(1);
      for (const event of page.events) {
        expect(seen.has(event.id)).toBe(false);
        seen.add(event.id);
        const data = event.data as { message?: { role: string; content: { text: string }[] } };
        if (data.message?.role === 'assistant') restored.push(data.message.content[0].text);
      }
      if (!page.nextBefore) break;
      expect(page.nextBefore).toBeLessThan(before ?? through + 1);
      before = page.nextBefore;
      if (count === 39) throw new Error('History pagination did not terminate');
    }
    expect(restored.map(digest).sort()).toEqual(bodies.map(digest).sort());
    const renewals = mocked.renewals.length,
      creates = mocked.creates.length;
    const params = new URLSearchParams({
      id: study.id,
      sessionId: queued.sessionId,
      through: String(through),
    });
    const response = await conversationPage(principal, params);
    expect(response.through).toBe(through);
    expect(JSON.stringify(response)).not.toContain('NEWER_UPDATE_NOT_IN_SNAPSHOT');
    expect(response.nextBefore).not.toBeNull();
    const displayed: string[] = [];
    let toolRestored = false;
    let projected = response;
    for (let count = 0; count < 40; count++) {
      for (const entry of projected.conversation)
        if (entry.speaker !== 'user')
          for (const part of entry.parts) if (part.kind === 'text') displayed.push(part.text);
      for (const entry of projected.conversation)
        for (const part of entry.parts)
          if (part.kind === 'tool' && part.id.includes('large-history-tool'))
            toolRestored =
              digest((part.result as typeof largeToolResult)?.content?.[0]?.text ?? '') ===
              digest(largeToolResult.content[0].text);
      if (!projected.nextBefore) break;
      projected = await conversationPage(
        principal,
        new URLSearchParams({
          ...Object.fromEntries(params),
          before: String(projected.nextBefore),
        }),
      );
      if (count === 39) throw new Error('Projected history pagination did not terminate');
    }
    expect(displayed.map(digest).sort()).toEqual(bodies.map(digest).sort());
    expect(toolRestored).toBe(true);
    await expect(
      conversationPage({ ...principal, ownerId: 'another-learner' }, params),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocked.renewals).toHaveLength(renewals);
    expect(mocked.creates).toHaveLength(creates);
    await expect(
      conversationPage(
        principal,
        new URLSearchParams({ ...Object.fromEntries(params), before: '-1' }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const other = await store.create(
      {
        ownerId: principal.ownerId,
        stageId: randomUUID(),
        sceneId: 'scene',
        projectId: project.ref.id,
        version: project.ref.version,
      },
      startOrchestration(project.definition),
    );
    await expect(
      conversationPage(
        principal,
        new URLSearchParams({ ...Object.fromEntries(params), id: other.id }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await agents.getSession(queued.sessionId))!.status).toBe('queued');
    const row = await store.get(study.id, principal.ownerId);
    await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
      row.environment_id,
    ]);
  }, 15000);

  it('keeps the last snapshot of every interrupted message across retry attempts', async () => {
    const study = await freshStudy();
    onTestFinished(async () => {
      const own = await store.get(study.id, principal.ownerId);
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        own.environment_id,
      ]);
    });
    const queued = (await study.send('begin')) as { sessionId: string };
    for (let attempt = 0; attempt < 2; attempt++) {
      const worker = `snapshot-worker-${attempt}`;
      const claimed = await agents.claimNextSession(worker, process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      for (let message = 0; message < 2; message++) {
        await agents.appendRunEvent(queued.sessionId, worker, {
          type: 'message_start',
          ts: Date.now(),
          attempt: claimed!.attempt,
          data: { message: { role: 'assistant', content: [] } },
        });
        for (let frame = 0; frame < 3; frame++)
          await agents.appendRunEvent(queued.sessionId, worker, {
            type: 'message_update',
            ts: Date.now(),
            attempt: claimed!.attempt,
            data: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'thinking', thinking: `Reasoning ${attempt}:${message}:${frame}` },
                  { type: 'text', text: `Partial ${attempt}:${message}:${frame}` },
                ],
              },
            },
          });
      }
      await agents.appendRunEvent(queued.sessionId, worker, {
        type: 'session_end',
        ts: Date.now(),
        attempt: claimed!.attempt,
        data: { status: 'failed', error: '[MODEL_REQUEST_IDLE_TIMEOUT] timed out' },
      });
      await agents.finishSession(queued.sessionId, worker, {
        status: 'failed',
        error: '[MODEL_REQUEST_IDLE_TIMEOUT] timed out',
        expectedAttempt: claimed!.attempt,
      });
      if (!attempt) await study.send('retry');
    }
    const { readConversationHistory } = await import('@/lib/server/pbl-v3/conversation-history');
    const events = await readConversationHistory(
      pool,
      queued.sessionId,
      await agents.lastEventSeq(queued.sessionId),
      1000,
    );
    expect(events.filter((e) => e.type === 'message_update')).toHaveLength(4);
    const view = await learningView(principal, study.id, { passive: true });
    for (let attempt = 0; attempt < 2; attempt++)
      for (let message = 0; message < 2; message++) {
        expect(JSON.stringify(view.conversation)).toContain(`Partial ${attempt}:${message}:2`);
        expect(JSON.stringify(view.conversation)).toContain(`Reasoning ${attempt}:${message}:2`);
      }
    expect(view.roleRun).toMatchObject({
      status: 'failed',
      canRetry: true,
      failure: 'timeout',
      failureCode: 'MODEL_REQUEST_IDLE_TIMEOUT',
    });
  });

  it('keeps a large reply whole while the committed review question awaits its display event', async () => {
    const study = await freshStudy();
    onTestFinished(async () => {
      const own = await store.get(study.id, principal.ownerId);
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        own.environment_id,
      ]);
    });
    const queued = (await study.send('begin')) as { sessionId: string };
    const claimed = await agents.claimNextSession('question-race-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const config = await teachingRunnerConfig({
      sessionId: queued.sessionId,
      ownerId: principal.ownerId,
      workerId: 'question-race-worker',
      attempt: claimed!.attempt,
      signal: new AbortController().signal,
    });
    await invoke(config, 'request_skill_review', { question: 'Ready to continue?' });
    const text = 'Current explanation. '.repeat(140000);
    await agents.appendRunEvent(queued.sessionId, 'question-race-worker', {
      type: 'message_update',
      ts: Date.now(),
      attempt: claimed!.attempt,
      data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
    });
    const view = await learningView(principal, study.id, { passive: true });
    expect(
      view.conversation?.flatMap((e) => e.parts).find((p) => p.kind === 'text' && p.text === text),
    ).toBeDefined();
    expect(JSON.stringify(view.conversation)).toContain('Ready to continue?');
    await agents.finishSession(queued.sessionId, 'question-race-worker', {
      status: 'succeeded',
      expectedAttempt: claimed!.attempt,
    });
  });
  it('bounds long evidence histories and oversized records while retaining complete quantitative totals', async () => {
    const study = await freshStudy();
    const started = (await study.send('begin')) as { sessionId: string };
    const row = await store.get(study.id, principal.ownerId);
    const size = 6005;
    await pool.query(
      `INSERT INTO pbl_v3_events(study_id,sequence,event)
      SELECT $1,$2+g,jsonb_build_object('type','decision.recorded','milestoneId','greeting','decisionId','format','chosen',CASE WHEN g%2=0 THEN 'format' ELSE 'concat' END)
      FROM generate_series(1,$3::int) g`,
      [study.id, row.state.lastSequence, size],
    );
    await pool.query(`INSERT INTO pbl_v3_events(study_id,sequence,event) VALUES($1,$2,$3)`, [
      study.id,
      row.state.lastSequence + size + 1,
      JSON.stringify({
        type: 'artifact.recorded',
        artifact: { kind: 'plan', milestoneId: 'greeting' },
        content: 'OVERSIZED_ORCHESTRATION_' + 'x'.repeat(100000),
      }),
    ]);
    await pool.query(
      `UPDATE pbl_v3_studies SET state=jsonb_set(jsonb_set(state,'{lastSequence}',to_jsonb($2::int)),'{status}','"completed"'),revision=revision+1 WHERE id=$1`,
      [study.id, row.state.lastSequence + size + 1],
    );
    await pool.query(
      `INSERT INTO pbl_v3_evidence(study_id,milestone_id,stage_index,kind,actor,detail)
      SELECT $1,'greeting',0,'file-edit','learner',jsonb_build_object('text',repeat('x',2000),'number',g) FROM generate_series(1,$2::int) g`,
      [study.id, size],
    );
    const current = await store.get(study.id, principal.ownerId);
    await recordLearningEvidence(pool, current, 'learner', 'file-edit', {
      text: 'OVERSIZED_FILE_' + 'x'.repeat(100000),
    });
    const seq = await agents.lastEventSeq(started.sessionId);
    await pool.query(
      `INSERT INTO agent_session_events(session_id,seq,ts,attempt,type,data)
      SELECT $1,$2+g,0,0,'user_message',jsonb_build_object('text',repeat('y',2000),'pblOpening',false) FROM generate_series(1,$3::int) g`,
      [started.sessionId, seq, size],
    );
    await agents.appendControlEvent(started.sessionId, {
      ts: Date.now(),
      type: 'message_end',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The most recent discussion remains visible.' }],
        },
      },
    });
    await agents.appendControlEvent(started.sessionId, {
      ts: Date.now(),
      type: 'message_end',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'OVERSIZED_CONVERSATION_' + 'z'.repeat(100000) }],
        },
      },
    });
    await pool.query("UPDATE agent_sessions SET status='succeeded' WHERE id=$1", [
      started.sessionId,
    ]);
    const report = await learningReport(principal, study.id);
    expect(report.truncated).toBe(true);
    expect(report.evidence.length).toBeLessThanOrEqual(2000);
    expect(report.conversations.flatMap((c) => c.messages).length).toBeLessThanOrEqual(1000);
    const textSize =
      report.evidence.reduce((n, e) => n + e.detail.length, 0) +
      report.conversations.flatMap((c) => c.messages).reduce((n, m) => n + m.text.length, 0);
    expect(textSize).toBeLessThanOrEqual(240000);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(1000000);
    expect(JSON.stringify(report)).not.toContain('OVERSIZED_');
    expect(report.evidence.some((e) => e.detail.includes(`"number": ${size}`))).toBe(true);
    expect(
      report.conversations
        .flatMap((c) => c.messages)
        .some((m) => m.text === 'The most recent discussion remains visible.'),
    ).toBe(true);
    expect(report.counts['decision.recorded']).toBe(size);
    expect(report.facts).toMatchObject({
      learnerTurns: size,
      assistantTurns: 2,
      decisions: 1,
      decisionChanges: size - 1,
      fileEdits: size + 1,
    });
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM pbl_v3_evidence WHERE study_id=$1', [
          study.id,
        ])
      ).rows[0].n,
    ).toBe(size + 1);
    mocked.reportAnalysis.mockReset().mockResolvedValueOnce({ findings: [], omitted: true });
    expect(
      (await generateLearningReport(principal, study.id, new AbortController().signal)).analysis
        ?.omitted,
    ).toBe(true);
    expect(mocked.reportAnalysis.mock.calls[0]![1].truncated).toBe(true);
    await agents.softDeleteSession(started.sessionId, principal.ownerId);
  });
  it('prepares once and runs the complete learning flow with actual Python tests', async () => {
    await command('prepare');
    await guided('teaching'); // project welcome waits for readiness inside the first step
    await expect(command('next')).rejects.toThrow('not available');
    await command('decide', { decisionId: 'format', chosen: 'format' });
    await command('next');
    expect((await learningView(principal, studyId)).decisionSummary).toEqual([
      {
        id: 'format',
        prompt: project.definition.decisions[0]!.desc,
        choice: project.definition.decisions[0]!.options.find((option) => option.id === 'format')!
          .label,
      },
    ]);
    await guided('plan');
    await guided('code');
    const service = await SandboxService.forOwner(principal);
    const environmentId = (await store.get(studyId, principal.ownerId)).environment_id!;
    const code = await service.readText(environmentId, 'greeting.py');
    // Simulate code changed by an external process, not an authorized generic file API.
    await writeFile(
      join(mocked.root, environmentId, 'greeting.py'),
      'def greet(name):\n    return "wrong"\n',
    );
    await command('evaluate');
    await command('collect');
    await expect(command('next')).rejects.toThrow('not available');
    await runTools('Please help me fix the failed greeting test.', async (config) => {
      expect(config.systemPrompt).toContain('observed test failure');
      const current = await service.readText(environmentId, 'greeting.py');
      await expect(
        invoke(config, 'write_file', {
          path: 'PLAN.md',
          text: 'overwrite',
          expectedHash: digest(''),
        }),
      ).rejects.toThrow('cannot write');
      await invoke(config, 'write_file', {
        path: 'greeting.py',
        text: code + '\n# repaired\n',
        expectedHash: digest(current),
      });
    });
    const evaluation = (await command('evaluate')) as { exitCode: number };
    expect(evaluation.exitCode).toBe(0);
    await command('collect');
    const tested = await store.get(studyId, principal.ownerId);
    expect(tested.state.collected.greeting!.tests?.status).toBe('passed');
    expect(tested.state.collected.greeting!.tests?.publicDiagnostics?.caseResults).toHaveLength(2);
    const completedId = tested.state.collected.greeting!.tests!.id;
    await commandStudy(principal, studyId, {
      id: randomUUID(),
      revision: 0,
      type: 'collect',
      evaluationId: completedId,
    });
    expect((await store.get(studyId, principal.ownerId)).revision).toBe(tested.revision);

    expect(tested.state.collected.greeting!.tests?.publicFeedback).toContain('2 checks passed');
    // A previous pass must not authorize progression while a newer run awaits collection.
    await command('evaluate');
    await expect(command('collect', { evaluationId: completedId })).rejects.toThrow(
      'pending evaluation changed',
    );

    expect((await learningView(principal, studyId)).actions).not.toContain('next');
    await expect(command('next')).rejects.toThrow('pending test result');
    expect((await store.get(studyId, principal.ownerId)).state.position.stageIndex).toBe(4);
    await command('collect');
    expect((await learningView(principal, studyId)).actions).toContain('next');
    await command('next');
    await command('quiz', { answers: [1] });
    const wrongQuiz = await learningView(principal, studyId);
    expect(wrongQuiz.state.collected.greeting!.quiz).toMatchObject({
      passed: false,
      score: 0,
      total: 1,
    });
    expect(wrongQuiz.actions).not.toContain('next');
    await expect(command('next')).rejects.toThrow('not available');
    // The repair passed tests, but was newer than the code-review checkpoint. Expiry at the
    // quiz must return to testing the restored version, not strand the learner at the quiz.
    mocked.missing.add(environmentId);
    await rm(join(mocked.root, environmentId), { recursive: true });
    await command('prepare');
    const recovered = await store.get(studyId, principal.ownerId);
    expect(recovered.environment_id).not.toBe(environmentId);
    expect(recovered.state.position.stageIndex).toBe(4);
    expect(recovered.state.collected.greeting).toMatchObject({
      tests: null,
      quiz: null,
      codeReviewCompleted: false,
      planReviewCompleted: true,
    });
    await command('evaluate');
    await command('collect');
    await command('next');
    await command('quiz', { answers: [0] });
    await command('next');
    await runTools('Please reflect on my results.', async (config) => {
      const tested = (await store.get(studyId, principal.ownerId)).state.collected.greeting!;
      // Reflection has its own disclosure and completion receipt.
      const mentor = (await store.roles(studyId)).find((binding) => binding.role === 'mentor')!;
      expect(mentor.stage_key).toBe('greeting:6');
      expect(config.systemPrompt).toContain(
        '"teachingContext":{"stageKey":"greeting:6","completionRecorded":false,"activeSection":null,',
      );
      expect(config.systemPrompt).toContain('"recordedEvidence"');
      expect(config.systemPrompt).toContain('2 checks passed');
      expect(config.systemPrompt).toContain(tested.tests!.revision.id);
      expect(config.systemPrompt).toContain('"score":1,"total":1');
      expect(config.systemPrompt).not.toContain('correctAnswer');
      expect(config.systemPrompt).not.toContain('internalDiagnostics');
    });
    await guided('teaching');
    const restored = await new LearningStore(pool).get(studyId, principal.ownerId);
    expect(restored.state.status).toBe('completed');
    expect((await learningView(principal, studyId)).actions).toEqual([]);
    expect(
      (await pool.query('SELECT count(*) FROM pbl_v3_events WHERE study_id=$1', [studyId])).rows[0]
        .count,
    ).toBe(String(restored.state.lastSequence));
  }, 60000);
  it('replaces a deleted role without resetting progress or reusing its review receipts', async () => {
    const study = await freshStudy();
    const first = (await study.send('chat')) as { sessionId: string };
    const before = await store.get(study.id, principal.ownerId);
    await agents.softDeleteSession(first.sessionId, principal.ownerId);
    expect((await learningView(principal, study.id)).roleRun?.status).toBe('missing');
    const replacement = (await study.send('chat')) as { sessionId: string };
    expect(replacement.sessionId).not.toBe(first.sessionId);
    expect((await agents.getSession(replacement.sessionId))?.status).toBe('queued');
    expect(await agents.getSession(first.sessionId)).toBeNull();
    expect((await store.get(study.id, principal.ownerId)).state).toEqual(before.state);
    expect(await store.binding(replacement.sessionId)).toMatchObject({
      guided: null,
      completion: null,
    });
    expect(
      (
        await pool.query('SELECT session_id FROM sandbox_session_grants WHERE session_id=$1', [
          first.sessionId,
        ])
      ).rows,
    ).toEqual([]);
    await agents.softDeleteSession(replacement.sessionId, principal.ownerId);
  });
  it('cancels despite a held learning lock and stale progress, while enforcing ownership', async () => {
    const study = await freshStudy();
    const queued = (await study.send('chat')) as { sessionId: string };
    let release!: () => void, entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = store.exclusive(
      study.id,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    await inside;
    const cancel = { id: randomUUID(), revision: 0, type: 'cancel' };
    try {
      await expect(
        commandStudy({ ...principal, ownerId: 'another-owner' }, study.id, cancel),
      ).rejects.toMatchObject({ status: 404 });
      expect(await agents.getCancelRequestedAt(queued.sessionId)).toBeNull();
      expect(await commandStudy(principal, study.id, cancel)).toEqual({ cancelRequested: true });
      expect(await agents.getCancelRequestedAt(queued.sessionId)).toBeTruthy();
    } finally {
      release();
      await blocked;
      await agents.softDeleteSession(queued.sessionId, principal.ownerId);
    }
  });
  it.each([
    ['401 unauthorized https://provider.invalid/?key=SECRET', 'authentication'],
    ['Teaching turn timed out after 120 seconds.', 'timeout'],
  ])('projects %s and retries without inventing student feedback', async (error, failure) => {
    const study = await freshStudy();
    const queued = (await study.send('chat')) as { sessionId: string };
    const meta = await agents.claimNextSession('failure-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const config = await teachingRunnerConfig({
      sessionId: queued.sessionId,
      ownerId: principal.ownerId,
      workerId: 'failure-worker',
      attempt: meta!.attempt,
      signal: new AbortController().signal,
    });
    await invoke(config, 'read_next_skill');
    await invoke(config, 'request_skill_review', { question: 'Explain the return value.' });
    await agents.finishSession(queued.sessionId, 'failure-worker', {
      status: 'failed',
      expectedAttempt: meta!.attempt,
      error,
    });
    const view = await learningView(principal, study.id);
    expect(view.roleRun).toMatchObject({ status: 'failed', failure, canRetry: true });
    expect(JSON.stringify(view)).not.toContain('SECRET');
    expect(view.messages.at(-1)?.text).toBe('Explain the return value.');
    const messages = await agents.listUserMessages(queued.sessionId);
    const binding = await store.binding(queued.sessionId);
    await study.send('retry');
    expect(await agents.listUserMessages(queued.sessionId)).toEqual(messages);
    expect((await store.binding(queued.sessionId))?.feedback_seq).toBe(binding?.feedback_seq);
    const retried = await agents.claimNextSession('failure-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const resumed = await teachingRunnerConfig({
      sessionId: queued.sessionId,
      ownerId: principal.ownerId,
      workerId: 'failure-worker',
      attempt: retried!.attempt,
      signal: new AbortController().signal,
    });
    expect(resumed.isTurnComplete()).toBe(true);
    await expect(
      invoke(resumed, 'request_skill_review', { question: 'Repeat question' }),
    ).rejects.toThrow();
    await expect(
      invoke(resumed, 'read_next_skill', { studentFeedback: 'Please start.' }),
    ).rejects.toThrow();
    await agents.finishSession(queued.sessionId, 'failure-worker', {
      status: 'cancelled',
      expectedAttempt: retried!.attempt,
    });
    expect((await learningView(principal, study.id)).roleRun).toMatchObject({
      status: 'cancelled',
      canRetry: true,
    });
  });
  it('repairs one ended prose-only turn then fails safely, preserving retry evidence', async () => {
    const original = studyId;
    const study = await freshStudy();
    studyId = study.id;
    onTestFinished(() => {
      studyId = original;
    });
    const handle = startAgentRunner();
    await handle.stop();
    const claim = (id: string) =>
      agents.claimNextSession(handle.workerId, process.pid, {
        sessionId: id,
        leaseTtlMs: 30000,
        maxAttempts: 5,
      });
    const queued = (await study.send('chat')) as { sessionId: string };
    mocked.responses = [
      toolResponse([
        { name: 'read_next_skill', input: {} },
        { name: 'request_skill_review', input: { question: 'Explain the return value.' } },
      ]),
    ];
    await runSession({ running: new Map(), shuttingDown: false }, (await claim(queued.sessionId))!);
    expect((await agents.getSession(queued.sessionId))?.status).toBe('succeeded');
    const reply = 'A returned value goes back to the caller.';
    await command('chat', { text: reply });
    const inputs = await agents.listUserMessages(queued.sessionId);
    const before = mocked.modelCalls;
    mocked.responses = [textResponse('You can continue now.'), textResponse('Click Continue.')];
    await runSession({ running: new Map(), shuttingDown: false }, (await claim(queued.sessionId))!);
    expect(mocked.modelCalls - before).toBe(2); // One repair of an already-ended turn; normal tool loops remain unbounded.
    expect((await agents.getSession(queued.sessionId))?.status).toBe('failed');
    expect((await agents.getSession(queued.sessionId))?.error).toContain('without recording');
    expect((await learningView(principal, study.id)).actions).not.toContain('next');
    expect((await store.binding(queued.sessionId))?.guided?.activeFile).toBe('A-teach.md');
    expect(await agents.listUserMessages(queued.sessionId)).toEqual(inputs);
    // The durable assistant stop is not grounds to early-settle an unclosed teaching turn.
    // Simulate a current runner settling a prose-only turn without its required receipt.
    await pool.query("UPDATE agent_sessions SET status='succeeded' WHERE id=$1", [
      queued.sessionId,
    ]);
    expect((await learningView(principal, study.id)).roleRun).toMatchObject({
      status: 'failed',
      failure: 'incomplete',
      canRetry: true,
    });
    await study.send('retry');
    const retried = await claim(queued.sessionId);
    const retryRequestIndex = mocked.modelRequests.length;
    mocked.responses = [
      toolResponse([{ name: 'read_next_skill', input: { studentFeedback: reply } }]),
      toolResponse([
        { name: 'request_skill_review', input: { question: 'How does the caller use it?' } },
      ]),
    ];
    await runSession({ running: new Map(), shuttingDown: false }, retried!);
    const settled = await agents.getSession(queued.sessionId);
    expect(settled?.status, settled?.error).toBe('succeeded');
    expect((await store.binding(queued.sessionId))?.guided?.activeFile).toBe('A-teach.md');
    expect(await agents.listUserMessages(queued.sessionId)).toEqual(inputs);
    expect(mocked.modelRequests[retryRequestIndex]?.at(-1)).toMatchObject({
      role: 'user',
      content: reply,
    });
    expect(mocked.modelSystems.at(-1)).toContain('\"activeSection\":\"A-teach.md\"');
    expect(mocked.modelSystems.at(-1)).toContain('Authoritative live teaching state');
    expect((await learningView(principal, study.id)).actions).not.toContain('next');
    studyId = original;
  }, 30000);
  it('repairs a prose-only lesson by recording its already delivered question without restarting teaching', async () => {
    const study = await freshTeachingStudy();
    const handle = startAgentRunner();
    await handle.stop();
    const queued = (await study.send('chat')) as { sessionId: string };
    const meta = await agents.claimNextSession(handle.workerId, process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const inputs = await agents.listUserMessages(queued.sessionId);
    await agents.markUserMessageDelivered(
      queued.sessionId,
      handle.workerId,
      meta!.attempt,
      inputs.at(-2)!.seq,
    );
    const question = 'What does the caller receive after adding a task?';
    const delivered = `This milestone adds a task. A list keeps order; append modifies it. ${question}`;
    mocked.responses = [
      toolResponse([{ name: 'read_next_skill', input: {} }]),
      textResponse(delivered),
      toolResponse([{ name: 'request_skill_review', input: { question } }]),
    ];
    const callsBefore = mocked.modelCalls;
    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...meta!, ...(await agents.getSession(queued.sessionId))! },
    );
    expect(mocked.modelCalls - callsBefore).toBe(3);
    expect(mocked.modelSystems.at(-1)).toContain(delivered);
    expect(mocked.modelSystems.at(-1)).toContain('record that SAME question');
    expect((await agents.getSession(queued.sessionId))?.status).toBe('succeeded');
    expect(await agents.listUserMessages(queued.sessionId)).toEqual(inputs);
    expect((await store.binding(queued.sessionId))?.guided?.pending?.question).toBe(question);
    const view = await learningView(principal, study.id);
    const parts = view.conversation!.flatMap((entry) => entry.parts);
    expect(
      parts.filter((part) => part.kind === 'text' && part.text.includes(question)),
    ).toHaveLength(1);
    expect(
      parts.filter((part) => part.kind === 'text' && part.text.includes('A list keeps order')),
    ).toHaveLength(1);
    expect(view.actions).not.toContain('next');
    expect(view.state.position.stageIndex).toBe(0);
  });
  it('repairs a prose-only assistance reply without replacing readiness or duplicating its answer', async () => {
    const study = await freshStudy();
    const row = await store.get(study.id, principal.ownerId);
    onTestFinished(async () => {
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        row.environment_id,
      ]);
    });
    const { sessionId } = (await study.send('chat')) as { sessionId: string };
    const first = await agents.claimNextSession('support-opener', process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const config = await teachingRunnerConfig({
      sessionId,
      ownerId: principal.ownerId,
      workerId: 'support-opener',
      attempt: first!.attempt,
      signal: new AbortController().signal,
    });
    await invoke(config, 'request_skill_review', {
      question: 'Any background questions? Ready to begin?',
    });
    const pending = structuredClone((await store.binding(sessionId))!.guided!.pending);
    await agents.finishSession(sessionId, 'support-opener', {
      status: 'succeeded',
      expectedAttempt: first!.attempt,
    });
    await commandStudy(principal, study.id, {
      id: randomUUID(),
      revision: (await store.get(study.id, principal.ownerId)).revision,
      type: 'chat',
      text: 'Where do I see project files?',
    });
    const handle = startAgentRunner();
    await handle.stop();
    const claimed = await agents.claimNextSession(handle.workerId, process.pid, {
      sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const inputs = await agents.listUserMessages(sessionId);
    await agents.markUserMessageDelivered(
      sessionId,
      handle.workerId,
      claimed!.attempt,
      inputs.at(-2)!.seq,
    );
    const response = 'Use Project files in the IDE. Allowed edits save automatically.';
    mocked.responses = [
      textResponse(response),
      toolResponse([{ name: 'respond_to_learner', input: { response } }]),
    ];
    const calls = mocked.modelCalls;
    await runSession(
      { running: new Map(), shuttingDown: false },
      { ...claimed!, ...(await agents.getSession(sessionId))! },
    );
    expect(mocked.modelCalls - calls).toBe(2);
    expect((await agents.getSession(sessionId))!.status).toBe('succeeded');
    expect((await store.binding(sessionId))!.guided!.pending).toEqual(pending);
    expect(mocked.modelSystems.at(-1)).toContain(
      'For an assistance-only answer or product clarification',
    );
    const view = await learningView(principal, study.id, { passive: true });
    expect(
      view
        .conversation!.flatMap((entry) => entry.parts)
        .filter((part) => part.kind === 'text' && part.text === response),
    ).toHaveLength(1);
    expect(view.actions).not.toContain('next');
    expect(view.state.position.stageIndex).toBe(0);
  }, 30_000);
  it('settles the automatic welcome when requesting readiness is the first tool call', async () => {
    const study = await freshStudy();
    const handle = startAgentRunner();
    await handle.stop();
    const queued = (await study.send('begin')) as { sessionId: string };
    const meta = await agents.claimNextSession(handle.workerId, process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    mocked.responses = [
      toolResponse([
        { name: 'request_skill_review', input: { question: 'Any process questions? Ready?' } },
      ]),
    ];
    const callsBefore = mocked.modelCalls;
    await runSession({ running: new Map(), shuttingDown: false }, meta!);
    expect(mocked.modelCalls - callsBefore).toBe(1);
    expect(await agents.getSession(queued.sessionId)).toMatchObject({ status: 'succeeded' });
    expect((await store.binding(queued.sessionId))?.guided).toMatchObject({
      welcome: 'pending',
      activeFile: 'A-teach.md',
      reviewedFiles: [],
      pending: { question: 'Any process questions? Ready?' },
    });
    const view = await learningView(principal, study.id);
    expect(view.roleRun).toMatchObject({ status: 'succeeded', canRetry: false, failure: null });
    expect(view.state.position.stageIndex).toBe(0);
    expect(view.actions).not.toContain('next');
    const messages = await listAgentUserMessages(agents, queued.sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.pblOpening).toBe(true);
  });
  it.each(['mixed', 'invalid-tail', 'failed-review'] as const)(
    'stops teaching at a saved review in a %s batch through the real Pi loop',
    async (batch) => {
      const original = studyId;
      studyId = (
        await store.create(
          {
            ownerId: principal.ownerId,
            stageId: `runner-classroom-${batch}`,
            sceneId: 'runner-scene',
            projectId: project.ref.id,
            version: project.ref.version,
          },
          startOrchestration(project.definition),
        )
      ).id;
      await command('prepare');
      const handle = startAgentRunner();
      await handle.stop();
      const queued = (await command('chat', { text: 'Please teach me about this project.' })) as {
        sessionId: string;
      };
      const meta = await agents.claimNextSession(handle.workerId, process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const finish = {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: {
          inputTokens: 1,
          outputTokens: 1,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { reasoningTokens: 0 },
          totalTokens: 2,
        },
      };
      const largeReply = 'Let us inspect the greeting. '.repeat(30000);
      mocked.responses = [
        [
          { type: 'text-delta', text: largeReply },
          { type: 'tool-call', toolCallId: 'read-section', toolName: 'read_next_skill', input: {} },
          {
            type: 'tool-call',
            toolCallId: 'ask-review',
            toolName: 'request_skill_review',
            input: { question: 'What should greet(name) return?' },
          },
          finish,
        ],
      ];
      if (batch === 'invalid-tail')
        mocked.responses[0]!.splice(-1, 0, {
          type: 'tool-call',
          toolCallId: 'unknown',
          toolName: 'unknown_tool',
          input: {},
        });
      if (batch === 'failed-review') {
        // A bad review request must remain recoverable, not silently terminate the role.
        mocked.responses.unshift([
          {
            type: 'tool-call',
            toolCallId: 'early-review',
            toolName: 'request_skill_review',
            input: { question: '' },
          },
          finish,
        ]);
      }
      const callsBefore = mocked.modelCalls;
      await runSession({ running: new Map(), shuttingDown: false }, meta!);
      expect(mocked.modelCalls - callsBefore).toBe(batch === 'failed-review' ? 2 : 1);
      const settled = await agents.getSession(queued.sessionId);
      expect(settled?.status, settled?.error).toBe('succeeded');
      const restored = await learningView(principal, studyId);
      expect(
        restored.conversation
          ?.flatMap((entry) => entry.parts)
          .some((part) => part.kind === 'text' && part.text === largeReply),
      ).toBe(true);

      expect(
        restored.conversation?.filter((entry) => !entry.boundary && entry.speaker !== 'user'),
      ).toMatchObject([{ status: 'succeeded' }]);
      expect(restored.messages.some((m) => m.text === 'What should greet(name) return?')).toBe(
        true,
      );
      expect(restored.actions).not.toContain('next');
      expect((await store.binding(queued.sessionId))?.guided?.pending?.question).toBe(
        'What should greet(name) return?',
      );
      const events = await agents.readEventsAfter(queued.sessionId, 0, 1000);
      const isEmptyStop = (event: (typeof events)[number]) => {
        const message = (
          event.data as { message?: { role?: string; content?: unknown[]; stopReason?: string } }
        ).message;
        return (
          event.type === 'message_end' &&
          message?.role === 'assistant' &&
          message.stopReason === 'stop' &&
          message.content?.length === 0
        );
      };
      expect(events.some(isEmptyStop)).toBe(true); // Durable control receipt is retained.
      const reply = 'It returns a greeting to the caller.';
      await command('chat', { text: reply });
      const next = await agents.claimNextSession(handle.workerId, process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      mocked.responses = [
        [
          {
            type: 'tool-call',
            toolCallId: 'next-section',
            toolName: 'read_next_skill',
            input: { studentFeedback: `Student reply: "${reply}"` },
          },
          {
            type: 'tool-call',
            toolCallId: 'next-review',
            toolName: 'request_skill_review',
            input: { question: 'How does the caller use that value?' },
          },
          finish,
        ],
      ];
      const nextCalls = mocked.modelCalls;
      await runSession({ running: new Map(), shuttingDown: false }, next!);
      expect(mocked.modelCalls - nextCalls).toBe(1);
      expect((await agents.getSession(queued.sessionId))?.status).toBe('succeeded');
      expect((await store.binding(queued.sessionId))?.guided?.activeFile).toBe('A-teach.md');
      const replayed = await learningView(principal, studyId);
      expect(
        replayed.conversation?.filter((entry) => !entry.boundary && entry.speaker !== 'user'),
      ).toMatchObject([{ status: 'succeeded' }, { status: 'succeeded' }]);
      // Inspect the actual connector input AFTER Pi's conversion and toModelMessages.
      const request = mocked.modelRequests.at(-1)!;
      expect(
        request.filter(
          (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.length === 0,
        ),
      ).toEqual([]);
      expect(request.at(-1)).toMatchObject({ role: 'user', content: reply });
      const assistantParts = request.flatMap((m) =>
        m.role === 'assistant' && Array.isArray(m.content) ? m.content : [],
      );
      expect(assistantParts.some((part) => part.type === 'text' && part.text === largeReply)).toBe(
        true,
      );
      expect(assistantParts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool-call', toolCallId: 'read-section' }),
          expect.objectContaining({ type: 'tool-call', toolCallId: 'ask-review' }),
        ]),
      );
      const toolParts = request.flatMap((m) => (m.role === 'tool' ? m.content : []));
      expect(toolParts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool-result', toolCallId: 'read-section' }),
          expect.objectContaining({ type: 'tool-result', toolCallId: 'ask-review' }),
        ]),
      );
      expect((await agents.readEventsAfter(queued.sessionId, 0, 1000)).some(isEmptyStop)).toBe(
        true,
      );
      const transcript = (await learningEvidence(principal, studyId)).conversations.flatMap(
        (c) => c.messages,
      );
      expect(transcript.filter((m) => m.text === 'What should greet(name) return?')).toHaveLength(
        1,
      );
      expect(
        transcript.filter((m) => m.text === 'How does the caller use that value?'),
      ).toHaveLength(1);
      expect(transcript.some((m) => m.role === 'user' && m.text === reply)).toBe(true);
      studyId = original;
    },
    30000,
  );
  it.each(['cancelled', 'takeover'] as const)(
    'keeps a committed review waiting after %s before the display receipt, then accepts a real reply',
    async (interruption) => {
      const study = await freshStudy();
      const queued = (await study.send('chat')) as { sessionId: string };
      const handle = startAgentRunner();
      await handle.stop();
      const meta = await agents.claimNextSession(handle.workerId, process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const messages = await agents.listUserMessages(queued.sessionId);
      await agents.markUserMessageDelivered(
        queued.sessionId,
        handle.workerId,
        meta!.attempt,
        messages.at(-1)!.seq,
      );
      const config = await teachingRunnerConfig({
        sessionId: queued.sessionId,
        ownerId: principal.ownerId,
        workerId: handle.workerId,
        attempt: meta!.attempt,
        signal: new AbortController().signal,
      });
      await invoke(config, 'read_next_skill');
      await invoke(config, 'request_skill_review', { question: 'Explain the saved review.' });
      // No tool event or transcript receipt has been written: the binding is the durable fact.
      if (interruption === 'cancelled') {
        await agents.finishSession(queued.sessionId, handle.workerId, {
          status: 'cancelled',
          expectedAttempt: meta!.attempt,
        });
        await study.send('retry');
      } else {
        await agents.releaseLease(queued.sessionId, handle.workerId);
      }
      const claimed = await agents.claimNextSession(handle.workerId, process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      expect(claimed).toBeTruthy();
      const before = mocked.modelCalls;
      await runSession({ running: new Map(), shuttingDown: false }, claimed!);
      expect(mocked.modelCalls).toBe(before);
      expect((await agents.getSession(queued.sessionId))?.status).toBe('succeeded');
      expect(await agents.listUserMessages(queued.sessionId)).toEqual(messages);
      expect((await learningView(principal, study.id)).messages.at(-1)?.text).toBe(
        'Explain the saved review.',
      );
      expect((await learningView(principal, study.id)).actions).not.toContain('next');
      expect(
        (await learningEvidence(principal, study.id)).conversations
          .flatMap((c) => c.messages)
          .filter((m) => m.text === 'Explain the saved review.'),
      ).toHaveLength(1);
      await study.send('chat');
      const next = await agents.claimNextSession(handle.workerId, process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const resumed = await teachingRunnerConfig({
        sessionId: queued.sessionId,
        ownerId: principal.ownerId,
        workerId: handle.workerId,
        attempt: next!.attempt,
        signal: new AbortController().signal,
      });
      expect(resumed.isTurnComplete()).toBe(false);
      await invoke(resumed, 'read_next_skill', { studentFeedback: 'Please start.' });
      expect((await store.binding(queued.sessionId))?.guided?.activeFile).toBe('A-teach.md');
      await agents.finishSession(queued.sessionId, handle.workerId, {
        status: 'succeeded',
        expectedAttempt: next!.attempt,
      });
    },
  );
  it('protects real PG learning bindings from generic mutations and retains ordinary workspace editing', async () => {
    const row = await store.get(studyId, principal.ownerId),
      service = await SandboxService.forOwner(principal);
    await expect(
      service.writeText(row.environment_id!, 'greeting.py', 'bypass'),
    ).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
    await expect(
      service.startCommand(row.environment_id!, {
        requestId: randomUUID(),
        command: 'echo bypass',
      }),
    ).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
    await expect(
      service.grantSession(row.environment_id!, 'ordinary-agent', true, true),
    ).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
    await expect(service.create(randomUUID(), `pbl-${row.id}`)).rejects.toMatchObject({
      code: 'PBL_WORKSPACE_MANAGED',
    });
    const ordinary = await service.create(randomUUID(), 'ordinary-project');
    await service.writeText(ordinary.id, 'main.py', 'first');
    await service.compareAndWriteText(ordinary.id, 'main.py', 'new content', digest('first'));
    await expect(
      service.compareAndWriteText(ordinary.id, 'main.py', 'stale overwrite', digest('first')),
    ).rejects.toThrow('changed');
    expect(await service.readText(ordinary.id, 'main.py')).toBe('new content');
  });
  it('allows a fresh save after progress rejection while preserving file conflicts and successful receipts', async () => {
    const study = await freshStudy();
    let row = await store.get(study.id, principal.ownerId);
    row.state.status = 'waiting_for_student';
    row.state.position.stageIndex = 3;
    row.state.milestones[0].status = 'active';
    row.state.milestones[0].stageIndex = 3;
    row = await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    const service = await SandboxService.forOwner(principal);
    const path = 'greeting.py';
    const original = await service.readText(row.environment_id!, path);
    const stale = {
      id: randomUUID(),
      revision: row.revision,
      type: 'save',
      path,
      text: 'Learner draft',
      expectedHash: digest(original),
    };
    row = await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    await expect(commandStudy(principal, study.id, stale)).rejects.toMatchObject({
      status: 409,
      reason: 'PROGRESS_CHANGED',
    });
    expect(
      (
        await pool.query('SELECT 1 FROM pbl_v3_commands WHERE study_id=$1 AND id=$2', [
          study.id,
          stale.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await service.readText(row.environment_id!, path)).toBe(original);
    const fresh = { ...stale, id: randomUUID(), revision: row.revision };
    await commandStudy(principal, study.id, fresh);
    expect(await service.readText(row.environment_id!, path)).toBe('Learner draft');
    const revision = (await store.get(study.id, principal.ownerId)).revision;
    await expect(commandStudy(principal, study.id, fresh)).resolves.toBeDefined();
    expect((await store.get(study.id, principal.ownerId)).revision).toBe(revision);
    await writeFile(join(mocked.root, row.environment_id!, path), 'Another writer');
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        commandStudy(principal, study.id, {
          ...fresh,
          id: randomUUID(),
          revision,
          text: 'Retained newer draft',
          expectedHash: digest('Learner draft'),
        }),
      ).rejects.toMatchObject({ status: 409, reason: 'WORKSPACE_FILE_CONFLICT' });
    expect(await service.readText(row.environment_id!, path)).toBe('Another writer');
    expect((await store.get(study.id, principal.ownerId)).revision).toBe(revision);
  });
  it('invalidates stored evidence before an ambiguous learner edit without losing the written content', async () => {
    const study = await freshStudy();
    const completed = await store.get(studyId, principal.ownerId);
    const state = structuredClone(completed.state);
    state.status = 'waiting_for_student';
    state.position.stageIndex = 3; // code production, with previously reviewed evidence
    state.milestones[0].status = 'active';
    state.milestones[0].stageIndex = 3;
    await pool.query('UPDATE pbl_v3_studies SET state=$2 WHERE id=$1', [
      study.id,
      JSON.stringify(state),
    ]);
    const row = await store.get(study.id, principal.ownerId);
    const service = await SandboxService.forOwner(principal);
    const original = await service.readText(row.environment_id!, 'greeting.py');
    const edit = (path: string, text: string, expectedHash: string) =>
      commandStudy(principal, study.id, {
        id: randomUUID(),
        revision: row.revision,
        type: 'save',
        path,
        text,
        expectedHash,
      });
    await expect(edit('PLAN.md', 'bypass', digest(''))).rejects.toThrow('read-only');
    await expect(edit('greeting.py', 'new', digest('stale'))).rejects.toThrow('changed');
    expect((await store.get(study.id, principal.ownerId)).state.collected).toEqual(state.collected);
    mocked.loseWriteAck = true;
    try {
      await expect(edit('greeting.py', 'new source', digest(original))).rejects.toThrow(
        'Write acknowledgement lost',
      );
    } finally {
      mocked.loseWriteAck = false;
    }
    const after = await store.get(study.id, principal.ownerId);
    expect(after.state.collected.greeting).toMatchObject({
      codeReviewCompleted: false,
      tests: null,
      quiz: null,
      recapCompleted: false,
    });
    expect(await service.readText(row.environment_id!, 'greeting.py')).toBe('new source');
    expect((await learningView(principal, study.id)).actions).not.toContain('next');
  });
  it('fences a stale role after progression', async () => {
    const roles = await store.roles(studyId),
      old = roles.find((r) => r.role === 'planner')!;
    await expect(
      teachingRunnerConfig({
        sessionId: old.session_id,
        ownerId: principal.ownerId,
        workerId: 'old',
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('changed');
  });
  it('renews on learner activity without changing progress and throttles repeated active reads', async () => {
    const study = await freshStudy();
    const before = await store.get(study.id, principal.ownerId);
    const count = mocked.renewals.length;
    expect((await learningView(principal, study.id)).environment?.ready).toBe(true);
    await learningView(principal, study.id);
    await touchEnvironment(store, before, await SandboxService.forOwner(principal));
    expect(mocked.renewals.slice(count)).toEqual([before.environment_id]);
    expect((await store.get(study.id, principal.ownerId)).revision).toBe(before.revision);
  });
  it('passively streams progress and workspace state without renewing or changing learner progress', async () => {
    const study = await freshStudy();
    const before = await store.get(study.id, principal.ownerId);
    const count = mocked.renewals.length;
    const observation = await learningView(principal, study.id, { passive: true });
    expect(observation.environment?.ready).toBe(true);
    const inspect = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'inspect');
    const read = vi.spyOn(SandboxService.prototype, 'readText');
    try {
      await learningView(principal, study.id, { passive: true, observation });
      const work = await workbenchView(principal, study.id, { passive: true });
      expect(work.environmentId).toBe(before.environment_id);
      expect(inspect).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(mocked.renewals.length).toBe(count);
      const after = await store.get(study.id, principal.ownerId);
      expect(after.revision).toBe(before.revision);
      expect(after.state).toEqual(before.state);
    } finally {
      inspect.mockRestore();
      read.mockRestore();
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        before.environment_id,
      ]);
    }
  });

  it('pushes a new role opening and runner text through real PG notifications without a browser poll', async () => {
    const { learningEventResponse } = await import('@/lib/server/pbl-v3/event-stream');
    const { startAgentEventNotifyBus } =
      await import('@/lib/server/agent-runtime/event-notify-bus');
    mocked.liveNotifications = true;
    const bus = startAgentEventNotifyBus();
    await bus.connecting;
    const study = await freshStudy();
    const response = await learningEventResponse(principal, study.id, new AbortController().signal);
    const reader = response.body!.getReader();
    const readUntil = async (marker: string) => {
      let text = '';
      const reading = (async () => {
        while (!text.includes(marker)) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Learning stream ended early');
          text += new TextDecoder().decode(chunk.value);
        }
        return text;
      })();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reading,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('PG push missed its deadline')), 3_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    try {
      await readUntil('event: learning');
      const renewals = mocked.renewals.length;
      const queued = (await study.send('begin')) as { sessionId: string };
      await readUntil('"busy":true');
      const count = mocked.renewals.length;
      await store.transaction(async (db) => {
        await store.agentStore(db).appendControlEvent(queued.sessionId, {
          ts: Date.now(),
          type: 'message_update',
          data: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Live lesson notification proof.' }],
            },
          },
        });
      });
      expect(await readUntil('Live lesson notification proof.')).toContain('event: learning');
      expect(mocked.renewals.length).toBe(count);
      expect(count).toBeGreaterThanOrEqual(renewals);
    } finally {
      await reader.cancel();
      await bus.stop();
      mocked.liveNotifications = false;
      const final = await store.get(study.id, principal.ownerId);
      await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
        final.environment_id,
      ]);
    }
  }, 15_000);

  it('rejects teaching submissions to an expired environment without posting or allocating', async () => {
    const study = await freshStudy();
    const original = await store.get(study.id, principal.ownerId);
    const created = mocked.creates.length;
    mocked.missing.add(original.environment_id!);
    await pool.query('UPDATE pbl_v3_studies SET environment_checked_at=NULL WHERE id=$1', [
      study.id,
    ]);
    try {
      for (const type of ['chat', 'retry', 'begin'])
        await expect(study.send(type)).rejects.toMatchObject({ reason: 'ENVIRONMENT_UNAVAILABLE' });
      expect(await store.roles(study.id)).toHaveLength(0);
      expect(mocked.creates).toHaveLength(created);
      const current = await store.get(study.id, principal.ownerId);
      expect(current.state).toEqual(original.state);
      expect(current.revision).toBe(original.revision);
    } finally {
      mocked.missing.delete(original.environment_id!);
    }
  });

  it('opens and rereads local protocol without cloud calls, while review still checks live evidence', async () => {
    const study = await freshTeachingStudy();
    const queued = (await study.send('chat')) as { sessionId: string };
    const meta = await agents.claimNextSession('protocol-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const config = await teachingRunnerConfig({
      sessionId: queued.sessionId,
      ownerId: principal.ownerId,
      workerId: 'protocol-worker',
      attempt: meta!.attempt,
      signal: new AbortController().signal,
    });
    const inspect = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'inspect');
    const read = vi.spyOn(SandboxService.prototype, 'readText');
    try {
      mocked.failInspect = true;
      await pool.query('UPDATE pbl_v3_studies SET environment_checked_at=NULL WHERE id=$1', [
        study.id,
      ]);
      await invoke(config, 'read_next_skill');
      await invoke(config, 'read_next_skill');
      expect(inspect).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      await expect(
        invoke(config, 'complete_stage', { studentFeedback: 'Too early.' }),
      ).rejects.toThrow('必须完成');
      expect(inspect).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      await expect(
        invoke(config, 'request_skill_review', { question: 'Explain the greeting.' }),
      ).rejects.toThrow('Provider unavailable');
      expect((await store.binding(queued.sessionId))?.guided?.pending).toBeUndefined();
    } finally {
      mocked.failInspect = false;
      inspect.mockRestore();
      read.mockRestore();
      await agents.finishSession(queued.sessionId, 'protocol-worker', {
        status: 'succeeded',
        expectedAttempt: meta!.attempt,
      });
    }
  });

  it('stops an aborted evidence read before another file or teaching receipt is written', async () => {
    const study = await freshTeachingStudy();
    const queued = (await study.send('chat')) as { sessionId: string };
    const meta = await agents.claimNextSession('abort-evidence-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const config = await teachingRunnerConfig({
      sessionId: queued.sessionId,
      ownerId: principal.ownerId,
      workerId: 'abort-evidence-worker',
      attempt: meta!.attempt,
      signal: new AbortController().signal,
    });
    await invoke(config, 'read_next_skill');
    const abort = new AbortController();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = SandboxService.prototype.readText;
    const read = vi
      .spyOn(SandboxService.prototype, 'readText')
      .mockImplementationOnce(async function (this: SandboxService, id, path) {
        entered();
        await gate;
        return original.call(this, id, path);
      });
    try {
      const tool = config.tools.find((t) => t.name === 'request_skill_review')!;
      const operation = tool.execute(
        randomUUID(),
        { question: 'Explain the greeting.' },
        abort.signal,
      );
      const rejected = expect(operation).rejects.toThrow();
      await ready;
      abort.abort();
      release();
      await rejected;
      expect(read).toHaveBeenCalledTimes(1);
      expect((await store.binding(queued.sessionId))?.guided?.pending).toBeUndefined();
      // The study lock is released; the same turn can reread its last committed section.
      await expect(invoke(config, 'read_next_skill')).resolves.toBeDefined();
    } finally {
      release();
      read.mockRestore();
      await agents.finishSession(queued.sessionId, 'abort-evidence-worker', {
        status: 'succeeded',
        expectedAttempt: meta!.attempt,
      });
    }
  });

  it('keeps teaching tools available while lifecycle maintenance renews the same environment', async () => {
    const study = await freshTeachingStudy();
    const queued = (await study.send('chat')) as { sessionId: string };
    const meta = await agents.claimNextSession('renewal-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const config = await teachingRunnerConfig({
      sessionId: queued.sessionId,
      ownerId: principal.ownerId,
      workerId: 'renewal-worker',
      attempt: meta!.attempt,
      signal: new AbortController().signal,
    });
    await invoke(config, 'read_next_skill');
    await pool.query('UPDATE pbl_v3_studies SET environment_checked_at=NULL WHERE id=$1', [
      study.id,
    ]);
    let entered!: () => void, release!: () => void, contended!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collision = new Promise<void>((resolve) => {
      contended = resolve;
    });
    const originalRenew = SandboxService.prototype.renew;
    const attempt = vi.spyOn(SandboxService.prototype, 'renew').mockImplementation(async function (
      this: SandboxService,
      id,
    ) {
      try {
        return await originalRenew.call(this, id);
      } catch (error) {
        contended();
        throw error;
      }
    });
    const renew = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'renew')
      .mockImplementationOnce(async () => {
        entered();
        await gate;
      });
    const refreshing = maintainStudy(store, study.id, principal.ownerId);
    try {
      await ready;
      const teaching = invoke(config, 'request_skill_review', {
        question: 'Explain the greeting.',
      });
      const outcome = expect(teaching).resolves.toMatchObject({
        content: expect.any(Array),
      });
      await collision;
      release();
      await outcome;
      expect(renew).toHaveBeenCalledTimes(1);
      expect((await store.binding(queued.sessionId))?.guided).toBeTruthy();
    } finally {
      release();
      await refreshing;
      renew.mockRestore();
      attempt.mockRestore();
      await agents.finishSession(queued.sessionId, 'renewal-worker', {
        status: 'succeeded',
        expectedAttempt: meta!.attempt,
      });
    }
  });
  it('restores a checkpoint with one durable allocation across an interrupted restore, clearing old evaluation and grants', async () => {
    const study = await freshStudy();
    const original = await store.get(study.id, principal.ownerId);
    const env = original.environment_id!;
    const service = await SandboxService.forOwner(principal);
    await writeFile(join(mocked.root, env, 'PLAN.md'), 'Saved plan');
    await study.send('checkpoint');
    await writeFile(join(mocked.root, env, 'PLAN.md'), 'Unsaved changes');
    const queued = (await study.send('chat')) as { sessionId: string };
    const claimed = await agents.claimNextSession('recovery-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await agents.finishSession(queued.sessionId, 'recovery-worker', {
      status: 'failed',
      expectedAttempt: claimed!.attempt,
    });
    await pool.query(
      'UPDATE pbl_v3_studies SET evaluation=$2,environment_checked_at=NULL WHERE id=$1',
      [
        study.id,
        JSON.stringify({
          id: randomUUID(),
          fingerprint: 'old',
          stageKey: 'greeting:0',
          startedAt: new Date().toISOString(),
        }),
      ],
    );
    mocked.missing.add(env);
    await rm(join(mocked.root, env), { recursive: true });
    const expired = await learningView(principal, study.id);
    expect(expired.environment).toEqual({ state: 'destroyed', ready: false });
    expect(expired.evaluation?.state).toBe('unavailable');
    expect(expired.id).toBe(study.id);
    const creates = mocked.creates.length;
    mocked.failImport = true;
    try {
      await expect(study.send('prepare')).rejects.toThrow('Interrupted restore');
    } finally {
      mocked.failImport = false;
    }
    const pending = await store.get(study.id, principal.ownerId);
    expect(pending.environment_id).toBe(env);
    const allocated = pending.environment_recovery!.requestId;
    expect(allocated).not.toBe(env);
    const restore = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'importWorkspace');
    try {
      const inspection = await service.reconcile(allocated, false);
      expect(inspection.workspaceReady).toBe(false);
      await learningView(principal, study.id);
      expect(restore).not.toHaveBeenCalled();
    } finally {
      restore.mockRestore();
    }
    await study.send('prepare'); // different browser command ID after reload, same allocation
    const recovered = await store.get(study.id, principal.ownerId);
    expect(recovered.environment_id).toBe(allocated);
    expect(recovered.evaluation).toBeNull();
    expect(mocked.creates.slice(creates)).toEqual([allocated]);
    expect(await service.readText(allocated, 'PLAN.md')).toBe('Saved plan');
    expect((await learningView(principal, study.id)).recovery?.checkpointRevision).toBe(1);
    expect(
      (
        await pool.query('SELECT * FROM sandbox_session_grants WHERE session_id=$1', [
          queued.sessionId,
        ])
      ).rowCount,
    ).toBe(0);
    await study.send('prepare');
    expect(mocked.creates.slice(creates)).toEqual([allocated]);
  });
  it('surfaces source-policy errors while keeping provider listing failures recoverable', async () => {
    const study = await freshStudy();
    const before = await store.get(study.id, principal.ownerId);
    const creates = mocked.creates.length;
    const selectedProject = vi.spyOn(catalog, 'installedProject').mockReturnValue({
      ...project,
      sourceRoots: ['src'],
    });
    const listing = vi
      .spyOn(SandboxService.prototype, 'listFiles')
      .mockResolvedValue(
        Array.from({ length: 257 }, (_, i) => ({ path: `src/${i}.py`, bytes: 0 })),
      );
    try {
      await expect(learningView(principal, study.id)).rejects.toMatchObject({
        code: 'SANDBOX_INVALID_REQUEST',
        status: 400,
        reason: 'PBL_SOURCE_COUNT',
      });
      selectedProject.mockReturnValue({
        ...project,
        sourceRoots: undefined,
        files: { '../outside.py': '' },
      });
      await expect(learningView(principal, study.id)).rejects.toMatchObject({
        code: 'SANDBOX_INVALID_REQUEST',
        reason: 'PBL_SOURCE_PATH',
      });
      selectedProject.mockReturnValue({ ...project, sourceRoots: ['src'] });
      // Structured provider failures still preserve progress instead of escaping the view.
      listing.mockRejectedValueOnce(new SandboxError('SANDBOX_UNAVAILABLE', 503, 'Unavailable'));
      const unavailable = await learningView(principal, study.id);
      expect(unavailable.environment).toEqual({ state: 'unknown', ready: false });
      expect(unavailable.id).toBe(study.id);
      expect(unavailable.state).toEqual(before.state);

      listing.mockResolvedValue([{ path: 'src/main.py', bytes: 0 }]);
      const ready = await learningView(principal, study.id);
      expect(ready.environment).toEqual({ state: 'running', ready: true });
      expect(ready.files).toEqual(['src/main.py']);
      expect(mocked.creates.length).toBe(creates);
      const after = await store.get(study.id, principal.ownerId);
      expect(after.environment_id).toBe(before.environment_id);
      expect(after.revision).toBe(before.revision);
      expect(after.state).toEqual(before.state);
    } finally {
      selectedProject.mockRestore();
      listing.mockRestore();
    }
  });
  it('keeps uncertain environments readable and never replaces them on a provider error', async () => {
    const study = await freshStudy();
    const before = await store.get(study.id, principal.ownerId);
    const creates = mocked.creates.length;
    mocked.failInspect = true;
    try {
      expect((await learningView(principal, study.id)).environment).toEqual({
        state: 'unknown',
        ready: false,
      });
      await expect(study.send('prepare')).rejects.toThrow('Provider unavailable');
    } finally {
      mocked.failInspect = false;
    }
    expect(mocked.creates.length).toBe(creates);
    expect((await store.get(study.id, principal.ownerId)).environment_id).toBe(
      before.environment_id,
    );
  });
  it('can restart an expired workspace without a checkpoint and reports that data loss', async () => {
    const study = await freshStudy();
    const before = await store.get(study.id, principal.ownerId);
    const env = before.environment_id!;
    mocked.missing.add(env);
    await rm(join(mocked.root, env), { recursive: true });
    await study.send('prepare');
    const view = await learningView(principal, study.id);
    expect(view.environment?.ready).toBe(true);
    expect(view.environmentId).not.toBe(env);
    expect(view.recovery?.checkpointRevision).toBe(0);
    const service = await SandboxService.forOwner(principal);
    expect(await service.readText(view.environmentId!, 'greeting.py')).toBe(
      project.files['greeting.py'],
    );
  });
  it('does not allocate twice when creation is uncertain and later discovered', async () => {
    const study = await freshStudy();
    const before = await store.get(study.id, principal.ownerId);
    mocked.missing.add(before.environment_id!);
    const creates = mocked.creates.length;
    mocked.loseCreateAck = mocked.hideDiscovery = true;
    try {
      await expect(study.send('prepare')).rejects.toThrow('Prepare or recover');
      await expect(study.send('prepare')).rejects.toThrow('Prepare or recover');
      expect(mocked.creates.length).toBe(creates + 1);
    } finally {
      mocked.loseCreateAck = mocked.hideDiscovery = false;
    }
    await study.send('prepare');
    expect(mocked.creates.length).toBe(creates + 1);
    expect((await learningView(principal, study.id)).environment?.ready).toBe(true);
  });

  it.each(
    (['missing', 'running', 'unknown'] as const).flatMap((buildState) =>
      (['displayed', 'crash'] as const).map((receipt) => ({ buildState, receipt })),
    ),
  )(
    'hands a $buildState build back with a $receipt receipt without unlocking advancement',
    async ({ buildState, receipt }) => {
      const codeStage = project.definition.milestones[0]!.stages[3]!;
      if (codeStage.kind !== 'produce') throw new Error('Expected code stage');
      const beforeRequired = codeStage.compileBeforeReview,
        beforeBuild = project.buildCommand;
      onTestFinished(() => {
        codeStage.compileBeforeReview = beforeRequired;
        project.buildCommand = beforeBuild;
      });
      codeStage.compileBeforeReview = true;
      project.buildCommand = 'python3 -m py_compile greeting.py';
      const study = await freshStudy();
      onTestFinished(async () => {
        const own = await store.get(study.id, principal.ownerId);
        await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
          own.environment_id,
        ]);
      });
      const row = await store.get(study.id, principal.ownerId);
      row.state.position.stageIndex = 3;
      row.state.milestones[0]!.stageIndex = 3;
      await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
      const queued = (await study.send('chat')) as {
        sessionId: string;
      };
      const claimed = await agents.claimNextSession('blocked-build-worker', process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const request = {
        sessionId: queued.sessionId,
        ownerId: principal.ownerId,
        workerId: 'blocked-build-worker',
        attempt: claimed!.attempt,
        signal: new AbortController().signal,
      };
      const config = await teachingRunnerConfig(request);
      await invoke(config, 'read_next_skill');
      await expect(
        invoke(config, 'request_skill_review', { question: 'Approve this code?' }),
      ).rejects.toThrow('successful build');
      let restoreCommand: (() => void) | undefined;
      if (buildState !== 'missing') {
        await invoke(config, 'run_build');
        const pending = (await store.get(study.id, principal.ownerId)).evaluation!;
        await pool.query(
          "UPDATE sandbox_commands SET result_json=jsonb_set(result_json,'{state}',to_jsonb($3::text)) WHERE environment_id=$1 AND id=$2",
          [row.environment_id, pending.id, buildState],
        );
        const original = E2BCompatibleSandboxProvider.prototype.readCommand;
        const observation = vi
          .spyOn(E2BCompatibleSandboxProvider.prototype, 'readCommand')
          .mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
            const result = await original.apply(this, args);
            return args[2] === pending.id ? { ...result, state: buildState } : result;
          });
        restoreCommand = () => observation.mockRestore();
        onTestFinished(restoreCommand);
        const service = await SandboxService.forOwner(principal);
        await expect(service.assertWorkspaceIdle(row.environment_id!)).rejects.toThrow();
      }
      const question = 'Which build requirement should we clarify?';
      if (buildState === 'missing' && receipt === 'displayed') {
        await pool.query(`CREATE FUNCTION reject_handoff_event() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'handoff event write failed'; END $$`);
        await pool.query(`CREATE TRIGGER reject_handoff_event BEFORE INSERT ON agent_session_events
          FOR EACH ROW WHEN (NEW.type='pbl_learner_handoff') EXECUTE FUNCTION reject_handoff_event()`);
        try {
          await expect(invoke(config, 'request_learner_help', { question })).rejects.toThrow(
            'handoff event write failed',
          );
          expect((await store.binding(queued.sessionId))!.guided?.handoff).toBeUndefined();
          expect(
            (await agents.readEventsAfter(queued.sessionId, 0, 1000)).some(
              (event) => event.type === 'pbl_learner_handoff',
            ),
          ).toBe(false);
        } finally {
          await pool.query('DROP TRIGGER reject_handoff_event ON agent_session_events');
          await pool.query('DROP FUNCTION reject_handoff_event()');
        }
        expect(config.isTurnComplete()).toBe(false);
        await invoke(config, 'read_next_skill');
        expect((await store.binding(queued.sessionId))!.guided?.handoff).toBeUndefined();
      }
      await invoke(config, 'request_learner_help', {
        question,
      });
      // The durable handoff precedes its tool display event, just like a review.
      const beforeDisplay = await learningEvidence(principal, study.id);
      expect(beforeDisplay.conversations.flatMap((c) => c.messages)).toContainEqual(
        expect.objectContaining({ role: 'assistant', text: question }),
      );
      const handoff = (await agents.readEventsAfter(queued.sessionId, 0, 1000)).find(
        (event) => event.type === 'pbl_learner_handoff',
      )!;
      expect(handoff.data).toMatchObject({ question, toolCallId: expect.any(String) });
      if (receipt === 'displayed') {
        await agents.appendControlEvent(queued.sessionId, {
          ts: Date.now(),
          type: 'tool_execution_end',
          data: {
            toolName: 'request_learner_help',
            toolCallId: (handoff.data as { toolCallId: string }).toolCallId,
            isError: false,
            result: { content: [{ type: 'text', text: JSON.stringify({ question }) }] },
          },
        });
        await agents.appendControlEvent(queued.sessionId, {
          ts: Date.now(),
          type: 'tool_execution_end',
          data: {
            toolName: 'request_learner_help',
            isError: true,
            result: {
              content: [{ type: 'text', text: JSON.stringify({ question: 'FAILED QUESTION' }) }],
            },
          },
        });
      }
      const displayed = await learningEvidence(principal, study.id);
      expect(
        displayed.conversations.flatMap((c) => c.messages).filter((m) => m.text === question),
      ).toHaveLength(1);
      expect(JSON.stringify(displayed)).not.toContain('FAILED QUESTION');
      expect(config.isTurnComplete()).toBe(true);
      expect(config.needsTurnReceipt()).toBe(false);
      const guided = (await store.binding(queued.sessionId))!.guided!;
      expect(guided.pending).toBeUndefined();
      expect(guided.coverage).toBeUndefined();
      expect(guided.handoff?.question).toContain('build requirement');
      await expect(
        invoke(config, 'complete_stage', {
          studentFeedback: 'This is not approval.',
          reuseFeedback: true,
        }),
      ).rejects.toThrow();
      if (receipt === 'crash') {
        await agents.releaseLease(queued.sessionId, 'blocked-build-worker');
        const recovery = await agents.claimNextSession('handoff-recovery', process.pid, {
          sessionId: queued.sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
        expect(recovery).toBeTruthy();
        const calls = mocked.modelCalls;
        await runSession({ running: new Map(), shuttingDown: false }, recovery!);
        expect(mocked.modelCalls).toBe(calls);
        expect(
          (await agents.readEventsAfter(queued.sessionId, 0, 1000)).some(
            (event) => event.type === 'tool_execution_end',
          ),
        ).toBe(false);
      } else {
        await agents.finishSession(queued.sessionId, 'blocked-build-worker', {
          status: 'succeeded',
          expectedAttempt: claimed!.attempt,
        });
      }
      const view = await learningView(principal, study.id, { passive: true });
      expect(view.roleRun).toMatchObject({ status: 'succeeded', canRetry: false });
      expect(view.actions).not.toContain('next');
      expect(JSON.stringify(view.conversation)).toContain('Which build requirement');
      if (receipt === 'displayed')
        expect((await teachingRunnerConfig(request)).isTurnComplete()).toBe(true);
      const current = await (
        await SandboxService.forOwner(principal)
      ).readText(row.environment_id!, 'greeting.py');
      const save = async () =>
        commandStudy(principal, study.id, {
          id: randomUUID(),
          revision: (await store.get(study.id, principal.ownerId)).revision,
          type: 'save',
          path: 'greeting.py',
          expectedHash: digest(current),
          text: current + '\n# learner can still edit\n',
        });
      if (restoreCommand) {
        await expect(save()).rejects.toThrow();
        restoreCommand();
        await study.send('collect');
      }
      await save();
      await expect(study.send('next')).rejects.toThrow();
      await study.send('chat');
      const follow = await agents.claimNextSession('blocked-build-followup', process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      const resumed = await teachingRunnerConfig({
        ...request,
        workerId: 'blocked-build-followup',
        attempt: follow!.attempt,
      });
      await expect(
        invoke(resumed, 'read_next_skill', {
          studentFeedback: 'Help is not review feedback.',
          reuseFeedback: true,
        }),
      ).rejects.toThrow();
      await invoke(resumed, 'run_build');
      await invoke(resumed, 'collect_build');
      await invoke(resumed, 'request_skill_review', { question: 'Now review the compiled code.' });
      await agents.finishSession(queued.sessionId, 'blocked-build-followup', {
        status: 'succeeded',
        expectedAttempt: follow!.attempt,
      });
      const answered = await learningEvidence(principal, study.id);
      const answeredMessages = answered.conversations.flatMap((c) => c.messages);
      expect(answeredMessages.filter((message) => message.text === question)).toHaveLength(1);
      expect(answeredMessages.findIndex((message) => message.text === question)).toBeLessThan(
        answeredMessages.findLastIndex((message) => message.role === 'user'),
      );
      expect(answered.conversations.flatMap((c) => c.messages)).toContainEqual(
        expect.objectContaining({ role: 'user', text: 'Please start.' }),
      );
    },
  );
  it.each(['compile', 'infrastructure'] as const)(
    'keeps %s assessment failure repairable without abandoning the test step',
    async (kind) => {
      const previousStudyId = studyId;
      const previousBuild = project.buildCommand;
      const previousEvaluation = project.evaluations.greeting!;
      onTestFinished(() => {
        studyId = previousStudyId;
        project.buildCommand = previousBuild;
        project.evaluations.greeting = previousEvaluation;
      });
      studyId = (await freshStudy()).id;
      let row = await store.get(studyId, principal.ownerId);
      row.state.position.stageIndex = 4;
      row.state.milestones[0]!.stageIndex = 4;
      await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
      project.buildCommand = 'python3 -m py_compile greeting.py';
      project.evaluations.greeting = {
        ...previousEvaluation,
        prepare:
          kind === 'compile'
            ? ['python3', '-m', 'py_compile', 'greeting.py']
            : ['python3', '-c', 'raise RuntimeError("PRIVATE_FIXTURE")'],
      };
      const service = await SandboxService.forOwner(principal);
      const file = join(mocked.root, row.environment_id!, 'greeting.py');
      await writeFile(file, 'def greet(name)\n    return ""\n');
      await command('evaluate');
      expect((await workbenchView(principal, studyId)).canEdit).toBe(false);
      await command('collect');
      const view = await learningView(principal, studyId);
      expect(view.environment?.ready).toBe(true);
      expect(view.state.status).not.toBe('failed');
      expect(view.state.collected.greeting!.tests).toMatchObject({
        status: kind === 'compile' ? 'failed' : 'error',
        failureKind: kind,
      });
      expect(view.state.collected.greeting!.remediation?.kind).toBe(
        kind === 'compile' ? 'implementation_repair' : 'evaluation_recovery',
      );
      expect(view.actions).toEqual(expect.arrayContaining(['chat', 'edit', 'evaluate']));
      expect(view.actions).not.toContain('next');
      expect((await workbenchView(principal, studyId)).canEdit).toBe(true);
      await expect(command('next')).rejects.toThrow('not available');
      // A real learner edit remains possible after an unreliable assessment.
      const original = await service.readText(row.environment_id!, 'greeting.py');
      await command('save', {
        path: 'greeting.py',
        expectedHash: digest(original),
        text: original + '# learner inspection\n',
      });
      await runTools('Please help inspect this assessment problem.', async (config) => {
        if (kind === 'infrastructure')
          expect(config.systemPrompt).toContain('not confirmed learner error');
        const failedBuild = await invoke(config, 'run_build');
        expect(failedBuild).toBeDefined();
        const collected = await invoke(config, 'collect_build');
        const failedContent = collected.content[0]!;
        if (failedContent.type !== 'text') throw new Error('Expected a build receipt');
        expect(JSON.parse(failedContent.text)).toMatchObject({ passed: false });
        const current = await service.readText(row.environment_id!, 'greeting.py');
        await invoke(config, 'write_file', {
          path: 'greeting.py',
          expectedHash: digest(current),
          text: 'def greet(name): return f"Hello, {name}!"\n',
        });
        await invoke(config, 'run_build');
        const passedContent = (await invoke(config, 'collect_build')).content[0]!;
        if (passedContent.type !== 'text') throw new Error('Expected a build receipt');
        expect(JSON.parse(passedContent.text)).toMatchObject({
          passed: true,
        });
      });
      project.evaluations.greeting = previousEvaluation;
      await command('evaluate');
      await command('collect');
      row = await store.get(studyId, principal.ownerId);
      expect(row.state.position.stageIndex).toBe(4);
      expect(row.state.collected.greeting!.tests?.status).toBe('passed');
      expect(row.state.collected.greeting!.remediation).toBeNull();
    },
    // Allocation, PG round trips and four real subprocesses need the bounded integration budget.
    60000,
  );
  it('does not relabel a healthy workspace as unavailable when reading test progress fails', async () => {
    const study = await freshStudy();
    const row = await store.get(study.id, principal.ownerId);
    row.state.position.stageIndex = 4;
    row.state.milestones[0]!.stageIndex = 4;
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    await study.send('evaluate');
    const observation = vi
      .spyOn(SandboxService.prototype, 'command')
      .mockRejectedValueOnce(new Error('Transient command query failure'));
    let view;
    try {
      view = await learningView(principal, study.id);
    } finally {
      observation.mockRestore();
    }
    expect(view.environment).toEqual({ state: 'running', ready: true });
    expect(view.evaluation?.state).toBe('unavailable');
    // Unknown execution state is not permission to edit concurrently with a possible writer.
    expect((await workbenchView(principal, study.id)).canEdit).toBe(false);
    await study.send('collect');
    expect((await workbenchView(principal, study.id)).canEdit).toBe(true);
  });
  it('locks failed-test repair writes until collection while retaining the same test step', async () => {
    const study = await freshStudy();
    let row = await store.get(study.id, principal.ownerId);
    row.state.position.stageIndex = 4;
    row.state.milestones[0]!.stageIndex = 4;
    row.state.collected.greeting!.remediation = {
      id: randomUUID(),
      kind: 'implementation_repair',
      target: 'coder',
      reason: 'tests',
      attempt: 1,
      evaluationId: randomUUID(),
    };
    row.evaluation = {
      id: randomUUID(),
      fingerprint: 'pending',
      stageKey: stageKey(row),
      startedAt: new Date().toISOString(),
    };
    row = await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    const service = await SandboxService.forOwner(principal);
    const original = await service.readText(row.environment_id!, 'greeting.py');
    const save = async () =>
      commandStudy(principal, study.id, {
        id: randomUUID(),
        revision: (await store.get(study.id, principal.ownerId)).revision,
        type: 'save',
        path: 'greeting.py',
        text: original + '# learner repair\n',
        expectedHash: digest(original),
      });
    expect(await workbenchView(principal, study.id)).toMatchObject({
      canEdit: false,
      editReason: 'testing',
    });
    await expect(save()).rejects.toMatchObject({ reason: 'WORKBENCH_ACCESS_DENIED' });
    expect(await service.readText(row.environment_id!, 'greeting.py')).toBe(original);
    row = await store.get(study.id, principal.ownerId);
    row.evaluation = null;
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    expect(await workbenchView(principal, study.id)).toMatchObject({ canEdit: true });
    await expect(save()).resolves.toBeDefined();
    const view = await learningView(principal, study.id);
    expect(view.state.position.stageIndex).toBe(4);
    expect(view.role).toBe('coder');
    expect(await service.readText(row.environment_id!, 'greeting.py')).toBe(
      original + '# learner repair\n',
    );
  });
  it('integrates scoped files, command evidence, terminal controls and recovery without project previews', async () => {
    const fresh = await freshStudy();
    let row = await store.get(fresh.id, principal.ownerId);
    const environmentId = row.environment_id!;
    const sandbox = await SandboxService.forOwner(principal);
    const send = async (action: string, payload: Record<string, unknown> = {}) =>
      workbenchCommand(principal, row.id, {
        id: randomUUID(),
        revision: (await store.get(row.id, principal.ownerId)).revision,
        environmentId,
        epoch: await sandbox.workspaceEpoch(environmentId),
        action,
        ...payload,
      });
    await expect(send('run', { text: 'echo forbidden' })).rejects.toThrow('teaching review');
    row.state.position.stageIndex = 3;
    row.state.milestones[0]!.stageIndex = 3;
    row.state.collected.greeting!.codeReviewCompleted = true;
    row = await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    const originalRoots = project.sourceRoots;
    project.sourceRoots = ['src'];
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'local-secret-'.repeat(4));
    vi.stubEnv('OPENMAIC_PREVIEW_GATEWAY_KEY', 'local-gateway-'.repeat(4));
    vi.stubEnv('OPENMAIC_APP_ORIGIN', 'https://app.example.com');
    vi.stubEnv('OPENMAIC_SANDBOX_PREVIEW_ORIGIN', 'https://{id}.preview-example.net');
    try {
      await expect(
        workbenchCommand({ ...principal, ownerId: 'other' }, row.id, {
          id: randomUUID(),
          revision: row.revision,
          environmentId,
          action: 'stop',
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(send('create', { path: 'tests/private.py', text: '' })).rejects.toThrow();
      await send('create', { path: 'src/new.py', text: 'print("hello")' });
      expect(
        (await store.get(row.id, principal.ownerId)).state.collected.greeting!.codeReviewCompleted,
      ).toBe(false);
      expect((await learningView(principal, row.id)).files).toContain('src/new.py');
      await expect(
        send('delete', { path: 'src/new.py', expectedHash: digest('wrong') }),
      ).rejects.toThrow('changed');
      await send('rename', {
        path: 'src/new.py',
        destination: 'src/moved.py',
        expectedHash: digest('print("hello")'),
      });
      await expect(send('delete', { path: 'PLAN.md', expectedHash: digest('') })).rejects.toThrow(
        'plan',
      );
      const result = await send('run', { text: 'python3 src/moved.py' });
      expect(result).toMatchObject({ state: 'exited', stdout: 'hello\n', exitCode: 0 });
      const terminal = (await send('terminal')) as { id: string };
      await send('input', { terminalId: terminal.id, data: 'echo hello\n', revision: 0 });
      expect(mocked.inputs.at(-1)).toBe('echo hello\n');
      let unlock!: () => void, locked!: () => void;
      const entered = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const lock = store.exclusive(row.id, async () => {
        locked();
        await new Promise<void>((resolve) => {
          unlock = resolve;
        });
      });
      await entered;
      try {
        await expect(
          send('input', { terminalId: terminal.id, data: 'x', revision: 0 }),
        ).resolves.toEqual({ accepted: true });
        expect(mocked.inputs.at(-1)).toBe('x');
      } finally {
        unlock();
        await lock;
      }

      await expect(fresh.send('checkpoint')).rejects.toThrow();
      await expect(send('preview', { port: 8000 })).rejects.toThrow('Unknown workbench operation');
      const busyTurn = (await fresh.send('chat')) as { sessionId: string };
      const worker = await agents.claimNextSession('preview-test-worker', process.pid, {
        sessionId: busyTurn.sessionId,
        leaseTtlMs: 30000,
        maxAttempts: 5,
      });
      const busyView = await workbenchView(principal, row.id);
      expect(busyView.canRun).toBe(false);
      expect(busyView.canEdit).toBe(false);
      expect(busyView.editReason).toBe('agent');
      expect(busyView).not.toHaveProperty('canPreview');
      expect(busyView).not.toHaveProperty('ports');
      await expect(
        send('input', { terminalId: terminal.id, data: 'forbidden' }),
      ).rejects.toMatchObject({ reason: 'WORKBENCH_ACCESS_DENIED' });
      await agents.finishSession(busyTurn.sessionId, 'preview-test-worker', {
        status: 'succeeded',
        expectedAttempt: worker!.attempt,
      });

      const oldGrant = new URL(
        issuePreviewGrant({ ownerId: principal.ownerId, environmentId, port: 8000, epoch: 0 }).url,
      );
      await expect(
        SandboxService.previewTarget(oldGrant.hash.slice(1), oldGrant.host),
      ).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
      const unsupportedScoped = new URL(
        issuePreviewGrant({
          ownerId: principal.ownerId,
          environmentId,
          port: 8000,
          epoch: 0,
          ...{ studyId: row.id },
        }).url,
      );
      await expect(
        SandboxService.previewTarget(unsupportedScoped.hash.slice(1), unsupportedScoped.host),
      ).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
      await store.exclusive(row.id, () => send('stop', { revision: 0 }));
      expect((await workbenchView(principal, row.id)).terminals[0]?.state).toBe('closed');
      await fresh.send('checkpoint');
      mocked.missing.add(environmentId);
      await fresh.send('prepare');
      const restored = await store.get(row.id, principal.ownerId);
      expect(restored.environment_id).not.toBe(environmentId);
      expect(
        await (
          await SandboxService.forOwner(principal)
        ).readText(restored.environment_id!, 'src/moved.py'),
      ).toBe('print("hello")');
      await expect(send('run', { text: 'echo old' })).rejects.toThrow('changed');
    } finally {
      project.sourceRoots = originalRoots;
    }
  }, 30000);

  it.each(['run', 'terminal'] as const)(
    'fences an admitted %s that reaches creation after Stop has succeeded',
    async (action) => {
      vi.stubEnv('OPENMAIC_SECRET_KEY', 'local-secret-'.repeat(4));
      vi.stubEnv('OPENMAIC_PREVIEW_GATEWAY_KEY', 'local-gateway-'.repeat(4));
      vi.stubEnv('OPENMAIC_APP_ORIGIN', 'https://app.example.com');
      vi.stubEnv('OPENMAIC_SANDBOX_PREVIEW_ORIGIN', 'https://{id}.preview-example.net');
      const fresh = await freshStudy();
      let row = await store.get(fresh.id, principal.ownerId);
      row.state.position.stageIndex = 3;
      row.state.milestones[0]!.stageIndex = 3;
      row = await store.transaction((db) =>
        store.commit(db, row, { state: row.state, events: [] }),
      );
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pause = async () => {
        entered();
        await gate;
      };
      const originalCommand = SandboxStore.prototype.reserveCommand;
      const originalTerminal = SandboxStore.prototype.reserveTerminal;
      const spy =
        action === 'run'
          ? vi.spyOn(SandboxStore.prototype, 'reserveCommand').mockImplementation(async function (
              this: SandboxStore,
              ...args
            ) {
              await pause();
              return originalCommand.apply(this, args);
            })
          : vi.spyOn(SandboxStore.prototype, 'reserveTerminal').mockImplementation(async function (
              this: SandboxStore,
              ...args
            ) {
              await pause();
              return originalTerminal.apply(this, args);
            });
      const request = {
        id: randomUUID(),
        revision: row.revision,
        environmentId: row.environment_id!,
        epoch: 0,
        action,
        text: 'echo should-not-start',
        port: 8000,
      };
      const pending = workbenchCommand(principal, row.id, request);
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await ready;
        await expect(
          workbenchCommand(principal, row.id, {
            ...request,
            id: randomUUID(),
            action: 'stop',
            revision: 0,
          }),
        ).resolves.toEqual({ stopped: true });
        release();
        expect(await outcome).toMatchObject({ error: { reason: 'WORKSPACE_STOPPED' } });
        const service = await SandboxService.forOwner(principal);
        expect(await service.listCommands(row.environment_id!)).toEqual([]);
        expect(await service.listTerminals(row.environment_id!)).toEqual([]);
        // Also reject an old submission that only reaches the server after Stop.
        await expect(
          workbenchCommand(principal, row.id, {
            ...request,
            id: randomUUID(),
            revision: (await store.get(row.id, principal.ownerId)).revision,
          }),
        ).rejects.toMatchObject({ reason: 'WORKSPACE_STOPPED' });
      } finally {
        release();
        await outcome;
        spy.mockRestore();
      }
    },
  );

  it('admits different learners independently and fails busy requests without exhausting PG', async () => {
    const first = await freshStudy(),
      second = await freshStudy();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const held = store.exclusive(first.id, async () => {
      entered();
      await gate;
    });
    await ready;
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 24 }, () => first.send('checkpoint')),
      );
      expect(outcomes.every((r) => r.status === 'rejected')).toBe(true);
      await expect(second.send('checkpoint')).resolves.toBeDefined();
      expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    } finally {
      release();
      await held;
    }
    await expect(first.send('checkpoint')).resolves.toBeDefined();
  }, 10000);

  it.each(['greeting-python-lab', 'greeting-java'])(
    'runs an unregistered imported %s course from pinned resources after its scene changes',
    async (projectId) => {
      const selected = installedProject({ id: projectId, version: '1.1.0' });
      const bundle = packageBuiltin(selected);
      const descriptor: ProjectDescriptor = JSON.parse(bundle.files['project.json']);
      const importedId = `imported-${projectId}`;
      descriptor.id = descriptor.definition.id = importedId;
      for (const role of ['mentor', 'discussion', 'planner', 'coder'] as const)
        descriptor.definition.agents[role].systemPrompt = 'Help me with this course task.';
      for (const binding of descriptor.teaching) {
        bundle.files[binding.entrypoint] = `PACKAGED SKILL ${binding.stage}`;
        for (const document of binding.documents)
          bundle.files[document] = `PACKAGED REFERENCE ${binding.stage}`;
      }
      const java = descriptor.runtime.profile === 'java';
      bundle.files['rubric/expected.txt'] = 'Hello, Ada!\nHello, Lin!\n';
      bundle.files['tests/private.py'] = java
        ? 'import subprocess,sys\nfor name in ["  Ada  ","Lin"]: print(subprocess.run(["java","-cp",sys.argv[1],"Greeting",name],check=True,text=True,stdout=subprocess.PIPE).stdout.strip())\n'
        : 'import pathlib,sys\nsys.path.insert(0,str(pathlib.Path.cwd()/"src"))\nfrom greeting import greet\nfor name in ["  Ada  ","Lin"]: print(greet(name))\n';
      bundle.files['tests/private.json'] = JSON.stringify({
        ...(java ? { prepare: ['javac', '-d', '{build}', 'src/Greeting.java'] } : {}),
        cases: [
          {
            id: 'course-owned-private-check',
            argv: ['python3', '{resources}/tests/private.py', ...(java ? ['{build}'] : [])],
            stdout: 'Hello, Ada!\nHello, Lin!\n',
          },
        ],
      });
      for (const milestone of descriptor.definition.milestones)
        descriptor.runtime.evaluations[milestone.id] = 'tests/private.json';
      bundle.files['project.json'] = JSON.stringify(descriptor);
      const projectRef = await installProjectPackage(
        principal.ownerId,
        indexProjectFiles(importedId, selected.ref.version, bundle.files),
      );
      const stageId = randomUUID();
      const documents = new PgDocumentStore<
        import('@/lib/types/stage').Scene,
        import('@/lib/types/stage').Stage
      >(pool, { withTransaction: (fn) => store.transaction(fn), trackAssetReferences: true });
      await documents.saveDocument({
        stage: { id: stageId, name: 'Imported course', createdAt: 1, updatedAt: 1 },
        scenes: [
          {
            id: 'scene',
            stageId,
            type: 'pbl',
            title: 'Project',
            order: 0,
            content: { type: 'pbl', projectV3: projectRef },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      });
      await claimStageMeta(pool, stageId, principal.ownerId);
      const created = await store.create(
        {
          ownerId: principal.ownerId,
          stageId,
          sceneId: 'scene',
          projectId: importedId,
          version: projectRef.version,
          projectRef,
        },
        startOrchestration(descriptor.definition),
      );
      const originalScene = (await documents.getScene(stageId, 'scene'))!;
      const replacementRef = await installProjectPackage(
        principal.ownerId,
        indexProjectFiles(importedId, selected.ref.version, {
          ...bundle.files,
          'docs/0.md': 'Replacement course introduction; existing learners must keep their pin.',
        }),
      );
      await documents.putScene(stageId, {
        ...originalScene,
        type: 'pbl',
        content: { type: 'pbl', projectV3: replacementRef },
      });
      // The browser reopens by classroom/scene after every refresh, without a study id.
      const reopened = await openStudy(principal, stageId, 'scene');
      expect(reopened.id).toBe(created.id);
      expect(reopened.project_reference).toEqual(projectRef);
      expect(reopened.project?.coursePackage?.descriptor.id).toBe(importedId);
      await expect(
        openStudy({ ...principal, ownerId: 'foreign-owner' }, stageId, 'scene'),
      ).rejects.toMatchObject({ status: 404 });
      await documents.deleteScene(stageId, 'scene');
      expect((await openStudy(principal, stageId, 'scene')).id).toBe(created.id);
      const lookup = vi.spyOn(catalog, 'installedProject');
      onTestFinished(() => lookup.mockRestore());
      const reloaded = await new LearningStore(pool).get(created.id, principal.ownerId);
      expect(reloaded.project_reference).toEqual(projectRef);
      expect(reloaded.project?.coursePackage?.descriptor.id).toBe(importedId);
      expect(reloaded.project?.files).toEqual(selected.files);
      const send = async (type: string, payload: Record<string, unknown> = {}) =>
        commandStudy(principal, created.id, {
          id: randomUUID(),
          revision: (await store.get(created.id, principal.ownerId)).revision,
          type,
          ...payload,
        });
      let oversizedPlanChecked = false;
      let longReplyChecked = false;
      let oversizedQuestionChecked = false;
      let oversizedPlanWriteChecked = false;
      let oversizedPlanSaveChecked = false;
      const turn = async (
        text: string,
        run: (config: Awaited<ReturnType<typeof teachingRunnerConfig>>) => Promise<void>,
      ) => {
        const queued = (await send('chat', { text })) as { sessionId: string };
        const claimed = await agents.claimNextSession('package-worker', process.pid, {
          sessionId: queued.sessionId,
          leaseTtlMs: 30000,
          maxAttempts: 5,
        });
        expect(claimed).toBeTruthy();
        const request = {
          sessionId: queued.sessionId,
          ownerId: principal.ownerId,
          workerId: 'package-worker',
          attempt: claimed!.attempt,
          signal: new AbortController().signal,
        };
        const current = await store.get(created.id, principal.ownerId);
        const active = stageFor(current);
        if (!oversizedPlanChecked && 'reads' in active && active.reads.includes('plan')) {
          const path = join(mocked.root, current.environment_id!, 'PLAN.md');
          const original = await readFile(path, 'utf8');
          const calls = mocked.modelCalls;
          try {
            await writeFile(path, 'Learner plan '.repeat(4000));
            const expanded = await teachingRunnerConfig(request);
            expect(expanded.systemPrompt).toContain('Learner plan '.repeat(4000));
            expect(mocked.modelCalls).toBe(calls);
            oversizedPlanChecked = true;
          } finally {
            await writeFile(path, original);
          }
        }
        const config = await teachingRunnerConfig(request);
        await run(config);
        const inputs = await agents.listUserMessages(queued.sessionId);
        await agents.markUserMessageDelivered(
          queued.sessionId,
          'package-worker',
          claimed!.attempt,
          inputs.at(-1)!.seq,
        );
        await agents.finishSession(queued.sessionId, 'package-worker', {
          status: 'succeeded',
          expectedAttempt: claimed!.attempt,
        });
      };
      await send('prepare');
      const service = await SandboxService.forOwner(principal);
      const environmentId = (await store.get(created.id, principal.ownerId)).environment_id!;
      for (const [path, text] of Object.entries(selected.files))
        expect(await service.readText(environmentId, path)).toBe(text);
      expect(await service.listFiles(environmentId)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'tests/private.py' })]),
      );
      let evaluations = 0;
      while ((await store.get(created.id, principal.ownerId)).state.status !== 'completed') {
        const row = await store.get(created.id, principal.ownerId),
          stage = stageFor(row),
          key = stageKey(row);
        const milestone = descriptor.definition.milestones[row.state.position.milestoneIndex]!;
        if (stage.kind === 'mentor_say' || stage.kind === 'produce') {
          if (stage.kind === 'produce' && stage.writes === 'plan' && !oversizedPlanSaveChecked) {
            const original = await service.readText(environmentId, 'PLAN.md');
            await expect(
              send('save', {
                path: 'PLAN.md',
                text: original + '\n' + 'Learner plan '.repeat(4000),
                expectedHash: digest(original),
              }),
            ).resolves.toBeDefined();
            const expanded = await service.readText(environmentId, 'PLAN.md');
            expect(expanded).toContain('Learner plan '.repeat(4000));
            await send('save', { path: 'PLAN.md', text: original, expectedHash: digest(expanded) });
            oversizedPlanSaveChecked = true;
          }
          const teaching = descriptor.teaching.find((binding) => binding.stage === key)!;
          const welcome =
            row.state.position.milestoneIndex === 0 && row.state.position.stageIndex === 0;
          if (welcome)
            await turn('Introduce the project.', async (config) => {
              const opening = JSON.stringify(await invoke(config, 'read_next_skill'));
              expect(opening).not.toContain(`PACKAGED SKILL ${key}`);
              expect(config.systemPrompt).not.toContain(`PACKAGED REFERENCE ${key}`);
              await invoke(config, 'request_skill_review', { question: 'Ready to begin?' });
            });
          for (let part = 0; part < teaching.sections.length; part++) {
            if (part === 1 && !longReplyChecked) {
              const longReply = 'My explanation of this course section. '.repeat(1500);
              await turn(longReply, async (config) => {
                expect(config.systemPrompt).not.toContain(longReply);
                expect(config.liveContext()).toContain('"studentResponseCount":1');
              });
              longReplyChecked = true;
            }
            await turn(
              part
                ? 'I reviewed this section.'
                : welcome
                  ? 'Ready, begin teaching.'
                  : 'Please start.',
              async (config) => {
                const section = await invoke(config, 'read_next_skill', {
                  ...(part
                    ? { studentFeedback: 'I reviewed this section.' }
                    : welcome
                      ? { studentFeedback: 'The learner is ready to begin.' }
                      : {}),
                });
                expect(JSON.stringify(section)).toContain(`PACKAGED SKILL ${key}`);
                if (welcome && part === 0)
                  expect(JSON.stringify(section)).toContain(`PACKAGED REFERENCE ${key}`);
                else expect(config.systemPrompt).toContain(`PACKAGED REFERENCE ${key}`);
                if (part === 0 && stage.kind === 'produce') {
                  const path =
                    stage.writes === 'plan'
                      ? 'PLAN.md'
                      : java
                        ? 'src/Greeting.java'
                        : 'src/greeting.py';
                  const original = await service.readText(environmentId, path);
                  if (stage.writes === 'plan' && !oversizedPlanWriteChecked) {
                    const oversized = original + '\n' + 'Learner plan '.repeat(4000);
                    await expect(
                      invoke(config, 'write_file', {
                        path,
                        text: oversized,
                        expectedHash: digest(original),
                      }),
                    ).resolves.toBeDefined();
                    expect(await service.readText(environmentId, path)).toBe(oversized);
                    await invoke(config, 'write_file', {
                      path,
                      text: original,
                      expectedHash: digest(oversized),
                    });
                    oversizedPlanWriteChecked = true;
                  }
                  await invoke(config, 'write_file', {
                    path,
                    text:
                      stage.writes === 'plan'
                        ? original +
                          `\n## ${milestone.title}\nImplement and review the current task.\n`
                        : java
                          ? 'public class Greeting { public static String greet(String name) { return "Hello, " + name.trim() + "!"; } public static void main(String[] args) { System.out.println(greet(args[0])); } }'
                          : 'def greet(name):\n    return f"Hello, {name.strip()}!"\n',
                    expectedHash: digest(original),
                  });
                  if (stage.compileBeforeReview) {
                    await invoke(config, 'run_build');
                    await invoke(config, 'collect_build');
                  }
                }
                const question = !oversizedQuestionChecked
                  ? 'Explain this section. '.repeat(250)
                  : 'Explain this section.';
                await invoke(config, 'request_skill_review', { question });
                expect(config.isTurnComplete()).toBe(true);
                oversizedQuestionChecked = true;
              },
            );
          }
          await turn('I reviewed this section.', async (config) => {
            await invoke(config, 'complete_stage', { studentFeedback: 'I reviewed this section.' });
          });
          if ((await store.get(created.id, principal.ownerId)).state.status !== 'completed')
            await send('next');
        } else if (stage.kind === 'dialogue') {
          await turn('I understand the course decisions.', async (config) => {
            expect(config.systemPrompt).toContain(`PACKAGED SKILL ${key}`);
            expect(config.systemPrompt).toContain(`PACKAGED REFERENCE ${key}`);
          });
          for (const decisionId of milestone.decisions) {
            const decision = descriptor.definition.decisions.find(
              (item) => item.id === decisionId,
            )!;
            await send('decide', { decisionId, chosen: decision.options[0].id });
          }
          await send('next');
        } else if (stage.kind === 'check' && stage.checker === 'tests') {
          await send('evaluate');
          await send('collect');
          const tested = (await store.get(created.id, principal.ownerId)).state.collected[
            milestone.id
          ]!.tests;
          expect(tested?.status).toBe('passed');
          expect(tested?.publicFeedback).toContain('1 / 1 checks passed');
          evaluations++;
          await send('next');
        } else if (stage.kind === 'check' && stage.checker === 'quiz') {
          await send('quiz', { answers: milestone.quiz.map((question) => question.answer) });
          await send('next');
        } else throw new Error(`Unexpected packaged stage: ${stage.kind}`);
      }
      expect(evaluations).toBe(2);
      expect(oversizedPlanChecked).toBe(true);
      expect(longReplyChecked).toBe(true);
      expect(oversizedQuestionChecked).toBe(true);
      expect(oversizedPlanWriteChecked).toBe(true);
      expect(oversizedPlanSaveChecked).toBe(true);
      const finished = await new LearningStore(pool).get(created.id, principal.ownerId);
      expect(finished.project_reference).toEqual(projectRef);
      expect(finished.project?.coursePackage?.bundle.files['tests/private.py']).toBe(
        bundle.files['tests/private.py'],
      );
      expect(lookup).not.toHaveBeenCalled();
    },
    120000,
  );
  async function ageStudy(id: string) {
    await pool.query(
      "UPDATE pbl_v3_studies SET last_used_at=now()-interval '20 minutes' WHERE id=$1",
      [id],
    );
  }
  // Explicit lifecycle-release intent fixture. Healthy inactivity never creates this intent.
  async function stageExplicitCleanup(id: string, expired = false) {
    await pool.query(
      `UPDATE pbl_v3_studies SET
      last_used_at=clock_timestamp()-($2::double precision*interval '1 millisecond'),
      idle_turn_cleanup=jsonb_build_object('environmentId',environment_id,
        'idleAt',clock_timestamp()::text,
        'releaseAt',(clock_timestamp()+($3::double precision*interval '1 millisecond'))::text)
      WHERE id=$1`,
      [id, pblIdleTimeoutMs() + 30_000, expired ? -60_000 : 300_000],
    );
  }

  it.each(['evaluate', 'compile'] as const)(
    'clears a %s execution whose start failed before command reservation',
    async (type) => {
      const fresh = await freshStudy(
        installedProject({ id: 'greeting-python-lab', version: '1.1.0' }),
      );
      const row = await store.get(fresh.id, principal.ownerId);
      row.state.position.stageIndex = type === 'compile' ? 3 : 4;
      await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
      const reserve = vi
        .spyOn(SandboxStore.prototype, 'reserveCommand')
        .mockRejectedValueOnce(new SandboxError('SANDBOX_BUSY', 429, 'busy'));
      try {
        await expect(fresh.send(type)).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
        const pending = await store.get(fresh.id, principal.ownerId);
        expect(pending.evaluation).not.toBeNull();
        await fresh.send('collect');
        expect((await store.get(fresh.id, principal.ownerId)).evaluation).toBeNull();
        expect((await workbenchView(principal, fresh.id)).canEdit).toBe(true);
      } finally {
        reserve.mockRestore();
      }
    },
  );

  it('bounds repeated idle execution collection failures without renewing forever', async () => {
    const fresh = await freshStudy();
    const row = await store.get(fresh.id, principal.ownerId),
      commandId = randomUUID();
    row.evaluation = {
      id: commandId,
      fingerprint: 'fixture',
      stageKey: stageKey(row),
      startedAt: new Date().toISOString(),
    };
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    await pool.query(
      `INSERT INTO sandbox_commands(environment_id,id,request_fingerprint,result_json,updated_at)
      VALUES($1,$2,'fixture',$3,now()-interval '20 minutes')`,
      [
        row.environment_id,
        commandId,
        JSON.stringify({
          id: commandId,
          state: 'exited',
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
        }),
      ],
    );
    await ageStudy(fresh.id);
    const command = vi
      .spyOn(SandboxService.prototype, 'command')
      .mockRejectedValue(new Error('collection unavailable'));
    try {
      await maintainStudy(store, fresh.id, principal.ownerId);
      const first = (await store.get(fresh.id, principal.ownerId)).checkpoint_failure
        ?.firstIdleFailureAt;
      expect(first).toBeTruthy();
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(
        (await store.get(fresh.id, principal.ownerId)).checkpoint_failure?.firstIdleFailureAt,
      ).toBe(first);
      await expireArchiveGrace(fresh.id);
      const renewals = mocked.renewals.length;
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(mocked.renewals).toHaveLength(renewals);
      expect(
        await (await SandboxService.forOwner(principal)).get(row.environment_id!),
      ).toMatchObject({ state: 'destroyed' });
      expect((await store.get(fresh.id, principal.ownerId)).archive_discard).toBeTruthy();
    } finally {
      command.mockRestore();
    }
  });

  it.each(['activity', 'edit', 'command'] as const)(
    'keeps %s available during periodic upload and fences changed generations',
    async (action) => {
      const fresh = await freshStudy();
      await fresh.send('checkpoint');
      const row = await store.get(fresh.id, principal.ownerId);
      row.state.position.stageIndex = 3;
      await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
      await pool.query(
        "UPDATE pbl_v3_studies SET workspace_dirty_at=now()-interval '2 minutes' WHERE id=$1",
        [fresh.id],
      );
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = E2BCompatibleSandboxProvider.prototype.exportWorkspace;
      const archive = vi
        .spyOn(E2BCompatibleSandboxProvider.prototype, 'exportWorkspace')
        .mockImplementation(async function* (this: E2BCompatibleSandboxProvider, ...args) {
          entered();
          await gate;
          yield* original.apply(this, args);
        });
      const maintaining = maintainStudy(store, fresh.id, principal.ownerId);
      try {
        await ready;
        await store.waitForExclusive(fresh.id, () =>
          store.recordActivity(fresh.id, principal.ownerId),
        );
        if (action === 'edit') {
          const before = await store.get(fresh.id, principal.ownerId);
          const text = await readFile(
            join(mocked.root, row.environment_id!, 'greeting.py'),
            'utf8',
          );
          await commandStudy(principal, fresh.id, {
            id: randomUUID(),
            revision: before.revision,
            type: 'save',
            path: 'greeting.py',
            expectedHash: digest(text),
            text: text + '\n# concurrent editor save\n',
          });
        } else if (action === 'command')
          await pool.query(
            "INSERT INTO sandbox_commands(environment_id,id,request_fingerprint) VALUES($1,$2,'fixture')",
            [row.environment_id, randomUUID()],
          );
        else {
          await maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId);
          expect(archive).toHaveBeenCalledTimes(1);
        }
        release();
        await maintaining;
        expect(
          (await (await SandboxService.forOwner(principal)).checkpoint(row.environment_id!))
            ?.revision,
        ).toBe(action === 'activity' ? 2 : 1);
        expect((await store.get(fresh.id, principal.ownerId)).workspace_dirty_at === null).toBe(
          action === 'activity',
        );
      } finally {
        release();
        await maintaining;
        archive.mockRestore();
      }
    },
  );

  it.each(['size', 'count', 'compile'] as const)(
    'bounds idle collection after a permanent source %s limit and unlocks editing',
    async (limit) => {
      const selected = installedProject({ id: 'greeting-python-lab', version: '1.1.0' });
      const fresh = await freshStudy(selected);
      await fresh.send('checkpoint');
      const row = await store.get(fresh.id, principal.ownerId),
        commandId = randomUUID();
      row.state.position.stageIndex = limit === 'compile' ? 3 : 4;
      row.evaluation = {
        id: commandId,
        fingerprint: 'fixture',
        stageKey: stageKey(row),
        startedAt: new Date().toISOString(),
        ...(limit === 'compile' ? { purpose: 'compile' as const } : {}),
      };
      await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
      await pool.query(
        `INSERT INTO sandbox_commands(environment_id,id,request_fingerprint,result_json,updated_at)
      VALUES($1,$2,'fixture',$3,now()-interval '20 minutes')`,
        [
          row.environment_id,
          commandId,
          JSON.stringify({
            id: commandId,
            state: 'exited',
            exitCode: 0,
            stdout: '',
            stderr: '',
            truncated: false,
          }),
        ],
      );
      if (limit !== 'count') {
        await writeFile(join(mocked.root, row.environment_id!, 'PLAN.md'), 'x'.repeat(600_000));
        await writeFile(
          join(mocked.root, row.environment_id!, 'src/greeting.py'),
          'x'.repeat(600_000),
        );
      } else {
        for (let n = 0; n < 257; n++)
          await writeFile(
            join(mocked.root, row.environment_id!, `src/generated${n}.py`),
            '# generated\n',
          );
      }
      await ageStudy(fresh.id);
      await maintainStudy(store, fresh.id, principal.ownerId);
      const failed = await store.get(fresh.id, principal.ownerId);
      expect(failed.evaluation).toBeNull();
      expect((await workbenchView(principal, fresh.id)).canEdit).toBe(true);
      expect(failed.checkpoint_failure).toMatchObject({ reason: 'source-limit', retryable: false });
      expect(failed.checkpoint_failure?.firstIdleFailureAt).toBeTruthy();
      await expireArchiveGrace(fresh.id);
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(
        await (await SandboxService.forOwner(principal)).get(row.environment_id!),
      ).toMatchObject({ state: 'destroyed' });
      expect(
        (await store.get(fresh.id, principal.ownerId)).archive_discard?.checkpointRevision,
      ).toBe(1);
    },
  );

  it('uses database time for inactivity even when the application clock is skewed', async () => {
    const fresh = await freshStudy();
    const row = await store.get(fresh.id, principal.ownerId);
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(realNow + 7 * 86400_000);
    try {
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(
        await (await SandboxService.forOwner(principal)).get(row.environment_id!),
      ).toMatchObject({ state: 'running' });
      await ageStudy(fresh.id);
      vi.setSystemTime(realNow - 7 * 86400_000);
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(
        await (await SandboxService.forOwner(principal)).get(row.environment_id!),
      ).toMatchObject({ state: 'destroyed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('timestamps the first dirty generation with database time despite a skewed Date constructor', async () => {
    const fresh = await freshStudy();
    const row = await store.get(fresh.id, principal.ownerId);
    row.state.position.stageIndex = 3;
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    const before = await store.get(fresh.id, principal.ownerId);
    const text = await readFile(join(mocked.root, row.environment_id!, 'greeting.py'), 'utf8');
    const realNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(realNow + 7 * 86400_000);
    try {
      await commandStudy(principal, fresh.id, {
        id: randomUUID(),
        revision: before.revision,
        type: 'save',
        path: 'greeting.py',
        expectedHash: digest(text),
        text: text + '\n# skewed edit\n',
      });
      const dirty = await store.get(fresh.id, principal.ownerId);
      expect(
        Math.abs((await store.now()).getTime() - dirty.workspace_dirty_at!.getTime()),
      ).toBeLessThan(10_000);
      await pool.query(
        "UPDATE pbl_v3_studies SET workspace_dirty_at=now()-interval '2 minutes' WHERE id=$1",
        [fresh.id],
      );
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect((await store.get(fresh.id, principal.ownerId)).workspace_dirty_at).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not record loss from a stale dirty view after a successful checkpoint/release', async () => {
    const fresh = await freshStudy();
    await pool.query('UPDATE pbl_v3_studies SET workspace_dirty_at=now() WHERE id=$1', [fresh.id]);
    const stale = await store.get(fresh.id, principal.ownerId);
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    const { recordExpiredWorkspace } = await import('@/lib/server/pbl-v3/environment');
    await recordExpiredWorkspace(store, stale, await SandboxService.forOwner(principal));
    expect((await store.get(fresh.id, principal.ownerId)).archive_discard).toBeNull();
  });

  it('publishes periodic dirty work with a single study admission slot', async () => {
    const fresh = await freshStudy();
    await pool.query(
      "UPDATE pbl_v3_studies SET workspace_dirty_at=now()-interval '2 minutes' WHERE id=$1",
      [fresh.id],
    );
    const previousMax = pool.options.max;
    pool.options.max = 4;
    try {
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect((await store.get(fresh.id, principal.ownerId)).workspace_dirty_at).toBeNull();
    } finally {
      pool.options.max = previousMax;
    }
  });

  it.each(['poll', 'maintenance'] as const)(
    'retains a loss notice on confirmed dirty expiry observed by %s',
    async (mode) => {
      const fresh = await freshStudy();
      await fresh.send('checkpoint');
      const row = await store.get(fresh.id, principal.ownerId);
      await pool.query(
        'UPDATE pbl_v3_studies SET workspace_dirty_at=now(),environment_checked_at=NULL WHERE id=$1',
        [fresh.id],
      );
      mocked.missing.add(row.environment_id!);
      if (mode === 'poll') await learningView(principal, fresh.id);
      else await maintainStudy(store, fresh.id, principal.ownerId);
      expect((await store.get(fresh.id, principal.ownerId)).archive_discard).toMatchObject({
        checkpointRevision: 1,
        reason: 'unavailable',
      });
    },
  );

  it('rotates maintenance beyond the first hundred environments durably', async () => {
    const environments: string[] = [];
    onTestFinished(async () => {
      await pool.query(
        "UPDATE sandbox_environments SET state='destroyed' WHERE id=ANY($1::text[])",
        [environments],
      );
    });
    await pool.query(
      "UPDATE sandbox_environments SET maintenance_checked_at=now()+interval '1 day'",
    );
    const ids = new Set<string>();
    for (let n = 0; n < 105; n++) {
      const study = await store.create(
        {
          ownerId: principal.ownerId,
          stageId: randomUUID(),
          sceneId: 'scene',
          projectId: project.ref.id,
          version: project.ref.version,
        },
        startOrchestration(project.definition),
      );
      const env = randomUUID();
      environments.push(env);
      ids.add(study.id);
      await pool.query(
        `INSERT INTO sandbox_environments(id,owner_id,workspace_id,connection_fingerprint,resource_id,state,workspace_ready)
        VALUES($1,$2,$3,'test',$1,'running',true)`,
        [env, principal.ownerId, `pbl-${study.id}`],
      );
      await pool.query('UPDATE pbl_v3_studies SET environment_id=$2 WHERE id=$1', [study.id, env]);
    }
    const visited = new Set<string>();
    for (let round = 0; round < 2; round++)
      await maintainLearningEnvironments(async (_store, id) => {
        if (ids.has(id)) visited.add(id);
      });
    expect(visited.size).toBe(105);
  });

  it.each(['command', 'maintenance'] as const)(
    'protects a slow %s checkpoint when the configured lease is only sixty seconds',
    async (mode) => {
      mocked.lifetimeMs = 60_000;
      let reading: ReturnType<typeof vi.spyOn> | undefined;
      let renewing: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const fresh = await freshStudy();
        const row = await store.get(fresh.id, principal.ownerId);
        const environmentId = row.environment_id!;
        await writeFile(join(mocked.root, environmentId, 'PLAN.md'), 'Protected short-lease plan');
        let elapsed = 0,
          expiresAt = 60_000;
        const originalRenew = E2BCompatibleSandboxProvider.prototype.renew;
        renewing = vi
          .spyOn(E2BCompatibleSandboxProvider.prototype, 'renew')
          .mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
            await originalRenew.apply(this, args);
            if (args[0] === environmentId) expiresAt = Math.max(expiresAt, elapsed + args[2]);
          });
        const originalRead = E2BCompatibleSandboxProvider.prototype.readText;
        reading = vi
          .spyOn(E2BCompatibleSandboxProvider.prototype, 'readText')
          .mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
            if (args[0] === environmentId) {
              elapsed = 75_000; // Model remote elapsed time without a wall-clock wait.
              if (elapsed >= expiresAt) throw new Error('Provider lease expired during snapshot');
            }
            return originalRead.apply(this, args);
          });
        if (mode === 'maintenance') {
          await ageStudy(fresh.id);
          await maintainStudy(store, fresh.id, principal.ownerId);
        } else await fresh.send('checkpoint');
        const service = await SandboxService.forOwner(principal);
        expect(await service.checkpoint(environmentId)).toMatchObject({ revision: 1 });
        if (mode === 'maintenance') {
          expect(await service.get(environmentId)).toMatchObject({ state: 'destroyed' });
          await fresh.send('prepare');
          const restored = await store.get(fresh.id, principal.ownerId);
          expect(await service.readText(restored.environment_id!, 'PLAN.md')).toBe(
            'Protected short-lease plan',
          );
        }
      } finally {
        reading?.mockRestore();
        renewing?.mockRestore();
        mocked.lifetimeMs = 300_000;
      }
    },
  );

  it.each(['file', 'listing'] as const)(
    'releases source snapshot %s admission at the shared deadline and fences late reads',
    async (kind) => {
      const fresh = await freshStudy();
      await fresh.send('checkpoint');
      const row = await store.get(fresh.id, principal.ownerId);
      const service = await SandboxService.forOwner(principal);
      let finish!: () => void;
      const reading = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'readText');
      const originalRead = reading.getMockImplementation()!;
      const listing = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'listWorkspace');
      const originalList = listing.getMockImplementation()!;
      const block = () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
      if (kind === 'file')
        reading.mockImplementationOnce(async function (
          this: E2BCompatibleSandboxProvider,
          ...args
        ) {
          await block();
          return originalRead.apply(this, args);
        });
      else {
        row.project = { ...project, sourceRoots: ['src'] };
        listing.mockImplementationOnce(async function (
          this: E2BCompatibleSandboxProvider,
          ...args
        ) {
          await block();
          return originalList.apply(this, args);
        });
      }
      const controller = new AbortController();
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      const deadline = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) => (ms === 120_000 ? controller.signal : timeout(ms)));
      const saving = store.exclusive(fresh.id, () => saveStudyCheckpoint(service, row));
      const outcome = saving.then(
        () => ({ saved: true }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        controller.abort(new DOMException('checkpoint deadline', 'TimeoutError'));
        const result = await Promise.race([
          outcome,
          new Promise((resolve) => setTimeout(() => resolve({ stillWaiting: true }), 1000)),
        ]);
        expect(result).toMatchObject({
          error: { stage: 'snapshot', failure: { reason: 'timeout' } },
        });
        expect(kind === 'file' ? reading.mock.calls[0]?.[3] : listing.mock.calls[0]?.[2]).toBe(
          controller.signal,
        );
        expect((await service.checkpoint(row.environment_id!))?.revision).toBe(1);
        await expect(store.exclusive(fresh.id, async () => 'available')).resolves.toBe('available');
        reading.mockRestore();
        listing.mockRestore();
        deadline.mockRestore();
        await fresh.send('checkpoint');
        finish();
        await new Promise((resolve) => setImmediate(resolve));
        expect((await service.checkpoint(row.environment_id!))?.revision).toBe(2);
        expect(row.environment_recovery?.savedPosition?.revision).toBe(1);
      } finally {
        finish?.();
        await outcome;
        reading.mockRestore();
        listing.mockRestore();
        deadline.mockRestore();
      }
    },
  );

  it('archives between-stage file edits before idle release and restores the same study', async () => {
    const fresh = await freshStudy();
    let row = await store.get(fresh.id, principal.ownerId);
    const source = Object.keys(project.files).find((name) => name !== 'PLAN.md')!;
    const code = 'def greet(name):\n    return f"Hello, {name}!"\n';
    await writeFile(join(mocked.root, row.environment_id!, source), code);
    row.workspace_dirty_at = new Date();
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    const before = await store.get(fresh.id, principal.ownerId);
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    await expect(
      (await SandboxService.forOwner(principal)).get(before.environment_id!),
    ).resolves.toMatchObject({ state: 'destroyed' });
    row = await store.get(fresh.id, principal.ownerId);
    expect(row.workspace_dirty_at).toBeNull();
    expect(row.revision).toBe(before.revision);
    expect(row.environment_recovery?.savedPosition?.revision).toBe(1);
    await fresh.send('prepare');
    row = await store.get(fresh.id, principal.ownerId);
    expect(row.id).toBe(fresh.id);
    expect(row.environment_id).not.toBe(before.environment_id);
    expect(
      await (await SandboxService.forOwner(principal)).readText(row.environment_id!, source),
    ).toBe(code);
    expect(row.state).toEqual(before.state);
  });

  it('bounds the dirty-work loss window without changing teaching revisions or releasing active use', async () => {
    const fresh = await freshStudy();
    await pool.query(
      "UPDATE pbl_v3_studies SET workspace_dirty_at=now()-interval '2 minutes' WHERE id=$1",
      [fresh.id],
    );
    const before = await store.get(fresh.id, principal.ownerId);
    await maintainStudy(store, fresh.id, principal.ownerId);
    const after = await store.get(fresh.id, principal.ownerId);
    expect(after.revision).toBe(before.revision);
    expect(after.workspace_dirty_at).toBeNull();
    expect(after.environment_recovery?.savedPosition?.revision).toBe(1);
    expect(
      await (await SandboxService.forOwner(principal)).get(after.environment_id!),
    ).toMatchObject({ state: 'running' });
  });

  it('does not count visible-page polling as learner activity or keepalive', async () => {
    const fresh = await freshStudy();
    await ageStudy(fresh.id);
    const before = await store.get(fresh.id, principal.ownerId);
    const renewals = mocked.renewals.length;
    await learningView(principal, fresh.id);
    await workbenchView(principal, fresh.id);
    const after = await store.get(fresh.id, principal.ownerId);
    expect(after.last_used_at).toEqual(before.last_used_at);
    expect(mocked.renewals).toHaveLength(renewals);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(
      await (await SandboxService.forOwner(principal)).get(after.environment_id!),
    ).toMatchObject({ state: 'destroyed' });
  });

  it('retains an active turn after departure and starts inactivity after the durable task completion', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    await pool.query(
      "UPDATE pbl_v3_roles SET turn_started_at=now()-interval '20 minutes' WHERE session_id=$1",
      [queued.sessionId],
    );
    await pool.query(
      "UPDATE pbl_v3_studies SET last_used_at=clock_timestamp()-($2::double precision*interval '1 millisecond') WHERE id=$1",
      [fresh.id, pblIdleTimeoutMs() / 2],
    );
    const before = await store.get(fresh.id, principal.ownerId);
    const renewals = mocked.renewals.length;
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(mocked.renewals.slice(renewals)).toContain(before.environment_id);
    expect(
      await (await SandboxService.forOwner(principal)).get(before.environment_id!),
    ).toMatchObject({ state: 'running' });
    const turn = await agents.claimNextSession('lifecycle-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await agents.finishSession(queued.sessionId, 'lifecycle-worker', {
      status: 'succeeded',
      expectedAttempt: turn!.attempt,
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    const after = await store.get(fresh.id, principal.ownerId);
    expect(after.last_used_at.getTime()).toBeGreaterThan(Date.now() - 10000);
    expect(
      await (await SandboxService.forOwner(principal)).get(after.environment_id!),
    ).toMatchObject({ state: 'running' });
  });

  it('retains the current environment and exposes retryable failure when checkpoint export fails', async () => {
    const fresh = await freshStudy();
    await ageStudy(fresh.id);
    mocked.failExport = true;
    onTestFinished(() => {
      mocked.failExport = false;
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    const failed = await store.get(fresh.id, principal.ownerId);
    expect(failed.lifecycle_error).toBe('checkpoint-unavailable');
    expect(
      await (await SandboxService.forOwner(principal)).get(failed.environment_id!),
    ).toMatchObject({ state: 'running' });
    expect((await learningView(principal, fresh.id)).lifecycleError).toBe('checkpoint-unavailable');
    mocked.failExport = false;
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).lifecycle_error).toBeNull();
    expect(
      await (await SandboxService.forOwner(principal)).get(failed.environment_id!),
    ).toMatchObject({ state: 'destroyed' });
  });

  it('shares activity across tabs and serializes competing reclaimers without duplicate checkpoints', async () => {
    const fresh = await freshStudy();
    await ageStudy(fresh.id);
    await store.exclusive(fresh.id, () => store.recordActivity(fresh.id, principal.ownerId));
    await maintainStudy(store, fresh.id, principal.ownerId);
    const row = await store.get(fresh.id, principal.ownerId);
    const service = await SandboxService.forOwner(principal);
    expect(await service.get(row.environment_id!)).toMatchObject({ state: 'running' });
    await ageStudy(fresh.id);
    await Promise.allSettled([
      maintainStudy(store, fresh.id, principal.ownerId),
      maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId),
    ]);
    expect(await service.checkpoint(row.environment_id!)).toMatchObject({ revision: 1 });
    expect(await service.get(row.environment_id!)).toMatchObject({ state: 'destroyed' });
  });

  async function expireArchiveGrace(id: string) {
    await pool.query(
      `UPDATE pbl_v3_studies SET checkpoint_failure=checkpoint_failure ||
       jsonb_build_object('firstIdleFailureAt',to_char(now()-interval '10 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE id=$1`,
      [id],
    );
  }

  async function studyWithTerminal() {
    const fresh = await freshStudy();
    await fresh.send('checkpoint');
    const row = await store.get(fresh.id, principal.ownerId);
    row.state.position.stageIndex = 3;
    row.state.milestones[0]!.stageIndex = 3;
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    const service = await SandboxService.forOwner(principal);
    const terminal = (await workbenchCommand(principal, fresh.id, {
      id: randomUUID(),
      revision: (await store.get(fresh.id, principal.ownerId)).revision,
      environmentId: row.environment_id!,
      epoch: await service.workspaceEpoch(row.environment_id!),
      action: 'terminal',
    })) as { id: string; state: string };
    expect(terminal.state).toBe('running');
    onTestFinished(() => {
      mocked.terminals.delete(terminal.id);
    });
    return { fresh, service, terminal, environmentId: row.environment_id! };
  }

  it.each(
    (
      [
        ['discard', 'input'],
        ['discard', 'resize'],
        ['release', 'input'],
        ['release', 'resize'],
      ] as const
    ).flatMap(([intent, action]) =>
      (['snapshot', 'discovery', 'permissions'] as const).map((timing) => ({
        intent,
        action,
        timing,
      })),
    ),
  )(
    'fences terminal $action after $intent intent committed during $timing',
    async ({ intent, action, timing }) => {
      const { fresh, service, terminal, environmentId } = await studyWithTerminal();
      const row = await store.get(fresh.id, principal.ownerId);
      const original = SandboxService.prototype.updateTerminal;
      const originalFind = E2BCompatibleSandboxProvider.prototype.findTerminal;
      const originalRoles = LearningStore.prototype.roles;
      const input = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'terminalInput');
      const resize = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'resizeTerminal');
      let committed = false;
      const commitIntent = async () => {
        if (committed) return;
        committed = true;
        if (intent === 'discard') {
          const saved = await service.checkpoint(environmentId);
          expect(
            await store.recordArchiveDiscard(row, {
              environmentId,
              at: (await store.now()).toISOString(),
              checkpointRevision: saved!.revision,
              checkpointAt: saved!.createdAt,
              reason: 'execution-unsettled',
            }),
          ).toBe(true);
        } else expect(await store.claimIdleRelease(row)).toBe(true);
      };
      const update = vi
        .spyOn(SandboxService.prototype, 'updateTerminal')
        .mockImplementation(async function (this: SandboxService, ...args) {
          if (timing === 'snapshot') await commitIntent();
          return original.apply(this, args);
        });
      const find = vi
        .spyOn(E2BCompatibleSandboxProvider.prototype, 'findTerminal')
        .mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
          const result = await originalFind.apply(this, args);
          if (timing === 'discovery') await commitIntent();
          return result;
        });
      const roles = vi.spyOn(LearningStore.prototype, 'roles').mockImplementation(async function (
        this: LearningStore,
        ...args
      ) {
        const result = await originalRoles.apply(this, args);
        if (timing === 'permissions') await commitIntent();
        return result;
      });
      try {
        await expect(
          workbenchCommand(principal, fresh.id, {
            id: randomUUID(),
            revision: row.revision,
            environmentId,
            action: 'input',
            terminalId: terminal.id,
            ...(action === 'input' ? { data: 'echo doomed\n' } : { cols: 90, rows: 24 }),
          }),
        ).rejects.toMatchObject({ reason: 'ENVIRONMENT_UNAVAILABLE' });
        expect(input).not.toHaveBeenCalled();
        expect(resize).not.toHaveBeenCalled();
        // Stop stays available after irreversible intent without Study admission.
        await store.exclusive(fresh.id, () =>
          workbenchCommand(principal, fresh.id, {
            id: randomUUID(),
            revision: row.revision,
            environmentId,
            action: 'stop',
          }),
        );
        expect(await service.terminal(environmentId, terminal.id)).toMatchObject({
          state: 'closed',
        });
      } finally {
        update.mockRestore();
        find.mockRestore();
        roles.mockRestore();
        input.mockRestore();
        resize.mockRestore();
        await withLearningWorkspaceAccess(
          {
            ownerId: principal.ownerId,
            workspaceId: learningWorkspaceId(fresh.id),
            environmentIds: () => [environmentId],
            operations: ['destroy'],
          },
          () => service.destroy(environmentId),
        );
      }
    },
  );

  it('closes an abandoned terminal before archiving its final writes and releasing the idle environment', async () => {
    const { fresh, service, terminal, environmentId } = await studyWithTerminal();
    const source = Object.keys(project.files).find((path) => path !== 'PLAN.md')!;
    const code =
      'def greet(name):\n    return f"Hello, {name}!"\n# terminal cleanup flushed this edit\n';
    const close = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'closeTerminal')
      .mockImplementation(async () => {
        await writeFile(join(mocked.root, environmentId, source), code);
        mocked.terminals.delete(terminal.id);
      });
    onTestFinished(() => close.mockRestore());
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await service.get(environmentId)).toMatchObject({ state: 'destroyed' });
    expect(await service.checkpoint(environmentId)).toMatchObject({ revision: 2 });
    const saved = await store.get(fresh.id, principal.ownerId);
    expect(saved.archive_discard).toBeNull();
    expect(saved.checkpoint_failure).toBeNull();
    await fresh.send('prepare');
    const restored = await store.get(fresh.id, principal.ownerId);
    expect(await service.readText(restored.environment_id!, source)).toBe(code);
  });

  it('keeps a terminal open for activity in another tab and for a running Agent turn', async () => {
    const { fresh, service, environmentId } = await studyWithTerminal();
    const close = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'closeTerminal');
    onTestFinished(() => close.mockRestore());
    await ageStudy(fresh.id);
    await store.recordActivity(fresh.id, principal.ownerId);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(close).not.toHaveBeenCalled();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(close).not.toHaveBeenCalled();
    expect(await service.get(environmentId)).toMatchObject({ state: 'running' });
    const turn = await agents.claimNextSession('terminal-lifecycle-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await agents.finishSession(queued.sessionId, 'terminal-lifecycle-worker', {
      status: 'succeeded',
      expectedAttempt: turn!.attempt,
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(close).not.toHaveBeenCalled();
    await ageStudy(fresh.id);
    // A stable task completion must also precede the simulated next inactivity window.
    await pool.query(
      "UPDATE agent_sessions SET updated_at=now()-interval '20 minutes' WHERE id=$1",
      [queued.sessionId],
    );
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await service.get(environmentId)).toMatchObject({ state: 'destroyed' });
  });

  it.each(['close', 'lookup'] as const)(
    'bounds abandoned terminal %s failures without archiving a possible writer',
    async (operation) => {
      const { fresh, service, environmentId } = await studyWithTerminal();
      const failure = vi
        .spyOn(
          E2BCompatibleSandboxProvider.prototype,
          operation === 'close' ? 'closeTerminal' : 'findTerminal',
        )
        .mockRejectedValue(new Error('Provider unavailable'));
      const archive = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'exportWorkspace');
      onTestFinished(() => {
        failure.mockRestore();
        archive.mockRestore();
      });
      await ageStudy(fresh.id);
      await maintainStudy(store, fresh.id, principal.ownerId);
      const first = await store.get(fresh.id, principal.ownerId);
      expect(first.checkpoint_failure).toMatchObject({
        reason: 'execution-unsettled',
        stage: 'terminal',
      });
      expect(first.checkpoint_failure?.firstIdleFailureAt).toBeTruthy();
      expect(await service.get(environmentId)).toMatchObject({ state: 'running' });
      await maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId);
      expect(
        (await store.get(fresh.id, principal.ownerId)).checkpoint_failure?.firstIdleFailureAt,
      ).toBe(first.checkpoint_failure?.firstIdleFailureAt);
      expect(archive).not.toHaveBeenCalled();
      await expireArchiveGrace(fresh.id);
      const renewals = mocked.renewals.length;
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(mocked.renewals).toHaveLength(renewals);
      expect(archive).not.toHaveBeenCalled();
      expect(await service.get(environmentId)).toMatchObject({ state: 'destroyed' });
      expect(await service.checkpoint(environmentId)).toMatchObject({ revision: 1 });
      expect((await learningView(principal, fresh.id)).archiveDiscard).toMatchObject({
        checkpointRevision: 1,
        reason: 'execution-unsettled',
      });
    },
  );

  it('retries a transient terminal cleanup failure and archives without extending idle time', async () => {
    const { fresh, service, environmentId } = await studyWithTerminal();
    const close = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'closeTerminal')
      .mockRejectedValueOnce(new Error('Close acknowledgement lost'));
    onTestFinished(() => close.mockRestore());
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    const failed = await store.get(fresh.id, principal.ownerId);
    expect(failed.checkpoint_failure?.stage).toBe('terminal');
    await maintainStudy(store, fresh.id, principal.ownerId);
    const saved = await store.get(fresh.id, principal.ownerId);
    expect(saved.last_used_at).toEqual(failed.last_used_at);
    expect(saved.checkpoint_failure).toBeNull();
    expect(saved.lifecycle_error).toBeNull();
    expect(saved.archive_discard).toBeNull();
    expect(await service.checkpoint(environmentId)).toMatchObject({ revision: 2 });
    expect(await service.get(environmentId)).toMatchObject({ state: 'destroyed' });
  });

  it('cancels pending terminal cleanup when the learner returns', async () => {
    const { fresh, service, environmentId } = await studyWithTerminal();
    const close = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'closeTerminal')
      .mockRejectedValue(new Error('Close unavailable'));
    onTestFinished(() => close.mockRestore());
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    await expireArchiveGrace(fresh.id);
    await store.recordActivity(fresh.id, principal.ownerId);
    const calls = close.mock.calls.length;
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(close).toHaveBeenCalledTimes(calls);
    expect((await store.get(fresh.id, principal.ownerId)).checkpoint_failure).toBeNull();
    expect(await service.get(environmentId)).toMatchObject({ state: 'running' });
  });

  it('bounds repeated idle archive failures and restores only the previous durable version with a loss notice', async () => {
    const fresh = await freshStudy();
    let row = await store.get(fresh.id, principal.ownerId);
    await writeFile(join(mocked.root, row.environment_id!, 'PLAN.md'), 'durable plan');
    await fresh.send('checkpoint');
    await writeFile(join(mocked.root, row.environment_id!, 'PLAN.md'), 'unarchived plan');
    await pool.query('UPDATE pbl_v3_studies SET workspace_dirty_at=now() WHERE id=$1', [fresh.id]);
    await ageStudy(fresh.id);
    mocked.failExport = true;
    onTestFinished(() => {
      mocked.failExport = false;
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    row = await store.get(fresh.id, principal.ownerId);
    const first = row.checkpoint_failure?.firstIdleFailureAt;
    expect(row.checkpoint_failure).toMatchObject({
      reason: 'unavailable',
      stage: 'archive',
      retryable: true,
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(
      (await store.get(fresh.id, principal.ownerId)).checkpoint_failure?.firstIdleFailureAt,
    ).toBe(first);
    await expireArchiveGrace(fresh.id);
    const exportSpy = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'exportWorkspace');
    onTestFinished(() => exportSpy.mockRestore());
    await maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId);
    expect(exportSpy).not.toHaveBeenCalled();
    const service = await SandboxService.forOwner(principal);
    expect(await service.get(row.environment_id!)).toMatchObject({ state: 'destroyed' });
    expect(await service.checkpoint(row.environment_id!)).toMatchObject({ revision: 1 });
    expect((await learningView(principal, fresh.id)).archiveDiscard).toMatchObject({
      checkpointRevision: 1,
      reason: 'unavailable',
    });
    expect((await learningView(principal, fresh.id)).environment?.state).toBe('destroyed');
    mocked.failExport = false;
    await fresh.send('prepare');
    row = await store.get(fresh.id, principal.ownerId);
    expect(await service.readText(row.environment_id!, 'PLAN.md')).toBe('durable plan');
    expect(row.workspace_dirty_at).toBeNull();
    expect((await learningView(principal, fresh.id)).archiveDiscard?.checkpointAt).toBeTruthy();
  });

  it('does not retry deterministic failures until real activity, and never starts the release grace during active use', async () => {
    const fresh = await freshStudy();
    await pool.query(
      "UPDATE pbl_v3_studies SET workspace_dirty_at=now()-interval '2 minutes' WHERE id=$1",
      [fresh.id],
    );
    const exportSpy = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'exportWorkspace')
      .mockImplementation(async function* () {
        yield* [];
        throw Object.assign(new Error('PRIVATE SIGNED URL'), { code: 'ASSET_STORAGE_PERMISSION' });
      });
    onTestFinished(() => exportSpy.mockRestore());
    await maintainStudy(store, fresh.id, principal.ownerId);
    const failed = await store.get(fresh.id, principal.ownerId);
    expect(failed.checkpoint_failure).toMatchObject({
      reason: 'storage-permission',
      retryable: false,
      firstIdleFailureAt: null,
    });
    expect(JSON.stringify(failed.checkpoint_failure)).not.toContain('PRIVATE');
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(
      (await store.get(fresh.id, principal.ownerId)).checkpoint_failure?.firstIdleFailureAt,
    ).toBeTruthy();
    await store.recordActivity(fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).checkpoint_failure).toBeNull();
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(exportSpy).toHaveBeenCalledTimes(2);
    expect(
      (await store.get(fresh.id, principal.ownerId)).checkpoint_failure?.firstIdleFailureAt,
    ).toBeNull();
    expect(
      await (await SandboxService.forOwner(principal)).get(failed.environment_id!),
    ).toMatchObject({ state: 'running' });
  });

  it('persists discard intent before uncertain deletion, fences old writes and retries the same environment on return', async () => {
    const fresh = await freshStudy();
    const row = await store.get(fresh.id, principal.ownerId);
    await ageStudy(fresh.id);
    mocked.failExport = true;
    onTestFinished(() => {
      mocked.failExport = false;
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    await expireArchiveGrace(fresh.id);
    const destroy = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'destroy')
      .mockRejectedValueOnce(new Error('delete ack lost'));
    onTestFinished(() => destroy.mockRestore());
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).archive_discard).toMatchObject({
      environmentId: row.environment_id,
      checkpointRevision: 0,
      checkpointAt: null,
    });
    await expect(fresh.send('chat')).rejects.toThrow('Prepare or recover');
    expect((await learningView(principal, fresh.id)).archiveDiscard?.checkpointRevision).toBe(0);
    mocked.failExport = false;
    await fresh.send('prepare');
    expect(destroy.mock.calls.map((call) => call[0])).toEqual([
      row.environment_id,
      row.environment_id,
    ]);
    const restored = await store.get(fresh.id, principal.ownerId);
    expect(restored.environment_id).not.toBe(row.environment_id);
    expect(restored.archive_discard?.checkpointRevision).toBe(0);
  });

  it('does not destroy a workspace if the durable discard record cannot be saved', async () => {
    const fresh = await freshStudy();
    await ageStudy(fresh.id);
    mocked.failExport = true;
    onTestFinished(() => {
      mocked.failExport = false;
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    await expireArchiveGrace(fresh.id);
    const save = vi
      .spyOn(store, 'recordArchiveDiscard')
      .mockRejectedValueOnce(new Error('DB unavailable'));
    onTestFinished(() => save.mockRestore());
    await maintainStudy(store, fresh.id, principal.ownerId);
    const row = await store.get(fresh.id, principal.ownerId);
    expect(row.archive_discard).toBeNull();
    expect(await (await SandboxService.forOwner(principal)).get(row.environment_id!)).toMatchObject(
      { state: 'running' },
    );
  });

  it('collects a completed build without an open browser and makes collection idempotent', async () => {
    const lab = installedProject({ id: 'greeting-python-lab', version: '1.1.0' });
    const fresh = await freshStudy(lab);
    const row = await store.get(fresh.id, principal.ownerId);
    const stageIndex = lab.definition.milestones[0]!.stages.findIndex(
      (stage) => stage.kind === 'produce' && stage.writes === 'code',
    );
    row.state.position.stageIndex = stageIndex;
    row.state.milestones[0]!.stageIndex = stageIndex;
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    await fresh.send('compile');
    const pending = await store.get(fresh.id, principal.ownerId);
    const executionId = pending.evaluation!.id;
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).evaluation).toBeNull();
    expect(
      (
        await pool.query('SELECT result FROM pbl_v3_commands WHERE study_id=$1 AND id=$2', [
          fresh.id,
          `build:${executionId}`,
        ])
      ).rows[0].result.passed,
    ).toBe(true);
    await expect(
      commandStudy(principal, fresh.id, {
        id: randomUUID(),
        type: 'collect',
        revision: pending.revision,
        evaluationId: executionId,
      }),
    ).resolves.toEqual({ collected: true });
  });
  it.each(['queued', 'reasoning', 'tool'] as const)(
    'preserves a healthy %s turn older than fifteen minutes',
    async (phase) => {
      const fresh = await freshStudy();
      const queued = (await fresh.send('chat')) as { sessionId: string };
      if (phase !== 'queued')
        await agents.claimNextSession('healthy-worker', process.pid, {
          sessionId: queued.sessionId,
          leaseTtlMs: 10000,
          maxAttempts: 5,
        });
      const before = await store.get(fresh.id, principal.ownerId);
      if (phase === 'tool')
        await pool.query(
          "INSERT INTO sandbox_commands(environment_id,id,request_fingerprint) VALUES($1,$2,'long-tool')",
          [before.environment_id, randomUUID()],
        );
      await pool.query(
        "UPDATE pbl_v3_roles SET turn_started_at=now()-interval '20 minutes' WHERE session_id=$1",
        [queued.sessionId],
      );
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(await agents.isCancelRequested(queued.sessionId)).toBe(false);
      expect((await agents.getSession(queued.sessionId))?.status).toBe(
        phase === 'queued' ? 'queued' : 'running',
      );
      expect((await store.get(fresh.id, principal.ownerId)).revision).toBe(before.revision);
      expect(
        await (await SandboxService.forOwner(principal)).get(before.environment_id!),
      ).toMatchObject({ state: 'running' });
    },
  );

  it.each(['queued', 'running'] as const)(
    'protects a departed learner’s healthy %s turn without interpreting inactivity as failure',
    async (status) => {
      const fresh = await freshStudy();
      onTestFinished(async () => {
        for (const binding of await store.roles(fresh.id))
          await agents.requestCancel(binding.session_id, { settle: true });
        const own = await store.get(fresh.id, principal.ownerId);
        await pool.query("UPDATE sandbox_environments SET state='destroyed' WHERE id=$1", [
          own.environment_id,
        ]);
      });
      await fresh.send('checkpoint');
      const edited = await store.get(fresh.id, principal.ownerId);
      await writeFile(
        join(mocked.root, edited.environment_id!, 'greeting.py'),
        '# dirty edit after checkpoint\n',
      );
      await pool.query(
        'UPDATE pbl_v3_studies SET workspace_dirty_at=clock_timestamp() WHERE id=$1',
        [fresh.id],
      );
      const queued = (await fresh.send('chat')) as { sessionId: string };
      const claimed =
        status === 'running'
          ? await agents.claimNextSession('departed-worker', process.pid, {
              sessionId: queued.sessionId,
              leaseTtlMs: 10000,
              maxAttempts: 5,
            })
          : null;
      await ageStudy(fresh.id);
      const row = await store.get(fresh.id, principal.ownerId);
      const renewals = mocked.renewals.length;
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(mocked.renewals.length).toBeGreaterThan(renewals);
      expect((await agents.getSession(queued.sessionId))?.status).toBe(status);
      expect(await agents.isCancelRequested(queued.sessionId)).toBe(false);
      expect(
        await (await SandboxService.forOwner(principal)).get(row.environment_id!),
      ).toMatchObject({ state: 'running' });
      expect((await store.get(fresh.id, principal.ownerId)).idle_turn_cleanup).toBeNull();
      if (claimed)
        await agents.assertActiveLease(queued.sessionId, 'departed-worker', claimed.attempt, pool);
    },
  );

  it('does not turn explicit cancellation into new learner activity', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const claimed = await agents.claimNextSession('departure-ack-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await stageExplicitCleanup(fresh.id);
    const before = await store.get(fresh.id, principal.ownerId);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(await agents.isCancelRequested(queued.sessionId)).toBe(true);
    await agents.finishSession(queued.sessionId, 'departure-ack-worker', {
      status: 'cancelled',
      expectedAttempt: claimed!.attempt,
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).last_used_at).toEqual(
      before.last_used_at,
    );
    expect(
      await (await SandboxService.forOwner(principal)).get(before.environment_id!),
    ).toMatchObject({ state: 'destroyed' });
  });

  it('archives safe edits after acknowledged cancellation even if the next pass is past the deadline', async () => {
    const fresh = await freshStudy();
    await fresh.send('checkpoint');
    const row = await store.get(fresh.id, principal.ownerId);
    await writeFile(
      join(mocked.root, row.environment_id!, 'greeting.py'),
      '# safe acknowledged edit\n',
    );
    await pool.query('UPDATE pbl_v3_studies SET workspace_dirty_at=clock_timestamp() WHERE id=$1', [
      fresh.id,
    ]);
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const claim = await agents.claimNextSession('acknowledged-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await stageExplicitCleanup(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    await agents.finishSession(queued.sessionId, 'acknowledged-worker', {
      status: 'cancelled',
      expectedAttempt: claim!.attempt,
    });
    await pool.query(
      "UPDATE pbl_v3_studies SET idle_turn_cleanup=jsonb_set(idle_turn_cleanup,'{releaseAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1",
      [fresh.id],
    );
    const renewals = mocked.renewals.length;
    await maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId);
    expect(mocked.renewals).toHaveLength(renewals);
    const service = await SandboxService.forOwner(principal);
    expect(await service.get(row.environment_id!)).toMatchObject({ state: 'destroyed' });
    expect(await service.checkpoint(row.environment_id!)).toMatchObject({ revision: 2 });
    expect((await store.get(fresh.id, principal.ownerId)).archive_discard).toBeNull();
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).archive_discard).toBeNull();
  });

  it('fences stale commands and fresh readiness checks after concurrent discard without changing revision', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    await agents.claimNextSession('discard-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const stale = await store.get(fresh.id, principal.ownerId);
    const service = await SandboxService.forOwner(principal);
    const destroy = vi
      .spyOn(SandboxService.prototype, 'destroy')
      .mockImplementation(async (id) => service.get(id));
    try {
      await stageExplicitCleanup(fresh.id, true);
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect((await store.get(fresh.id, principal.ownerId)).revision).toBe(stale.revision);
      expect(await touchEnvironment(store, stale, service)).toMatchObject({
        workspaceReady: false,
      });
      await expect(
        store.transaction((db) => store.commit(db, stale, { state: stale.state, events: [] })),
      ).rejects.toThrow();
      const returned = await store.recordActivity(fresh.id, principal.ownerId);
      expect(returned.archive_discard).toBeTruthy();
    } finally {
      destroy.mockRestore();
      await maintainStudy(store, fresh.id, principal.ownerId);
    }
  });

  it('cannot publish an in-flight teaching checkpoint after forced release intent', async () => {
    const fresh = await freshStudy();
    await fresh.send('checkpoint');
    const queued = (await fresh.send('chat')) as { sessionId: string };
    await agents.claimNextSession('checkpoint-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    const row = await store.get(fresh.id, principal.ownerId);
    const service = await SandboxService.forOwner(principal);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = E2BCompatibleSandboxProvider.prototype.exportWorkspace;
    const exporting = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'exportWorkspace')
      .mockImplementation(async function* (this: E2BCompatibleSandboxProvider, ...args) {
        entered();
        await gate;
        yield* original.apply(this, args);
      });
    const destroy = vi
      .spyOn(SandboxService.prototype, 'destroy')
      .mockRejectedValue(new SandboxError('SANDBOX_CONFLICT', 409, 'busy', 'ENVIRONMENT_BUSY'));
    const saving = store.exclusive(fresh.id, () =>
      withLearningWorkspaceAccess(
        {
          ownerId: principal.ownerId,
          workspaceId: learningWorkspaceId(fresh.id),
          environmentIds: () => [row.environment_id],
          operations: ['checkpoint'],
        },
        () => saveStudyCheckpoint(service, row),
      ),
    );
    const outcome = saving.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        ready,
        outcome.then(() => {
          throw new Error('Checkpoint did not enter archive.');
        }),
      ]);
      await stageExplicitCleanup(fresh.id, true);
      await expect(maintainStudy(store, fresh.id, principal.ownerId)).rejects.toMatchObject({
        reason: 'ENVIRONMENT_BUSY',
      });
      release();
      expect(await outcome).toMatchObject({ code: 'CHECKPOINT_CHANGED' });
      expect(await service.checkpoint(row.environment_id!)).toMatchObject({ revision: 1 });
      await expect(store.saveEnvironmentRecovery(row)).rejects.toMatchObject({
        code: 'CHECKPOINT_CHANGED',
      });
    } finally {
      release();
      await outcome;
      exporting.mockRestore();
      destroy.mockRestore();
      await maintainStudy(store, fresh.id, principal.ownerId);
    }
  });

  it('keeps an explicit release deadline across maintenance instances and late heartbeats', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    await agents.claimNextSession('silent-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await stageExplicitCleanup(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    const first = (await store.get(fresh.id, principal.ownerId)).idle_turn_cleanup;
    expect(first).toBeTruthy();
    await agents.heartbeat(queued.sessionId, 'silent-worker');
    await maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).idle_turn_cleanup).toEqual(first);
    await pool.query(
      "UPDATE pbl_v3_studies SET idle_turn_cleanup=jsonb_set(idle_turn_cleanup,'{releaseAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1",
      [fresh.id],
    );
    const renewals = mocked.renewals.length;
    await maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId);
    expect(mocked.renewals).toHaveLength(renewals);
    expect((await agents.getSession(queued.sessionId))?.status).toBe('cancelled');
  });

  it('allows a returning learner to stop cleanup and explicitly retry a cancelled turn', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const claim = await agents.claimNextSession('return-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await stageExplicitCleanup(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    await store.recordActivity(fresh.id, principal.ownerId);
    const returned = await store.get(fresh.id, principal.ownerId);
    expect(returned.idle_turn_cleanup).toBeNull();
    await maintainStudy(new LearningStore(pool), fresh.id, principal.ownerId);
    expect((await agents.getSession(queued.sessionId))?.status).toBe('running');
    await agents.finishSession(queued.sessionId, 'return-worker', {
      status: 'cancelled',
      expectedAttempt: claim!.attempt,
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).last_used_at).toEqual(
      returned.last_used_at,
    );
    await fresh.send('retry');
    expect((await agents.getSession(queued.sessionId))?.status).toBe('queued');
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect((await store.get(fresh.id, principal.ownerId)).archive_discard).toBeNull();
  });

  it('fences explicit release while the cancelled turn teaching mutex is held', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    await agents.claimNextSession('locked-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await stageExplicitCleanup(fresh.id, true);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = store.exclusive(fresh.id, async () => {
      entered();
      await gate;
    });
    try {
      await ready;
      const renewals = mocked.renewals.length;
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(mocked.renewals).toHaveLength(renewals);
      expect((await agents.getSession(queued.sessionId))?.lease).toBeUndefined();
      const row = await store.get(fresh.id, principal.ownerId);
      expect(
        await (await SandboxService.forOwner(principal)).get(row.environment_id!),
      ).toMatchObject({ state: 'destroyed' });
    } finally {
      release();
      await held;
    }
  });

  it.each([false, true])(
    'a learner return during acknowledged cleanup archive cancels release, with archive failure: %s',
    async (fails) => {
      const fresh = await freshStudy();
      const queued = (await fresh.send('chat')) as { sessionId: string };
      const claim = await agents.claimNextSession('return-archive', process.pid, {
        sessionId: queued.sessionId,
        leaseTtlMs: 10000,
        maxAttempts: 5,
      });
      await stageExplicitCleanup(fresh.id);
      await maintainStudy(store, fresh.id, principal.ownerId);
      await agents.finishSession(queued.sessionId, 'return-archive', {
        status: 'cancelled',
        expectedAttempt: claim!.attempt,
      });
      const row = await store.get(fresh.id, principal.ownerId);
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = E2BCompatibleSandboxProvider.prototype.exportWorkspace;
      const archive = vi
        .spyOn(E2BCompatibleSandboxProvider.prototype, 'exportWorkspace')
        .mockImplementation(async function* (this: E2BCompatibleSandboxProvider, ...args) {
          entered();
          await gate;
          if (fails) throw new Error('Archive failed');
          yield* original.apply(this, args);
        });
      const maintaining = maintainStudy(store, fresh.id, principal.ownerId);
      try {
        await Promise.race([
          ready,
          maintaining.then(() => {
            throw new Error('Archive did not start.');
          }),
        ]);
        const returned = await store.recordActivity(fresh.id, principal.ownerId);
        release();
        await maintaining;
        const after = await store.get(fresh.id, principal.ownerId);
        expect(after.last_used_at).toEqual(returned.last_used_at);
        expect(after.idle_turn_cleanup).toBeNull();
        expect(after.archive_discard).toBeNull();
        expect(after.checkpoint_failure).toBeNull();
        expect(
          await (await SandboxService.forOwner(principal)).get(row.environment_id!),
        ).toMatchObject({ state: 'running' });
      } finally {
        release();
        await Promise.allSettled([maintaining]);
        archive.mockRestore();
      }
    },
  );

  it('keeps committed safe-release intent through deletion contention and learner return', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const claim = await agents.claimNextSession('busy-delete', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await stageExplicitCleanup(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    await agents.finishSession(queued.sessionId, 'busy-delete', {
      status: 'cancelled',
      expectedAttempt: claim!.attempt,
    });
    await pool.query(
      "UPDATE pbl_v3_studies SET idle_turn_cleanup=jsonb_set(idle_turn_cleanup,'{releaseAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1",
      [fresh.id],
    );
    const destroy = vi
      .spyOn(SandboxService.prototype, 'destroy')
      .mockRejectedValueOnce(new SandboxError('SANDBOX_CONFLICT', 409, 'busy', 'ENVIRONMENT_BUSY'));
    try {
      await maintainStudy(store, fresh.id, principal.ownerId);
      const saved = await store.get(fresh.id, principal.ownerId);
      expect(saved.idle_turn_cleanup?.releasing).toBe(true);
      expect(saved.archive_discard).toBeNull();
      await store.recordActivity(fresh.id, principal.ownerId);
      expect((await store.get(fresh.id, principal.ownerId)).idle_turn_cleanup).toEqual(
        saved.idle_turn_cleanup,
      );
      const renewals = mocked.renewals.length;
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(mocked.renewals).toHaveLength(renewals);
      expect(
        await (await SandboxService.forOwner(principal)).get(saved.environment_id!),
      ).toMatchObject({ state: 'destroyed' });
      await fresh.send('prepare');
      const restored = await store.get(fresh.id, principal.ownerId);
      expect(restored.environment_id).not.toBe(saved.environment_id);
      expect(restored.idle_turn_cleanup).toBeNull();
    } finally {
      destroy.mockRestore();
    }
  });

  it.each(['capacity', 'mutex'])(
    'renews a restored replacement during slow validation despite expired predecessor cleanup and %s contention',
    async (contention) => {
      const previousMax = pool.options.max;
      pool.options.max = contention === 'capacity' ? 10 : 12;
      mocked.lifetimeMs = 60_000;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let preparing: Promise<unknown> | undefined;
      const originalRenew = E2BCompatibleSandboxProvider.prototype.renew;
      const originalRead = E2BCompatibleSandboxProvider.prototype.readText;
      const renew = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'renew');
      const read = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'readText');
      try {
        const fresh = await freshStudy();
        await ageStudy(fresh.id);
        await maintainStudy(store, fresh.id, principal.ownerId);
        const previous = await store.get(fresh.id, principal.ownerId);
        expect(previous.idle_turn_cleanup?.releasing).toBe(true);
        expect(Date.parse(previous.idle_turn_cleanup!.releaseAt)).toBeLessThan(
          (await store.now()).getTime(),
        );
        let elapsed = 20_000,
          expiresAt = 60_000,
          first = true;
        renew.mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
          await originalRenew.apply(this, args);
          if (args[0] !== previous.environment_id) expiresAt = elapsed + args[2];
        });
        read.mockImplementation(async function (this: E2BCompatibleSandboxProvider, ...args) {
          if (args[0] !== previous.environment_id) {
            if (first) {
              first = false;
              entered();
              await gate;
              elapsed = 75_000;
            }
            if (elapsed >= expiresAt)
              throw new Error('Replacement lease expired during validation');
          }
          return originalRead.apply(this, args);
        });
        preparing = fresh.send('prepare');
        const outcome = preparing.then(
          () => ({ prepared: true }),
          (error: unknown) => ({ error }),
        );
        await Promise.race([
          ready,
          outcome.then(() => {
            throw new Error('Restored source validation did not start.');
          }),
        ]);
        const pending = await store.get(fresh.id, principal.ownerId);
        const replacement = pending.environment_recovery!.requestId;
        expect(pending.environment_id).toBe(previous.environment_id);
        expect(replacement).not.toBe(previous.environment_id);
        expect(pending.idle_turn_cleanup).toEqual(previous.idle_turn_cleanup);
        const service = await SandboxService.forOwner(principal);
        expect(await service.get(replacement)).toMatchObject({ workspaceReady: true });
        const renewals = mocked.renewals.length;
        await expect(
          maintainStudy(store, fresh.id, principal.ownerId, replacement),
        ).rejects.toMatchObject({ reason: 'STUDY_BUSY' });
        expect(mocked.renewals.slice(renewals)).toEqual([replacement]);
        release();
        expect(await outcome).toEqual({ prepared: true });
        const restored = await store.get(fresh.id, principal.ownerId);
        expect(restored.environment_id).toBe(replacement);
        expect(restored.idle_turn_cleanup).toBeNull();
      } finally {
        release();
        if (preparing) await Promise.allSettled([preparing]);
        read.mockRestore();
        renew.mockRestore();
        mocked.lifetimeMs = 300_000;
        pool.options.max = previousMax;
      }
    },
  );

  it('does not renew again when source snapshot crosses a departed cleanup deadline', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const claim = await agents.claimNextSession('crossing-deadline', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await stageExplicitCleanup(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    await agents.finishSession(queued.sessionId, 'crossing-deadline', {
      status: 'cancelled',
      expectedAttempt: claim!.attempt,
    });
    await pool.query(
      "UPDATE pbl_v3_studies SET idle_turn_cleanup=jsonb_set(idle_turn_cleanup,'{releaseAt}',to_jsonb((clock_timestamp()+interval '3 seconds')::text)) WHERE id=$1",
      [fresh.id],
    );
    const row = await store.get(fresh.id, principal.ownerId);
    let entered!: () => void,
      release!: () => void,
      first = true;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = SandboxService.prototype.readText;
    const read = vi.spyOn(SandboxService.prototype, 'readText').mockImplementation(async function (
      this: SandboxService,
      ...args
    ) {
      if (args[0] === row.environment_id && first) {
        first = false;
        entered();
        await gate;
      }
      return original.apply(this, args);
    });
    const maintaining = maintainStudy(store, fresh.id, principal.ownerId);
    try {
      await Promise.race([
        ready,
        maintaining.then(() => {
          throw new Error('Snapshot did not start.');
        }),
      ]);
      const remaining =
        Date.parse(row.idle_turn_cleanup!.releaseAt) - (await store.now()).getTime();
      expect(remaining).toBeGreaterThan(0);
      const renewals = mocked.renewals.length;
      await new Promise((resolve) => setTimeout(resolve, remaining + 50));
      release();
      await maintaining;
      expect(mocked.renewals).toHaveLength(renewals);
      expect(
        await (await SandboxService.forOwner(principal)).get(row.environment_id!),
      ).toMatchObject({ state: 'destroyed' });
      expect((await store.get(fresh.id, principal.ownerId)).archive_discard).toBeNull();
    } finally {
      release();
      await Promise.allSettled([maintaining]);
      read.mockRestore();
    }
  }, 15000);

  it('does not restore a stale idle-failure clock after a learner returns during terminal closure', async () => {
    const { fresh, service, environmentId } = await studyWithTerminal();
    let returned = false;
    const close = vi
      .spyOn(E2BCompatibleSandboxProvider.prototype, 'closeTerminal')
      .mockImplementation(async () => {
        if (!returned) {
          returned = true;
          await store.recordActivity(fresh.id, principal.ownerId);
        }
        throw new Error('Terminal close failed.');
      });
    try {
      await ageStudy(fresh.id);
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect((await store.get(fresh.id, principal.ownerId)).checkpoint_failure).toBeNull();
      await ageStudy(fresh.id);
      await maintainStudy(store, fresh.id, principal.ownerId);
      const row = await store.get(fresh.id, principal.ownerId);
      expect(row.checkpoint_failure?.stage).toBe('terminal');
      expect(
        Math.abs(
          Date.parse(row.checkpoint_failure!.firstIdleFailureAt!) - (await store.now()).getTime(),
        ),
      ).toBeLessThan(10_000);
      expect(row.archive_discard).toBeNull();
      expect(await service.get(environmentId)).toMatchObject({ state: 'running' });
    } finally {
      close.mockRestore();
    }
  });

  it('does not re-lease a forced-cancelled local run before its old setup settles', async () => {
    const fresh = await freshStudy();
    await fresh.send('checkpoint');
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const realClaim = agents.claimNextSession.bind(agents);
    const claims = vi
      .spyOn(agents, 'claimNextSession')
      .mockImplementation((worker, pid, options) =>
        realClaim(worker, pid, { ...options, sessionId: queued.sessionId }),
      );
    const runnerTools = await import('@/lib/server/pbl-v3/runner-tools');
    const configure = runnerTools.teachingRunnerConfig;
    let entered = false,
      first = true,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const setup = vi
      .spyOn(runnerTools, 'teachingRunnerConfig')
      .mockImplementation(async (input) => {
        if (input.sessionId === queued.sessionId && first) {
          first = false;
          entered = true;
          await gate;
        }
        return configure(input);
      });
    const runner = startAgentRunner();
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
      const old = await agents.getSession(queued.sessionId);
      expect(old?.lease).toBeTruthy();
      await agents.requestCancel(queued.sessionId, { settle: true });
      await fresh.send('retry');
      await vi.waitFor(
        () =>
          expect(
            claims.mock.calls.some((call) => call[2].excludeSessionIds?.includes(queued.sessionId)),
          ).toBe(true),
        { timeout: 5000 },
      );
      expect((await agents.getSession(queued.sessionId))?.status).toBe('queued');
      release();
      await vi.waitFor(
        async () => {
          const leased = (
            await Promise.all(claims.mock.results.map((result) => result.value))
          ).filter(Boolean);
          expect(leased.length).toBeGreaterThanOrEqual(2);
          expect(leased[1]?.lease?.workerId).not.toBe(old!.lease!.workerId);
        },
        { timeout: 5000 },
      );
      expect(await agents.heartbeat(queued.sessionId, old!.lease!.workerId)).toBe(false);
      expect(
        await agents.finishSession(queued.sessionId, old!.lease!.workerId, {
          status: 'succeeded',
          expectedAttempt: old!.attempt,
        }),
      ).toBe(false);
    } finally {
      release();
      await runner.stop();
      setup.mockRestore();
      claims.mockRestore();
      mocked.responses.length = 0;
    }
  });

  it('recovers an actual orphan through the runner lease and reclaims after completion', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const previous = await agents.claimNextSession('lost-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await pool.query('UPDATE agent_sessions SET lease_heartbeat_at=0 WHERE id=$1', [
      queued.sessionId,
    ]);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(await agents.isCancelRequested(queued.sessionId)).toBe(false);
    const recovered = await agents.claimNextSession('replacement-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    expect(recovered).toMatchObject({
      claimReason: 'orphaned',
      attempt: previous!.attempt + 1,
    });
    expect(await agents.heartbeat(queued.sessionId, 'lost-worker')).toBe(false);
    expect(
      await agents.finishSession(queued.sessionId, 'lost-worker', {
        status: 'succeeded',
        expectedAttempt: previous!.attempt,
      }),
    ).toBe(false);
    await agents.finishSession(queued.sessionId, 'replacement-worker', {
      status: 'succeeded',
      expectedAttempt: recovered!.attempt,
    });
    await maintainStudy(store, fresh.id, principal.ownerId);
    const finished = await store.get(fresh.id, principal.ownerId);
    expect(finished.last_used_at.getTime()).toBeGreaterThan((await store.now()).getTime() - 10000);
    await pool.query(
      "UPDATE agent_sessions SET updated_at=now()-interval '20 minutes' WHERE id=$1",
      [queued.sessionId],
    );
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(
      await (await SandboxService.forOwner(principal)).get(finished.environment_id!),
    ).toMatchObject({ state: 'destroyed' });
  });

  it.each([false, true])(
    'bounds a permanently unknown command even when cancellation fails: %s',
    async (cancelFails) => {
      const fresh = await freshStudy();
      const row = await store.get(fresh.id, principal.ownerId);
      const id = randomUUID();
      const unknown = {
        id,
        state: 'unknown',
        stdout: '',
        stderr: '',
        exitCode: null,
        truncated: false,
      };
      await pool.query(
        "INSERT INTO sandbox_commands(environment_id,id,request_fingerprint,result_json,created_at) VALUES($1,$2,'fixture',$3,now()-interval '20 minutes')",
        [row.environment_id, id, JSON.stringify(unknown)],
      );
      await writeFile(
        join(mocked.root, row.environment_id!, `.command-${id}`),
        JSON.stringify(unknown),
      );
      const cancel = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'cancelCommand');
      if (cancelFails) cancel.mockRejectedValue(new Error('Provider unavailable'));
      const exportSpy = vi.spyOn(E2BCompatibleSandboxProvider.prototype, 'exportWorkspace');
      onTestFinished(() => {
        cancel.mockRestore();
        exportSpy.mockRestore();
      });
      await ageStudy(fresh.id);
      await maintainStudy(store, fresh.id, principal.ownerId);
      const failure = (await store.get(fresh.id, principal.ownerId)).checkpoint_failure;
      expect(failure).toMatchObject({ reason: 'execution-unsettled', stage: 'execution' });
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(
        (await store.get(fresh.id, principal.ownerId)).checkpoint_failure?.firstIdleFailureAt,
      ).toBe(failure?.firstIdleFailureAt);
      await expireArchiveGrace(fresh.id);
      const renewals = mocked.renewals.length;
      await maintainStudy(store, fresh.id, principal.ownerId);
      expect(mocked.renewals).toHaveLength(renewals);
      expect(exportSpy).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalled();
      const view = await learningView(principal, fresh.id);
      expect(view.environment?.state).toBe('destroyed');
      expect(view.archiveDiscard?.reason).toBe('execution-unsettled');
      await fresh.send('prepare');
      expect((await store.get(fresh.id, principal.ownerId)).environment_id).not.toBe(
        row.environment_id,
      );
    },
  );

  it('reclaims an uncertain replacement even while the study still references its expired predecessor', async () => {
    const fresh = await freshStudy();
    const original = await store.get(fresh.id, principal.ownerId);
    mocked.missing.add(original.environment_id!);
    mocked.loseCreateAck = mocked.hideDiscovery = true;
    onTestFinished(() => {
      mocked.loseCreateAck = mocked.hideDiscovery = false;
    });
    await expect(fresh.send('prepare')).rejects.toThrow();
    mocked.loseCreateAck = mocked.hideDiscovery = false;
    const pending = await store.get(fresh.id, principal.ownerId);
    const replacement = pending.environment_recovery!.requestId;
    expect(replacement).not.toBe(original.environment_id);
    expect(pending.environment_id).toBe(original.environment_id);
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId, replacement);
    expect(await (await SandboxService.forOwner(principal)).get(replacement)).toMatchObject({
      state: 'destroyed',
    });
  });
  it('restores completed project files without reopening teaching or allocating for a report read', async () => {
    const fresh = await freshStudy();
    const row = await store.get(fresh.id, principal.ownerId);
    row.state.status = 'completed';
    await store.transaction((db) => store.commit(db, row, { state: row.state, events: [] }));
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    const allocations = mocked.creates.length;
    expect((await learningView(principal, fresh.id)).reportAvailable).toBe(true);
    expect(mocked.creates).toHaveLength(allocations);
    await fresh.send('prepare');
    const restored = await store.get(fresh.id, principal.ownerId);
    expect(restored.state.status).toBe('completed');
    expect(restored.environment_id).not.toBe(row.environment_id);
    await expect(fresh.send('chat')).rejects.toThrow('completed');
  });

  it('does not authorize maintenance against another owner or an unrelated environment', async () => {
    const fresh = await freshStudy();
    const row = await store.get(fresh.id, principal.ownerId);
    await expect(
      SandboxService.forLearningMaintenance(fresh.id, 'another-owner', row.environment_id!),
    ).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
    await expect(
      SandboxService.forLearningMaintenance(randomUUID(), principal.ownerId, row.environment_id!),
    ).rejects.toMatchObject({ code: 'SANDBOX_NOT_FOUND' });
  });

  it('aborts lock waiting promptly and never retains a PG connection between retries', async () => {
    const fresh = await freshStudy();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = store.exclusive(fresh.id, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    const controller = new AbortController();
    const waiting = store.waitForExclusive(
      fresh.id,
      async () => {
        throw new Error('must not enter');
      },
      controller.signal,
    );
    const outcome = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    controller.abort();
    await outcome;
    release();
    await held;
  });
  it('archives a terminal model request failure after inactivity and restores progress for retry', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const claim = await agents.claimNextSession('failed-request-worker', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await agents.finishSession(queued.sessionId, 'failed-request-worker', {
      status: 'failed',
      error: '[MODEL_REQUEST_IDLE_TIMEOUT] no upstream feedback',
      expectedAttempt: claim!.attempt,
    });
    const before = await store.get(fresh.id, principal.ownerId);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(
      await (await SandboxService.forOwner(principal)).get(before.environment_id!),
    ).toMatchObject({ state: 'running' });
    await pool.query(
      "UPDATE agent_sessions SET updated_at=now()-interval '20 minutes' WHERE id=$1",
      [queued.sessionId],
    );
    await ageStudy(fresh.id);
    await maintainStudy(store, fresh.id, principal.ownerId);
    expect(
      await (await SandboxService.forOwner(principal)).get(before.environment_id!),
    ).toMatchObject({ state: 'destroyed' });
    expect((await store.get(fresh.id, principal.ownerId)).state).toEqual(before.state);
    expect((await learningView(principal, fresh.id, { passive: true })).roleRun).toMatchObject({
      status: 'failed',
      canRetry: true,
      failureCode: 'MODEL_REQUEST_IDLE_TIMEOUT',
    });
    await fresh.send('prepare');
    await fresh.send('retry');
    expect((await agents.getSession(queued.sessionId))?.status).toBe('queued');
    const restored = await store.get(fresh.id, principal.ownerId);
    expect(restored.state).toEqual(before.state);
    expect(restored.environment_id).not.toBe(before.environment_id);
  });

  it('records a retried turn start without inventing learner feedback', async () => {
    const fresh = await freshStudy();
    const queued = (await fresh.send('chat')) as { sessionId: string };
    const turn = await agents.claimNextSession('retry-deadline', process.pid, {
      sessionId: queued.sessionId,
      leaseTtlMs: 10000,
      maxAttempts: 5,
    });
    await agents.finishSession(queued.sessionId, 'retry-deadline', {
      status: 'failed',
      error: 'fixture',
      expectedAttempt: turn!.attempt,
    });
    const before = await store.binding(queued.sessionId);
    await pool.query(
      "UPDATE pbl_v3_roles SET turn_started_at=now()-interval '20 minutes' WHERE session_id=$1",
      [queued.sessionId],
    );
    await fresh.send('retry');
    await maintainStudy(store, fresh.id, principal.ownerId);
    const after = await store.binding(queued.sessionId);
    expect(after!.feedback_seq).toBe(before!.feedback_seq);
    expect(after!.turn_started_at.getTime()).toBeGreaterThan(Date.now() - 10000);
    expect((await agents.getSession(queued.sessionId))?.status).toBe('queued');
  });
});
