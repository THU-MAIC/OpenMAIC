import type { ChatNode } from './session-store';

/**
 * The courses this conversation's own tool calls work on: every stage a tool
 * call names in its arguments (`stageId`), whether it reads, patches,
 * regenerates or narrates it. `create_stage` names no existing stage — the
 * course it creates arrives through its link.
 *
 * Durable facts only: what the agent actually called, from the event log.
 * A course that is merely open in the pane, or that the conversation was
 * started beside (and so is bound to as context), is not among them until a
 * call works on it.
 */
export function conversationTargetStageIds(chat: readonly ChatNode[]): string[] {
  const ids: string[] = [];
  for (const node of chat) {
    if (node.kind !== 'tool' || node.toolName === 'create_stage') continue;
    const stageId = node.toolArgs?.stageId;
    if (typeof stageId === 'string' && stageId && !ids.includes(stageId)) ids.push(stageId);
  }
  return ids;
}

/** Calls that look through the owner's existing courses rather than create one. */
const COURSE_LIBRARY_TOOLS = new Set([
  'list_folder_stages',
  'search_classrooms',
  'read_classroom',
  'read_stage',
  'read_stage_outline',
  'grep_stage',
  'list_scenes',
]);

/**
 * A conversation bound to an existing course (started beside it) whose calls
 * look through existing courses and that has created none: it is working on
 * existing courses, not producing one. Durable facts only — the binding and
 * the calls the agent made — never the wording of the request.
 */
export function worksOnExistingCourses(
  chat: readonly ChatNode[],
  boundStageId: string | null,
): boolean {
  if (!boundStageId) return false;
  let looked = false;
  for (const node of chat) {
    if (node.kind !== 'tool' || !node.toolName) continue;
    if (node.toolName === 'create_stage') return false;
    if (COURSE_LIBRARY_TOOLS.has(node.toolName)) looked = true;
  }
  return looked;
}
