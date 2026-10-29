import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import { currentTeachingContext } from '@/lib/server/pbl-v3/teaching-context';

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    stopReason: 'stop',
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
const earlier: Message[] = [
  { role: 'user', content: 'I chose readability over brevity.', timestamp: 0 },
  assistant([{ type: 'toolCall', id: 'old-completion', name: 'complete_stage', arguments: {} }]),
  {
    role: 'toolResult',
    toolCallId: 'old-completion',
    toolName: 'complete_stage',
    content: [{ type: 'text', text: '{"readyForStudentConfirmation":true}' }],
    isError: false,
    timestamp: 0,
  },
  assistant([{ type: 'text', text: 'This earlier stage is finished. Click Continue.' }]),
];
const reflection: Message = {
  role: 'user',
  content: 'Now reflect on the recorded test result.',
  timestamp: 1,
};
const window = { stageKey: 'greeting:6', studentTurns: 1 };

describe('teaching stage handoff', () => {
  it('retains project knowledge without replaying an earlier completion as the active workflow', () => {
    const context: Context = {
      systemPrompt: 'Current stage: greeting:6, incomplete.',
      messages: [...earlier, reflection],
    };
    const original = structuredClone(context);
    const result = currentTeachingContext(context, window);
    expect(result.messages).toEqual([reflection]);
    expect(result.systemPrompt).toContain('I chose readability over brevity.');
    expect(result.systemPrompt).not.toContain('readyForStudentConfirmation');
    expect(result.systemPrompt).toMatch(/historical/i);
    expect(result.systemPrompt?.endsWith(context.systemPrompt!)).toBe(true);
    expect(context).toEqual(original);
  });

  it('preserves current-stage tool pairs and all real feedback without fabricating user messages', () => {
    const active: Message[] = [
      reflection,
      assistant([
        { type: 'toolCall', id: 'current-review', name: 'request_skill_review', arguments: {} },
      ]),
      {
        role: 'toolResult',
        toolCallId: 'current-review',
        toolName: 'request_skill_review',
        content: [{ type: 'text', text: 'Explain one observed result.' }],
        isError: false,
        timestamp: 1,
      },
      {
        role: 'user',
        content: 'Two recorded checks passed; other cases remain predictions.',
        timestamp: 2,
      },
    ];
    const result = currentTeachingContext(
      { systemPrompt: 'Current stage', messages: [...earlier, ...active] },
      { ...window, studentTurns: 2 },
    );
    expect(result.messages).toEqual(active);
    expect(result.messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(
      result.messages.some(
        (message) => message.role === 'toolResult' && message.toolCallId === 'old-completion',
      ),
    ).toBe(false);
  });

  it('retains the available transcript when its first current-stage turn is outside the retained view', () => {
    const context: Context = { messages: [reflection] };
    expect(currentTeachingContext(context, { ...window, studentTurns: 3 })).toBe(context);
  });

  it.each([true, false])(
    'retains already delivered prose as recovery data, not learner feedback (history: %s)',
    (history) => {
      const reply =
        'This milestone adds tasks. Append preserves order. What does the caller receive?';
      const context: Context = {
        systemPrompt: 'Current teaching policy',
        messages: history ? [...earlier, reflection] : [reflection],
      };
      const result = currentTeachingContext(context, { ...window, deliveredReply: reply });
      expect(result.messages).toEqual([reflection]);
      expect(result.systemPrompt).toContain(JSON.stringify(reply));
      expect(result.systemPrompt).toContain('record that SAME reply');
      expect(result.systemPrompt).toContain('verbatim into explanation');
      expect(result.systemPrompt).toContain('closing question verbatim into question');
      expect(result.systemPrompt).toContain('Do not omit an already delivered explanation');
      expect(result.systemPrompt).toContain('never student feedback');
      expect(result.messages.filter((message) => message.role === 'user')).toHaveLength(1);
      expect(context.systemPrompt).toBe('Current teaching policy');
    },
  );
});
