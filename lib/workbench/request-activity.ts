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
  if (replaying) return null;
  // An open question is the user's move, whatever followed it: `ask_user` ends
  // the run, a tool later in the same batch may still run, and a textless
  // attachment answers nothing. Only the fold's answered flag retires it (the
  // same rule as the conversation's pending question).
  const question = chat.findLast((item) => item.kind === 'question' && !item.questionAnswered);
  if (question) return { node: question, stepId: undefined };
  // Never borrow the preceding answer's activity while the next request starts.
  const start = requestStartIndex(chat);
  const node = chat
    .slice(start + 1)
    .findLast((item) => ['waiting', 'thinking', 'assistant', 'tool'].includes(item.kind));
  if (!node) return null;
  if (!['running', 'queued', 'connecting'].includes(status)) return null;
  return {
    node,
    stepId:
      node.kind === 'tool' && node.toolState === 'running'
        ? TOOL_VISUALIZERS[node.toolName ?? '']
        : undefined,
  };
}
