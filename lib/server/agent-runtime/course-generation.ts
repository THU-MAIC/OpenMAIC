/**
 * What the agent is told about a course a generation run is still producing.
 *
 * Such a course is read-only until its run completes (or is ended): the
 * document store refuses every other writer with `COURSE_GENERATING`
 * (`assertCourseWritableIn`). The refusal alone arrives too late — an agent
 * that read the course without knowing offers to edit it, or to "generate the
 * remaining pages", which is exactly what the run is doing. So the reader tools
 * say it up front: the list tools mark the course, and the read tools put a
 * short notice before their result. The guidance is result text, not a branch
 * in the tools: the course still reads as it is, and the write refusal stays
 * where it was.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';

import { listActiveGenerationRuns } from '@/lib/server/generation/run/store';
import type { GenerationRunState } from '@/lib/server/generation/run/types';

/** A course an active run is producing, as the agent sees it. */
export interface CourseGeneration {
  readonly state: GenerationRunState;
  readonly scenesCompleted: number;
  readonly scenesTotal: number;
}

/** The owner's courses that runs are producing, by stage id. */
export type CourseGenerationLookup = () => Promise<ReadonlyMap<string, CourseGeneration>>;

/**
 * The owner's courses an active run is producing: every run that is not
 * completed or ended and already has its course, the same condition the
 * store's write fence refuses on.
 */
export async function listCourseGenerations(
  ownerId: string,
): Promise<ReadonlyMap<string, CourseGeneration>> {
  const generations = new Map<string, CourseGeneration>();
  for (const run of await listActiveGenerationRuns(ownerId)) {
    if (!run.stageId) continue;
    generations.set(run.stageId, {
      state: run.state,
      scenesCompleted: run.progress.scenesCompleted,
      scenesTotal: run.progress.scenesTotal,
    });
  }
  return generations;
}

/** The fields a list or read result carries for a course being generated. */
export function courseGenerationFields(generation: CourseGeneration) {
  return {
    generating: true,
    generationState: generation.state,
    scenesCompleted: generation.scenesCompleted,
    scenesTotal: generation.scenesTotal,
  } as const;
}

/** The notice a read result of a course being generated starts with. */
export function courseGenerationNotice(generation: CourseGeneration): string {
  const pages = `${generation.scenesCompleted}/${generation.scenesTotal} pages`;
  if (generation.state === 'paused') {
    return `This course is still being generated (${pages}); its generation is paused after a page failed, and it is read-only until generation completes. Do not offer to edit or generate its pages; tell the user to retry the failed page from the classroom and wait.`;
  }
  return `This course is still being generated (${pages}); it is read-only until generation completes. Do not offer to edit or generate its pages; tell the user to wait.`;
}

/** The reader tools whose results start with the notice, by the parameter naming the course. */
export const COURSE_READER_TOOLS: ReadonlyMap<string, 'stageId' | 'classroomId'> = new Map([
  ['read_stage', 'stageId'],
  ['grep_stage', 'stageId'],
  ['list_scenes', 'stageId'],
  ['read_stage_outline', 'stageId'],
  ['read_classroom', 'classroomId'],
]);

interface TextResult {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

/**
 * Put the notice before the result of every reader tool that read a course a
 * run is producing. Other tools, and a reader's error result, pass through.
 */
export function withCourseGenerationNotice(
  tools: readonly AgentTool[],
  lookup: CourseGenerationLookup,
): AgentTool[] {
  return tools.map((tool) => {
    const param = COURSE_READER_TOOLS.get(tool.name);
    if (!param) return tool;
    const original = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(...args: Parameters<typeof tool.execute>) {
        const result = await original(...args);
        const raw = (args[1] as unknown as Record<string, unknown>)?.[param];
        const stageId = typeof raw === 'string' ? raw.trim() : '';
        if (!stageId || (result as TextResult).isError) return result;
        const generation = (await lookup()).get(stageId);
        if (!generation) return result;
        const notice = courseGenerationNotice(generation);
        const content = (result as TextResult).content ?? [];
        const first = content.findIndex((block) => block.type === 'text');
        const noticed =
          first < 0
            ? [{ type: 'text', text: notice }, ...content]
            : content.map((block, index) =>
                index === first ? { ...block, text: `${notice}\n\n${block.text ?? ''}` } : block,
              );
        const details =
          result.details && typeof result.details === 'object'
            ? { ...(result.details as object), generation: courseGenerationFields(generation) }
            : { generation: courseGenerationFields(generation) };
        return { ...result, content: noticed, details } as typeof result;
      },
    } as AgentTool;
  });
}
