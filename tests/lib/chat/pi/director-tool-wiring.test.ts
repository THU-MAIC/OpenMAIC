import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { buildDirectorPrompt } from '@/lib/chat/pi/prompts';
import { buildReadSceneTool } from '@/lib/chat/pi/tools/read-scene';
import { buildDirectorWebSearchTool } from '@/lib/chat/pi/tools/web-search';
import type { StatelessChatRequest } from '@/lib/types/chat';

const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teach from evidence.',
  avatar: '',
  color: '#3366ff',
  allowedActions: [],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

function makeBody(question: string): StatelessChatRequest {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: question }],
      },
    ],
    storeState: {
      stage: {
        id: 'stage-1',
        name: 'Quadratic Functions',
        createdAt: 1,
        updatedAt: 77,
      },
      outlines: [
        {
          id: 'outline-1',
          type: 'slide',
          title: 'Vertex form',
          description: 'The current slide introduces the vertex form.',
          keyPoints: ['y=a(x-h)^2+k'],
          order: 1,
        },
        {
          id: 'outline-2',
          type: 'slide',
          title: 'Axis of symmetry',
          description: 'The next slide derives the axis of symmetry.',
          keyPoints: ['x=h'],
          order: 2,
        },
      ],
      scenes: [
        {
          id: 'scene-1',
          outlineId: 'outline-1',
          stageId: 'stage-1',
          title: 'Vertex form',
          order: 1,
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } as never },
        },
        {
          id: 'scene-2',
          outlineId: 'outline-2',
          stageId: 'stage-1',
          title: 'Axis of symmetry',
          order: 2,
          type: 'slide',
          updatedAt: 88,
          content: {
            type: 'slide',
            canvas: {
              elements: [
                {
                  id: 'next-slide-proof',
                  type: 'text',
                  content: 'For y=a(x-h)^2+k, the axis of symmetry is x=h.',
                  left: 40,
                  top: 80,
                  width: 480,
                  height: 60,
                },
              ],
            } as never,
          },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: {
      agentIds: [teacher.id],
      agentConfigs: [teacher],
      sessionType: 'qa',
    },
    apiKey: '',
  } as StatelessChatRequest;
}

describe('Pi Director scene and web tool wiring', () => {
  it('can resolve a question whose evidence exists only on the next slide', async () => {
    const body = makeBody('下一页才会讲到的对称轴是什么？');
    const prompt = buildDirectorPrompt(body, [teacher], 4);
    const tool = buildReadSceneTool({ body });

    const result = await tool.execute('read-next', { sceneId: 'scene-2' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(prompt).toContain('order=2, sceneId="scene-2"');
    expect(prompt).toContain('another scene, or the next scene');
    expect(text).toContain('the axis of symmetry is x=h');
    expect(result.details).toMatchObject({
      status: 'ok',
      sceneId: 'scene-2',
      revision: '88',
      source: 'request_start_snapshot',
    });
  });

  it('uses sourced web evidence for a latest World Cup result boundary', async () => {
    const body = makeBody('最新一届世界杯决赛结果是什么？');
    const prompt = buildDirectorPrompt(body, [teacher], 4);
    const searchResponses = vi.fn(async () => ({
      answer: 'Verified current result.',
      query: 'latest World Cup final result',
      responseTime: 0.2,
      sources: [
        {
          title: 'Official result',
          url: 'https://example.test/official-world-cup-result',
          content: 'Official match result.',
          score: 1,
        },
      ],
    }));
    const tool = buildDirectorWebSearchTool({
      resolveConfig: () => ({
        providerId: 'responses',
        apiKey: 'test-key',
        baseUrl: 'https://responses-proxy.test/v1',
        model: 'search-model',
      }),
      searchResponses,
      now: () => new Date('2026-07-21T08:00:00.000Z'),
    });

    const result = await tool.execute('search-latest', {
      query: 'latest World Cup final result',
    });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(prompt).toContain('current, recent, or externally verifiable information');
    expect(searchResponses).toHaveBeenCalledOnce();
    expect(text).toContain('https://example.test/official-world-cup-result');
    expect(text).toContain('retrievedAt=2026-07-21T08:00:00.000Z');
  });

  it('keeps ordinary course questions on the scene path instead of the web path', () => {
    const prompt = buildDirectorPrompt(
      makeBody('二次函数顶点式中的 h 和 k 分别表示什么？'),
      [teacher],
      4,
    );

    expect(prompt).toContain('Do not call `web_search` for ordinary course-content questions');
    expect(prompt).toContain('call `read_scene` with the exact sceneId');
  });
});
