import { requestEpisodeStart } from './request-activity';
import type { ChatNode } from './session-store';

/**
 * Which course is this conversation working on? The one question behind the
 * right pane's request preview.
 *
 * - A conversation started beside an existing course (`existingCourse`, the
 *   durable fact the server keeps on the session) works on that course: the
 *   pane is that course, never a preview.
 * - A new conversation is making its course: from the request's first tool
 *   call or question a preview tab stands for it, and when the course's first
 *   page is persisted that same tab becomes the course tab.
 * - Once the conversation has its course (an earlier request persisted a
 *   page), later requests work on it: the pane is that course.
 * - Any request that calls `create_stage` is making a new course, whatever
 *   came before, and that course goes through the preview like the first.
 *
 * Durable facts only: the session's own flag and the calls in its event log —
 * never the wording of the request, nor what the agent looked at.
 */
export type RequestCourse =
  /**
   * The request works on a course the conversation already has: no preview.
   * `courseId` is that course when it is known — the one its latest persisted
   * page went to, else the one the conversation was started beside.
   */
  | { readonly kind: 'course'; readonly courseId: string | null }
  /**
   * The request is making a new course. `ready` lists the courses it is making
   * whose first page is persisted, in the order those pages landed; the first
   * one is the course the preview tab becomes.
   */
  | { readonly kind: 'new'; readonly ready: readonly string[] };

/** The course a `create_stage` call created, once it returned one. */
function createdStageId(node: ChatNode): string | null {
  if (node.kind !== 'tool' || node.toolName !== 'create_stage' || node.toolState !== 'done') {
    return null;
  }
  // `reused` is a retry of this same call (the id derives from the call id),
  // so it still names the course this call created.
  const stageId = (node.toolDetails as { stageId?: unknown } | undefined)?.stageId;
  return typeof stageId === 'string' && stageId ? stageId : null;
}

/** Whether this card persisted a page (the fold stamps it at the page's checkpoint). */
function persistedPage(node: ChatNode): boolean {
  return node.kind === 'tool' && Boolean(node.sceneId);
}

/** The course a persisted page belongs to: its checkpoint's stage, else the call's. */
function pageStageId(node: ChatNode): string | null {
  if (node.sceneStageId) return node.sceneStageId;
  const stageId = node.toolArgs?.stageId;
  return typeof stageId === 'string' && stageId ? stageId : null;
}

/**
 * What the current request is to the right pane.
 *
 * `existingCourse` is null while the session's flag is not known yet (the
 * list and the detail read have not answered): nothing is a new course until
 * it is, so a conversation beside a course never flashes a preview.
 * `boundStageId` is the session's own stage: for a conversation started beside
 * a course, that course.
 */
export function requestCourse(
  chat: readonly ChatNode[],
  existingCourse: boolean | null,
  boundStageId: string | null = null,
): RequestCourse {
  const start = Math.max(requestEpisodeStart(chat), 0);
  const request = chat.slice(start);
  const createIndex = request.findIndex(
    (node) => node.kind === 'tool' && node.toolName === 'create_stage',
  );
  const creates = createIndex >= 0;
  const hasCourse =
    existingCourse !== false || chat.slice(0, start).some((node) => persistedPage(node));
  if (hasCourse && !creates) {
    if (existingCourse === null) return { kind: 'course', courseId: null };
    // The course the conversation's latest persisted page went to — the one a
    // conversation started beside a course went on to create, included —
    // else the course it was started beside.
    let courseId: string | null = null;
    let lastCreated: string | null = null;
    for (const node of chat) {
      lastCreated = createdStageId(node) ?? lastCreated;
      if (persistedPage(node)) courseId = pageStageId(node) ?? lastCreated ?? courseId;
    }
    return { kind: 'course', courseId: courseId ?? (existingCourse ? boundStageId || null : null) };
  }

  // The courses this request created, so far, in creation order.
  const created = request.flatMap((node) => {
    const id = createdStageId(node);
    return id ? [id] : [];
  });
  const ready: string[] = [];
  let lastCreated: string | null = null;
  for (const [index, node] of request.entries()) {
    lastCreated = createdStageId(node) ?? lastCreated;
    if (!persistedPage(node)) continue;
    // A request that creates a course is making THAT course: a page it wrote
    // to another one before (or beside) it is not the new course's.
    if (creates && index < createIndex) continue;
    const stageId = pageStageId(node) ?? lastCreated;
    if (!stageId || (creates && !created.includes(stageId))) continue;
    if (!ready.includes(stageId)) ready.push(stageId);
  }
  return { kind: 'new', ready };
}
