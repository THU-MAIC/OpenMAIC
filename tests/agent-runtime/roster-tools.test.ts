/**
 * Classroom roster tools: `set_roster` and `list_voices`.
 *
 * `generate_roster` is retired from the agent toolset (the model writes the
 * roster itself), so this file pins the surviving surface:
 *  - set_roster: explicit roster (user-settled) written to
 *    `stage.generatedAgentConfigs` with ids minted when omitted, voice binding
 *    parsed from `providerId::voiceId`, and the exactly-1-teacher /
 *    at-least-2-agents validation;
 *  - voice bindings validated against the deployment's actual voice catalog
 *    (an unknown voice, an unserved provider, or a keyless provider is
 *    refused; a voice registered THIS session by register_voice is accepted);
 *  - the explicit `excludeFromAgentVoiceCatalog` flag keeping paid showcase
 *    presets out of list_voices even when the provider is served AND keyed;
 *  - allowlist carries set_roster / list_voices and NOT the retired
 *    generate_roster.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { GeneratedAgentConfig } from '@openmaic/dsl';

import {
  buildRosterTools,
  ROSTER_TOOL_NAMES,
  type CourseDocument,
  type CourseStore,
} from '@/lib/server/agent-runtime/roster-tools';
import { withOwnerStageAuthorization } from '@/lib/server/agent-runtime/course-tools';

const mocks = vi.hoisted(() => ({
  enabledServerTTSProviderIds: vi.fn(),
  resolveTTSApiKey: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    enabledServerTTSProviderIds: mocks.enabledServerTTSProviderIds,
    resolveTTSApiKey: mocks.resolveTTSApiKey,
  };
});

/** In-memory DocumentStore stub: just the methods the roster tools use. */
function makeStore(initial: CourseDocument | null = null): CourseStore {
  let doc = initial;
  const store = {
    async loadDocument() {
      return doc;
    },
    async saveDocument(next: CourseDocument) {
      doc = next;
    },
  };
  return store as unknown as CourseStore;
}

function makeDoc(opts: { roster?: GeneratedAgentConfig[] } = {}): CourseDocument {
  const roster = opts.roster;
  return {
    stage: {
      id: 'stage-test',
      name: 'Test Course',
      ...(roster ? { generatedAgentConfigs: roster, agentIds: roster.map((a) => a.id) } : {}),
    } as CourseDocument['stage'],
    scenes: [],
    outline: { outlines: [], generationComplete: true },
  };
}

interface ToolResultShape {
  isError?: boolean;
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
}

function buildTools(deps: Record<string, unknown> = {}): AgentTool<never, never>[] {
  return buildRosterTools({
    store: makeStore(makeDoc()),
    onCheckpoint: () => {},
    ...deps,
  });
}

async function runTool(
  store: CourseStore,
  name: 'set_roster' | 'list_voices',
  params: Record<string, unknown> = {},
  deps: Record<string, unknown> = {},
): Promise<ToolResultShape> {
  const tools = buildRosterTools({
    store,
    onCheckpoint: () => {},
    ...deps,
  });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  return (await tool.execute('call-1', params as never)) as ToolResultShape;
}

function llmAgent(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Prof. Lin',
    role: 'teacher',
    persona: 'A patient mentor who builds from what students know.',
    avatar: '/avatars/teacher.png',
    color: '#111111',
    priority: 10,
    ...extra,
  };
}

describe('set_roster', () => {
  beforeEach(() => {
    // set_roster validates a `voice` binding against the served providers, so
    // the provider map has to be a real (possibly empty) object per test.
    mocks.enabledServerTTSProviderIds.mockReset();
    mocks.enabledServerTTSProviderIds.mockReturnValue([]);
    mocks.resolveTTSApiKey.mockReset();
    mocks.resolveTTSApiKey.mockReturnValue('sk-test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the explicit roster, minting gen- ids when omitted', async () => {
    const store = makeStore(makeDoc());
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-test',
      agents: [
        {
          id: 'named-teacher',
          name: 'Prof. Lin',
          role: 'teacher',
          persona: 'A patient mentor.',
          voiceDesign: {
            identity: 'middle-aged male teacher',
            texture: 'warm low',
            delivery: 'calm',
          },
        },
        { name: 'Sam', role: 'student', persona: 'Curious.' },
        { name: 'Ada', role: 'student', persona: 'Diligent.' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const doc = await store.loadDocument('stage-test');
    const roster = doc?.stage?.generatedAgentConfigs;
    expect(roster).toHaveLength(3);
    expect(roster?.[0]).toMatchObject({ id: 'named-teacher', name: 'Prof. Lin', role: 'teacher' });
    expect(roster?.[1]?.id).toMatch(/^gen-[A-Za-z0-9_-]{8}$/);
    expect(roster?.[0]?.voiceDesign).toEqual({
      identity: 'middle-aged male teacher',
      texture: 'warm low',
      delivery: 'calm',
    });
    expect(doc?.stage?.agentIds).toEqual(roster?.map((agent) => agent.id));
  });

  it('rejects fewer than 2 agents', async () => {
    const store = makeStore(makeDoc());
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-test',
      agents: [{ name: 'Only', role: 'teacher', persona: 'solo' }],
    });
    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe('at-least-2-agents');
  });

  it('rejects rosters without exactly one teacher', async () => {
    const store = makeStore(makeDoc());
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-test',
      agents: [
        { name: 'A', role: 'student', persona: 'a' },
        { name: 'B', role: 'student', persona: 'b' },
        { name: 'C', role: 'student', persona: 'c' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe('teacher-count');
  });

  it('refuses when no stage document exists', async () => {
    const store = makeStore(null);
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-missing',
      agents: [
        { name: 'T', role: 'teacher', persona: 't' },
        { name: 'S', role: 'student', persona: 's' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.details?.blocked).toBe('no-document');
  });

  it('rejects a voice that is not in the deployment voice catalog', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['qwen-tts']);
    const store = makeStore(makeDoc());
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-test',
      agents: [
        {
          name: 'Andrew Ng',
          role: 'teacher',
          persona: 'Explains supervised learning from first principles.',
          voice: 'qwen-tts::enda',
        },
        { name: 'Leo', role: 'student', persona: 'Asks basic questions.' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe('voice-not-in-catalog');
    // Nothing may be persisted: a half-applied roster is worse than none.
    expect((await store.loadDocument('stage-test'))?.stage?.generatedAgentConfigs).toBeUndefined();
  });

  it('binds a voice from the deployment catalog and reports it in the summary', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['doubao-tts']);
    const store = makeStore(makeDoc());
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-test',
      agents: [
        {
          name: 'Andrew Ng',
          role: 'teacher',
          persona: 'Explains supervised learning from first principles.',
          voice: 'doubao-tts::zh_female_vv_uranus_bigtts',
        },
        { name: 'Leo', role: 'student', persona: 'Asks basic questions.' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const roster = (await store.loadDocument('stage-test'))?.stage?.generatedAgentConfigs ?? [];
    expect(roster[0]?.voiceConfig).toEqual({
      providerId: 'doubao-tts',
      voiceId: 'zh_female_vv_uranus_bigtts',
    });
    expect(roster[1]?.voiceConfig).toBeUndefined();
    expect(result.content[0].text).toContain(
      'Andrew Ng [teacher] (doubao-tts::zh_female_vv_uranus_bigtts)',
    );
  });

  // A cloned voice registered THIS session (register_voice → shared registry)
  // is part of the list_voices catalog, so set_roster accepts the binding —
  // the acceptance path the loop demands: agent runs list_voices → set_roster
  // and the roster really carries the providerId::voiceId binding.
  it('binds a voice registered this session by register_voice', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['qwen-tts']);
    const registeredVoices = [
      { providerId: 'qwen-tts', voiceId: 'enda', name: 'Enda', kind: 'clone' },
    ];
    const store = makeStore(makeDoc());
    const result = await runTool(
      store,
      'set_roster',
      {
        stageId: 'stage-test',
        agents: [
          {
            name: 'Andrew Ng',
            role: 'teacher',
            persona: 'Explains supervised learning from first principles.',
            voice: 'qwen-tts::enda',
          },
          { name: 'Leo', role: 'student', persona: 'Asks basic questions.' },
        ],
      },
      { registeredVoices },
    );

    expect(result.isError).toBeUndefined();
    const roster = (await store.loadDocument('stage-test'))?.stage?.generatedAgentConfigs ?? [];
    expect(roster[0]?.voiceConfig).toEqual({ providerId: 'qwen-tts', voiceId: 'enda' });
    expect(result.content[0].text).toContain('Andrew Ng [teacher] (qwen-tts::enda)');
  });

  it('leaves voiceConfig unbound, and the summary bare, when no voice is passed', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['qwen-tts']);
    const store = makeStore(makeDoc());
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-test',
      agents: [
        { name: 'Prof. Lin', role: 'teacher', persona: 'Mentor.' },
        { name: 'Sam', role: 'student', persona: 'Curious.' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const roster = (await store.loadDocument('stage-test'))?.stage?.generatedAgentConfigs ?? [];
    expect(roster.every((agent) => agent.voiceConfig === undefined)).toBe(true);
    expect(result.content[0].text).not.toContain('::');
  });

  it('rejects a voice bound to a provider this deployment does not serve', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['qwen-tts']);
    const store = makeStore(makeDoc());
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-test',
      agents: [
        {
          name: 'Teacher',
          role: 'teacher',
          persona: 'p',
          voice: 'some-other-provider::enda',
        },
        { name: 'Student', role: 'student', persona: 'p' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe('voice-not-in-catalog');
    expect((await store.loadDocument('stage-test'))?.stage?.generatedAgentConfigs).toBeUndefined();
  });

  // A served-but-keyless provider is the subtler half: synthesis drops the
  // binding and falls back to the default voice with only a log line, so its
  // voices are excluded from the catalog and the binding is refused —
  // persisting it would store a roster that says one voice while every
  // synthesis produces another.
  it('rejects a voice whose provider is served but has no API key', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['qwen-tts']);
    mocks.resolveTTSApiKey.mockReturnValue('');
    const store = makeStore(makeDoc());
    const result = await runTool(store, 'set_roster', {
      stageId: 'stage-test',
      agents: [
        {
          name: 'Teacher',
          role: 'teacher',
          persona: 'p',
          voice: 'qwen-tts::enda',
        },
        { name: 'Student', role: 'student', persona: 'p' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.details?.error).toBe('voice-not-in-catalog');
    expect((await store.loadDocument('stage-test'))?.stage?.generatedAgentConfigs).toBeUndefined();
  });
});

describe('list_voices', () => {
  beforeEach(() => {
    mocks.enabledServerTTSProviderIds.mockReset();
    mocks.enabledServerTTSProviderIds.mockReturnValue([]);
    mocks.resolveTTSApiKey.mockReset();
    mocks.resolveTTSApiKey.mockReturnValue('sk-test');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports every served provider preset as a flat providerId::voiceId pair', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['doubao-tts']);
    const result = await runTool(makeStore(makeDoc()), 'list_voices', {});
    const voices = (result.details?.voices ?? []) as Array<Record<string, unknown>>;
    expect(result.isError).toBeUndefined();
    expect(voices).toContainEqual({
      binding: 'doubao-tts::zh_female_vv_uranus_bigtts',
      providerId: 'doubao-tts',
      voiceId: 'zh_female_vv_uranus_bigtts',
      name: 'Vivi 2.0',
      language: 'zh-CN',
      gender: 'female',
    });
    expect(voices).toContainEqual(
      expect.objectContaining({ binding: 'doubao-tts::zh_male_m191_uranus_bigtts' }),
    );
  });

  it('includes a voice registered this session by register_voice', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['qwen-tts']);
    const registeredVoices = [
      { providerId: 'qwen-tts', voiceId: 'enda', name: 'Enda', kind: 'clone' },
    ];
    const result = await runTool(makeStore(makeDoc()), 'list_voices', {}, { registeredVoices });
    const voices = (result.details?.voices ?? []) as Array<Record<string, unknown>>;
    expect(voices).toContainEqual({
      binding: 'qwen-tts::enda',
      providerId: 'qwen-tts',
      voiceId: 'enda',
      name: 'Enda',
      language: 'auto',
    });
  });

  // Paid vendor showcase presets must never reach the agent even when the
  // provider is served AND keyed — explicit provider flag, not "no env so
  // absent" (declared exclusion mechanism).
  it('never exposes paid qwen-tts presets even when served and keyed', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['qwen-tts', 'doubao-tts']);
    const result = await runTool(makeStore(makeDoc()), 'list_voices', {});
    const voices = (result.details?.voices ?? []) as Array<Record<string, unknown>>;
    const bindings = voices.map((voice) => voice.binding);
    expect(bindings).toContain('doubao-tts::zh_female_vv_uranus_bigtts');
    expect(bindings).not.toContain('qwen-tts::Cherry');
    expect(bindings.some((binding) => String(binding).startsWith('qwen-tts::'))).toBe(false);
  });

  it('excludes providers whose synthesis would be silently skipped (keyless)', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['doubao-tts']);
    mocks.resolveTTSApiKey.mockReturnValue('');
    const result = await runTool(makeStore(makeDoc()), 'list_voices', {});
    const voices = (result.details?.voices ?? []) as Array<Record<string, unknown>>;
    expect(voices).toHaveLength(0);
  });

  it('reports an empty catalog message when nothing is served', async () => {
    const result = await runTool(makeStore(makeDoc()), 'list_voices', {});
    expect(result.details?.voices).toEqual([]);
    expect(result.content[0].text).toContain('no bindable TTS voices');
  });
});

describe('roster abort handling', () => {
  it('set_roster throws aborted without persisting when the run signal is already aborted', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue([]);
    mocks.resolveTTSApiKey.mockReturnValue('sk-test');
    const store = makeStore(makeDoc());
    const controller = new AbortController();
    controller.abort();
    const tools = buildRosterTools({
      store,
      onCheckpoint: () => {},
    });
    const set = tools.find((candidate) => candidate.name === 'set_roster');
    if (!set) throw new Error('set_roster not registered');

    await expect(
      set.execute(
        'call-1',
        { stageId: 'stage-test', agents: [llmAgent({}), llmAgent({ role: 'student' })] } as never,
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
    const doc = await store.loadDocument('stage-test');
    expect(doc?.stage?.generatedAgentConfigs).toBeUndefined();
  });
});

describe('roster owner gate (reference semantics)', () => {
  it('refuses a foreign stage on set_roster before any store IO', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue([]);
    mocks.resolveTTSApiKey.mockReturnValue('sk-test');
    const store = makeStore(makeDoc());
    const save = vi.spyOn(store as unknown as { saveDocument(): Promise<void> }, 'saveDocument');
    const tools = withOwnerStageAuthorization(buildRosterTools({ store, onCheckpoint: () => {} }), {
      stageAccess: async () => ({ kind: 'foreign' as const }),
    });
    const set = tools.find((candidate) => candidate.name === 'set_roster');
    if (!set) throw new Error('set_roster not registered');

    const result = (await set.execute('call-1', {
      stageId: 'stage-foreign',
      agents: [llmAgent({}), llmAgent({ role: 'student' })],
    } as never)) as ToolResultShape;
    expect(result).toMatchObject({
      isError: true,
      details: { refused: true, stageId: 'stage-foreign' },
    });
    expect(result.content[0].text).toContain('does not belong to this session user');
    expect(save).not.toHaveBeenCalled();
  });

  it('list_voices (no stage target) passes through the owner gate untouched', async () => {
    const tools = withOwnerStageAuthorization(
      buildRosterTools({ store: makeStore(makeDoc()), onCheckpoint: () => {} }),
      {
        stageAccess: async () => ({ kind: 'foreign' as const }),
      },
    );
    const list = tools.find((candidate) => candidate.name === 'list_voices');
    if (!list) throw new Error('list_voices not registered');
    const result = (await list.execute('call-1', {} as never)) as ToolResultShape;
    expect(result.isError).toBeUndefined();
  });
});

describe('roster tool registry', () => {
  it('registers set_roster and list_voices, and not the retired generate_roster, in ROSTER_TOOL_NAMES', () => {
    expect(ROSTER_TOOL_NAMES).toEqual(['list_voices', 'set_roster']);
    expect(ROSTER_TOOL_NAMES).not.toContain('generate_roster');
  });

  it('exposes set_roster and list_voices from the toolset', () => {
    const names = buildTools().map((candidate) => candidate.name);
    expect(names).toContain('set_roster');
    expect(names).toContain('list_voices');
    expect(names).not.toContain('generate_roster');
  });
});
