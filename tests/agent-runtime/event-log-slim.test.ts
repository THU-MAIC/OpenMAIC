import { describe, expect, it, vi } from 'vitest';

import { slimEventDataForLog } from '@/lib/server/agent-runtime/runner';

describe('runner event-log payload slimming', () => {
  it('keeps only the terminal metadata needed from agent_end', () => {
    const source = {
      type: 'agent_end',
      messages: [
        { role: 'user', content: 'Start' },
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'provider unavailable',
          content: [{ type: 'text', text: 'large partial response' }],
        },
      ],
    };
    expect(slimEventDataForLog('agent_end', source)).toEqual({
      type: 'agent_end',
      messageCount: 2,
      lastMessageContentLength: 22,
      messages: [
        {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'provider unavailable',
        },
      ],
    });
  });

  it('slims turn_end messages and valid tool results', () => {
    const source = {
      type: 'turn_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'stream failed',
        content: [{ type: 'text', text: 'large final response' }],
      },
      toolResults: [
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'ask_user',
          content: [{ type: 'text', text: 'large result' }],
          details: { large: true },
          isError: false,
          timestamp: 1_000,
        },
      ],
    };
    expect(slimEventDataForLog('turn_end', source)).toEqual({
      type: 'turn_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'stream failed' },
      toolResults: [
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'ask_user',
          isError: false,
          timestamp: 1_000,
        },
      ],
    });
  });

  it('never mutates the transcript object', () => {
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'ask_user',
      content: [{ type: 'text', text: 'full result' }],
      details: { question: 'Choose' },
      isError: false,
      timestamp: 1_000,
    };
    const event = { type: 'message_end', message: toolResult };
    const slimmed = slimEventDataForLog('message_end', event) as typeof event;
    expect(slimmed).not.toBe(event);
    expect(slimmed.message).not.toBe(toolResult);
    expect(slimmed.message.content).toEqual([]);
    expect(toolResult.content).toEqual([{ type: 'text', text: 'full result' }]);
    expect(toolResult.details).toEqual({ question: 'Choose' });
  });

  it('deep-clones an unrecognized tool-results payload and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const toolResults = [{ content: [{ type: 'text', text: 'unknown shape' }] }];
    const slimmed = slimEventDataForLog('turn_end', {
      type: 'turn_end',
      toolResults,
    }) as { toolResults: unknown };
    expect(slimmed.toolResults).toEqual(toolResults);
    expect(slimmed.toolResults).not.toBe(toolResults);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('toolResults shape unrecognized; preserving original payload'),
    );
    warn.mockRestore();
  });

  it('counts text and thinking while ignoring malformed blocks', () => {
    const source = {
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          content: [
            null,
            42,
            { type: 'image', source: 'asset://image' },
            [{ type: 'text', text: 'nested' }],
            { type: 'text', text: 'answer' },
            { type: 'thinking', thinking: 'reason' },
          ],
        },
      ],
    };
    expect(slimEventDataForLog('agent_end', source)).toMatchObject({
      lastMessageContentLength: 12,
    });
  });

  it('handles empty transcripts and user-terminal transcripts', () => {
    expect(slimEventDataForLog('agent_end', { type: 'agent_end', messages: [] })).toEqual({
      type: 'agent_end',
      messageCount: 0,
      lastMessageContentLength: 0,
      messages: [],
    });
    expect(
      slimEventDataForLog('agent_end', {
        type: 'agent_end',
        messages: [{ role: 'user', content: 'Please continue' }],
      }),
    ).toMatchObject({
      messageCount: 1,
      lastMessageContentLength: 15,
      messages: [{ role: 'user' }],
    });
  });

  it('drops repeated progress bodies', () => {
    const source = {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'ask_user',
      args: { large: true },
      partialResult: { large: true },
    };
    expect(slimEventDataForLog('tool_execution_update', source)).toEqual({
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'ask_user',
    });
    expect(source.args).toEqual({ large: true });
  });
});
