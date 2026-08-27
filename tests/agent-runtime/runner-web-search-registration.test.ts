/**
 * Runner-level pins for capability-registered `web_search` wiring.
 *
 * The tool-level tests in web-search.test.ts exercise the tool itself. This
 * file drives the actual `runSession` loop through a fake agent (mocked
 * `buildAgent`) so the RUNNER WIRING is observable: the toolset the agent
 * receives, the allowlist it is given, and the system prompt it is built with
 * all depend on whether a web-search backend is configured:
 *
 * - configured: both ask_user and web_search are registered and the prompt
 *   carries the web-search capability block (and no ask_user-only claim);
 * - unconfigured: the toolset is ask_user-only, the allowlist matches, and the
 *   prompt never mentions web_search — the model never sees a dead tool.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { AgentSessionMaterial, ClaimedAgentSession } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  resolveWebSearchCapability: vi.fn(),
  searchWeb: vi.fn(),
  formatSearchResultsAsContext: vi.fn(),
  listSessionMaterials: vi.fn(async (): Promise<AgentSessionMaterial[]> => []),
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
// block. The mock defaults to no materials; individual tests override it to
// observe the prompt block. The real tool builders stay loaded.
vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: mocks.listSessionMaterials };
});

vi.mock('@/lib/web-search', () => ({
  searchWeb: mocks.searchWeb,
  formatSearchResultsAsContext: mocks.formatSearchResultsAsContext,
}));

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

// Keep the real tool builder and prompt block; only the capability resolution
// is faked, so the assertions observe the actual registered tool and prompt.
vi.mock('@/lib/server/agent-runtime/web-search', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/web-search')>();
  return {
    ...actual,
    resolveWebSearchCapability: mocks.resolveWebSearchCapability,
  };
});

// Skills are orthogonal to web_search registration. Pin the runner to a
// deployment with NO installed skills (the skill tools themselves are still
// registered unconditionally) so the web_search-specific toolset and prompt
// assertions below stay focused.
vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return {
    ...actual,
    listSkills: vi.fn(async () => []),
    findSkill: vi.fn(async () => null),
  };
});
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
  prompt(text: string): Promise<void>;
  continue(): Promise<void>;
  waitForIdle(): Promise<void>;
  steer(message: AgentMessage): void;
  abort(): void;
  readonly state: { messages: AgentMessage[]; errorMessage?: string };
}

function makeFakeAgent(): FakeAgent {
  const messages: AgentMessage[] = [];
  const listeners = new Set<(event: AgentEvent, signal?: AbortSignal) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async () => {},
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
  mocks.listSessionMaterials.mockResolvedValue([]);
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue((() => {}) as never);
  mocks.buildAgent.mockReturnValue(makeFakeAgent() as never);
  // The owner-bound document store is never touched in these registration
  // pins (buildAgent is mocked), so a bare forOwner facade is enough.
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

async function runToBuildAgent(): Promise<BuildAgentOptions> {
  const meta = makeMeta();
  const session = await makeEntryTree();
  const store = makeStore(meta);
  mocks.openEntryStorage.mockResolvedValue(session.getStorage());
  mocks.getAgentSessionStore.mockResolvedValue(store);

  let options: BuildAgentOptions | undefined;
  mocks.buildAgent.mockImplementation((agentOptions: BuildAgentOptions) => {
    options = agentOptions;
    return makeFakeAgent();
  });

  await runSession({ running: new Map(), shuttingDown: false }, meta);

  expect(options, 'buildAgent must be called with the run options').toBeDefined();
  expect(store.finishSession).toHaveBeenCalledWith(
    SESSION_ID,
    WORKER_ID,
    expect.objectContaining({ status: 'succeeded' }),
  );
  return options!;
}

describe('web_search runner registration', () => {
  it('registers both tools and the web-search prompt block when a backend is configured', async () => {
    mocks.resolveWebSearchCapability.mockReturnValue({
      providerId: 'searxng',
      apiKey: '',
      baseUrl: 'https://search.example',
    });

    const options = await runToBuildAgent();

    expect(options.tools.map((tool) => tool.name)).toEqual([
      'ask_user',
      'web_search',
      'create_skill',
      'read_skill',
      'patch_skill',
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
      'web_search',
    ]);
    expect(options.systemPrompt).toContain('## Web search');
    expect(options.systemPrompt).toContain('web_search');
    // The material tools are always registered, so their guidance and the
    // untrusted content policy are always in the prompt (reference semantics).
    expect(options.systemPrompt).toContain('## untrusted_content_policy');
    expect(options.systemPrompt).toContain('## Fetch URL');
    // The skill tools are always registered, so the ask_user-only claim is
    // never true in the runner prompt.
    expect(options.systemPrompt).not.toContain('Your only available tool is ask_user');
  });

  it('registers ask_user and the skill tools, but no web-search prompt, when nothing is configured', async () => {
    mocks.resolveWebSearchCapability.mockReturnValue(null);

    const options = await runToBuildAgent();

    expect(options.tools.map((tool) => tool.name)).toEqual([
      'ask_user',
      'create_skill',
      'read_skill',
      'patch_skill',
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
    expect(options.systemPrompt).not.toContain('web_search');
    expect(options.systemPrompt).not.toContain('## Web search');
    // The always-registered material tools keep their prompt blocks regardless
    // of the web-search capability.
    expect(options.systemPrompt).toContain('## untrusted_content_policy');
    expect(options.systemPrompt).toContain('## Fetch URL');
    expect(options.systemPrompt).not.toContain('Your only available tool is ask_user');
  });

  it('wires web_search result URLs to the session URL trust gate', async () => {
    mocks.resolveWebSearchCapability.mockReturnValue({
      providerId: 'searxng',
      apiKey: '',
      baseUrl: 'https://search.example',
    });
    mocks.searchWeb.mockResolvedValue({
      answer: '',
      query: 'q',
      responseTime: 0.1,
      sources: [{ title: 'A', url: 'https://a.example/', content: 'a', score: 1 }],
    });
    mocks.formatSearchResultsAsContext.mockReturnValue('search context');

    const meta = makeMeta();
    const session = await makeEntryTree();
    const store = makeStore(meta);
    mocks.openEntryStorage.mockResolvedValue(session.getStorage());
    mocks.getAgentSessionStore.mockResolvedValue(store);

    let options: BuildAgentOptions | undefined;
    mocks.buildAgent.mockImplementation((agentOptions: BuildAgentOptions) => {
      options = agentOptions;
      return makeFakeAgent();
    });

    await runSession({ running: new Map(), shuttingDown: false }, meta);

    const tool = options!.tools.find(
      (candidate) => candidate.name === 'web_search',
    )! as unknown as {
      execute: (id: string, params: never, signal?: AbortSignal) => Promise<unknown>;
    };
    await tool.execute('call_1', { query: 'q' } as never, undefined);

    // The runner-bound callback registers with THIS session id and the
    // web_search source, before the tool result is returned.
    expect(store.registerSessionUrls).toHaveBeenCalledWith(
      SESSION_ID,
      ['https://a.example/'],
      'web_search',
    );
  });

  it('lists the session materials in the system prompt so the model knows what it can read', async () => {
    mocks.resolveWebSearchCapability.mockReturnValue(null);
    mocks.listSessionMaterials.mockResolvedValue([
      {
        id: 'mat_web1',
        sessionId: SESSION_ID,
        kind: 'web',
        title: 'Example article',
        sourceUrl: 'https://example.com/a',
        textAssetId: 'ast_1',
        rawAssetId: null,
        textChars: 1200,
        derivedFrom: null,
        extraction: { status: 'done', attempts: 0 },
        createdAt: new Date(0).toISOString(),
      },
    ]);

    const options = await runToBuildAgent();

    expect(mocks.listSessionMaterials).toHaveBeenCalledWith(SESSION_ID);
    expect(options.systemPrompt).toContain('## Registered session materials');
    expect(options.systemPrompt).toContain('Example article');
    expect(options.systemPrompt).toContain('list_materials');
    expect(options.systemPrompt).toContain('read_material');
    expect(options.systemPrompt).toContain('search_material');
  });

  it('omits the materials block when the session has no materials', async () => {
    mocks.resolveWebSearchCapability.mockReturnValue(null);
    mocks.listSessionMaterials.mockResolvedValue([]);

    const options = await runToBuildAgent();

    expect(options.systemPrompt).not.toContain('## Registered session materials');
  });
});
