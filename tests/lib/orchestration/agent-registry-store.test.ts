/**
 * The browser agent registry over a mocked agents API: custom agents are read
 * from and written to the server (never browser storage) through one ordered
 * queue, a refused save changes nothing, a failed read is not remembered,
 * built-in agents are read-only, generated agents stay in memory, and ids
 * that name `Object.prototype` members are ordinary ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentsImportResult } from '@/lib/legacy-browser-import/agents-import';

const runAgentsImport = vi.hoisted(() =>
  vi.fn(async (): Promise<AgentsImportResult> => ({ outcome: 'none', imported: 0, pending: [] })),
);
vi.mock('@/lib/legacy-browser-import/agents-import', () => ({ runAgentsImport }));
vi.mock('@/lib/audio/agent-voice', () => ({ warmUpAgentVoices: vi.fn() }));

import {
  applyGeneratedAgentsToRegistry,
  importLegacyAgents,
  loadAgentRegistry,
  reloadAgentRegistry,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

const listing = (...agents: unknown[]) => Response.json({ agents });
const refusal = (status: number, code = 'X') =>
  Response.json({ error: { code, message: code } }, { status });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAgentRegistryLoadForTests();
  useAgentRegistry.setState({
    agents: Object.assign(Object.create(null), BUILT_IN_AGENTS),
    customAgentsLoaded: false,
    legacyAgentsPending: [],
  });
  runAgentsImport.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const registry = () => useAgentRegistry.getState();
const customIds = () =>
  registry()
    .listAgents()
    .filter((agent) => !agent.isDefault)
    .map((agent) => agent.id);

describe('reading the registry', () => {
  it('reads the owner’s agents, keeping built-in agents from code and the course roster', async () => {
    fetchMock.mockResolvedValue(listing(agentView(BUILT_IN_AGENTS['default-1']!), view('tutor')));
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

    await expect(whenAgentRegistryLoaded()).resolves.toBe(true);
    await expect(whenAgentRegistryLoaded()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/agents', { cache: 'no-store' });
    const tutor = registry().getAgent('tutor')!;
    expect(tutor.createdAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(tutor).not.toHaveProperty('readOnly');
    expect(registry().getAgent('default-1')).toBe(BUILT_IN_AGENTS['default-1']);
    expect(registry().getAgent('gen-a')?.isGenerated).toBe(true);
    expect(registry().customAgentsLoaded).toBe(true);
  });

  it('does not remember a refused first read (the access code) and reads again on reload', async () => {
    fetchMock.mockResolvedValueOnce(refusal(401, 'INVALID_CREDENTIAL'));
    await expect(whenAgentRegistryLoaded()).resolves.toBe(false);
    expect(registry().customAgentsLoaded).toBe(false);

    // The access code is accepted: the guard reads again.
    fetchMock.mockResolvedValueOnce(listing(view('tutor')));
    await expect(reloadAgentRegistry()).resolves.toBe(true);
    expect(customIds()).toEqual(['tutor']);
    await expect(whenAgentRegistryLoaded()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads again on the next wait after a transient server error', async () => {
    fetchMock.mockResolvedValueOnce(refusal(503));
    await expect(whenAgentRegistryLoaded()).resolves.toBe(false);
    expect(customIds()).toEqual([]);
    fetchMock.mockResolvedValueOnce(listing(view('tutor')));
    await expect(whenAgentRegistryLoaded()).resolves.toBe(true);
    expect(customIds()).toEqual(['tutor']);
  });

  it('stops waiting after the bound, and the read still lands later', async () => {
    const answer = deferred<Response>();
    fetchMock.mockReturnValueOnce(answer.promise);
    await expect(whenAgentRegistryLoaded(20)).resolves.toBe(false);
    answer.resolve(listing(view('tutor')));
    await expect(whenAgentRegistryLoaded(1_000)).resolves.toBe(true);
    expect(customIds()).toEqual(['tutor']);
  });

  it('imports the browser’s old agents after the read, without holding it up', async () => {
    const importing = deferred<AgentsImportResult>();
    runAgentsImport.mockReturnValueOnce(importing.promise);
    fetchMock
      .mockResolvedValueOnce(listing(view('tutor')))
      .mockResolvedValueOnce(listing(view('tutor'), view('old')));

    await expect(whenAgentRegistryLoaded()).resolves.toBe(true);
    expect(customIds()).toEqual(['tutor']);
    await vi.waitFor(() => expect(runAgentsImport).toHaveBeenCalledOnce());

    importing.resolve({
      outcome: 'partial',
      imported: 1,
      pending: [{ id: 'too-many', reason: 'limit' }],
    });
    await importLegacyAgents();
    await vi.waitFor(() => expect(customIds()).toEqual(['tutor', 'old']));
    expect(registry().legacyAgentsPending).toEqual([{ id: 'too-many', reason: 'limit' }]);
  });

  it('drops a voice whose provider this app does not know', async () => {
    fetchMock.mockResolvedValue(
      listing(view('tutor', { voiceConfig: { providerId: 'no-such-tts', voiceId: 'v' } })),
    );
    await loadAgentRegistry();
    expect(registry().getAgent('tutor')).not.toHaveProperty('voiceConfig');
  });
});

describe('changing custom agents', () => {
  it('creates, updates and deletes them on the server', async () => {
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

    await registry().addAgent(custom('tutor'));
    expect(registry().getAgent('tutor')?.updatedAt).toEqual(new Date('2026-01-02T00:00:00.000Z'));
    await registry().updateAgent('tutor', { name: 'Renamed' });
    expect(registry().getAgent('tutor')?.name).toBe('Renamed');
    await registry().deleteAgent('tutor');
    expect(registry().getAgent('tutor')).toBeUndefined();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'PUT', 'DELETE']);
  });

  it('changes nothing when the server refuses', async () => {
    fetchMock.mockResolvedValue(refusal(409, 'AGENT_LIMIT_REACHED'));
    await expect(registry().addAgent(custom('tutor'))).rejects.toMatchObject({
      status: 409,
      code: 'AGENT_LIMIT_REACHED',
    });
    expect(registry().getAgent('tutor')).toBeUndefined();

    useAgentRegistry.setState((state) => ({
      agents: Object.assign(Object.create(null), state.agents, { tutor: custom('tutor') }),
    }));
    await expect(registry().deleteAgent('tutor')).rejects.toMatchObject({ status: 409 });
    expect(registry().getAgent('tutor')).toBeDefined();
  });

  it('a late refusal cannot undo a newer update, and answers apply in request order', async () => {
    useAgentRegistry.setState((state) => ({
      agents: Object.assign(Object.create(null), state.agents, { tutor: custom('tutor') }),
    }));
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const refused = registry().updateAgent('tutor', { name: 'First' });
    const accepted = registry().updateAgent('tutor', { persona: 'Second' });
    // The second request waits for the first answer.
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.resolve(refusal(503));
    await expect(refused).rejects.toMatchObject({ status: 503 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Merged with the agent the refusal left: the refused name is not sent.
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).agent).toMatchObject({
      name: 'Agent tutor',
      persona: 'Second',
    });
    second.resolve(Response.json({ agent: view('tutor', { persona: 'Second' }) }));
    await accepted;
    expect(registry().getAgent('tutor')).toMatchObject({ name: 'Agent tutor', persona: 'Second' });
  });

  it('a read that began before a delete cannot bring the agent back', async () => {
    useAgentRegistry.setState((state) => ({
      agents: Object.assign(Object.create(null), state.agents, { tutor: custom('tutor') }),
    }));
    const list = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(list.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const reading = loadAgentRegistry();
    const deleting = registry().deleteAgent('tutor');
    list.resolve(listing(view('tutor')));
    await reading;
    await deleting;
    expect(registry().getAgent('tutor')).toBeUndefined();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'GET',
      'DELETE',
    ]);
  });

  it('an import that began before a delete cannot bring the agent back', async () => {
    useAgentRegistry.setState((state) => ({
      agents: Object.assign(Object.create(null), state.agents, { tutor: custom('tutor') }),
    }));
    let deleted = false;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return listing(...(deleted ? [view('old')] : [view('tutor'), view('old')]));
    });
    const importing = deferred<AgentsImportResult>();
    runAgentsImport.mockReturnValueOnce(importing.promise);

    const imported = importLegacyAgents();
    await vi.waitFor(() => expect(runAgentsImport).toHaveBeenCalledOnce());
    const deleting = registry().deleteAgent('tutor');
    await Promise.resolve();
    // The delete waits for the import.
    expect(fetchMock).not.toHaveBeenCalled();

    importing.resolve({ outcome: 'imported', imported: 1, pending: [] });
    await deleting;
    await imported;
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'DELETE',
      'GET',
    ]);
    expect(customIds()).toEqual(['old']);
  });

  it('refuses to change built-in agents and invalid custom ones, without a request', async () => {
    await expect(registry().updateAgent('default-1', { name: 'Mine' })).rejects.toThrow(/built in/);
    await expect(registry().deleteAgent('default-1')).rejects.toThrow(/built in/);
    await expect(registry().addAgent(custom('default-9'))).rejects.toThrow(/built in/);
    await expect(registry().addAgent({ ...custom('tutor'), name: '' })).rejects.toThrow();
    expect(registry().getAgent('default-1')?.name).toBe('AI teacher');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('changes generated agents in memory only', async () => {
    await registry().addAgent({ ...custom('gen-a'), isGenerated: true });
    await registry().updateAgent('gen-a', { name: 'Renamed' });
    expect(registry().getAgent('gen-a')?.name).toBe('Renamed');
    await registry().deleteAgent('gen-a');
    expect(registry().getAgent('gen-a')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ids that name Object.prototype members', () => {
  it('are unknown until created, and ordinary agents once they exist', async () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(registry().getAgent(id)).toBeUndefined();
    }
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Response.json({ agent: view(JSON.parse(init.body as string).agent.id) }, { status: 201 })
        : listing(view('constructor'), view('__proto__')),
    );
    await registry().addAgent(custom('constructor'));
    expect(registry().getAgent('constructor')?.name).toBe('Agent constructor');

    await loadAgentRegistry();
    expect(registry().getAgent('__proto__')?.name).toBe('Agent __proto__');
    expect(registry().getAgent('toString')).toBeUndefined();
    expect(Object.getPrototypeOf(registry().agents)).toBeNull();
    expect(customIds().sort()).toEqual(['__proto__', 'constructor']);
  });
});
