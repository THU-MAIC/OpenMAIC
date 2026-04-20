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
  | 'speech-guidelines'
  | 'whiteboard-reference';

/**
 * Loaded prompt template
 */
export interface LoadedPrompt {
  id: PromptId;
  systemPrompt: string;
  userPromptTemplate: string;
}
