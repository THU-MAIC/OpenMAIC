/**
 * Simplified prompt system type definitions
 */

/**
 * Prompt template identifier
 */
export type PromptId =
  | 'requirements-to-outlines'
  | 'interactive-outlines'
  | 'web-search-query-rewrite'
  | 'slide-content'
  | 'quiz-content'
  | 'slide-actions'
  | 'quiz-actions'
  | 'interactive-actions'
  | 'simulation-content'
  | 'diagram-content'
  | 'code-content'
  | 'game-content'
  | 'visualization3d-content'
  | 'widget-teacher-actions'
  | 'pbl-actions'
  | 'agent-system'
  | 'agent-system-wb-teacher'
  | 'agent-system-wb-assistant'
  | 'agent-system-wb-student'
  | 'director'
  | 'pbl-design';

/**
 * Snippet identifier
 */
export type SnippetId =
  | 'json-output-rules'
  | 'element-types'
  | 'action-types'
  | 'image-instructions'
  | 'video-instructions'
  | 'media-safety-guidelines'
  | 'outline-image-fields'
  | 'outline-media-field'
  | 'outline-image-resources'
  | 'slide-image-resources'
  | 'slide-image-user-rule'
  | 'slide-image-instructions'
  | 'slide-generated-image-instructions'
  | 'slide-video-instructions'
  | 'slide-video-user-rule'
  | 'slide-source-image-checklist'
  | 'slide-generated-image-checklist'
  | 'slide-video-checklist'
  | 'speech-guidelines'
  | 'whiteboard-reference';

/**
 * Prompt load/build options
 */
export interface PromptLoadOptions {
  /**
   * Values used by conditional snippet includes:
   * {{snippet:name?if=conditionName}}
   */
  conditions?: Record<string, unknown>;
}

/**
 * Loaded prompt template
 */
export interface LoadedPrompt {
  id: PromptId;
  systemPrompt: string;
  userPromptTemplate: string;
}
