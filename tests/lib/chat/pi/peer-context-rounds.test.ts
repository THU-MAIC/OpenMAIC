import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { streamLLM } from '@/lib/ai/llm';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn(), resolveModel: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));

import { POST } from '@/app/api/chat/pi/route';

const agents: AgentConfig[] = ['Teacher', 'Assistant'].map((name, index) => ({
  id: `agent-${index}`,
  name,
  role: index === 0 ? 'teacher' : 'assistant',
  persona: 'Explain clearly.',
  avatar: '',
  color: '#fff',
  allowedActions: [],
  priority: 10 - index,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: true,
}));

function response(parts: Record<string, unknown>[], finishReason = 'stop') {
  return {
    fullStream: (async function* () {
      yield* parts;
      yield {
        type: 'finish',
        finishReason,
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      };
    })(),
    usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
  };
}

type ProviderRequest = Pick<Parameters<typeof streamLLM>[0], 'system' | 'messages'>;
const utterance = (round: number, name: string) => `Round ${round} ${name} explanation.`;

describe('peer context across client follow-up turns', () => {
  beforeEach(() => {
    mocks.streamLLM.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { provider: 'test.provider', modelId: 'offline' },
      apiKey: 'offline',
      providerId: 'openai',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected network request'))),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(['native', 'legacy'] as const)(
    'keeps history separate from current-round peers through the %s route',
    async (mode) => {
      vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', String(mode === 'native'));
      const body: StatelessChatRequest = {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Test', createdAt: 1, updatedAt: 1 },
          outlines: [],
          scenes: [],
          currentSceneId: null,
          mode: 'autonomous',
          whiteboardOpen: false,
        },
        config: { agentIds: agents.map((agent) => agent.id), agentConfigs: agents },
        apiKey: '',
      } as StatelessChatRequest;
      const captures: { round: number; children: ProviderRequest[]; director: ProviderRequest }[] =
        [];

      for (let round = 1; round <= 3; round++) {
        let directorCalls = 0;
        const children: ProviderRequest[] = [];
        let director!: ProviderRequest;
        mocks.streamLLM.mockImplementation((params: ProviderRequest, source: string) => {
          if (source === 'pi-chat-director') {
            if (directorCalls === 0)
              director = structuredClone({ system: params.system, messages: params.messages });
            const agent = agents[directorCalls++];
            return response(
              [
                {
                  type: 'tool-call',
                  toolCallId: `round-${round}-call-${directorCalls}`,
                  toolName: agent ? 'call_agent' : 'cue_user',
                  input: agent ? { agentId: agent.id, instruction: 'Explain the next point.' } : {},
                },
              ],
              'tool-calls',
            );
          }
          children.push(structuredClone({ system: params.system, messages: params.messages }));
          const text = utterance(round, agents[children.length - 1].name);
          return response([
            {
              type: 'text-delta',
              text: mode === 'native' ? text : JSON.stringify([{ type: 'text', content: text }]),
            },
          ]);
        });

        // The client retains session messages and sends the last done.directorState verbatim.
        body.messages.push({
          id: `user-${round}`,
          role: 'user',
          parts: [{ type: 'text', text: `Explain round ${round}.` }],
        });
        const result = await POST(
          new Request('http://localhost/api/chat/pi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }) as NextRequest,
        );
        expect(result.status).toBe(200);
        const events: StatelessEvent[] = (await result.text())
          .split('\n\n')
          .filter((frame) => frame.startsWith('data: '))
          .map((frame) => JSON.parse(frame.slice(6)));
        const done = events.find((event) => event.type === 'done');
        expect(done, JSON.stringify(events)).toBeDefined();
        if (done?.type !== 'done') throw new Error('Missing completion');
        expect(children).toHaveLength(2);
        expect(done.data.totalAgents).toBe(2);
        expect(done.data.directorState?.agentResponses).toHaveLength(round * 2);
        body.directorState = done.data.directorState;

        // Reconstruct the visible assistant messages using the same stream message IDs.
        for (const event of events) {
          if (event.type === 'agent_start') {
            body.messages.push({ id: event.data.messageId, role: 'assistant', parts: [] });
          } else if (event.type === 'text_delta') {
            const message = body.messages.find((item) => item.id === event.data.messageId);
            if (!message) throw new Error('Text without an agent message');
            message.parts.push({ type: 'text', text: event.data.content });
          }
        }
        captures.push({ round, children, director });
      }

      for (const { round, children, director } of captures) {
        for (const [index, child] of children.entries()) {
          const label = `${mode} round ${round} ${agents[index].name}`;
          const system = String(child.system);
          if (index === 0) {
            expect.soft(system, label).not.toContain("# This Round's Context");
          } else {
            expect.soft(system, label).toContain("# This Round's Context");
            expect.soft(system, label).toContain(utterance(round, 'Teacher'));
          }
          expect.soft(system, label).not.toContain(utterance(round, agents[index].name));
          for (let previous = 1; previous < round; previous++) {
            for (const agent of agents) {
              const history = utterance(previous, agent.name);
              expect.soft(system, label).not.toContain(history);
              expect.soft(JSON.stringify(child.messages), label).toContain(history);
              expect.soft(String(director.system), label).toContain(history);
              expect.soft(JSON.stringify(director.messages), label).toContain(history);
            }
          }
        }
      }
    },
  );
});
