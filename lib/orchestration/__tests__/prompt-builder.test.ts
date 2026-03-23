/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { summarizeConversation, convertMessagesToOpenAI } from '../prompt-builder';

describe('summarizeConversation', () => {
  it('returns placeholder for empty messages', () => {
    expect(summarizeConversation([])).toBe('No conversation history yet.');
  });

  it('formats messages with role labels', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there' },
    ];
    const result = summarizeConversation(messages);
    expect(result).toContain('[User] Hello');
    expect(result).toContain('[Assistant] Hi there');
  });

  it('labels system messages correctly', () => {
    const messages = [{ role: 'system' as const, content: 'System init' }];
    const result = summarizeConversation(messages);
    expect(result).toContain('[System] System init');
  });

  it('truncates long messages to maxContentLength', () => {
    const longContent = 'A'.repeat(300);
    const messages = [{ role: 'user' as const, content: longContent }];
    const result = summarizeConversation(messages, 10, 50);
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(longContent.length);
  });

  it('limits to maxMessages most recent', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `Message ${i}`,
    }));
    const result = summarizeConversation(messages, 3);
    // Should only have the last 3 messages
    expect(result).toContain('Message 17');
    expect(result).toContain('Message 18');
    expect(result).toContain('Message 19');
    expect(result).not.toContain('Message 0');
  });
});

describe('convertMessagesToOpenAI', () => {
  it('converts user text messages', () => {
    const messages = [
      {
        role: 'user' as const,
        parts: [{ type: 'text', text: 'Hello teacher' }],
      },
    ];
    const result = convertMessagesToOpenAI(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('Hello teacher');
  });

  it('converts assistant messages with text parts to JSON format', () => {
    const messages = [
      {
        role: 'assistant' as const,
        parts: [{ type: 'text', text: 'Good morning' }],
      },
    ];
    const result = convertMessagesToOpenAI(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    const parsed = JSON.parse(result[0].content);
    expect(parsed).toEqual([{ type: 'text', content: 'Good morning' }]);
  });

  it('converts assistant action result parts', () => {
    const messages = [
      {
        role: 'assistant' as const,
        parts: [
          {
            type: 'action-spotlight',
            state: 'result',
            actionName: 'spotlight',
            output: { success: true },
          },
        ],
      },
    ];
    const result = convertMessagesToOpenAI(messages as any);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0].content);
    expect(parsed[0].type).toBe('action');
    expect(parsed[0].name).toBe('spotlight');
    expect(parsed[0].result).toBe('success');
  });

  it('attributes other agent messages as user role with name', () => {
    const messages = [
      {
        role: 'assistant' as const,
        parts: [{ type: 'text', text: 'I am agent B' }],
        metadata: { agentId: 'agent-b', senderName: 'AgentB' },
      },
    ];
    const result = convertMessagesToOpenAI(messages as any, 'agent-a');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('[AgentB]');
  });

  it('keeps own agent messages as assistant role', () => {
    const messages = [
      {
        role: 'assistant' as const,
        parts: [{ type: 'text', text: 'I said this' }],
        metadata: { agentId: 'agent-a' },
      },
    ];
    const result = convertMessagesToOpenAI(messages as any, 'agent-a');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
  });

  it('filters out system messages', () => {
    const messages = [
      { role: 'system' as const, parts: [{ type: 'text', text: 'system' }] },
      { role: 'user' as const, parts: [{ type: 'text', text: 'user' }] },
    ];
    const result = convertMessagesToOpenAI(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
  });

  it('filters out empty/whitespace-only user messages', () => {
    const messages = [
      { role: 'user' as const, parts: [{ type: 'text', text: '' }] },
      { role: 'user' as const, parts: [{ type: 'text', text: '...' }] },
      { role: 'user' as const, parts: [{ type: 'text', text: '…' }] },
    ];
    const result = convertMessagesToOpenAI(messages as any);
    expect(result).toHaveLength(0);
  });

  it('annotates interrupted messages', () => {
    const messages = [
      {
        role: 'user' as const,
        parts: [{ type: 'text', text: 'Interrupted text' }],
        metadata: { interrupted: true },
      },
    ];
    const result = convertMessagesToOpenAI(messages as any);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('interrupted');
  });

  it('includes sender name in user messages', () => {
    const messages = [
      {
        role: 'user' as const,
        parts: [{ type: 'text', text: 'My thought' }],
        metadata: { senderName: 'Student1' },
      },
    ];
    const result = convertMessagesToOpenAI(messages as any);
    expect(result[0].content).toContain('[Student1]');
  });
});
