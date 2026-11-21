/** Read the current AI SDK delta or its legacy aliases. */
export function readStreamDelta(part: Record<string, unknown>): string | undefined {
  const delta = part.text ?? part.delta ?? part.textDelta;
  return typeof delta === 'string' ? delta : undefined;
}

type StreamPart =
  | { type: 'text' | 'text-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result' }
  | { type: 'error'; error: unknown };

/** Normalize the SDK parts shared by the agent runtimes. */
export function mapStreamPart(part: Record<string, unknown>): StreamPart | undefined {
  switch (part.type) {
    case 'text':
    case 'text-delta': {
      const delta = readStreamDelta(part);
      return delta ? { type: part.type, delta } : undefined;
    }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: (part.toolCallId ?? part.id) as string,
        toolName: (part.toolName ?? part.name) as string,
        input: part.input,
      };
    case 'tool-result':
      return { type: 'tool-result' };
    case 'error':
      return { type: 'error', error: part.error };
    default:
      return undefined;
  }
}
