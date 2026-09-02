import { describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';

import {
  buildPersonalHistoryTools,
  createPersonalHistorySource,
  HISTORY_PAGE_LIMIT_MAX,
  HISTORY_RESULT_MAX_CHARS,
  PERSONAL_HISTORY_TOOL_NAMES,
  visibleChatMessages,
  type ChatHistoryRow,
  type ClassroomHistoryRow,
  type PersonalHistorySource,
} from '@/lib/server/agent-runtime/personal-history-tools';

const owner = 'user:mine';
const classroom = (overrides: Partial<ClassroomHistoryRow> = {}): ClassroomHistoryRow => ({
  ownerId: owner,
  id: 'stage-1',
  title: 'Interactive Python',
  description: 'Challenge-driven learning',
  updatedAt: 10,
  pageCount: 2,
  outline: {
    requirement: 'Prioritize interaction',
    outlines: [
      {
        title: 'Variable challenge',
        description: 'Start with a real problem, then explain variables',
        keyPoints: ['Immediate feedback', 'Allow retries'],
        type: 'quiz',
      },
      { title: 'Review', type: 'slide' },
    ],
  },
  ...overrides,
});
const chat = (overrides: Partial<ChatHistoryRow> = {}): ChatHistoryRow => ({
  ownerId: owner,
  id: 'session-1',
  prompt: 'Build an interactive Python course',
  status: 'succeeded',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  messages: [
    { role: 'system', content: 'SYSTEM SECRET' },
    { role: 'user', content: [{ type: 'text', text: 'Prioritize interaction' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will add a challenge' },
        { type: 'toolCall', name: 'generate_scene', arguments: { secret: 'HIDDEN PAYLOAD' } },
      ],
    },
    {
      role: 'toolResult',
      toolName: 'read_material',
      content: [{ type: 'text', text: 'MATERIAL BODY SECRET' }],
    },
    { role: 'user', content: [{ type: 'text', text: 'api_key=visible-but-sensitive' }] },
  ],
  ...overrides,
});

function source(overrides: Partial<PersonalHistorySource> = {}): PersonalHistorySource {
  const classrooms = [
    classroom(),
    classroom({ id: 'foreign', ownerId: 'user:foreign', title: 'Bookmarked course' }),
  ];
  const chats = [chat(), chat({ id: 'foreign-chat', ownerId: 'user:foreign' })];
  return {
    listClassrooms: vi.fn(async () => classrooms),
    getClassroom: vi.fn(async (_ownerId, id) => classrooms.find((row) => row.id === id) ?? null),
    listScenes: vi.fn(async (_ownerId, id) =>
      id === 'stage-1'
        ? [
            {
              id: 'scene-1',
              order: 1,
              data: {
                title: 'Challenge',
                type: 'quiz',
                content: { canvas: { elements: [{ type: 'text', content: 'large body' }] } },
                materialBody: 'SECRET',
              },
            },
            {
              id: 'scene-2',
              order: 2,
              data: { title: 'Review', type: 'slide', actions: [{ type: 'speech', text: 'body' }] },
            },
          ]
        : null,
    ),
    listChats: vi.fn(async () => chats),
    getChat: vi.fn(async (_ownerId, id) => chats.find((row) => row.id === id) ?? null),
    ...overrides,
  };
}

function tool(tools: ReturnType<typeof buildPersonalHistoryTools>, name: string) {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found as unknown as {
    parameters: object;
    execute(
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{ details: Record<string, unknown>; isError?: boolean }>;
  };
}

describe('personal history tools', () => {
  it('registers four owner-captured tools and accepts limits that execution caps', async () => {
    const deps = source();
    const tools = buildPersonalHistoryTools(owner, deps);
    expect(tools.map((item) => item.name)).toEqual(PERSONAL_HISTORY_TOOL_NAMES);
    for (const item of tools) expect(JSON.stringify(item.parameters)).not.toContain('owner');
    expect(Check(tool(tools, 'search_classrooms').parameters, { limit: 50 })).toBe(true);
    await tool(tools, 'search_classrooms').execute('call', {});
    expect(deps.listClassrooms).toHaveBeenCalledWith(owner);
  });

  it('searches owned classroom outline text and excludes foreign rows', async () => {
    const found = await tool(
      buildPersonalHistoryTools(owner, source()),
      'search_classrooms',
    ).execute('call', { query: 'Variable challenge' });
    expect(found.details).toMatchObject({ total: 1, query: 'variable challenge' });
    expect(JSON.stringify(found.details)).toContain('stage-1');
    expect(JSON.stringify(found.details)).not.toContain('Bookmarked course');
  });

  it('paginates outlines and scenes without returning raw scene bodies', async () => {
    const tools = buildPersonalHistoryTools(owner, source());
    const outlines = await tool(tools, 'read_classroom').execute('call', {
      classroomId: 'stage-1',
      section: 'outlines',
      limit: 1,
    });
    expect(outlines.details).toMatchObject({ total: 2, hasMore: true, nextOffset: 1 });
    const scenes = await tool(tools, 'read_classroom').execute('call', {
      classroomId: 'stage-1',
      section: 'scenes',
      limit: 1,
    });
    expect(JSON.stringify(scenes)).toContain('elementTypes');
    expect(JSON.stringify(scenes)).not.toContain('materialBody');
    expect(JSON.stringify(scenes)).not.toContain('SECRET');
    expect(JSON.stringify(scenes)).not.toContain('large body');
  });

  it('makes foreign and missing classroom reads indistinguishable', async () => {
    const read = tool(buildPersonalHistoryTools(owner, source()), 'read_classroom');
    const foreign = await read.execute('call', { classroomId: 'foreign', section: 'overview' });
    const missing = await read.execute('call', { classroomId: 'missing', section: 'overview' });
    expect(foreign).toEqual(missing);
    expect(foreign.isError).toBe(true);
  });

  it('searches visible chat text only and excludes the current session', async () => {
    const search = tool(buildPersonalHistoryTools(owner, source(), 'session-1'), 'search_chats');
    expect((await search.execute('call', { query: 'challenge' })).details).toMatchObject({
      total: 0,
    });
    const withoutCurrentGate = tool(buildPersonalHistoryTools(owner, source()), 'search_chats');
    for (const hidden of ['SYSTEM SECRET', 'HIDDEN PAYLOAD', 'MATERIAL BODY SECRET']) {
      expect((await withoutCurrentGate.execute('call', { query: hidden })).details).toMatchObject({
        total: 0,
      });
    }
  });

  it('reads visible messages, exposes tool names, and redacts secrets', async () => {
    const result = await tool(buildPersonalHistoryTools(owner, source()), 'read_chat').execute(
      'call',
      { sessionId: 'session-1', limit: 20 },
    );
    expect(result.details).toMatchObject({ total: 3, hasMore: false });
    expect(JSON.stringify(result)).toContain('generate_scene');
    expect(JSON.stringify(result)).toContain('api_key=[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('HIDDEN PAYLOAD');
    expect(JSON.stringify(result)).not.toContain('visible-but-sensitive');
  });

  it('caps page size and serialized output', async () => {
    const huge = 'x'.repeat(HISTORY_RESULT_MAX_CHARS * 2);
    const deps = source({
      listClassrooms: async () =>
        Array.from({ length: 100 }, (_, index) => classroom({ id: `stage-${index}`, title: huge })),
    });
    const result = await tool(buildPersonalHistoryTools(owner, deps), 'search_classrooms').execute(
      'call',
      { limit: 999 },
    );
    expect((result.details as { items?: unknown[] }).items?.length ?? 0).toBeLessThanOrEqual(
      HISTORY_PAGE_LIMIT_MAX,
    );
    expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(
      HISTORY_RESULT_MAX_CHARS + 200,
    );
  });
});

describe('visibleChatMessages', () => {
  it('drops system/tool results and keeps public text plus assistant tool names', () => {
    expect(visibleChatMessages(chat().messages)).toEqual([
      { role: 'user', text: 'Prioritize interaction' },
      { role: 'assistant', text: 'I will add a challenge', toolNames: ['generate_scene'] },
      { role: 'user', text: 'api_key=[REDACTED]' },
    ]);
  });
});

describe('upstream storage adaptation', () => {
  it('maps owner-scoped document summaries and session metadata without widening ownership', async () => {
    const documentStore = {
      listDocuments: vi.fn(async () => [
        {
          id: 'stage-1',
          name: 'Owned stage',
          description: 'Description',
          createdAt: 1,
          updatedAt: 2,
          sceneCount: 1,
        },
      ]),
      loadDocument: vi.fn(async () => ({
        stage: { id: 'stage-1', name: 'Owned stage' },
        outline: { requirement: 'Evidence' },
        scenes: [{ id: 'scene-1', stageId: 'stage-1', order: 1, title: 'Page', type: 'slide' }],
      })),
    };
    const sessionStore = {
      listSessionsByOwner: vi.fn(async () => [
        {
          id: 'chat-1',
          ownerId: owner,
          prompt: 'Prompt',
          stageId: 'stage-1',
          existingCourse: false,
          status: 'succeeded',
          attempt: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
      getSession: vi.fn(async () => null),
    };
    const adapted = createPersonalHistorySource({
      getDocumentStore: vi.fn(async (ownerId) => {
        expect(ownerId).toBe(owner);
        return documentStore as never;
      }),
      getSessionStore: vi.fn(async () => sessionStore as never),
      readChatMessages: vi.fn(async () => [{ role: 'user', content: 'Visible' }]),
    });

    expect(await adapted.listClassrooms(owner)).toMatchObject([
      { ownerId: owner, id: 'stage-1', title: 'Owned stage', pageCount: 1 },
    ]);
    expect(await adapted.listScenes(owner, 'foreign')).toBeNull();
    expect(await adapted.listChats(owner)).toMatchObject([
      { ownerId: owner, id: 'chat-1', messages: [{ role: 'user', content: 'Visible' }] },
    ]);
  });
});
