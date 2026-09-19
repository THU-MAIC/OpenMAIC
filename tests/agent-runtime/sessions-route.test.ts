import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: true,
  createSession: vi.fn(),
  postUserMessage: vi.fn(),
  softDeleteSession: vi.fn(),
  bindOwnerMaterialsToSession: vi.fn(),
  listSessionsByOwner: vi.fn(),
  resolveRequestOwnerId: vi.fn(),
  listSkills: vi.fn(),
  findSkill: vi.fn(),
  inferSkillIdFromPrompt: vi.fn(),
  scheduleConversationTitle: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => mocks.runtimeEnabled,
  isAgentRuntimeConfigured: () => mocks.runtimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
// The route reads skills off the explicit `skill` param AND the prompt; pin the
// lookup to a fixed installed set so no user-skill store or skill directory is
// touched. `findSkill` is the route's (and the runner's) id-or-name lookup.
vi.mock('@/lib/server/agent-runtime/skills', () => ({
  listSkills: mocks.listSkills,
  findSkill: mocks.findSkill,
  inferSkillIdFromPrompt: mocks.inferSkillIdFromPrompt,
}));

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    createSession: mocks.createSession,
    postUserMessage: mocks.postUserMessage,
    softDeleteSession: mocks.softDeleteSession,
    listSessionsByOwner: mocks.listSessionsByOwner,
  }),
}));
vi.mock('@/lib/server/agent-runtime/session-materials', () => ({
  bindOwnerMaterialsToSession: mocks.bindOwnerMaterialsToSession,
  SessionMaterialBindingError: class SessionMaterialBindingError extends Error {},
}));
vi.mock('@/lib/server/agent-runtime/conversation-title-task', () => ({
  scheduleConversationTitle: mocks.scheduleConversationTitle,
}));

import { GET, POST } from '@/app/api/agent/sessions/route';
import { MAX_SESSION_TEXT_LENGTH } from '@/lib/server/agent-runtime/limits';

function post(body: unknown, headers?: HeadersInit) {
  return POST(
    new NextRequest('http://localhost/api/agent/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeEnabled = true;
  mocks.resolveRequestOwnerId.mockImplementation(
    (_request: NextRequest, responseHeaders: Headers) => {
      responseHeaders.append('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
      return 'anon:test';
    },
  );
  const installed = [
    { id: 'custom-skill', name: 'custom-skill' },
    { id: 'usk_1', name: 'my-demo' },
  ];
  mocks.listSkills.mockResolvedValue(installed);
  mocks.findSkill.mockImplementation(async (ref: string) => {
    return installed.find((s) => s.id === ref || s.name === ref) ?? null;
  });
  mocks.inferSkillIdFromPrompt.mockResolvedValue(undefined);
  mocks.createSession.mockResolvedValue({
    id: 'session-1',
    ownerId: 'anon:test',
    prompt: 'Build a course',
    stageId: 'agent-session-1',
    status: 'queued',
  });
  mocks.listSessionsByOwner.mockResolvedValue([]);
  mocks.postUserMessage.mockResolvedValue({ seq: 1, delivery: 'queued', requeued: true });
  mocks.softDeleteSession.mockResolvedValue(true);
  mocks.bindOwnerMaterialsToSession.mockResolvedValue([]);
});

describe('agent session collection route', () => {
  it('creates a queued session and propagates a newly minted owner cookie', async () => {
    const response = await post({ prompt: ' Build a course ', skill: 'custom-skill' });

    expect(response.status).toBe(202);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'anon:test',
        prompt: 'Build a course',
        skillId: 'custom-skill',
        existingCourse: false,
        titleState: 'pending',
        origin: 'http://localhost',
      }),
    );
    expect(mocks.scheduleConversationTitle).toHaveBeenCalledWith('session-1', 'anon:test');
  });

  it('does not schedule an ordinary session until its create write resolves', async () => {
    let resolveCreate:
      | ((value: Awaited<ReturnType<typeof mocks.createSession>>) => void)
      | undefined;
    mocks.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const responsePromise = post({ prompt: 'Build a course' });
    await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
    expect(mocks.scheduleConversationTitle).not.toHaveBeenCalled();

    resolveCreate?.({
      id: 'session-1',
      ownerId: 'anon:test',
      prompt: 'Build a course',
      stageId: 'agent-session-1',
      status: 'queued',
    });
    expect((await responsePromise).status).toBe(202);
    expect(mocks.scheduleConversationTitle).toHaveBeenCalledWith('session-1', 'anon:test');
  });

  it('accepts a skill by its user-visible name and freezes the durable id, like the runner', async () => {
    // The runner's `findSkill` matches id OR name (a user skill's natural
    // handle is `my-*`), so a `?skill=my-demo` launch link must not 400.
    const response = await post({ prompt: 'Build a course', skill: 'my-demo' });

    expect(response.status).toBe(202);
    expect(mocks.findSkill).toHaveBeenCalledWith('my-demo', 'anon:test');
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ skillId: 'usk_1' }));
  });

  it('persists opening course mentions before queueing and returns the capability receipt', async () => {
    const courseRefs = [{ kind: 'course', stageId: 'stage-2', title: 'Referenced course' }];
    const response = await post({ prompt: 'Compare this', courseRefs });

    expect(response.status).toBe(202);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded' }),
    );
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      { text: 'Compare this', courseRefs },
      { expectedOwnerId: 'anon:test' },
    );
    expect(mocks.scheduleConversationTitle).toHaveBeenCalledWith('session-1', 'anon:test');
    await expect(response.json()).resolves.toMatchObject({
      id: 'session-1',
      status: 'queued',
      courseRefs,
    });
  });

  it('binds opening uploads before the first user message queues the runner', async () => {
    mocks.bindOwnerMaterialsToSession.mockResolvedValue([
      { materialId: 'material-1', originalName: 'notes.pdf', bytes: 42 },
    ]);
    const response = await post({ prompt: 'Read this', materialIds: ['material-1'] });

    expect(response.status).toBe(202);
    expect(mocks.bindOwnerMaterialsToSession).toHaveBeenCalledWith('session-1', 'anon:test', [
      'material-1',
    ]);
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      {
        text: 'Read this',
        materials: [{ materialId: 'material-1', originalName: 'notes.pdf', bytes: 42 }],
      },
      { expectedOwnerId: 'anon:test' },
    );
    expect(mocks.bindOwnerMaterialsToSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.postUserMessage.mock.invocationCallOrder[0]!,
    );
    expect(mocks.postUserMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scheduleConversationTitle.mock.invocationCallOrder[0]!,
    );
  });

  it('persists the opening message exactly once, with materials and course refs intact', async () => {
    const courseRefs = [{ kind: 'course', stageId: 'stage-2', title: 'Referenced course' }];
    mocks.bindOwnerMaterialsToSession.mockResolvedValue([
      { materialId: 'material-1', originalName: 'notes.pdf', bytes: 42 },
    ]);
    const response = await post({
      prompt: 'Read this and compare',
      materialIds: ['material-1'],
      courseRefs,
    });

    expect(response.status).toBe(202);
    // The create-with-opening-context flow must write the opening message as a
    // durable `user_message` EXACTLY ONCE, carrying both the bound materials
    // and the named classrooms — no second copy without the refs may exist.
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'succeeded' }),
    );
    expect(mocks.postUserMessage).toHaveBeenCalledTimes(1);
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      {
        text: 'Read this and compare',
        materials: [{ materialId: 'material-1', originalName: 'notes.pdf', bytes: 42 }],
        courseRefs,
      },
      { expectedOwnerId: 'anon:test' },
    );
    await expect(response.json()).resolves.toMatchObject({
      id: 'session-1',
      status: 'queued',
      courseRefs,
    });
  });

  it('does not schedule when the opening message write fails', async () => {
    mocks.postUserMessage.mockRejectedValue(new Error('message write failed'));

    const response = await post({
      prompt: 'Compare this',
      courseRefs: [{ kind: 'course', stageId: 'stage-2', title: 'Referenced course' }],
    });

    expect(response.status).toBe(500);
    expect(mocks.softDeleteSession).toHaveBeenCalledWith('session-1', 'anon:test');
    expect(mocks.scheduleConversationTitle).not.toHaveBeenCalled();
  });

  it('rejects an explicit skill that matches neither id nor name', async () => {
    const response = await post({ prompt: 'Build a course', skill: 'my-unknown' });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
    expect(body.error).toContain('unknown skill "my-unknown"');
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('requires a prompt for a new session', async () => {
    const response = await post({ prompt: '  ' });

    expect(response.status).toBe(400);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('creates an idle existing-course session without a stage access dependency', async () => {
    const response = await post({ existingCourse: true, stageId: 'stage-1' });

    expect(response.status).toBe(202);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'stage-1',
        stageId: 'stage-1',
        existingCourse: true,
        titleState: 'pending',
        status: 'succeeded',
      }),
    );
    expect(mocks.scheduleConversationTitle).not.toHaveBeenCalled();
  });

  it('persists empty opening text instead of a synthetic Stage id for existing-course refs', async () => {
    const courseRefs = [{ kind: 'course', stageId: 'stage-2', title: 'Referenced course' }];

    const response = await post({ existingCourse: true, stageId: 'stage-1', courseRefs });

    expect(response.status).toBe(202);
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      { text: '', courseRefs },
      { expectedOwnerId: 'anon:test' },
    );
    expect(mocks.scheduleConversationTitle).not.toHaveBeenCalled();
  });

  it('schedules an explicit existing-course opening prompt after it is durable', async () => {
    const courseRefs = [{ kind: 'course', stageId: 'stage-2', title: 'Referenced course' }];

    const response = await post({
      existingCourse: true,
      stageId: 'stage-1',
      prompt: 'Compare this lesson',
      courseRefs,
    });

    expect(response.status).toBe(202);
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      { text: 'Compare this lesson', courseRefs },
      { expectedOwnerId: 'anon:test' },
    );
    expect(mocks.scheduleConversationTitle).toHaveBeenCalledWith('session-1', 'anon:test');
    expect(mocks.postUserMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scheduleConversationTitle.mock.invocationCallOrder[0]!,
    );
  });

  it('requires a stage id for an existing-course session', async () => {
    const response = await post({ existingCourse: true });

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('rejects an existing-course stage id that fails the classroom id format', async () => {
    const response = await post({ existingCourse: true, stageId: 'not a valid id!' });

    expect(response.status).toBe(400);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('rejects a prompt that exceeds the text length cap', async () => {
    const response = await post({ prompt: 'x'.repeat(MAX_SESSION_TEXT_LENGTH + 1) });

    expect(response.status).toBe(400);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('keeps the minted owner cookie when session creation fails', async () => {
    mocks.createSession.mockRejectedValue(new Error('database unavailable'));

    const response = await post({ prompt: 'Build a course' });

    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.scheduleConversationTitle).not.toHaveBeenCalled();
  });

  it('lists only sessions for the resolved owner', async () => {
    mocks.listSessionsByOwner.mockResolvedValue([{ id: 'session-1', status: 'running' }]);
    const response = await GET(new NextRequest('http://localhost/api/agent/sessions'));

    expect(response.status).toBe(200);
    expect(mocks.listSessionsByOwner).toHaveBeenCalledWith('anon:test');
    await expect(response.json()).resolves.toEqual([{ id: 'session-1', status: 'running' }]);
  });

  it('keeps both collection methods behind the runtime gate', async () => {
    mocks.runtimeEnabled = false;

    expect((await post({ prompt: 'Build' })).status).toBe(404);
    expect((await GET(new NextRequest('http://localhost/api/agent/sessions'))).status).toBe(404);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });
});
