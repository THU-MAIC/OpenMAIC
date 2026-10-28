/**
 * Focused tests for runner media tool capability registration.
 *
 * Verifies that:
 * - generate_tts is registered only when the run owner's TTS connection resolves to a usable provider;
 * - generate_image is registered only when the owner's image connection resolves to a usable provider;
 * - unavailable tools are omitted from both options.tools and options.allowedToolNames;
 * - list_voices and set_roster remain registered regardless of TTS provider availability;
 * - the system prompt includes the discipline instruction to use only registered tools.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { AgentSessionMaterial, ClaimedAgentSession } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runSession } from '@/lib/server/agent-runtime/runner';
import {
  hasConfiguredTtsCapability,
  hasConfiguredTtsGeneration,
} from '@/lib/server/agent-runtime/course-edit/tools';
import {
  hasConfiguredImageCapability,
  hasConfiguredImageGeneration,
} from '@/lib/server/agent-runtime/generate-image';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  resolveWebSearchCapability: vi.fn(),
  listSessionMaterials: vi.fn(async (_sessionId: string): Promise<AgentSessionMaterial[]> => []),
  serverMediaConnection: vi.fn(),
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

vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: mocks.listSessionMaterials };
});

vi.mock('@/lib/server/agent-runtime/material-resolver', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/material-resolver')>();
  return {
    ...actual,
    listSessionScopeMaterials: async (sessionId: string) =>
      (await mocks.listSessionMaterials(sessionId)).map((record) => ({
        origin: 'session' as const,
        record,
      })),
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

vi.mock('@/lib/server/agent-runtime/web-search', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/web-search')>();
  return {
    ...actual,
    resolveWebSearchCapability: mocks.resolveWebSearchCapability,
  };
});

vi.mock('@/lib/server/model-config/media', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/server/model-config/media')>()),
  serverMediaConnection: vi.fn(async (slot: string, ownerId?: string) =>
    mocks.serverMediaConnection(slot, ownerId),
  ),
}));

vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return {
    ...actual,
    listSkills: vi.fn(async () => []),
    findSkill: vi.fn(async () => null),
  };
});

const SESSION_ID = 'session-media-1';
const WORKER_ID = 'worker-media-1';

function makeMeta(): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'user:test-owner',
    attempt: 1,
    status: 'claimed',
    updatedAt: new Date(),
    claimSeq: 1,
  } as unknown as ClaimedAgentSession;
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
    readEventsAfter: vi.fn(async () => []),
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

function makeFakeAgent() {
  const messages: AgentMessage[] = [];
  const listeners = new Set<(event: AgentEvent, signal?: AbortSignal) => void>();
  return {
    subscribe: (listener: (event: AgentEvent, signal?: AbortSignal) => void) => {
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
  return options!;
}

const usableTtsConnection = {
  providerId: 'qwen-tts',
  apiKey: 'test-tts-key',
  managed: true,
  userEndpoint: false,
  origin: 'configuration' as const,
};

const usableImageConnection = {
  providerId: 'seedream',
  apiKey: 'test-image-key',
  managed: true,
  userEndpoint: false,
  origin: 'configuration' as const,
};

describe('runner media tool capability registration', () => {
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
    mocks.resolveWebSearchCapability.mockReturnValue(null);
    mocks.serverMediaConnection.mockResolvedValue(null);
    mocks.getServerPersistenceProvider.mockResolvedValue({
      documentStore: { forOwner: () => ({}) },
    });
  });

  it('proves tool registration with no providers: omits generate_tts and generate_image', async () => {
    mocks.serverMediaConnection.mockResolvedValue(null);

    const options = await runToBuildAgent();
    const toolNames = options.tools.map((tool) => tool.name);
    const allowed = options.allowedToolNames ?? new Set();

    expect(toolNames).not.toContain('generate_tts');
    expect(toolNames).not.toContain('generate_image');
    expect(allowed.has('generate_tts')).toBe(false);
    expect(allowed.has('generate_image')).toBe(false);

    // Unrelated tools remain registered
    expect(toolNames).toContain('list_voices');
    expect(toolNames).toContain('set_roster');
    expect(toolNames).toContain('edit_deck');
    expect(toolNames).toContain('ask_user');

    // Runner prompt carries the discipline instruction
    expect(options.systemPrompt).toContain(
      'Use only registered tools and skip unavailable steps such as narration or image generation.',
    );
  });

  it('proves tool registration with TTS only: registers generate_tts and omits generate_image', async () => {
    mocks.serverMediaConnection.mockImplementation(async (slot: string) => {
      if (slot === 'tts') return usableTtsConnection;
      return null;
    });

    const options = await runToBuildAgent();
    const toolNames = options.tools.map((tool) => tool.name);
    const allowed = options.allowedToolNames ?? new Set();

    expect(toolNames).toContain('generate_tts');
    expect(toolNames).not.toContain('generate_image');
    expect(allowed.has('generate_tts')).toBe(true);
    expect(allowed.has('generate_image')).toBe(false);

    // Unrelated tools remain registered
    expect(toolNames).toContain('list_voices');
    expect(toolNames).toContain('set_roster');
    expect(toolNames).toContain('edit_deck');

    expect(options.systemPrompt).toContain(
      'Use only registered tools and skip unavailable steps such as narration or image generation.',
    );
  });

  it('proves tool registration with image only: registers generate_image and omits generate_tts', async () => {
    mocks.serverMediaConnection.mockImplementation(async (slot: string) => {
      if (slot === 'image') return usableImageConnection;
      return null;
    });

    const options = await runToBuildAgent();
    const toolNames = options.tools.map((tool) => tool.name);
    const allowed = options.allowedToolNames ?? new Set();

    expect(toolNames).toContain('generate_image');
    expect(toolNames).not.toContain('generate_tts');
    expect(allowed.has('generate_image')).toBe(true);
    expect(allowed.has('generate_tts')).toBe(false);

    // Unrelated tools remain registered
    expect(toolNames).toContain('list_voices');
    expect(toolNames).toContain('set_roster');
    expect(toolNames).toContain('edit_deck');

    expect(options.systemPrompt).toContain(
      'Use only registered tools and skip unavailable steps such as narration or image generation.',
    );
  });

  it('proves tool registration with both providers: registers both generate_tts and generate_image', async () => {
    mocks.serverMediaConnection.mockImplementation(async (slot: string) => {
      if (slot === 'tts') return usableTtsConnection;
      if (slot === 'image') return usableImageConnection;
      return null;
    });

    const options = await runToBuildAgent();
    const toolNames = options.tools.map((tool) => tool.name);
    const allowed = options.allowedToolNames ?? new Set();

    expect(toolNames).toContain('generate_tts');
    expect(toolNames).toContain('generate_image');
    expect(allowed.has('generate_tts')).toBe(true);
    expect(allowed.has('generate_image')).toBe(true);

    // Unrelated tools remain registered
    expect(toolNames).toContain('list_voices');
    expect(toolNames).toContain('set_roster');
    expect(toolNames).toContain('edit_deck');

    expect(options.systemPrompt).toContain(
      'Use only registered tools and skip unavailable steps such as narration or image generation.',
    );
  });
});

describe('media capability gates unit tests', () => {
  it('hasConfiguredTtsCapability validates presence, off, browser-native and api key', () => {
    expect(hasConfiguredTtsCapability(null)).toBe(false);
    expect(hasConfiguredTtsCapability(undefined)).toBe(false);
    expect(hasConfiguredTtsCapability('off')).toBe(false);
    expect(
      hasConfiguredTtsCapability({
        providerId: 'browser-native-tts',
        apiKey: 'key',
        managed: false,
        userEndpoint: false,
        origin: 'configuration',
      }),
    ).toBe(false);
    expect(
      hasConfiguredTtsCapability({
        providerId: 'qwen-tts',
        apiKey: '',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      }),
    ).toBe(false);
    expect(
      hasConfiguredTtsCapability({
        providerId: 'qwen-tts',
        apiKey: 'test-key',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      }),
    ).toBe(true);
    expect(hasConfiguredTtsGeneration).toBe(hasConfiguredTtsCapability);
  });

  it('hasConfiguredImageCapability validates presence, off, and api key', () => {
    expect(hasConfiguredImageCapability(null)).toBe(false);
    expect(hasConfiguredImageCapability(undefined)).toBe(false);
    expect(hasConfiguredImageCapability('off')).toBe(false);
    expect(
      hasConfiguredImageCapability({
        providerId: 'seedream',
        apiKey: '',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      }),
    ).toBe(false);
    expect(
      hasConfiguredImageCapability({
        providerId: 'seedream',
        apiKey: 'test-key',
        managed: true,
        userEndpoint: false,
        origin: 'configuration',
      }),
    ).toBe(true);
    expect(hasConfiguredImageGeneration).toBe(hasConfiguredImageCapability);
  });
});
