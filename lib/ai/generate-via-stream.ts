import type { LanguageModelMiddleware } from 'ai';

type WrapGenerate = NonNullable<LanguageModelMiddleware['wrapGenerate']>;
type GenerateResult = Awaited<ReturnType<WrapGenerate>>;
type Content = GenerateResult['content'][number];
type TextContent = Extract<Content, { type: 'text' | 'reasoning' }>;
type StreamPart =
  Awaited<ReturnType<Parameters<WrapGenerate>[0]['doStream']>>['stream'] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;

/** Stream parts that are whole content items. */
const CONTENT_PARTS = new Set<string>([
  'tool-call',
  'tool-result',
  'tool-approval-request',
  'file',
  'source',
]);

/**
 * For a provider that answers only in streams: `generate` is served from the
 * model's stream, assembled into the result `generate` would have returned.
 * An `error` part fails the call, and so does a stream that ends before its
 * `finish` part. Put it outside middleware that shapes the stream, so
 * generate calls get that shaping too.
 */
export function generateViaStreamMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doStream }) => {
      const { stream, request, response } = await doStream();
      const content: Content[] = [];
      const open = new Map<string, TextContent>();
      const entry = (kind: TextContent['type'], id: string): TextContent => {
        const key = `${kind}:${id}`;
        const existing = open.get(key);
        if (existing) return existing;
        const item: TextContent = { type: kind, text: '' } as TextContent;
        open.set(key, item);
        content.push(item);
        return item;
      };
      let warnings: GenerateResult['warnings'] = [];
      let metadata: Omit<Extract<StreamPart, { type: 'response-metadata' }>, 'type'> = {};
      let finish: Extract<StreamPart, { type: 'finish' }> | undefined;

      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value: part } = await reader.read();
          if (done) break;
          switch (part.type) {
            case 'stream-start':
              warnings = part.warnings;
              break;
            case 'response-metadata': {
              const { type: _type, ...rest } = part;
              metadata = rest;
              break;
            }
            case 'text-start':
            case 'reasoning-start':
            case 'text-end':
            case 'reasoning-end': {
              const item = entry(part.type.startsWith('text') ? 'text' : 'reasoning', part.id);
              if (part.providerMetadata) item.providerMetadata = part.providerMetadata;
              break;
            }
            case 'text-delta':
            case 'reasoning-delta':
              entry(part.type === 'text-delta' ? 'text' : 'reasoning', part.id).text += part.delta;
              break;
            case 'finish':
              finish = part;
              break;
            case 'error':
              throw part.error;
            default:
              if (CONTENT_PARTS.has(part.type)) content.push(part as Content);
          }
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      if (!finish) throw new Error('The model stream ended before it finished.');

      return {
        content,
        finishReason: finish.finishReason,
        usage: finish.usage,
        ...(finish.providerMetadata ? { providerMetadata: finish.providerMetadata } : {}),
        ...(request ? { request } : {}),
        response: { ...metadata, ...(response?.headers ? { headers: response.headers } : {}) },
        warnings,
      };
    },
  };
}
