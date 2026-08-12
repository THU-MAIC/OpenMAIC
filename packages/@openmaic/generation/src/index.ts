export type {
  AICallFn,
  AgentInfo,
  GeneratedSlideData,
  GenerationResult,
  SceneGenerationContext,
} from './pipeline-types.js';

export {
  extractInteractiveElements,
  extractWidgetConfig,
  generateSceneActions,
  generateSceneContent,
  generateWidgetContent,
  PBLGenerationError,
} from './scene-generator.js';
export type { SceneActionsOptions, SceneContentOptions } from './scene-generator.js';
export { buildCompleteScene } from './scene-builder.js';
export type { BuildCompleteSceneOptions } from './scene-builder.js';
export {
  isAbortError,
  isRetryableGenerationError,
  withGenerationRetry,
} from './generation-retry.js';
export type { GenerationRetryEvent, GenerationRetryOptions } from './generation-retry.js';
export { parseActionsFromStructuredOutput } from './action-parser.js';
export { postProcessInteractiveHtml } from './interactive-post-processor.js';
export { generatePBLV2ProjectSingleCall } from './pbl/planner-single-call.js';
export type { PlannerSingleCallFn } from './pbl/planner-single-call.js';
export type { PBLPlannerV2Input, PriorQuizResult } from './pbl/types.js';
export {
  MAX_SYNTHESIS_STAGES,
  PlannerV2Error,
  SCENARIO_SCHEMA_VERSION,
  applyPlannerProficiency,
  buildPlannerSystemPrompt,
  buildScenarioDesignBlock,
  emptyProject,
  instructorProjectAnchor,
  newId,
  normalizeSynthesisChecks,
  plannerCompletionGaps,
} from './pbl/planner-core.js';
export type { PlannerV2Callbacks, PlannerV2ProgressEvent } from './pbl/planner-core.js';
export { loadPBLV2Prompt } from './pbl/prompts/loader.js';
export {
  MAX_ENGAGEMENT_EVENTS,
  capEngagementEvents,
  microtaskEngagement,
  milestoneSynthesisSatisfied,
  recordEvent,
} from './pbl/operations/kernel/engagement.js';
export * from './pbl/operations/kernel/proficiency.js';
export * from './pbl/operations/kernel/progress.js';
export * from './pbl/operations/kernel/runtime-events.js';
export * from './pbl/operations/kernel/task-completion.js';
export type {
  CompleteScene,
  CompleteSceneContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  GeneratedQuizContent,
  GeneratedSceneContent,
  GeneratedSlideContent,
  ScientificModel,
  WidgetConfig,
} from './scene-types.js';

export {
  DEFAULT_LANGUAGE_DIRECTIVE,
  applyOutlineFallbacks,
  buildOutlinePrompt,
  generateSceneOutlinesFromRequirements,
  sanitizeProceduralSkillOutline,
} from './outline-generator.js';
export type {
  OutlineFallbackOptions,
  OutlineGenerationOptions,
  OutlinePromptContext,
} from './outline-generator.js';
export { changeOutlineType } from './outline-type.js';
export { uniquifyMediaElementIds } from './outline-media.js';
export { parseJsonResponse } from './json-repair.js';
export type { JsonParsingOptions } from './json-repair.js';
export { noopGenerationLogger } from './logger.js';
export type { GenerationLogger } from './logger.js';
export {
  buildCourseContext,
  buildLanguageText,
  buildVisionUserContent,
  formatAgentsForPrompt,
  formatImageDescription,
  formatImagePlaceholder,
  formatTeacherPersonaForPrompt,
} from './prompt-formatters.js';
export type {
  ImageMapping,
  MediaGenerationRequest,
  PdfImage,
  SceneOutline,
  UserRequirements,
  WidgetOutline,
  WidgetType,
} from './outline-types.js';

export * from './prompts/index.js';
