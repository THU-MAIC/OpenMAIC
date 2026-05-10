import { describe, expect, test } from 'vitest';
import {
  summarizeConversation,
  extractLastHumanMessage,
  type OpenAIMessage,
} from '@/lib/orchestration/summarizers/conversation-summary';
import type { StatelessChatRequest } from '@/lib/types/chat';

// ==================== Helpers ====================

// summarizeConversation() takes OpenAI-format messages from the director path.
// In the director path (no currentAgentId), message-converter.ts produces:
//   - human turns:  role:'user',      content: '[You]: <text>'  (senderName prefix applied)
//   - agent turns:  role:'assistant', content: '<json or text>'  (stay as assistant)
// There are NO role:'user' messages from agents in the director path.

const humanMsg = (content: string): OpenAIMessage => ({
  role: 'user',
  content: `[You]: ${content}`,
});
const agentMsg = (content: string): OpenAIMessage => ({ role: 'assistant', content });

// extractLastHumanMessage() takes original pre-conversion messages.
// These carry msg.metadata.originalRole === 'user' for genuine human turns.

let _msgId = 0;
const origHuman = (content: string): StatelessChatRequest['messages'][number] => ({
  id: `human-${++_msgId}`,
  role: 'user',
  parts: [{ type: 'text', text: content }],
  metadata: { originalRole: 'user', senderName: 'You' },
});

const origAgent = (name: string, content: string): StatelessChatRequest['messages'][number] => ({
  id: `agent-${++_msgId}`,
  role: 'assistant',
  parts: [{ type: 'text', text: content }],
  metadata: { originalRole: 'agent', senderName: name, agentId: `agent-${name}` },
});

// ==================== summarizeConversation ====================

describe('summarizeConversation — empty input', () => {
  test('returns sentinel string for empty message array', () => {
    expect(summarizeConversation([])).toBe('No conversation history yet.');
  });
});

describe('summarizeConversation — role label correctness (issue #511 core fix)', () => {
  test('human message with [You]: prefix is labelled [Student (Human)] with prefix stripped', () => {
    const out = summarizeConversation([humanMsg('Can a 3D object be axisymmetric?')]);
    expect(out).toContain('[Student (Human)]');
    expect(out).toContain('Can a 3D object be axisymmetric?');
    // The [You]: prefix must not appear in summary output
    expect(out).not.toContain('[You]:');
  });

  test('human message without any prefix is also labelled [Student (Human)]', () => {
    // Edge case: if senderName is absent, content has no prefix
    const bare: OpenAIMessage = { role: 'user', content: 'Bare question' };
    const out = summarizeConversation([bare]);
    expect(out).toContain('[Student (Human)]');
    expect(out).toContain('Bare question');
  });

  test('agent (assistant role) message is labelled [Agent]', () => {
    const out = summarizeConversation([agentMsg('Let us examine this together.')]);
    expect(out).toContain('[Agent]');
    expect(out).not.toContain('[User]');
    expect(out).not.toContain('[Student (Human)]');
  });

  test('mixed conversation: human and agent correctly labelled', () => {
    const messages: OpenAIMessage[] = [
      humanMsg('What is axial symmetry?'),
      agentMsg('Axial symmetry means the shape looks the same after rotation.'),
      humanMsg('But can a 3D object really be axisymmetric?'),
    ];
    const out = summarizeConversation(messages);
    expect(out).toContain('[Student (Human)] What is axial symmetry?');
    expect(out).toContain('[Agent]');
    expect(out).toContain('[Student (Human)] But can a 3D object really be axisymmetric?');
    expect(out).not.toContain('[User]');
    expect(out).not.toContain('[You]:');
  });
});

describe('summarizeConversation — issue #511 exact scenario', () => {
  /**
   * Reproduces the exact failure from issue #511 as it appears in the director path.
   * The director must distinguish an unanswered human challenge from agent exchanges.
   */
  test('#511 scenario: human challenge and agent reply are distinguishable', () => {
    const messages: OpenAIMessage[] = [
      agentMsg('Today we study axial symmetry. The Tiananmen gate is a great example.'),
      agentMsg('Yes, the gate looks symmetric from the front!'),
      humanMsg(
        'Wait — the gate is a 3D structure. Can we really call a 3D object axisymmetric? Symmetry is usually for 2D shapes.',
      ),
    ];

    const out = summarizeConversation(messages);

    expect(out).toContain('[Student (Human)]');
    expect(out).toContain('3D structure');
    expect(out).toContain('[Agent]');
    expect(out).not.toContain('[User]');
    expect(out).not.toContain('[You]:');

    const lines = out.split('\n');
    const humanLine = lines.find((l) => l.startsWith('[Student (Human)]'));
    const agentLine = lines.find((l) => l.startsWith('[Agent]'));
    expect(humanLine).toBeDefined();
    expect(agentLine).toBeDefined();
  });
});

describe('summarizeConversation — content truncation', () => {
  test('content longer than maxContentLength is truncated with ellipsis', () => {
    const longContent = 'A'.repeat(300);
    const out = summarizeConversation([humanMsg(longContent)], 10, 200);
    expect(out).toContain('A'.repeat(200) + '...');
    expect(out).not.toContain('A'.repeat(201));
  });

  test('content exactly at maxContentLength is NOT truncated', () => {
    const exactContent = 'B'.repeat(200);
    const out = summarizeConversation([humanMsg(exactContent)], 10, 200);
    expect(out).not.toContain('...');
  });

  test('agent message content is truncated correctly', () => {
    const longBody = 'C'.repeat(300);
    const out = summarizeConversation([agentMsg(longBody)], 10, 200);
    expect(out).toContain('[Agent]');
    expect(out).toContain('C'.repeat(200) + '...');
  });
});

describe('summarizeConversation — maxMessages slicing', () => {
  test('returns only the last maxMessages messages', () => {
    const messages: OpenAIMessage[] = Array.from({ length: 15 }, (_, i) =>
      humanMsg(`Message ${i + 1}`),
    );
    const out = summarizeConversation(messages, 5);
    expect(out).toContain('Message 15');
    expect(out).toContain('Message 11');
    expect(out).not.toContain('Message 10');
  });

  test('fewer messages than maxMessages returns all messages', () => {
    const messages = [humanMsg('Only one message')];
    const out = summarizeConversation(messages, 10);
    expect(out).toContain('Only one message');
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});

// ==================== extractLastHumanMessage ====================

describe('extractLastHumanMessage — basic extraction', () => {
  test('returns null for empty message array', () => {
    expect(extractLastHumanMessage([])).toBeNull();
  });

  test('returns the single human message content', () => {
    const result = extractLastHumanMessage([origHuman('Hello teacher!')]);
    expect(result).toBe('Hello teacher!');
  });

  test('returns the LAST human message when multiple exist', () => {
    const messages = [
      origHuman('First question'),
      origAgent('Teacher', 'Here is the answer.'),
      origHuman('Follow-up: what about 3D objects?'),
    ];
    expect(extractLastHumanMessage(messages)).toBe('Follow-up: what about 3D objects?');
  });

  test('skips agent messages (originalRole !== user)', () => {
    const messages = [
      origHuman('Can 3D objects be axisymmetric?'),
      origAgent('Xiao Ming', 'Yes of course!'),
    ];
    // Last message is an agent — should skip and return the human message
    expect(extractLastHumanMessage(messages)).toBe('Can 3D objects be axisymmetric?');
  });

  test('returns null when only agent messages exist', () => {
    const messages = [
      origAgent('Xiao Ming', 'I agree with the teacher.'),
      origAgent('Li Hua', 'Me too!'),
    ];
    expect(extractLastHumanMessage(messages)).toBeNull();
  });

  test('returns null when only assistant messages with no originalRole exist', () => {
    // Messages with no metadata at all — should not be treated as human
    const messages: StatelessChatRequest['messages'] = [
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Let us begin.' }] },
    ];
    expect(extractLastHumanMessage(messages)).toBeNull();
  });

  test('returns null for blank human message content', () => {
    const blank: StatelessChatRequest['messages'][number] = {
      id: 'h1',
      role: 'user',
      parts: [{ type: 'text', text: '   ' }],
      metadata: { originalRole: 'user', senderName: 'You' },
    };
    expect(extractLastHumanMessage([blank])).toBeNull();
  });

  test('multi-part human message: joins text parts', () => {
    const multiPart: StatelessChatRequest['messages'][number] = {
      id: 'h1',
      role: 'user',
      parts: [
        { type: 'text', text: 'First line' },
        { type: 'text', text: 'Second line' },
      ],
      metadata: { originalRole: 'user', senderName: 'You' },
    };
    expect(extractLastHumanMessage([multiPart])).toBe('First line\nSecond line');
  });

  test('issue #511 scenario: returns the substantive human challenge, not agent reply', () => {
    const messages = [
      origAgent('Teacher', 'The Tiananmen gate is axisymmetric...'),
      origAgent('Xiao Ming', 'Yes symmetric from the front!'),
      origHuman('But the gate is 3D — can 3D objects really be axisymmetric?'),
    ];
    const result = extractLastHumanMessage(messages);
    expect(result).toBe('But the gate is 3D — can 3D objects really be axisymmetric?');
  });

  test('handles conversation where human message comes before multiple agent turns', () => {
    const messages = [
      origHuman('What is symmetry?'),
      origAgent('Xiao Ming', 'Symmetry is when two sides match.'),
      origAgent('Li Hua', 'Like a butterfly!'),
    ];
    expect(extractLastHumanMessage(messages)).toBe('What is symmetry?');
  });
});

// ==================== Integration: summarize + extract together ====================

describe('integration: summarizeConversation + extractLastHumanMessage', () => {
  test('summary and extracted question are consistent on same conversation', () => {
    // summarizeConversation takes converted (OpenAI-format) messages
    const convertedMsgs: OpenAIMessage[] = [
      humanMsg('Can a 3D structure be axisymmetric?'),
      agentMsg('Good question! Let me explain...'),
    ];
    // extractLastHumanMessage takes original messages
    const originalMsgs = [
      origHuman('Can a 3D structure be axisymmetric?'),
      origAgent('Teacher', 'Good question! Let me explain...'),
    ];

    const summary = summarizeConversation(convertedMsgs);
    const lastHuman = extractLastHumanMessage(originalMsgs);

    expect(summary).toContain('[Student (Human)] Can a 3D structure be axisymmetric?');
    expect(summary).toContain('[Agent]');
    expect(lastHuman).toBe('Can a 3D structure be axisymmetric?');
  });
});
