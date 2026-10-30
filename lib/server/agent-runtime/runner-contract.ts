import type { AgentTool } from '@earendil-works/pi-agent-core';
import { courseSystemPrompt, dslToolsPrompt, DSL_TOOLS_PROMPT } from './course-tools';

type PromptBlocks = Parameters<typeof courseSystemPrompt>[0];

/** Pure runner assembly seam: tests can pin the exact registered name set. */
export function assembleRunnerTools(
  ...groups: ReadonlyArray<ReadonlyArray<AgentTool>>
): AgentTool[] {
  return groups.flat();
}

export interface RunnerCoursePromptBlocks extends Omit<PromptBlocks, 'dslTools'> {
  dslTools?: string;
  tts?: boolean;
  image?: boolean;
}

/** The DSL compatibility block is part of every runner prompt. */
export function buildRunnerCoursePrompt(blocks: RunnerCoursePromptBlocks): string {
  const dslTools =
    blocks.dslTools ??
    (blocks.tts !== undefined || blocks.image !== undefined
      ? dslToolsPrompt({ tts: blocks.tts, image: blocks.image })
      : DSL_TOOLS_PROMPT);
  return courseSystemPrompt({ ...blocks, dslTools });
}
