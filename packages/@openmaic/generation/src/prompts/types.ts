/**
 * Simplified prompt system type definitions
 */

/** Prompt template identifier for generation-owned prompts. */
export type PromptId =
  | 'requirements-to-outlines'
  | 'slide-content'
  | 'quiz-content'
  | 'simulation-content'
  | 'diagram-content'
  | 'code-content'
  | 'game-content'
  | 'visualization3d-content'
  | 'procedural-skill-content'
  | 'slide-actions'
  | 'quiz-actions'
  | 'interactive-actions'
  | 'pbl-actions';

/** Snippets referenced by generation-owned prompt templates. */
export type SnippetId =
  | 'json-output-rules'
  | 'image-instructions'
  | 'video-instructions'
  | 'media-safety-guidelines'
  | 'slide-image-instructions'
  | 'slide-generated-image-instructions'
  | 'slide-video-instructions';

/** Loaded prompt template. */
export interface LoadedPrompt {
  id: PromptId;
  systemPrompt: string;
  userPromptTemplate: string;
}

export type PromptVariableDefaults = Partial<Record<PromptId, Readonly<Record<string, unknown>>>>;
