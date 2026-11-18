import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ClassroomWebEvidence } from '@/lib/types/chat';
import type { SendEvent } from '../types';

type WebToolDetails = {
  // web_search
  status?: string;
  sources?: Array<{ title: string; url: string }>;
  // fetch_url
  trusted?: { status: string; offset?: number; totalChars?: number };
  untrusted?: { url: string; title: string; content: string };
};

/**
 * Stream the lifecycle of a classroom web tool call as `web_evidence` events.
 * Source cards are projected from the tool's own result, never from model text.
 */
export function withClassroomWebEvidence<T extends AgentTool>(
  tool: T,
  messageId: string,
  send: SendEvent,
): T {
  const reading = tool.name === 'fetch_url';
  return {
    ...tool,
    execute: async (id, params, signal, onUpdate) => {
      const input = params as { url?: string; query?: string };
      const evidence: ClassroomWebEvidence = {
        id,
        kind: reading ? 'read' : 'search',
        status: 'running',
        startedAt: Date.now(),
        ...(reading ? { url: input.url } : { query: input.query }),
      };
      await send({ type: 'web_evidence', data: { messageId, evidence } });
      try {
        const result = await tool.execute(id, params, signal, onUpdate);
        signal?.throwIfAborted();
        const details = result.details as WebToolDetails | undefined;
        const status = details?.trusted?.status ?? details?.status;
        const success =
          !(result as { isError?: boolean }).isError && (status === 'done' || status === 'ok');
        const completed: ClassroomWebEvidence = {
          ...evidence,
          status: success ? 'done' : 'error',
          finishedAt: Date.now(),
          ...(success ? {} : { reason: status ?? 'error' }),
          ...(success && details?.untrusted
            ? {
                url: details.untrusted.url,
                title: details.untrusted.title,
                chars: details.untrusted.content.length,
                offset: details.trusted?.offset,
                totalChars: details.trusted?.totalChars,
              }
            : {}),
          ...(success && details?.sources
            ? {
                sources: details.sources.map(({ title, url }) => ({ title, url })),
              }
            : {}),
        };
        await send({ type: 'web_evidence', data: { messageId, evidence: completed } });
        return result;
      } catch (error) {
        // An aborted request has no consumer, and the client settles a running
        // card itself on interruption, so only report non-abort failures.
        if (!signal?.aborted) {
          await send({
            type: 'web_evidence',
            data: {
              messageId,
              evidence: { ...evidence, status: 'error', finishedAt: Date.now(), reason: 'error' },
            },
          });
        }
        throw error;
      }
    },
  };
}
