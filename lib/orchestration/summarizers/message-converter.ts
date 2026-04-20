import type { StatelessChatRequest } from '@/lib/types/chat';

// ==================== Message Conversion ====================

/**
 * Content part shapes compatible with Vercel AI SDK's `ModelMessage`.
 * When a message has no attachments this stays a string; when there are
 * image attachments it becomes an array.
 */
type ImagePart = { type: 'image'; image: string; mediaType?: string };
type TextPart = { type: 'text'; text: string };
export type ConvertedContent = string | Array<TextPart | ImagePart>;

export interface ConvertedMessage {
  role: 'system' | 'user' | 'assistant';
  content: ConvertedContent;
}

/**
 * Extract image URLs from UIMessage parts.
 * Returns image parts in AI SDK's `ImagePart` shape.
 *
 * AI SDK's `streamText`/`generateText` treats strings as URLs to download.
 * data URLs fail that download check, so we unwrap `data:image/...;base64,<payload>`
 * into a raw base64 string and carry the media type separately.
 * http(s) URLs pass through unchanged (AI SDK will fetch them).
 */
function extractImageParts(parts: unknown[] | undefined): ImagePart[] {
  if (!parts) return [];
  const out: ImagePart[] = [];
  for (const part of parts) {
    const p = part as Record<string, unknown>;
    if (
      p.type !== 'file' ||
      typeof p.mediaType !== 'string' ||
      !p.mediaType.startsWith('image/') ||
      typeof p.url !== 'string'
    ) {
      continue;
    }

    const url = p.url;
    // Match data URLs: data:<mime>[;base64],<payload>
    const dataUrlMatch = /^data:([^;,]+)(?:;base64)?,(.*)$/.exec(url);
    if (dataUrlMatch) {
      const payload = dataUrlMatch[2];
      out.push({ type: 'image', image: payload, mediaType: p.mediaType });
    } else {
      // http / https URL — AI SDK will fetch it
      out.push({ type: 'image', image: url, mediaType: p.mediaType });
    }
  }
  return out;
}

/**
 * Convert UI messages to OpenAI-compatible format.
 * Includes tool call information so the model knows what actions were taken.
 * Preserves image attachments on user messages as multimodal content parts.
 */
export function convertMessagesToOpenAI(
  messages: StatelessChatRequest['messages'],
  currentAgentId?: string,
): ConvertedMessage[] {
  return messages
    .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
    .map((msg): ConvertedMessage => {
      if (msg.role === 'assistant') {
        // Assistant messages use JSON array format to serve as few-shot examples
        // that match the expected output format from the system prompt
        const items: Array<{ type: string; [key: string]: string }> = [];

        if (msg.parts) {
          for (const part of msg.parts) {
            const p = part as Record<string, unknown>;

            if (p.type === 'text' && p.text) {
              items.push({ type: 'text', content: p.text as string });
            } else if ((p.type as string)?.startsWith('action-') && p.state === 'result') {
              const actionName = (p.actionName ||
                (p.type as string).replace('action-', '')) as string;
              const output = p.output as Record<string, unknown> | undefined;
              const isSuccess = output?.success === true;
              const resultSummary = isSuccess
                ? output?.data
                  ? `result: ${JSON.stringify(output.data).slice(0, 100)}`
                  : 'success'
                : (output?.error as string) || 'failed';
              items.push({
                type: 'action',
                name: actionName,
                result: resultSummary,
              });
            }
          }
        }

        const content = items.length > 0 ? JSON.stringify(items) : '';
        const msgAgentId = msg.metadata?.agentId;

        // When currentAgentId is provided and this message is from a DIFFERENT agent,
        // convert to user role with agent name attribution
        if (currentAgentId && msgAgentId && msgAgentId !== currentAgentId) {
          const agentName = msg.metadata?.senderName || msgAgentId;
          return {
            role: 'user',
            content: content ? `[${agentName}]: ${content}` : '',
          };
        }

        return {
          role: 'assistant',
          content,
        };
      }

      // User messages: keep plain text concatenation + preserve image attachments
      const contentParts: string[] = [];

      if (msg.parts) {
        for (const part of msg.parts) {
          const p = part as Record<string, unknown>;

          if (p.type === 'text' && p.text) {
            contentParts.push(p.text as string);
          } else if ((p.type as string)?.startsWith('action-') && p.state === 'result') {
            const actionName = (p.actionName ||
              (p.type as string).replace('action-', '')) as string;
            const output = p.output as Record<string, unknown> | undefined;
            const isSuccess = output?.success === true;
            const resultSummary = isSuccess
              ? output?.data
                ? `result: ${JSON.stringify(output.data).slice(0, 100)}`
                : 'success'
              : (output?.error as string) || 'failed';
            contentParts.push(`[Action ${actionName}: ${resultSummary}]`);
          }
        }
      }

      // Extract speaker name from metadata (e.g. other agents' messages in discussion)
      const senderName = msg.metadata?.senderName;
      let textContent = contentParts.join('\n');
      if (senderName) {
        textContent = `[${senderName}]: ${textContent}`;
      }

      // Annotate interrupted messages so the LLM knows context was cut short
      const isInterrupted =
        (msg as unknown as Record<string, unknown>).metadata &&
        ((msg as unknown as Record<string, unknown>).metadata as Record<string, unknown>)
          ?.interrupted;
      if (isInterrupted) {
        textContent = `${textContent}\n[This response was interrupted — do NOT continue it. Start a new JSON array response.]`;
      }

      const images = extractImageParts(msg.parts);
      if (images.length > 0) {
        // Multimodal content: text (possibly empty) followed by image parts.
        const parts: Array<TextPart | ImagePart> = [];
        if (textContent) parts.push({ type: 'text', text: textContent });
        parts.push(...images);
        return { role: 'user', content: parts };
      }

      return { role: 'user', content: textContent };
    })
    .filter((msg) => {
      // Drop empty messages and messages with only dots/ellipsis/whitespace
      // (produced by failed agent streams). Messages with image attachments are
      // always kept, even if the text is empty.
      if (typeof msg.content !== 'string') return true;
      const stripped = msg.content.replace(/[.\s…]+/g, '');
      return stripped.length > 0;
    });
}
