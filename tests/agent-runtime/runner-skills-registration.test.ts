/**
 * Runner-level pins for the skills wiring.
 *
 * The tool-level tests in skills.test.ts / skill-preload.test.ts exercise the
 * pure pieces. This file drives the actual `runSession` loop through a fake
 * agent (mocked `buildAgent`) with REAL skills loaded from a temp directory, so
 * the RUNNER WIRING is observable:
 *
 * - the toolset the agent receives includes the skill tools and, when skills
 *   are installed, the skill-scoped native `read` tool;
 * - the allowlist matches the toolset;
 * - the system prompt carries the `<available_skills>` discovery block;
 * - a prompt naming a `/handle` reaches `agent.prompt()` as the three-message
 *   group (user → assistant(toolCall read) → toolResult), and a session with a
 *   frozen `skillId` loads that skill even when the text names no handle.
 */
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession, PersistedAgentSessionEvent } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Point the real skill loader at a temp directory BEFORE config.ts loads. */
const fixture = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports -- vi.hoisted runs before
     module imports, and OPENMAIC_AGENT_SKILLS_DIR must be set before config.ts loads. */
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = mkdtempSync(join(tmpdir(), 'skill-runner-'));
  for (const [name, body] of [
    ['pro-editing', 'Edit an EXISTING course.'],
    ['stage-design', 'Design a stage.'],
  ] as const) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ntitle: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\n${body}\n`,
      'utf8',
    );
  }
  process.env.OPENMAIC_AGENT_SKILLS_DIR = root;
  return { root };
});

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  findDeletedUserSkill: vi.fn(),
  listUserSkills: vi.fn(),
  findUserSkillByRef: vi.fn(),
  patchUserSkill: vi.fn(),
}));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomUUID: mocks.randomUUID };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

// The runner lists the session's materials to build the materials prompt
// block. No material store exists in this harness; an empty list keeps the
// prompt free of the block while the real tool builders stay loaded.
vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: vi.fn(async () => []) };
});
// The runner lists what the session reaches through the shared resolver;
// links need a database these tests do not have.
vi.mock('@/lib/server/agent-runtime/material-resolver', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/material-resolver')>();
  return {
    ...actual,
    listSessionScopeMaterials: vi.fn(async () => []),
  };
});

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return {
    ...actual,
    AgentSessionEntryStorage: {
      open: mocks.openEntryStorage,
    },
  };
});

vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: mocks.resolveAgentDriverModel,
}));

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
}));
vi.mock('@/lib/persistence/owner-merges', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/persistence/owner-merges')>();
  return { ...actual, canonicalizeStoredOwner: async (ownerId: string) => ownerId };
});

// Real skill loader, real read tool, real preload builder; only the
// owner-scoped user-skill store is neutralized (no database in this test).
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return {
    ...actual,
    listUserSkills: mocks.listUserSkills,
    findDeletedUserSkill: mocks.findDeletedUserSkill,
    findUserSkillByRef: mocks.findUserSkillByRef,
    patchUserSkill: mocks.patchUserSkill,
  };
});

import { runSession, tagDurableUserMessage } from '@/lib/server/agent-runtime/runner';

const SESSION_ID = 'session-1';
/** Mirrors the runner's `WORKER_ID` derivation with the fixed mock uuid. */
const WORKER_ID = `runner-t:${process.pid}`;

function makeMeta(overrides: Partial<ClaimedAgentSession> = {}): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'owner-1',
    prompt: 'Help me',
    stageId: 'stage-1',
    existingCourse: false,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    claimReason: 'queued',
    claimSeq: 0,
    deliveredUserMessageSeq: 0,
    ...overrides,
  };
}

function makeStore(meta: ClaimedAgentSession, events: PersistedAgentSessionEvent[] = []) {
  let seq = 0;
  return {
    appendRunEvent: vi.fn(
      async (
        _id: string,
        _workerId: string,
        _event: { type: string; data?: Record<string, unknown> },
      ) => {
        seq += 1;
        return seq;
      },
    ),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    readEventsAfter: vi.fn(async (_id: string, after: number) =>
      events.filter((event) => event.id > after),
    ),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    markUserMessageDelivered: vi.fn(async () => true),
    registerSessionUrls: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
    detachSessionSkill: vi.fn(async () => {
      delete meta.skillId;
      return true;
    }),
  };
}

async function makeEntryTree(): Promise<Session> {
  const repo = new InMemorySessionRepo();
  return repo.create({ id: SESSION_ID });
}

interface FakeAgent {
  emit(event: AgentEvent): void;
  subscribe(listener: (event: AgentEvent, signal?: AbortSignal) => void): () => void;
  prompt(input: unknown): Promise<void>;
  continue(): Promise<void>;
  waitForIdle(): Promise<void>;
  steer(message: AgentMessage): void;
  abort(): void;
  readonly state: { messages: AgentMessage[]; errorMessage?: string };
}

function makeFakeAgent(promptSpy: (input: unknown) => void): FakeAgent {
  const messages: AgentMessage[] = [];
  const listeners = new Set<(event: AgentEvent, signal?: AbortSignal) => void>();
  return {
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (input: unknown) => promptSpy(input),
    continue: async () => {},
    waitForIdle: async () => {},
    steer: () => {},
    abort: () => {},
    state: {
      get messages() {
        return messages;
      },
      errorMessage: undefined,
    },
  };
}

interface BuildAgentOptions {
  streamFn: StreamFn;
  systemPrompt: string;
  tools: AgentTool[];
  allowedToolNames?: ReadonlySet<string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findDeletedUserSkill.mockResolvedValue(null);
  mocks.listUserSkills.mockResolvedValue([]);
  mocks.findUserSkillByRef.mockResolvedValue(null);
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue(vi.fn());
  // The owner-bound document store is never touched in these runner pins
  // (buildAgent is mocked), so a bare forOwner facade is enough.
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

interface RunOutcome {
  options: BuildAgentOptions;
  promptedWith: unknown;
  meta: ClaimedAgentSession;
  store: ReturnType<typeof makeStore>;
}

async function runToBuildAgent(
  metaOverrides: Partial<ClaimedAgentSession> = {},
  events: PersistedAgentSessionEvent[] = [],
  history: AgentMessage[] = [],
  onPrompt?: (options: BuildAgentOptions, agent: FakeAgent) => Promise<void>,
): Promise<RunOutcome> {
  const meta = makeMeta(metaOverrides);
  const session = await makeEntryTree();
  for (const message of history) await session.appendMessage(message);
  const store = makeStore(meta, events);
  mocks.openEntryStorage.mockResolvedValue(session.getStorage());
  mocks.getAgentSessionStore.mockResolvedValue(store);

  let options: BuildAgentOptions | undefined;
  const promptedWith: unknown[] = [];
  mocks.buildAgent.mockImplementation((agentOptions: BuildAgentOptions) => {
    options = agentOptions;
    const agent = makeFakeAgent((input) => promptedWith.push(input));
    const prompt = agent.prompt;
    agent.prompt = async (input) => {
      await prompt(input);
      await onPrompt?.(agentOptions, agent);
    };
    return agent;
  });

  await runSession({ running: new Map(), shuttingDown: false }, meta);

  expect(options, 'buildAgent must be called with the run options').toBeDefined();
  expect(store.finishSession).toHaveBeenCalledWith(
    SESSION_ID,
    WORKER_ID,
    expect.objectContaining({ status: 'succeeded' }),
  );
  return { options: options!, promptedWith: promptedWith[0], meta, store };
}

describe('skills runner registration', () => {
  it('registers the skill tools and the skill-scoped read tool, with a matching allowlist and prompt block', async () => {
    const { options } = await runToBuildAgent();

    expect(options.tools.map((tool) => tool.name)).toEqual([
      'ask_user',
      'create_skill',
      'read_skill',
      'patch_skill',
      'read',
      'fetch_url',
      'generate_scene',
      'list_scenes',
      'generate_actions',
      'duplicate_scene',
      'import_pptx',
      'generate_image',
      'generate_tts',
      'edit_deck',
      'use_material_media',
      'read_stage',
      'patch_stage',
      'grep_stage',
      'create_stage',
      'create_folder',
      'move_to_folder',
      'rename_stage',
      'list_folder_stages',
      'read_stage_outline',
      'list_materials',
      'read_material',
      'search_material',
      'extract_material',
      'wait_for_materials',
      'list_material_folders',
      'create_material_folder',
      'rename_material_folder',
      'move_materials',
      'rename_material',
      'list_voices',
      'set_roster',
      'clip_audio',
      'search_classrooms',
      'read_classroom',
      'search_chats',
      'read_chat',
    ]);
    expect([...(options.allowedToolNames ?? [])].sort()).toEqual([
      'ask_user',
      'clip_audio',
      'create_folder',
      'create_material_folder',
      'create_skill',
      'create_stage',
      'duplicate_scene',
      'edit_deck',
      'extract_material',
      'fetch_url',
      'generate_actions',
      'generate_image',
      'generate_scene',
      'generate_tts',
      'grep_stage',
      'import_pptx',
      'list_folder_stages',
      'list_material_folders',
      'list_materials',
      'list_scenes',
      'list_voices',
      'move_materials',
      'move_to_folder',
      'patch_skill',
      'patch_stage',
      'read',
      'read_chat',
      'read_classroom',
      'read_material',
      'read_skill',
      'read_stage',
      'read_stage_outline',
      'rename_material',
      'rename_material_folder',
      'rename_stage',
      'search_chats',
      'search_classrooms',
      'search_material',
      'set_roster',
      'use_material_media',
      'wait_for_materials',
    ]);
    expect(options.systemPrompt).toContain('<available_skills>');
    expect(options.systemPrompt).toContain('<name>pro-editing</name>');
    expect(options.systemPrompt).toContain('<name>stage-design</name>');
  });

  it('delivers a named /handle as the three-message preload group', async () => {
    const { promptedWith } = await runToBuildAgent({
      prompt: '/pro-editing make page three better',
    });

    expect(Array.isArray(promptedWith)).toBe(true);
    const group = promptedWith as Array<{ role?: string; content?: unknown[] }>;
    expect(group.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    const call = (group[1]!.content as Array<{ type?: string; name?: string }>)[0]!;
    expect(call).toMatchObject({ type: 'toolCall', name: 'read' });
    const receipt = group[2] as unknown as { toolName?: string; details?: { skill?: string } };
    expect(receipt.toolName).toBe('read');
    expect(receipt.details?.skill).toBe('pro-editing');
  });

  it('force-loads the frozen session skillId even when the text names no handle', async () => {
    const { promptedWith } = await runToBuildAgent({
      prompt: 'Build a refraction lesson',
      skillId: 'stage-design',
    });

    const group = promptedWith as Array<{ role?: string; content?: unknown[] }>;
    expect(group.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    const call = (group[1]!.content as Array<{ type?: string; name?: string }>)[0]!;
    expect(call).toMatchObject({ type: 'toolCall', name: 'read' });
    const receipt = group[2] as unknown as { details?: { skill?: string } };
    expect(receipt.details?.skill).toBe('stage-design');
  });

  it('fails a run whose frozen skillId is not installed', async () => {
    const meta = makeMeta({ skillId: 'no-such-skill' });
    const session = await makeEntryTree();
    const store = makeStore(meta);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.buildAgent.mockImplementation(() => makeFakeAgent(() => undefined));

    await runSession({ running: new Map(), shuttingDown: false }, meta);

    // The setup error settles the session as failed rather than building an agent.
    expect(mocks.buildAgent).not.toHaveBeenCalled();
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({
        status: 'failed',
        error: 'session skill "no-such-skill" is unavailable for its owner',
      }),
    );
  });

  it('sends a plain text prompt when the message names no skill', async () => {
    const { promptedWith } = await runToBuildAgent({ prompt: 'Just help me out' });

    expect(promptedWith).toBe('Just help me out');
  });

  it('persists deletion recovery, continues the same request, and does not detach again next run', async () => {
    mocks.findDeletedUserSkill.mockResolvedValue({ id: 'usk_deleted', name: 'my-method' });
    const first = await runToBuildAgent({ skillId: 'usk_deleted', prompt: 'Just help me out' });
    expect(first.promptedWith).toBe('Just help me out');
    expect(mocks.findDeletedUserSkill).toHaveBeenCalledWith('usk_deleted', 'owner-1');
    expect(first.store.detachSessionSkill).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        ownerId: 'owner-1',
        workerId: WORKER_ID,
        attempt: 1,
        skillId: 'usk_deleted',
        notice: expect.objectContaining({
          type: 'skill_detached',
          data: { skillName: 'my-method', throughMessageSeq: 0 },
        }),
      }),
    );
    expect(first.store.appendRunEvent.mock.calls[0]![2].type).toBe('session_start');
    expect(first.meta).not.toHaveProperty('skillId');
    const second = await runToBuildAgent(first.meta);
    expect(second.store.detachSessionSkill).not.toHaveBeenCalled();
    expect(second.promptedWith).toBe('Just help me out');
  });

  it('still preloads an explicitly requested available Skill after deletion recovery', async () => {
    mocks.findDeletedUserSkill.mockResolvedValue({ id: 'usk_deleted', name: 'my-method' });
    const result = await runToBuildAgent({
      skillId: 'usk_deleted',
      prompt: '/pro-editing adjust the title',
    });
    const group = result.promptedWith as Array<{ role: string; details?: { skill?: string } }>;
    expect(group.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(group[2]!.details?.skill).toBe('pro-editing');
  });

  it.each(['recover', 'restart', 'explicit follow-up', 'first follow-up'])(
    'handles a same-name replacement without replaying old intent (%s)',
    async (mode) => {
      mocks.findDeletedUserSkill.mockResolvedValue({ id: 'usk_deleted', name: 'my-method' });
      const replacement = {
        id: 'usk_replacement',
        ownerId: 'owner-1',
        name: 'my-method',
        title: 'Replacement',
        description: 'New instructions',
        content: 'Only these new instructions.',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mocks.listUserSkills.mockResolvedValue([replacement]);
      mocks.findUserSkillByRef.mockResolvedValue(replacement);
      mocks.patchUserSkill.mockResolvedValue({
        skill: replacement,
        applied: [{ status: 'applied' }],
        changed: true,
      });
      const prompt = '/my-method Just help me out';
      const events: PersistedAgentSessionEvent[] = [
        { id: 1, ts: 1, attempt: 0, type: 'user_message', data: { text: prompt } },
      ];
      if (mode !== 'recover' && mode !== 'first follow-up') {
        events.push({
          id: 2,
          ts: 2,
          attempt: 1,
          type: 'skill_detached',
          data: { skillName: 'my-method', throughMessageSeq: 1 },
        });
      }
      if (mode === 'explicit follow-up') {
        events.push({ id: 3, ts: 3, attempt: 0, type: 'user_message', data: { text: prompt } });
      }
      const history: AgentMessage[] = [];
      if (mode === 'first follow-up') {
        events.splice(
          0,
          events.length,
          { id: 1, ts: 1, attempt: 1, type: 'session_start', data: { prompt } },
          { id: 2, ts: 2, attempt: 1, type: 'session_end', data: { status: 'succeeded' } },
          { id: 3, ts: 3, attempt: 0, type: 'user_message', data: { text: prompt } },
        );
        history.push({ role: 'user', content: prompt, timestamp: 1 }, {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
          timestamp: 2,
        } as unknown as AgentMessage);
      }
      const explicit = mode === 'explicit follow-up' || mode === 'first follow-up';
      const result = await runToBuildAgent(
        {
          skillId: mode === 'recover' || mode === 'first follow-up' ? 'usk_deleted' : undefined,
          prompt,
          deliveredUserMessageSeq: mode === 'explicit follow-up' ? 1 : 0,
        },
        events,
        history,
      );
      const group = result.promptedWith as Array<{ role: string; details?: { skill?: string } }>;
      expect(group.map((message) => message.role)).toEqual(
        explicit ? ['user', 'assistant', 'toolResult'] : ['user'],
      );
      if (explicit) expect(group[2]!.details?.skill).toBe('usk_replacement');
      const read = result.options.tools.find((tool) => tool.name === 'read')!;
      const nativeRead = () =>
        read.execute('read-replacement', {
          path: '/__openmaic_user_skills__/usk_replacement/SKILL.md',
        });
      const sourceRead = await result.options.tools
        .find((tool) => tool.name === 'read_skill')!
        .execute('read-source', { skillId: '/my-method' });
      const patch = await result.options.tools
        .find((tool) => tool.name === 'patch_skill')!
        .execute('patch-replacement', {
          skillId: '/my-method',
          intent: 'Change the Skill',
          ops: [{ op: 'set', path: '/content', value: 'Changed' }],
        });
      if (explicit) {
        expect(result.options.systemPrompt).toContain('usk_replacement');
        expect(await nativeRead()).toMatchObject({ details: { skill: 'usk_replacement' } });
        expect(sourceRead).not.toHaveProperty('isError', true);
        expect(patch).not.toHaveProperty('isError', true);
        expect(mocks.patchUserSkill).toHaveBeenCalledWith(
          'owner-1',
          replacement.id,
          expect.any(Array),
        );
      } else {
        await expect(nativeRead()).rejects.toThrow('read is limited');
        expect(result.options.systemPrompt).not.toContain('usk_replacement');
        expect(sourceRead).toHaveProperty('isError', true);
        expect(JSON.stringify(sourceRead)).not.toContain(replacement.content);
        expect(patch).toHaveProperty('isError', true);
        expect(mocks.patchUserSkill).not.toHaveBeenCalled();
      }
      expect(result.meta.skillId).toBeUndefined();
    },
  );

  it('includes a transcript-consumed message in the durable detachment boundary', async () => {
    mocks.findDeletedUserSkill.mockResolvedValue({ id: 'usk_deleted', name: 'my-method' });
    mocks.listUserSkills.mockResolvedValue([
      {
        id: 'usk_replacement',
        ownerId: 'owner-1',
        name: 'my-method',
        title: 'Replacement',
        description: 'Replacement',
        content: 'New instructions',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const prompt = '/my-method continue';
    const result = await runToBuildAgent(
      { skillId: 'usk_deleted', prompt, claimReason: 'orphaned', deliveredUserMessageSeq: 1 },
      [
        { id: 1, ts: 1, attempt: 0, type: 'user_message', data: { text: 'Start' } },
        { id: 2, ts: 2, attempt: 1, type: 'session_start', data: {} },
        { id: 7, ts: 7, attempt: 0, type: 'user_message', data: { text: prompt } },
      ],
      [tagDurableUserMessage({ role: 'user', content: prompt, timestamp: 7 }, 7)],
    );
    expect(result.store.detachSessionSkill).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        notice: expect.objectContaining({
          data: { skillName: 'my-method', throughMessageSeq: 7 },
        }),
      }),
    );
    expect(result.promptedWith).toBeUndefined(); // continue, without replacement preload
    expect(result.options.systemPrompt).not.toContain('usk_replacement');
    await expect(
      result.options.tools
        .find((tool) => tool.name === 'read')!
        .execute('read-replacement', {
          path: '/__openmaic_user_skills__/usk_replacement/SKILL.md',
        }),
    ).rejects.toThrow('read is limited');
  });

  it('updates discovery and both readers only when a fresh same-run message is consumed', async () => {
    const replacement = {
      id: 'usk_replacement',
      ownerId: 'owner-1',
      name: 'my-method',
      title: 'Replacement',
      description: 'Replacement',
      content: 'New instructions',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.listUserSkills.mockResolvedValue([replacement]);
    mocks.findUserSkillByRef.mockResolvedValue(replacement);
    const prompt = '/my-method Start';
    await runToBuildAgent(
      { prompt },
      [
        { id: 1, ts: 1, attempt: 0, type: 'user_message', data: { text: prompt } },
        {
          id: 2,
          ts: 2,
          attempt: 1,
          type: 'skill_detached',
          data: { skillName: 'my-method', throughMessageSeq: 1 },
        },
      ],
      [],
      async (options, agent) => {
        const nativeRead = () =>
          options.tools
            .find((tool) => tool.name === 'read')!
            .execute('read-replacement', {
              path: '/__openmaic_user_skills__/usk_replacement/SKILL.md',
            });
        const sourceRead = () =>
          options.tools
            .find((tool) => tool.name === 'read_skill')!
            .execute('read-source', { skillId: '/my-method' });
        const callProvider = () =>
          options.streamFn({} as Parameters<StreamFn>[0], {
            systemPrompt: options.systemPrompt,
            messages: [],
          });
        await callProvider();
        expect(mocks.createCallLlmStreamFn.mock.results[0]!.value).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ systemPrompt: expect.not.stringContaining('usk_replacement') }),
          undefined,
        );
        await expect(nativeRead()).rejects.toThrow('read is limited');
        expect(await sourceRead()).toHaveProperty('isError', true);
        agent.emit({
          type: 'message_end',
          message: tagDurableUserMessage(
            {
              role: 'user',
              content: '/my-method use the replacement',
              timestamp: 3,
            },
            3,
          ),
        });
        await callProvider();
        expect(mocks.createCallLlmStreamFn.mock.results[0]!.value).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ systemPrompt: expect.stringContaining('usk_replacement') }),
          undefined,
        );
        expect(await nativeRead()).toMatchObject({ details: { skill: replacement.id } });
        expect(await sourceRead()).not.toHaveProperty('isError', true);
      },
    );
  });

  it('discards a confirmed deletion from the snapshot even for a fresh follow-up', async () => {
    const deleted = {
      id: 'usk_deleted',
      ownerId: 'owner-1',
      name: 'my-method',
      title: 'Old',
      description: 'Old skill',
      content: 'Deleted instructions',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mocks.listUserSkills.mockResolvedValueOnce([deleted]).mockResolvedValue([]);
    mocks.findDeletedUserSkill.mockResolvedValue({ id: deleted.id, name: deleted.name });
    const result = await runToBuildAgent(
      { skillId: deleted.id, deliveredUserMessageSeq: 1, prompt: 'Start' },
      [
        { id: 1, ts: 1, attempt: 0, type: 'user_message', data: { text: 'Start' } },
        { id: 2, ts: 2, attempt: 1, type: 'session_start', data: {} },
        { id: 3, ts: 3, attempt: 0, type: 'user_message', data: { text: '/my-method continue' } },
      ],
      [
        { role: 'user', content: 'Start', timestamp: 1 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
          stopReason: 'stop',
          timestamp: 2,
        } as unknown as AgentMessage,
      ],
    );
    const group = result.promptedWith as AgentMessage[];
    expect(group.map((message) => message.role)).toEqual(['user']);
    expect(result.options.systemPrompt).not.toContain(deleted.id);
    await expect(
      result.options.tools
        .find((tool) => tool.name === 'read')!
        .execute('read-deleted', { path: `/__openmaic_user_skills__/${deleted.id}/SKILL.md` }),
    ).rejects.toThrow('read is limited');
  });

  it.each(['missing', 'database', 'lease'])(
    'does not silently recover from %s errors',
    async (failure) => {
      const meta = makeMeta({ skillId: 'usk_deleted' });
      const session = await makeEntryTree();
      const store = makeStore(meta);
      mocks.openEntryStorage.mockResolvedValue(session.getStorage());
      mocks.getAgentSessionStore.mockResolvedValue(store);
      if (failure === 'database')
        mocks.findDeletedUserSkill.mockRejectedValue(new Error('database unavailable'));
      if (failure === 'lease') {
        mocks.findDeletedUserSkill.mockResolvedValue({ id: 'usk_deleted', name: 'my-method' });
        store.detachSessionSkill.mockResolvedValue(false);
      }
      await runSession({ running: new Map(), shuttingDown: false }, meta);
      expect(mocks.buildAgent).not.toHaveBeenCalled();
      if (failure !== 'lease') expect(store.detachSessionSkill).not.toHaveBeenCalled();
    },
  );

  it('reuses the fixture temp dir so the loader reads real files', () => {
    expect(fixture.root).toBe(process.env.OPENMAIC_AGENT_SKILLS_DIR);
  });
});
