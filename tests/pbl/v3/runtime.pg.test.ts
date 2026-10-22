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
  validateProjectPackage,
  type ProjectDescriptor,
} from '@/lib/server/pbl-v3/project-package';
import { WORKSPACE_FILE_RUNNER } from '@/lib/server/sandbox/workspace-archive';
import { workbenchCommand, workbenchView } from '@/lib/server/pbl-v3/workbench';
import { issuePreviewGrant } from '@/lib/server/sandbox/preview';
import type { ModelMessage } from 'ai';
import { PgAgentSessionStore, ensureAgentSessionSchema } from '@openmaic/storage/agent-session/pg';
vi.mock('server-only', () => ({}));
const mocked = vi.hoisted(() => ({
  pool: undefined as unknown,
  agents: undefined as unknown,
  root: '',
  missing: new Set<string>(),
  failInspect: false,
  failImport: false,
  loseWriteAck: false,
  loseCreateAck: false,
  hideDiscovery: false,
  creates: [] as string[],
  renewals: [] as string[],
  terminals: new Map<string, number>(),
  inputs: [] as string[],
  objects: new Map<string, Uint8Array>(),
  responses: [] as Array<Array<Record<string, unknown>>>,
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
    lifetimeMs: 300000,
    maxActive: 50,
    maxActivePerOwner: 50,
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
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  notifyDurableAgentEvent: async () => {},
  subscribeAgentEventWakeup: () => () => {},
}));
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
import { learningReport } from '@/lib/server/pbl-v3/report';
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import * as catalog from '@/lib/server/pbl-v3/catalog';
import { SandboxError } from '@/lib/sandbox/errors';
import { LearningStore } from '@/lib/server/pbl-v3/store';
import {
  commandStudy,
  openStudy,
  learningView,
  digest,
  stageFor,
  stageKey,
} from '@/lib/server/pbl-v3/runtime';
import { teachingRunnerConfig } from '@/lib/server/pbl-v3/runner-tools';
import { touchEnvironment } from '@/lib/server/pbl-v3/environment';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { isExplorationStage } from '@/lib/pbl/v3/domain/project/project-schema';
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxStore } from '@/lib/server/sandbox/store';
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
async function freshStudy() {
  const row = await store.create(
    {
      ownerId: principal.ownerId,
      stageId: randomUUID(),
      sceneId: 'scene',
      projectId: project.ref.id,
      version: project.ref.version,
    },
    startOrchestration(project.definition),
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
  const parts = role === 'teaching' ? 3 : 4;
  for (let index = 0; index < parts; index++)
    await runTools(
      index === 0 ? 'Please start.' : 'I checked the current part and understand it.',
      async (config) => {
        await invoke(config, 'read_next_skill', {
          ...(index ? { studentFeedback: 'I checked the current part' } : {}),
        });
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
  it.each(['greeting-python-lab', 'greeting-java'])(
    'completes two milestones and resumes optional exploration for %s',
    async (projectId) => {
      const selected = installedProject({ id: projectId, version: '1.0.0' });
      const created = await store.create(
        {
          ownerId: principal.ownerId,
          stageId: randomUUID(),
          sceneId: 'scene',
          projectId,
          version: '1.0.0',
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
        const parts = stage.kind === 'produce' ? 4 : 3;
        for (let part = 0; part < parts; part++)
          await roleTurn(
            part ? 'I checked this part and understand it.' : 'Please begin.',
            async (config) => {
              const section = await invoke(
                config,
                'read_next_skill',
                part ? { studentFeedback: 'I checked this part' } : {},
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
      const exploring = await learningView(principal, id);
      expect(exploring.state.position.milestoneId).toBe('explore');
      expect(exploring.actions).not.toContain('next');
      const before = await store.get(id, principal.ownerId);
      const report = await learningReport(principal, id);
      expect(report.requiredComplete).toBe(true);
      expect(report.outcomes?.filter((outcome) => outcome.milestoneId !== 'explore')).toEqual([
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
      await roleTurn('I want to explore another greeting.', async (config) => {
        expect(config.allowedToolNames.has('complete_stage')).toBe(false);
        expect(config.allowedToolNames.has('read_next_skill')).toBe(false);
        const path = projectId === 'greeting-java' ? 'src/Greeting.java' : 'src/greeting.py';
        const original = await (
          await SandboxService.forOwner(principal)
        ).readText(initialEnv, path);
        await invoke(config, 'write_file', {
          path,
          text: original + '\n',
          expectedHash: digest(original),
        });
      });
      await send('checkpoint');
      mocked.missing.add(initialEnv);
      await send('prepare');
      const restored = await learningView(principal, id);
      expect(restored.state.position.milestoneId).toBe('explore');
      expect(restored.environmentId).not.toBe(initialEnv);
      expect((await learningReport(principal, id)).requiredComplete).toBe(true);
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
  it('accepts wrapped and multi-message review feedback from durable student turns', async () => {
    const original = studyId;
    studyId = (await freshStudy()).id;
    const answer = 'It returns a string to the caller; print returns None.';
    const first = 'The caller receives the return value.';
    const second = 'Printing only displays the value.';
    try {
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
  it('opens each stage once without fabricating student feedback, including legacy intro rows', async () => {
    const study = await freshStudy();
    const original = await store.get(study.id, principal.ownerId);
    expect(original.state.introCompleted).toBe(true);
    expect(original.state.position.stageIndex).toBe(0);
    // Old sessions keep their content and position while dropping the separate intro gate.
    await pool.query(
      "UPDATE pbl_v3_studies SET state=jsonb_set(state,'{introCompleted}','false') WHERE id=$1",
      [study.id],
    );
    const started = (await study.send('begin')) as { sessionId: string };
    const state = await store.get(study.id, principal.ownerId);
    expect(state.state.introCompleted).toBe(true);
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
    const pending = await learningReport(principal, study.id);
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
    const displayed = await learningReport(principal, study.id);
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
    const answered = await learningReport(principal, study.id);
    expect(answered.conversations[0]!.messages).toEqual([
      expect.objectContaining({ role: 'assistant', text: question }),
      expect.objectContaining({ role: 'user', text }),
    ]);
    await expect(
      learningReport({ ...principal, ownerId: 'another-owner' }, study.id),
    ).rejects.toMatchObject({ status: 404 });
    await agents.softDeleteSession(started.sessionId, principal.ownerId);
  });
  it('prepares once and runs the complete learning flow with actual Python tests', async () => {
    await command('prepare');
    await guided('teaching'); // project opening and concepts share the first step
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
    expect(view.roleRun).toEqual({ status: 'failed', failure, canRetry: true });
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
  it('repairs a prose-only guided turn once, fails explicitly if still unclosed, and retries without a new learner reply', async () => {
    const original = studyId;
    const study = await freshStudy();
    studyId = study.id;
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
    expect(mocked.modelCalls - before).toBe(2); // bounded, not an autonomous retry loop
    expect((await agents.getSession(queued.sessionId))?.status).toBe('failed');
    expect((await agents.getSession(queued.sessionId))?.error).toContain('without recording');
    expect((await learningView(principal, study.id)).actions).not.toContain('next');
    expect((await store.binding(queued.sessionId))?.guided?.activeFile).toBe('A-teach.md');
    expect(await agents.listUserMessages(queued.sessionId)).toEqual(inputs);
    // The durable assistant stop is not grounds to early-settle an unclosed teaching turn.
    // Emulate an older release that incorrectly settled the same prose-only run as succeeded.
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
    expect((await store.binding(queued.sessionId))?.guided?.activeFile).toBe('B-dialogue.md');
    expect(await agents.listUserMessages(queued.sessionId)).toEqual(inputs);
    expect(mocked.modelRequests[retryRequestIndex]?.at(-1)).toMatchObject({
      role: 'user',
      content: reply,
    });
    expect(mocked.modelSystems.at(-1)).toContain('\"activeSection\":\"B-dialogue.md\"');
    expect(mocked.modelSystems.at(-1)).toContain('Authoritative live teaching state');
    expect((await learningView(principal, study.id)).actions).not.toContain('next');
    studyId = original;
  }, 30000);
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
      mocked.responses = [
        [
          { type: 'text-delta', text: 'Let us inspect the greeting.' },
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
            input: { question: 'No section opened yet' },
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
      expect((await store.binding(queued.sessionId))?.guided?.activeFile).toBe('B-dialogue.md');
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
      expect(assistantParts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'Let us inspect the greeting.' }),
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
      const transcript = (await learningReport(principal, studyId)).conversations.flatMap(
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
        (await learningReport(principal, study.id)).conversations
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
      expect((await store.binding(queued.sessionId))?.guided?.activeFile).toBe('B-dialogue.md');
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
  it('renews on learner activity without changing progress and throttles repeated polls', async () => {
    const study = await freshStudy();
    const before = await store.get(study.id, principal.ownerId);
    const count = mocked.renewals.length;
    expect((await learningView(principal, study.id)).environment?.ready).toBe(true);
    await learningView(principal, study.id);
    await touchEnvironment(store, before, await SandboxService.forOwner(principal));
    expect(mocked.renewals.slice(count)).toEqual([before.environment_id]);
    expect((await store.get(study.id, principal.ownerId)).revision).toBe(before.revision);
  });
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
    const study = await freshStudy();
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
    const study = await freshStudy();
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

  it('keeps teaching tools available while a background poll renews the same environment', async () => {
    const study = await freshStudy();
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
    const polling = learningView(principal, study.id);
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
      await polling;
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
          stageKey: 'intro:-1',
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
  it('integrates scoped files, command evidence, terminal controls, previews and recovery', async () => {
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
    row.state.introCompleted = true;
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
      await expect(fresh.send('checkpoint')).rejects.toThrow();
      const preview = new URL(((await send('preview', { port: 8000 })) as { url: string }).url);
      await expect(
        SandboxService.previewTarget(preview.hash.slice(1), preview.host),
      ).resolves.toMatchObject({ transport: 'native' });
      await expect(send('preview', { port: 49983 })).rejects.toThrow();
      const oldGrant = new URL(
        issuePreviewGrant({ ownerId: principal.ownerId, environmentId, port: 8000, epoch: 0 }).url,
      );
      await expect(
        SandboxService.previewTarget(oldGrant.hash.slice(1), oldGrant.host),
      ).rejects.toMatchObject({ code: 'PBL_WORKSPACE_MANAGED' });
      await store.exclusive(row.id, () => send('stop', { revision: 0 }));
      expect((await workbenchView(principal, row.id)).terminals[0]?.state).toBe('closed');
      await expect(
        SandboxService.previewTarget(preview.hash.slice(1), preview.host),
      ).rejects.toThrow('revoked');
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

  it.each(['run', 'terminal', 'preview'] as const)(
    'fences an admitted %s that reaches creation after Stop has succeeded',
    async (action) => {
      vi.stubEnv('OPENMAIC_SECRET_KEY', 'local-secret-'.repeat(4));
      vi.stubEnv('OPENMAIC_PREVIEW_GATEWAY_KEY', 'local-gateway-'.repeat(4));
      vi.stubEnv('OPENMAIC_APP_ORIGIN', 'https://app.example.com');
      vi.stubEnv('OPENMAIC_SANDBOX_PREVIEW_ORIGIN', 'https://{id}.preview-example.net');
      const fresh = await freshStudy();
      let row = await store.get(fresh.id, principal.ownerId);
      row.state.introCompleted = true;
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
      const originalPreview = SandboxService.prototype.preview;
      const spy =
        action === 'preview'
          ? vi.spyOn(SandboxService.prototype, 'preview').mockImplementation(async function (
              this: SandboxService,
              ...args
            ) {
              await pause();
              return originalPreview.apply(this, args);
            })
          : action === 'run'
            ? vi.spyOn(SandboxStore.prototype, 'reserveCommand').mockImplementation(async function (
                this: SandboxStore,
                ...args
              ) {
                await pause();
                return originalCommand.apply(this, args);
              })
            : vi
                .spyOn(SandboxStore.prototype, 'reserveTerminal')
                .mockImplementation(async function (this: SandboxStore, ...args) {
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
  });

  it.each(['greeting-python-lab', 'greeting-java'])(
    'runs an unregistered imported %s course from pinned resources after its scene changes',
    async (projectId) => {
      const selected = installedProject({ id: projectId, version: '1.0.0' });
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
        ? 'import pathlib,subprocess,sys\nexpected=pathlib.Path(sys.argv[1]).read_text().splitlines()\nactual=[subprocess.run(["java","-cp",sys.argv[2],"Greeting",name],check=True,text=True,stdout=subprocess.PIPE).stdout.strip() for name in ["  Ada  ","Lin"]]\nassert actual==expected\nprint("private course checks passed")\n'
        : 'import pathlib,sys\nsys.path.insert(0,str(pathlib.Path.cwd()/"src"))\nfrom greeting import greet\nexpected=pathlib.Path(sys.argv[1]).read_text().splitlines()\nassert [greet(name) for name in ["  Ada  ","Lin"]]==expected\nprint("private course checks passed")\n';
      bundle.files['tests/private.json'] = JSON.stringify({
        ...(java ? { prepare: ['javac', '-d', '{build}', 'src/Greeting.java'] } : {}),
        cases: [
          {
            id: 'course-owned-private-check',
            argv: [
              'python3',
              '{resources}/tests/private.py',
              '{resources}/rubric/expected.txt',
              ...(java ? ['{build}'] : []),
            ],
            stdout: 'private course checks passed\n',
          },
        ],
      });
      for (const milestone of descriptor.definition.milestones)
        descriptor.runtime.evaluations[milestone.id] = 'tests/private.json';
      bundle.files['project.json'] = JSON.stringify(descriptor);
      // Build a valid course close to the actual 32 KiB budget, with room for a short question.
      const introDoc = descriptor.teaching.find((binding) => binding.stage !== 'intro:-1')!
          .documents[0]!,
        introText = bundle.files[introDoc];
      validateProjectPackage(indexProjectFiles(importedId, selected.ref.version, bundle.files));
      let low = 0,
        high = 4500;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        bundle.files[introDoc] = introText + 'x'.repeat(middle);
        try {
          validateProjectPackage(indexProjectFiles(importedId, selected.ref.version, bundle.files));
          low = middle;
        } catch {
          high = middle - 1;
        }
      }
      bundle.files[introDoc] = introText + 'x'.repeat(Math.max(0, low - 256));
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
            await expect(teachingRunnerConfig(request)).rejects.toMatchObject({
              code: 'PBL_PROMPT_SIZE',
            });
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
        if (isExplorationStage(stage)) {
          expect((await learningReport(principal, created.id)).requiredComplete).toBe(true);
          await turn('I want to explore a course extension.', async (config) => {
            expect(config.allowedToolNames.has('read_next_skill')).toBe(false);
            expect(config.allowedToolNames.has('complete_stage')).toBe(false);
            expect(config.systemPrompt).toContain(`PACKAGED SKILL ${key}`);
            expect(config.systemPrompt).toContain(`PACKAGED REFERENCE ${key}`);
            expect(config.systemPrompt).not.toContain('PACKAGED SKILL greeting:1');
            const path = java ? 'src/Greeting.java' : 'src/greeting.py';
            const original = await service.readText(environmentId, path);
            await invoke(config, 'write_file', {
              path,
              text: original + '\n',
              expectedHash: digest(original),
            });
          });
          await send('checkpoint');
          mocked.missing.add(environmentId);
          await send('prepare');
          const recovered = await learningView(principal, created.id);
          expect(recovered.environmentId).not.toBe(environmentId);
          expect(recovered.state.position.milestoneId).toBe(milestone.id);
          expect((await learningReport(principal, created.id)).requiredComplete).toBe(true);
          break;
        } else if (stage.kind === 'mentor_say' || stage.kind === 'produce') {
          if (stage.kind === 'produce' && stage.writes === 'plan' && !oversizedPlanSaveChecked) {
            const original = await service.readText(environmentId, 'PLAN.md');
            await expect(
              send('save', {
                path: 'PLAN.md',
                text: original + '\n' + 'Learner plan '.repeat(4000),
                expectedHash: digest(original),
              }),
            ).rejects.toMatchObject({ code: 'PBL_PROMPT_SIZE' });
            expect(await service.readText(environmentId, 'PLAN.md')).toBe(original);
            oversizedPlanSaveChecked = true;
          }
          const teaching = descriptor.teaching.find((binding) => binding.stage === key)!;
          for (let part = 0; part < teaching.sections.length; part++) {
            if (part === 1 && !longReplyChecked) {
              const longReply = 'My explanation of this course section. '.repeat(1500);
              await turn(longReply, async (config) => {
                expect(config.systemPrompt).not.toContain(longReply);
                expect(config.liveContext()).toContain('"studentResponseCount":1');
              });
              longReplyChecked = true;
            }
            await turn(part ? 'I reviewed this section.' : 'Please start.', async (config) => {
              const section = await invoke(config, 'read_next_skill', {
                ...(part ? { studentFeedback: 'I reviewed this section.' } : {}),
              });
              expect(JSON.stringify(section)).toContain(`PACKAGED SKILL ${key}`);
              expect(config.systemPrompt).toContain(`PACKAGED REFERENCE ${key}`);
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
                  ).rejects.toMatchObject({ code: 'PBL_PROMPT_SIZE' });
                  expect(await service.readText(environmentId, path)).toBe(original);
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
              if (!oversizedQuestionChecked) {
                await expect(
                  invoke(config, 'request_skill_review', { question: '请'.repeat(2000) }),
                ).rejects.toMatchObject({ code: 'PBL_PROMPT_SIZE' });
                expect(config.isTurnComplete()).toBe(false);
                oversizedQuestionChecked = true;
              }
              await invoke(config, 'request_skill_review', { question: 'Explain this section.' });
            });
          }
          await turn('I reviewed this section.', async (config) => {
            await invoke(config, 'complete_stage', { studentFeedback: 'I reviewed this section.' });
          });
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
});
