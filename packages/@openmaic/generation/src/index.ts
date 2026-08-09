export type {
  AICallFn,
  AgentInfo,
  GeneratedSlideData,
  GenerationResult,
  SceneGenerationContext,
} from './pipeline-types.js';

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
