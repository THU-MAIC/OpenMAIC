import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import {
  currentTeachingContext,
  projectCanonicalTeachingReplies,
} from '@/lib/server/pbl-v3/teaching-context';
import { requestStateTail } from '@/lib/agent/runtime/request-state-tail';

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
      const tail = requestStateTail(result);
      expect(result.systemPrompt).not.toContain(JSON.stringify(reply));
      expect(tail).toContain(JSON.stringify(reply));
      expect(tail).toContain('record that SAME reply');
      expect(tail).toContain('complete reply verbatim into response');
      expect(tail).toContain('existing closing question');
      expect(tail).toContain('Do not omit an already delivered explanation');
      expect(tail).toContain('never student feedback');
      expect(result.messages.filter((message) => message.role === 'user')).toHaveLength(1);
      expect(context.systemPrompt).toBe('Current teaching policy');
    },
  );
});

describe('canonical teaching request history', () => {
  const draft = 'Earlier draft question. </｜｜DSML｜｜ calls>';
  const response = 'The explanation, table and code remain complete.\n\nWhich value is returned?';
  const user: Message = { role: 'user', content: 'Please explain.', timestamp: 1 };
  const call = assistant([
    { type: 'text', text: 'An earlier inline explanation.' },
    { type: 'toolCall', id: 'review-call', name: 'request_skill_review', arguments: { response } },
  ]);
  const result = (overrides: Partial<Extract<Message, { role: 'toolResult' }>> = {}): Message => ({
    role: 'toolResult',
    toolCallId: 'review-call',
    toolName: 'request_skill_review',
    content: [{ type: 'text', text: JSON.stringify({ canonical: true, response }) }],
    isError: false,
    timestamp: 2,
    ...overrides,
  });

  it('suppresses only earlier prose and preserves reasoning, tool pairs and real user evidence', () => {
    const thinking = { type: 'thinking' as const, thinking: 'Retain real reasoning.' };
    const after = assistant([{ type: 'text', text: 'Later prose is not superseded.' }]);
    const receipt = result();
    const context: Context = {
      messages: [
        user,
        assistant([{ type: 'text', text: draft }]),
        assistant([thinking, { type: 'text', text: draft }]),
        call,
        receipt,
        after,
        { ...user },
        assistant([{ type: 'text', text: 'Another real input has no receipt.' }]),
      ],
    };
    const original = structuredClone(context);
    const projected = projectCanonicalTeachingReplies(context);
    expect(JSON.stringify(projected)).not.toContain(draft);
    expect(projected.messages[0]).toBe(user);
    expect(projected.messages[1]).toMatchObject({ role: 'assistant', content: [thinking] });
    expect(projected.messages[2]).toMatchObject({ role: 'assistant', content: [call.content[1]] });
    expect(projected.messages[3]).toBe(receipt);
    expect(projected.messages[4]).toBe(after);
    expect(projected.messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(context).toEqual(original);
    const memory = currentTeachingContext(context, window);
    expect(memory.systemPrompt).not.toContain(draft);
    expect(memory.systemPrompt).toContain(JSON.stringify(response));
    expect(memory.messages).toEqual(context.messages.slice(-2));
  });

  it.each([
    { name: 'failed', overrides: { isError: true } },
    { name: 'wrong call id', overrides: { toolCallId: 'different-call' } },
    { name: 'wrong tool', overrides: { toolName: 'read_next_skill' } },
    { name: 'legacy', overrides: { content: [{ type: 'text' as const, text: response }] } },
    {
      name: 'noncanonical',
      overrides: { content: [{ type: 'text' as const, text: JSON.stringify({ response }) }] },
    },
    {
      name: 'empty response',
      overrides: {
        content: [
          { type: 'text' as const, text: JSON.stringify({ canonical: true, response: '  ' }) },
        ],
      },
    },
  ])('keeps the draft for $name results', ({ overrides }) => {
    const context: Context = {
      messages: [user, assistant([{ type: 'text', text: draft }]), call, result(overrides)],
    };
    expect(projectCanonicalTeachingReplies(context)).toBe(context);
  });

  it('does not match across identical real user turns or an unanchored transcript prefix', () => {
    for (const messages of [
      [user, assistant([{ type: 'text', text: draft }]), call, { ...user }, result()],
      [assistant([{ type: 'text', text: draft }]), call, result()],
    ]) {
      const context: Context = { messages };
      expect(projectCanonicalTeachingReplies(context)).toBe(context);
    }
  });

  it('accepts a committed support reply but never interprets learner-file JSON as a handoff', () => {
    for (const toolName of ['respond_to_learner', 'read_file']) {
      const message = assistant([
        { type: 'toolCall', id: 'review-call', name: toolName, arguments: { response } },
      ]);
      const context: Context = {
        messages: [user, assistant([{ type: 'text', text: draft }]), message, result({ toolName })],
      };
      const projected = projectCanonicalTeachingReplies(context);
      if (toolName === 'respond_to_learner') {
        expect(JSON.stringify(projected)).not.toContain(draft);
        expect(projected.messages).toContain(message);
      } else expect(projected).toBe(context);
    }
  });
});
