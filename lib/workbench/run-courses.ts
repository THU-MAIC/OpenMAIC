/**
 * The classrooms ONE EXCHANGE put in front of the user.
 *
 * AN EXCHANGE, NOT A pi TURN. The unit is one question and its answer — the
 * user says something, the agent finishes replying — which in the durable log is
 * `agent_start` … `agent_end`. pi's own `turn` is something much smaller (one
 * assistant message plus the tool calls it made), and a single answer routinely
 * spans ten of them: "write me ten pages" is ten turns against ONE classroom.
 * Flushing per turn would end that answer with ten identical cards. So the flush
 * point is `agent_end` and nothing here should be renamed back towards "turn" —
 * `turn_end` is a real event a few lines away in the same stream, and the two
 * must not be confused.
 *
 * This replaced a session-level derivation (`deriveSessionCourses`, plus a
 * user-owned ignore list to correct it). That model asked the wrong question.
 * It tried to answer "which classrooms is this CONVERSATION about" — a standing
 * association — and a derived standing association is always slightly wrong:
 * a course the agent glanced at while looking around sat in the list beside the
 * one the conversation was actually about, which is why it needed a removal
 * affordance, a stored ignore list and a column on the session row. There is no
 * association to model. An exchange either produced or named a classroom or it
 * did not, and that fact is per-exchange, durable, and needs no correcting.
 *
 * So the scope is an EVENT RANGE — one exchange's slice of the durable log — and
 * the answer is an ordered set of stage ids. Same sources as before, same
 * deliberate exclusion:
 *
 *   - `stage_link` (legacy `course_link`) — a tool produced or handed back a link,
 *   - `library_changed` with `change: 'stage_created'` — v1 transcripts recorded a
 *     minted stage only here,
 *   - a STAGE-WRITER tool call carrying `args.stageId`,
 *   - a `checkpoint` carrying `stageId` — a durable write receipt,
 *   - a `user_message`'s `courseRefs` — the classrooms the user named with `@`.
 *
 * READER TOOLS ARE DELIBERATELY EXCLUDED (`read_stage`, `grep_stage`,
 * `search_classrooms`, …). Looking around is how an agent works; a card for
 * every classroom it opened to read would turn the end of an answer into a
 * search-result dump. `isStageWriterTool` is the one list that decides this, and
 * this module is the only place the fold consults it — so the rule cannot drift
 * between "what arms a write" and "what earns a card".
 *
 * NOT A PERMISSION, NOT PROMPT INPUT. A card is display and navigation: it says
 * "this classroom came up here" and clicking it opens the right pane. The
 * server's owner-bound store is what refuses a course the user may not touch,
 * and the runner resolves a `courseRef` against the owner's own library when it
 * composes the message.
 */

import { isStageWriterTool } from '@/lib/agent-runtime/stage-writer-tools';
import { parseCourseRefs } from './course-refs';

/** One durable frame, as much of it as this needs. */
export interface CourseSightingEvent {
  readonly type: string;
  readonly data: unknown;
}

const trimmedId = (value: unknown): string =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';

/**
 * The classrooms this one frame puts in front of the user, in the order the
 * frame names them. Empty for every other event type — including a reader tool.
 *
 * The durable log is treated as UNTRUSTED: a legacy or malformed record folds to
 * nothing rather than producing a card for an id that is not one.
 */
export function courseSightingsOf(event: CourseSightingEvent): readonly string[] {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'tool_execution_start': {
      const toolName = String(data.toolName ?? '');
      if (!isStageWriterTool(toolName)) return [];
      const args = data.args as { stageId?: unknown } | undefined;
      const stageId = trimmedId(args?.stageId);
      return stageId ? [stageId] : [];
    }
    case 'checkpoint': {
      const stageId = trimmedId(data.stageId);
      return stageId ? [stageId] : [];
    }
    case 'library_changed': {
      if (data.change !== 'stage_created') return [];
      const stageId = trimmedId(data.stageId);
      return stageId ? [stageId] : [];
    }
    // The pre-rename event name, with identical semantics — historical logs
    // still carry it.
    case 'course_link':
    case 'stage_link': {
      const stageId = trimmedId(data.stageId);
      return stageId ? [stageId] : [];
    }
    case 'user_message':
      return parseCourseRefs(data.courseRefs).map((ref) => ref.stageId);
    default:
      return [];
  }
}

/**
 * Append a sighting to a first-seen-order, de-duplicated list, returning the
 * SAME array when there is nothing to add.
 *
 * Identity matters: the fold copies its state on every event, and a buffer that
 * allocated a new array per frame would make `foldEvent`'s structural equality
 * checks (and every `useWorkbenchStore` selector reading it) churn for no reason.
 */
export function appendCourseSighting(seen: readonly string[], stageId: string): readonly string[] {
  if (!stageId || seen.includes(stageId)) return seen;
  return [...seen, stageId];
}

/**
 * The classrooms in one exchange's event range, first-seen order, de-duplicated.
 *
 * WITHIN an exchange ids are de-duplicated (an answer that patched the same
 * course across ten turns shows it once); ACROSS exchanges they are not (ask
 * again about the same course and that answer ends with its own card). The card
 * belongs to the answer that produced it, so "this answer touched it again" is
 * news, and a session-wide first-seen rule would have hidden it.
 *
 * Pure and order-only, which is what makes a cold replay identical to the live
 * fold: the same slice of the log in the same order yields the same list.
 */
export function runCourseStageIds(events: readonly CourseSightingEvent[]): readonly string[] {
  let seen: readonly string[] = [];
  for (const event of events) {
    for (const stageId of courseSightingsOf(event)) {
      seen = appendCourseSighting(seen, stageId);
    }
  }
  return seen;
}
