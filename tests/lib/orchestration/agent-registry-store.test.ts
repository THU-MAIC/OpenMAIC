/**
 * The browser agent registry over a mocked agents API: custom agents are read
 * from and written to the server (never browser storage), a refused save
 * restores the registry, built-in agents are read-only, and generated agents
 * stay in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runAgentsImport = vi.hoisted(() => vi.fn(async () => 'none'));
vi.mock('@/lib/legacy-browser-import/agents-import', () => ({ runAgentsImport }));
vi.mock('@/lib/audio/agent-voice', () => ({ warmUpAgentVoices: vi.fn() }));

import {
  applyGeneratedAgentsToRegistry,
  loadAgentRegistry,
  resetAgentRegistryLoadForTests,
  useAgentRegistry,
  whenAgentRegistryLoaded,
} from '@/lib/orchestration/registry/store';
import { BUILT_IN_AGENTS } from '@/lib/orchestration/registry/built-in';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { agentView } from '@/lib/orchestration/registry/wire';

function view(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Agent ${id}`,
    role: 'student',
    persona: 'Asks.',
    avatar: '/avatars/curious.png',
    color: '#ec4899',
    allowedActions: [],
    priority: 5,
    isDefault: false,
    readOnly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...extra,
  };
}

function custom(id: string): AgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    role: 'student',
    persona: 'Asks.',
    avatar: '/avatars/curious.png',
    color: '#ec4899',
    allowedActions: [],
    priority: 5,
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAgentRegistryLoadForTests();
  useAgentRegistry.setState({ agents: { ...BUILT_IN_AGENTS } });
  runAgentsImport.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ids = () => Object.keys(useAgentRegistry.getState().agents).sort();

describe('the agent registry store', () => {
  it('imports the browser’s old agents before it reads the owner’s', async () => {
    const order: string[] = [];
    runAgentsImport.mockImplementationOnce(async () => {
      order.push('import');
      return 'imported';
    });
    fetchMock.mockImplementation(async () => {
      order.push('list');
      return Response.json({ agents: [agentView(BUILT_IN_AGENTS['default-1']!), view('tutor')] });
    });
    applyGeneratedAgentsToRegistry('stage-1', [
      {
        id: 'gen-a',
        name: 'Gen',
        role: 'student',
        persona: 'p',
        avatar: 'a',
        color: '#000',
        priority: 1,
      },
    ]);

    await whenAgentRegistryLoaded();
    await whenAgentRegistryLoaded();

    expect(order).toEqual(['import', 'list']);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents', { cache: 'no-store' });
    const tutor = useAgentRegistry.getState().getAgent('tutor')!;
    expect(tutor.createdAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(tutor).not.toHaveProperty('readOnly');
    // Built-in agents come from code; the course roster stays.
    expect(useAgentRegistry.getState().getAgent('default-1')).toBe(BUILT_IN_AGENTS['default-1']);
    expect(useAgentRegistry.getState().getAgent('gen-a')?.isGenerated).toBe(true);
  });

  it('keeps the built-in agents when the read fails, and never rejects the shared load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue(Response.json({ error: { code: 'X' } }, { status: 503 }));
    await expect(whenAgentRegistryLoaded()).resolves.toBeUndefined();
    await expect(loadAgentRegistry()).rejects.toMatchObject({ status: 503 });
    expect(ids()).toEqual(Object.keys(BUILT_IN_AGENTS).sort());
  });

  it('drops a voice whose provider this app does not know', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        agents: [view('tutor', { voiceConfig: { providerId: 'no-such-tts', voiceId: 'v' } })],
      }),
    );
    await loadAgentRegistry();
    expect(useAgentRegistry.getState().getAgent('tutor')).not.toHaveProperty('voiceConfig');
  });

  it('creates, updates and deletes custom agents on the server', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const sent = JSON.parse(init.body as string).agent;
        expect(sent).not.toHaveProperty('createdAt');
        expect(sent).not.toHaveProperty('isDefault');
        return Response.json({ agent: view(sent.id) }, { status: 201 });
      }
      if (init?.method === 'PUT') {
        expect(url).toBe('/api/agents/tutor');
        const sent = JSON.parse(init.body as string).agent;
        expect(sent).not.toHaveProperty('id');
        return Response.json({ agent: view('tutor', { name: sent.name }) });
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      throw new Error('unexpected');
    });
    const { addAgent, updateAgent, deleteAgent } = useAgentRegistry.getState();

    await addAgent(custom('tutor'));
    expect(useAgentRegistry.getState().getAgent('tutor')?.updatedAt).toEqual(
      new Date('2026-01-02T00:00:00.000Z'),
    );
    await updateAgent('tutor', { name: 'Renamed' });
    expect(useAgentRegistry.getState().getAgent('tutor')?.name).toBe('Renamed');
    await deleteAgent('tutor');
    expect(useAgentRegistry.getState().getAgent('tutor')).toBeUndefined();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });

  it('restores the registry when the server refuses a save', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: { code: 'AGENT_LIMIT_REACHED', message: 'full' } }, { status: 409 }),
    );
    const { addAgent } = useAgentRegistry.getState();
    const adding = addAgent(custom('tutor'));
    // Shown at once, while the save is in flight.
    expect(useAgentRegistry.getState().getAgent('tutor')).toBeDefined();
    await expect(adding).rejects.toMatchObject({ status: 409, code: 'AGENT_LIMIT_REACHED' });
    expect(useAgentRegistry.getState().getAgent('tutor')).toBeUndefined();

    useAgentRegistry.setState((state) => ({
      agents: { ...state.agents, tutor: custom('tutor') },
    }));
    await expect(useAgentRegistry.getState().deleteAgent('tutor')).rejects.toMatchObject({
      status: 409,
    });
    expect(useAgentRegistry.getState().getAgent('tutor')).toBeDefined();
  });

  it('refuses to change built-in agents and invalid custom ones, without a request', async () => {
    const { addAgent, updateAgent, deleteAgent } = useAgentRegistry.getState();
    await expect(updateAgent('default-1', { name: 'Mine' })).rejects.toThrow(/built in/);
    await expect(deleteAgent('default-1')).rejects.toThrow(/built in/);
    await expect(addAgent({ ...custom('default-9') })).rejects.toThrow(/built in/);
    await expect(addAgent({ ...custom('tutor'), name: '' })).rejects.toThrow();
    expect(useAgentRegistry.getState().getAgent('default-1')?.name).toBe('AI teacher');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('changes generated agents in memory only', async () => {
    const { addAgent, updateAgent, deleteAgent } = useAgentRegistry.getState();
    await addAgent({ ...custom('gen-a'), isGenerated: true });
    await updateAgent('gen-a', { name: 'Renamed' });
    expect(useAgentRegistry.getState().getAgent('gen-a')?.name).toBe('Renamed');
    await deleteAgent('gen-a');
    expect(useAgentRegistry.getState().getAgent('gen-a')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
