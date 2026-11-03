import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import { validateToolArguments, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import {
  replayToolCallArguments,
  toolCallArguments,
  TOOL_ARGUMENTS_ERROR_KEY,
} from '@/lib/agent/runtime/tool-call-arguments';
import { createPartMapper, toModelMessages } from '@/lib/agent/runtime/stream-fn';

function emptyPartial(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'unknown' as never,
    provider: 'unknown' as never,
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 0,
  };
}

// A long argument string with an unescaped quote inside a string value.
const MALFORMED = `{"stageId":"s1","note":"${'x'.repeat(2000)} say "hi" here"}`;

describe('toolCallArguments', () => {
  it('passes plain objects through and parses JSON object strings', () => {
    const args = { a: 1 };
    expect(toolCallArguments(args)).toBe(args);
    expect(toolCallArguments('{"a":1}')).toEqual({ a: 1 });
    expect(toolCallArguments(undefined)).toEqual({});
    expect(toolCallArguments('  ')).toEqual({});
  });

  it('turns malformed JSON into {} plus a positioned diagnosis', () => {
    const args = toolCallArguments(MALFORMED);
    expect(Object.keys(args)).toEqual([TOOL_ARGUMENTS_ERROR_KEY]);
    const diagnosis = String(args[TOOL_ARGUMENTS_ERROR_KEY]);
    expect(diagnosis).toMatch(/^Tool arguments were not valid JSON \(/);
    expect(diagnosis).toMatch(/at position \d+ of \d+ chars/);
    expect(diagnosis).toContain(`of ${MALFORMED.length} chars`);
    expect(diagnosis).toContain('say \\"hi');
    expect(diagnosis).toContain('Check quote escaping inside string values');
    // The raw multi-KB payload is never echoed back whole.
    expect(diagnosis.length).toBeLessThan(400);
  });

  it('rejects non-object JSON values with a diagnosis', () => {
    expect(toolCallArguments('[1,2]')).toEqual({
      [TOOL_ARGUMENTS_ERROR_KEY]: 'Tool arguments must be a JSON object, got an array.',
    });
    expect(toolCallArguments(42)[TOOL_ARGUMENTS_ERROR_KEY]).toContain('a number');
  });

  it('replays a plain object without the diagnosis key', () => {
    expect(replayToolCallArguments(MALFORMED)).toEqual({});
    expect(replayToolCallArguments({ a: 1, [TOOL_ARGUMENTS_ERROR_KEY]: 'x' })).toEqual({ a: 1 });
    expect(replayToolCallArguments('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('stream-fn tool-call arguments', () => {
  it('stores an object for malformed tool input and surfaces the diagnosis on validation', () => {
    const partial = emptyPartial();
    const mapper = createPartMapper(partial, () => undefined);
    mapper.handle({ type: 'tool-call', toolCallId: 'c1', toolName: 'write', input: MALFORMED });
    const call = partial.content[0] as ToolCall;
    expect(typeof call.arguments).toBe('object');

    const tool = {
      name: 'write',
      description: 'test',
      parameters: Type.Object({ stageId: Type.String(), note: Type.String() }),
    };
    let message = '';
    try {
      validateToolArguments(tool, call);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Validation failed for tool "write"');
    expect(message).toContain('Tool arguments were not valid JSON');

    // The next turn replays a plain object, never the raw string.
    const replayed = toModelMessages([partial]);
    const part = (replayed[0] as { content: Array<Record<string, unknown>> }).content[0]!;
    expect(part).toMatchObject({ type: 'tool-call', toolCallId: 'c1', input: {} });
  });

  it('replays legacy string arguments stored by older sessions as objects', () => {
    const partial = emptyPartial();
    partial.content.push({
      type: 'toolCall',
      id: 'c2',
      name: 'write',
      arguments: '{"stageId":"s1"}' as unknown as Record<string, unknown>,
    });
    const replayed = toModelMessages([partial]);
    const part = (replayed[0] as { content: Array<Record<string, unknown>> }).content[0]!;
    expect(part.input).toEqual({ stageId: 's1' });
  });
});
