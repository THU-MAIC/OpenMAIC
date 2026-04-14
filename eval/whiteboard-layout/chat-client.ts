import type { StatelessEvent, DirectorState } from '@/lib/types/chat';

export interface ChatRequest {
  baseUrl: string;
  messages: Array<{ role: string; content: string; parts?: unknown[]; metadata?: unknown }>;
  storeState: Record<string, unknown>;
  config: {
    agentIds: string[];
    sessionType?: string;
    agentConfigs?: Record<string, unknown>[];
  };
  directorState?: DirectorState;
  userProfile?: { nickname?: string; bio?: string };
  apiKey: string;
  baseUrlOverride?: string;
  model?: string;
  providerType?: string;
}

/**
 * Call /api/chat and yield parsed SSE events.
 */
export async function* chatStream(
  request: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<StatelessEvent> {
  const { baseUrl, ...body } = request;

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`/api/chat returned ${response.status}: ${text}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;

        try {
          const event: StatelessEvent = JSON.parse(line.slice(6));
          yield event;
        } catch {
          // Skip malformed events (heartbeats, etc.)
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
