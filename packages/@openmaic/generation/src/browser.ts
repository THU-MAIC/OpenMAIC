/**
 * Explicit browser-safe API. Do not re-export the root barrel here: it also
 * exposes Node-only prompt loaders and generation orchestration.
 */
export {
  isAbortError,
  isRetryableGenerationError,
  withGenerationRetry,
} from './generation-retry.js';
export type { GenerationRetryEvent, GenerationRetryOptions } from './generation-retry.js';
export { changeOutlineType } from './outline-type.js';
export { parseJsonResponse } from './json-repair.js';
export * from './pbl/operations/kernel/engagement.js';
export * from './pbl/operations/kernel/proficiency.js';
export * from './pbl/operations/kernel/progress.js';
export * from './pbl/operations/kernel/runtime-events.js';
export * from './pbl/operations/kernel/task-completion.js';

export {
  COURSE_STYLES,
  DEFAULT_COURSE_STYLE,
  VALID_COURSE_STYLE_IDS,
  generateDesignTokenCss,
  isColorDark,
  isValidCourseStyle,
  normalizeCourseStyle,
  resolveCourseTheme,
  resolveSubjectTheme,
} from './theme.js';
export type {
  CourseDesignTokens,
  CourseStyleId,
  CourseTheme,
} from './theme.js';

export { postProcessInteractiveHtml } from './interactive-post-processor.js';
export {
  rewriteInteractiveLibraries,
  mapInteractiveLibraryUrl,
} from './interactive-library-mapper.js';
export {
  INTERACTIVE_LIBRARIES,
  INTERACTIVE_ASSET_PATH,
  interactiveAssetBaseUrl,
  interactiveLibraryUrl,
} from './interactive-libraries.js';
