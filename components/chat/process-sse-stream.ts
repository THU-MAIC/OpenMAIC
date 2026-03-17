import type { StatelessEvent } from '@/lib/types/chat';
import type { StreamBuffer } from '@/lib/buffer/stream-buffer';
import { createLogger } from '@/lib/logger';

const log = createLogger('SSEStream');

/**
 * Thin SSE parser — reads the /api/chat response stream and pushes
 * typed events into a StreamBuffer. All pacing, state management,
 * and UI updates are handled by the buffer's tick loop and callbacks.
 */
export async function processSSEStream(
  response: Response,
  sessionId: string,
  buffer: StreamBuffer,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let sseBuffer = '';
  let currentMessageId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      sseBuffer += chunk;

      // Process complete SSE events (split on double newline)
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop() || '';

      for (const eventStr of events) {
        const line = eventStr.trim();
        if (!line.startsWith('data: ')) continue;

        let sseError: Error | null = null;

        try {
          const event: StatelessEvent = JSON.parse(line.slice(6));

          switch (event.type) {
            case 'agent_start': {
              const { messageId, agentId, agentName, agentAvatar, agentColor } = event.data;
              currentMessageId = messageId;
              buffer.pushAgentStart({
                messageId,
                agentId,
                agentName,
                avatar: agentAvatar,
                color: agentColor,
              });
              break;
            }

            case 'agent_end': {
              buffer.pushAgentEnd({
                messageId: event.data.messageId,
                agentId: event.data.agentId,
              });
              break;
            }

            case 'text_delta': {
              const targetId = event.data.messageId ?? currentMessageId;
              if (!targetId) break;
              buffer.pushText(targetId, event.data.content);
              break;
            }

            case 'action': {
              const targetId = event.data.messageId ?? currentMessageId;
              if (!targetId) break;
              if (signal?.aborted) break;
              buffer.pushAction({
                messageId: targetId,
                actionId: event.data.actionId,
                actionName: event.data.actionName,
                params: event.data.params,
                agentId: event.data.agentId,
              });
              break;
            }

            case 'thinking': {
              buffer.pushThinking(event.data);
              break;
            }

            case 'cue_user': {
              buffer.pushCueUser(event.data);
              break;
            }

            case 'done': {
              buffer.pushDone(event.data);
              break;
            }

            case 'error': {
              sseError = new Error(event.data.message);
              buffer.pushError(event.data.message);
              break;
            }
          }
        } catch (parseError) {
          log.warn('[SSE] Parse error:', parseError);
        }

        if (sseError) throw sseError;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
