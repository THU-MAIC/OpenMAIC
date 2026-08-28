import type { AgentTool } from '@earendil-works/pi-agent-core';
import { courseSystemPrompt, DSL_TOOLS_PROMPT } from './course-tools';

type PromptBlocks = Parameters<typeof courseSystemPrompt>[0];

/** Pure runner assembly seam: tests can pin the exact registered name set. */
export function assembleRunnerTools(
  ...groups: ReadonlyArray<ReadonlyArray<AgentTool>>
): AgentTool[] {
  return groups.flat();
}

/** The DSL compatibility block is part of every runner prompt. */
export function buildRunnerCoursePrompt(blocks: Omit<PromptBlocks, 'dslTools'>): string {
  return courseSystemPrompt({ ...blocks, dslTools: DSL_TOOLS_PROMPT });
}
