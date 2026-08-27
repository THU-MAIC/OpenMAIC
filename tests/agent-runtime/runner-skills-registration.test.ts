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
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession } from '@openmaic/storage';
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

// Real skill loader, real read tool, real preload builder; only the
// owner-scoped user-skill store is neutralized (no database in this test).
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

import { runSession } from '@/lib/server/agent-runtime/runner';

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
    ...overrides,
  };
}

function makeStore(meta: ClaimedAgentSession) {
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
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    registerSessionUrls: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
}

async function makeEntryTree(): Promise<Session> {
  const repo = new InMemorySessionRepo();
  return repo.create({ id: SESSION_ID });
}

interface FakeAgent {
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
  systemPrompt: string;
  tools: Array<{ name: string }>;
  allowedToolNames?: ReadonlySet<string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue((() => {}) as never);
  // The owner-bound document store is never touched in these runner pins
  // (buildAgent is mocked), so a bare forOwner facade is enough.
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

interface RunOutcome {
  options: BuildAgentOptions;
  promptedWith: unknown;
}

async function runToBuildAgent(
  metaOverrides: Partial<ClaimedAgentSession> = {},
): Promise<RunOutcome> {
  const meta = makeMeta(metaOverrides);
  const session = await makeEntryTree();
  const store = makeStore(meta);
  mocks.openEntryStorage.mockResolvedValue(session.getStorage());
  mocks.getAgentSessionStore.mockResolvedValue(store);

  let options: BuildAgentOptions | undefined;
  const promptedWith: unknown[] = [];
  mocks.buildAgent.mockImplementation((agentOptions: BuildAgentOptions) => {
    options = agentOptions;
    return makeFakeAgent((input) => promptedWith.push(input));
  });

  await runSession({ running: new Map(), shuttingDown: false }, meta);

  expect(options, 'buildAgent must be called with the run options').toBeDefined();
  expect(store.finishSession).toHaveBeenCalledWith(
    SESSION_ID,
    WORKER_ID,
    expect.objectContaining({ status: 'succeeded' }),
  );
  return { options: options!, promptedWith: promptedWith[0] };
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
      'list_materials',
      'list_scenes',
      'list_voices',
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

  it('reuses the fixture temp dir so the loader reads real files', () => {
    expect(fixture.root).toBe(process.env.OPENMAIC_AGENT_SKILLS_DIR);
  });
});
