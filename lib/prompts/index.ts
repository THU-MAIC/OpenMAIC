/**
 * Prompt System - Simplified prompt management
 *
 * Features:
 * - File-based prompt storage in templates/
 * - Snippet composition via {{snippet:name}} syntax
 * - Conditional blocks via {{#if flag}}...{{/if}} syntax
 * - Variable interpolation via {{variable}} syntax
 */

// Types
import type { PromptId } from './types';
export type { PromptId, SnippetId, LoadedPrompt } from './types';

// Loader functions
export {
  loadPrompt,
  loadSnippet,
  buildPrompt,
  interpolateVariables,
  processSnippets,
  processConditionalBlocks,
} from './loader';

// Prompt IDs constant
export const PROMPT_IDS = {
  INTERACTIVE_OUTLINES: 'interactive-outlines',
  TASK_ENGINE_OUTLINES: 'task-engine-outlines',
  WEB_SEARCH_QUERY_REWRITE: 'web-search-query-rewrite',
} as const satisfies Record<string, PromptId>;
