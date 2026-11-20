import type { TextStreamPart, ToolSet } from 'ai';

import { mapStreamPart } from '@/lib/ai/stream-parts';
import type { SSEErrorEvent, SSETokenEvent, SSEToolCallEvent } from './sse';

type PBLStreamPart = SSETokenEvent | SSEToolCallEvent | SSEErrorEvent | { type: 'tool-result' };

/**
 * Translate model parts in arrival order. Tool results signal that queued
 * project patches can be flushed. Each turn owns its terminal events.
 */
export async function* streamPBLParts<Tools extends ToolSet>(
  stream: AsyncIterable<TextStreamPart<Tools>>,
  errorFallback?: string,
): AsyncGenerator<PBLStreamPart> {
  for await (const rawPart of stream) {
    const part = mapStreamPart(rawPart);
    switch (part?.type) {
      case 'text-delta':
        yield { type: 'token', delta: part.delta };
        break;
      case 'tool-call':
        yield {
          type: 'tool_call',
          toolName: part.toolName,
          args: (part.input ?? {}) as Record<string, unknown>,
          toolCallId: part.toolCallId,
        };
        break;
      case 'tool-result':
        yield part;
        break;
      case 'error':
        // The simulator reads only text and handles an empty attempt itself.
        if (errorFallback !== undefined) {
          yield {
            type: 'error',
            code: 'LLM_ERROR',
            message:
              part.error instanceof Error
                ? part.error.message
                : String(part.error ?? errorFallback),
          };
        }
        break;
    }
  }
}
