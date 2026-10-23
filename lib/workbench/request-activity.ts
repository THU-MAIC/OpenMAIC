import type { ChatNode, SessionStatus } from './session-store';

/** Only existing visualizers whose subject matches a real tool operation. */
const TOOL_VISUALIZERS: Readonly<Record<string, string>> = {
  web_search: 'web-search',
  set_roster: 'agent-generation',
  generate_scene: 'slide-content',
};

/** The fold's durable steer receipt keeps the message inside the current request. */
export function requestStartIndex(chat: readonly ChatNode[]): number {
  return chat.findLastIndex(
    (node, index) =>
      node.kind === 'user' &&
      !(
        chat[index + 1]?.kind === 'system' &&
        chat[index + 1]?.copyKey === 'workbench.system.steerQueued'
      ),
  );
}

export function requestActivity(
  chat: readonly ChatNode[],
  status: SessionStatus,
  replaying: boolean,
) {
  if (replaying || !['running', 'queued', 'connecting'].includes(status)) return null;
  // Never borrow the preceding answer's activity while the next request starts.
  const start = requestStartIndex(chat);
  const node = chat
    .slice(start + 1)
    .findLast((item) => ['waiting', 'thinking', 'assistant', 'tool'].includes(item.kind));
  if (!node) return null;
  return {
    node,
    stepId:
      node.kind === 'tool' && node.toolState === 'running'
        ? TOOL_VISUALIZERS[node.toolName ?? '']
        : undefined,
  };
}
