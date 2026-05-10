import { describe, expect, test } from 'vitest';
import {
  summarizeConversation,
  extractLastHumanMessage,
  type OpenAIMessage,
} from '@/lib/orchestration/summarizers/conversation-summary';

// ==================== Helpers ====================

const human = (content: string): OpenAIMessage => ({ role: 'user', content });
const agent = (name: string, content: string): OpenAIMessage => ({
  role: 'user',
  content: `[${name}]: ${content}`,
});
const assistant = (content: string): OpenAIMessage => ({ role: 'assistant', content });

// ==================== summarizeConversation ====================

describe('summarizeConversation — empty input', () => {
  test('returns sentinel string for empty message array', () => {
    expect(summarizeConversation([])).toBe('No conversation history yet.');
  });
});

describe('summarizeConversation — role label correctness (issue #511 core fix)', () => {
  test('genuine human message is labelled [Student (Human)]', () => {
    const out = summarizeConversation([human('Can a 3D object be axisymmetric?')]);
    expect(out).toContain('[Student (Human)]');
    expect(out).toContain('Can a 3D object be axisymmetric?');
  });

  test('peer agent message is labelled [Agent: Name], NOT [User]', () => {
    const out = summarizeConversation([agent('Xiao Ming', 'Yes, the gate is symmetric!')]);
    expect(out).toContain('[Agent: Xiao Ming]');
    expect(out).not.toContain('[User]');
    expect(out).not.toContain('[Student (Human)]');
  });

  test('agent label strips the [Name]: prefix from content body', () => {
    const out = summarizeConversation([agent('Xiao Ming', 'Yes it is symmetric.')]);
    // The prefix should appear only as part of the role label, not duplicated in body
    expect(out).not.toContain('[Agent: Xiao Ming] [Xiao Ming]');
    expect(out).toContain('Yes it is symmetric.');
  });

  test('assistant message is labelled [Assistant]', () => {
    const out = summarizeConversation([assistant('Let us look at the diagram.')]);
    expect(out).toContain('[Assistant]');
    expect(out).not.toContain('[User]');
    expect(out).not.toContain('[Student (Human)]');
  });

  test('mixed conversation: human, agent, and assistant all correctly labelled', () => {
    const messages: OpenAIMessage[] = [
      human('What is axial symmetry?'),
      assistant('Great question! Axial symmetry means...'),
      agent('Xiao Ming', 'I think the gate is symmetric!'),
      human('But can a 3D object really be axisymmetric?'),
    ];
    const out = summarizeConversation(messages);
    expect(out).toContain('[Student (Human)] What is axial symmetry?');
    expect(out).toContain('[Assistant]');
    expect(out).toContain('[Agent: Xiao Ming]');
    expect(out).toContain('[Student (Human)] But can a 3D object really be axisymmetric?');
    // Must not collapse human and agent turns to the same label
    expect(out).not.toContain('[User]');
  });

  test('agent names with spaces are preserved correctly', () => {
    const out = summarizeConversation([agent('Li Hua', 'The shape is symmetric along the axis.')]);
    expect(out).toContain('[Agent: Li Hua]');
  });

  test('agent names with special chars preserved (numbers, hyphens)', () => {
    const out = summarizeConversation([agent('Agent-2', 'I agree with the teacher.')]);
    expect(out).toContain('[Agent: Agent-2]');
  });
});

describe('summarizeConversation — issue #511 exact scenario', () => {
  /**
   * Reproduces the exact failure from issue #511:
   * User challenges whether a 3D structure can be called axisymmetric.
   * Student agent gives a short generic reply.
   * Director must see these as DIFFERENT speakers — not both as [User].
   */
  test('#511 scenario: human challenge and agent reply are distinguishable', () => {
    const messages: OpenAIMessage[] = [
      assistant('Today we study axial symmetry. The Tiananmen gate is a great example.'),
      // Student agent's brief reply (re-encoded as user role by convertMessagesToOpenAI)
      agent('Xiao Ming', 'Yes, the gate looks symmetric from the front!'),
      // The actual human student's substantive challenge
      human(
        'Wait — the gate is a 3D structure. Can we really call a 3D object axisymmetric? Symmetry is usually for 2D shapes.',
      ),
    ];

    const out = summarizeConversation(messages);

    // Human challenge is labelled as human
    expect(out).toContain('[Student (Human)]');
    expect(out).toContain('3D structure');

    // Agent reply is labelled as agent — director can distinguish them
    expect(out).toContain('[Agent: Xiao Ming]');

    // Critical: they must NOT share the same [User] label
    expect(out).not.toContain('[User]');

    // The director summary clearly shows an open human question (3D / axisymmetric)
    // that has not been answered — preventing premature END
    const lines = out.split('\n');
    const humanLine = lines.find((l) => l.startsWith('[Student (Human)]'));
    const agentLine = lines.find((l) => l.startsWith('[Agent: Xiao Ming]'));
    expect(humanLine).toBeDefined();
    expect(agentLine).toBeDefined();
  });
});

describe('summarizeConversation — content truncation', () => {
  test('content longer than maxContentLength is truncated with ellipsis', () => {
    const longContent = 'A'.repeat(300);
    const out = summarizeConversation([human(longContent)], 10, 200);
    expect(out).toContain('A'.repeat(200) + '...');
    expect(out).not.toContain('A'.repeat(201));
  });

  test('content exactly at maxContentLength is NOT truncated', () => {
    const exactContent = 'B'.repeat(200);
    const out = summarizeConversation([human(exactContent)], 10, 200);
    expect(out).not.toContain('...');
  });

  test('agent message body is truncated, not the full [Name]: body string', () => {
    const longBody = 'C'.repeat(300);
    const out = summarizeConversation([agent('Xiao Ming', longBody)], 10, 200);
    // Label should be intact, only body truncated
    expect(out).toContain('[Agent: Xiao Ming]');
    expect(out).toContain('C'.repeat(200) + '...');
  });
});

describe('summarizeConversation — maxMessages slicing', () => {
  test('returns only the last maxMessages messages', () => {
    const messages: OpenAIMessage[] = Array.from({ length: 15 }, (_, i) =>
      human(`Message ${i + 1}`),
    );
    const out = summarizeConversation(messages, 5);
    expect(out).toContain('Message 15');
    expect(out).toContain('Message 11');
    expect(out).not.toContain('Message 10');
  });

  test('fewer messages than maxMessages returns all messages', () => {
    const messages = [human('Only one message')];
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
    const result = extractLastHumanMessage([human('Hello teacher!')]);
    expect(result).toBe('Hello teacher!');
  });

  test('returns the LAST human message when multiple exist', () => {
    const messages: OpenAIMessage[] = [
      human('First question'),
      assistant('Here is the answer.'),
      human('Follow-up: what about 3D objects?'),
    ];
    expect(extractLastHumanMessage(messages)).toBe('Follow-up: what about 3D objects?');
  });

  test('skips agent-prefixed messages (re-encoded as role:user)', () => {
    const messages: OpenAIMessage[] = [
      human('Can 3D objects be axisymmetric?'),
      agent('Xiao Ming', 'Yes of course!'),
    ];
    // Last user-role message has agent prefix — should skip it and return human's message
    expect(extractLastHumanMessage(messages)).toBe('Can 3D objects be axisymmetric?');
  });

  test('returns null when only agent messages exist (no bare human message)', () => {
    const messages: OpenAIMessage[] = [
      agent('Xiao Ming', 'I agree with the teacher.'),
      agent('Li Hua', 'Me too!'),
    ];
    expect(extractLastHumanMessage(messages)).toBeNull();
  });

  test('returns null when only assistant messages exist', () => {
    const messages: OpenAIMessage[] = [assistant('Let us begin.'), assistant('Here is the answer.')];
    expect(extractLastHumanMessage(messages)).toBeNull();
  });

  test('returns null for blank human message content', () => {
    const messages: OpenAIMessage[] = [{ role: 'user', content: '   ' }];
    expect(extractLastHumanMessage(messages)).toBeNull();
  });

  test('issue #511 scenario: returns the substantive human challenge, not agent reply', () => {
    const messages: OpenAIMessage[] = [
      assistant('The Tiananmen gate is axisymmetric...'),
      agent('Xiao Ming', 'Yes symmetric from the front!'),
      human('But the gate is 3D — can 3D objects really be axisymmetric?'),
    ];
    const result = extractLastHumanMessage(messages);
    expect(result).toBe('But the gate is 3D — can 3D objects really be axisymmetric?');
    expect(result).not.toContain('[Xiao Ming]');
  });

  test('handles conversation where human message comes before multiple agent turns', () => {
    const messages: OpenAIMessage[] = [
      human('What is symmetry?'),
      agent('Xiao Ming', 'Symmetry is when two sides match.'),
      agent('Li Hua', 'Like a butterfly!'),
    ];
    // Human message is earlier but is the only genuine human turn
    expect(extractLastHumanMessage(messages)).toBe('What is symmetry?');
  });
});

// ==================== Integration: summarize + extract together ====================

describe('integration: summarizeConversation + extractLastHumanMessage', () => {
  test('summary and extracted question are consistent on same message list', () => {
    const messages: OpenAIMessage[] = [
      human('Can a 3D structure be axisymmetric?'),
      agent('Xiao Ming', 'I think yes!'),
    ];
    const summary = summarizeConversation(messages);
    const lastHuman = extractLastHumanMessage(messages);

    // Summary correctly labels both
    expect(summary).toContain('[Student (Human)] Can a 3D structure be axisymmetric?');
    expect(summary).toContain('[Agent: Xiao Ming]');

    // Extracted human message matches what's in summary
    expect(lastHuman).toBe('Can a 3D structure be axisymmetric?');
  });
});
