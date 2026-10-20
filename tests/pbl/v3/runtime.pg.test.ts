/** Real PG + local Python execution. Model decisions are driven explicitly through the role tools. No cloud or live model calls. */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
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
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool: mocked.pool,
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
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getBackgroundDocumentStore: async () => ({}),
}));
vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  notifyDurableAgentEvent: async () => {},
  subscribeAgentEventWakeup: () => () => {},
}));
vi.mock('@/lib/ai/llm', () => ({
  streamLLM: (options: { messages: ModelMessage[] }) => {
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
import { installedProject } from '@/lib/server/pbl-v3/catalog';
import * as catalog from '@/lib/server/pbl-v3/catalog';
import { SandboxError } from '@/lib/sandbox/errors';
import { LearningStore } from '@/lib/server/pbl-v3/store';
import { commandStudy, learningView, digest } from '@/lib/server/pbl-v3/runtime';
import { teachingRunnerConfig } from '@/lib/server/pbl-v3/runner-tools';
import { startOrchestration } from '@/lib/pbl/v3/domain/orchestration/transition';
import { SandboxService } from '@/lib/server/sandbox/service';
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
  if (!(await store.get(studyId, principal.ownerId)).state.introCompleted) {
    // Generic Agent APIs must not make an old completion valid for a new student message.
    const binding = (await store.roles(studyId)).find((binding) => binding.role === 'mentor')!;
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
    await agents.finishSession(binding.session_id, 'direct-worker', {
      status: 'succeeded',
      expectedAttempt: meta!.attempt,
    });
    expect((await learningView(principal, studyId)).actions).not.toContain('next');
    await expect(command('next')).rejects.toThrow('teaching interaction');
    await runTools('I checked the current part and confirm it.', async (config) => {
      await invoke(config, 'complete_stage', { studentFeedback: 'I checked the current part' });
    });
  }
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
    await expect(command('next')).rejects.toThrow('teaching interaction');
    await runTools('Please start.', async (config) => {
      await expect(
        invoke(config, 'complete_stage', { studentFeedback: 'Please start.' }),
      ).rejects.toThrow();
    });
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
  it('prepares once and runs the complete learning flow with actual Python tests', async () => {
    await command('prepare');
    await guided('teaching'); // project intro
    await guided('teaching'); // concepts
    await expect(command('next')).rejects.toThrow('all milestone decisions');
    await command('decide', { decisionId: 'format', chosen: 'format' });
    await command('next');
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
    expect(tested.state.collected.greeting!.tests?.publicFeedback).toContain('2 checks passed');
    // A previous pass must not authorize progression while a newer run awaits collection.
    await command('evaluate');
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
            input: { studentFeedback: reply },
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
    expect(mocked.renewals.slice(count)).toEqual([before.environment_id]);
    expect((await store.get(study.id, principal.ownerId)).revision).toBe(before.revision);
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
    const send = async (action: string, payload: Record<string, unknown> = {}) =>
      workbenchCommand(principal, row.id, {
        id: randomUUID(),
        revision: (await store.get(row.id, principal.ownerId)).revision,
        environmentId,
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
});
