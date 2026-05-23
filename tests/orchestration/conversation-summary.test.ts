import { describe, expect, test } from 'vitest';
import {
  summarizeConversation,
  type OpenAIMessage,
} from '@/lib/orchestration/summarizers/conversation-summary';

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
