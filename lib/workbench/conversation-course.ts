import type { ChatNode } from './session-store';

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
 * The courses this conversation's own tool calls work on: every stage a tool
 * call names in its arguments (`stageId`) to write to it — patch, regenerate,
 * narrate. A read is not working on a course: "make a grade-5 version of my
 * course" reads the original and creates a new one, which is the
 * conversation's own (reads are `worksOnExistingCourses`' concern).
 * `create_stage` names no existing stage — the course it creates arrives
 * through its link.
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
    if (node.toolName && COURSE_LIBRARY_TOOLS.has(node.toolName)) continue;
    const stageId = node.toolArgs?.stageId;
    if (typeof stageId === 'string' && stageId && !ids.includes(stageId)) ids.push(stageId);
  }
  return ids;
}

/**
 * A conversation that has created no course and either `@`-names an existing
 * course, or is bound to one (started beside it) and whose calls look through
 * existing courses: it is working on existing courses, not producing one. Durable facts only — the binding and
 * the calls the agent made — never the wording of the request.
 *
 * Every conversation carries a stage id, a new one included: there it is the
 * id its course will be created under, so it names nothing yet. Only a bound
 * id that is a course in the library (`isExistingCourse`) is a binding beside
 * one; a new request glancing at the library is still producing a course.
 */
export function worksOnExistingCourses(
  chat: readonly ChatNode[],
  boundStageId: string | null,
  isExistingCourse: (stageId: string) => boolean = () => true,
): boolean {
  const bound = !!boundStageId && isExistingCourse(boundStageId);
  let looked = false;
  let named = false;
  for (const node of chat) {
    // A course the teacher `@`-named is one they asked about by name: the
    // conversation is working on it, whatever the conversation is bound to.
    if (node.courseRefs?.some((ref) => isExistingCourse(ref.stageId))) named = true;
    if (node.kind !== 'tool' || !node.toolName) continue;
    if (node.toolName === 'create_stage') return false;
    if (COURSE_LIBRARY_TOOLS.has(node.toolName)) looked = true;
  }
  return named || (bound && looked);
}
