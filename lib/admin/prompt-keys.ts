/**
 * Prompt key registry - standardized keys for all generation/grading/system prompts
 * Phase 3: AI Prompt Dynamic Injection
 */

export const PROMPT_KEYS = {
  // Generation prompts
  GENERATION: {
    SCENE_OUTLINE: 'generation_scene_outline',
    SCENE_CONTENT: 'generation_scene_content',
    SCRIPT: 'generation_script',
    IMAGE_DESCRIPTION: 'generation_image_description',
    VIDEO_CONCEPT: 'generation_video_concept',
    QUIZ_QUESTION: 'generation_quiz_question',
  },
  // Grading prompts
  GRADING: {
    QUIZ_EVALUATION: 'grading_quiz_evaluation',
    ASSIGNMENT_FEEDBACK: 'grading_assignment_feedback',
    RUBRIC_SCORING: 'grading_rubric_scoring',
  },
  // System prompts
  SYSTEM: {
    AGENT_BEHAVIOR: 'system_agent_behavior',
    CLASSROOM_CONTEXT: 'system_classroom_context',
    USER_INSTRUCTIONS: 'system_user_instructions',
  },
  // Analysis prompts
  ANALYSIS: {
    CONTENT_CLASSIFICATION: 'analysis_content_classification',
    KEYWORD_EXTRACTION: 'analysis_keyword_extraction',
    SENTIMENT: 'analysis_sentiment',
  },
  // Chat prompts
  CHAT: {
    CLASSROOM_INSTRUCTOR: 'chat_classroom_instructor',
    CLASSROOM_ASSISTANT: 'chat_classroom_assistant',
    CLASSROOM_CLASSMATE: 'chat_classroom_classmate',
    STUDENT_TUTOR: 'chat_student_tutor',
    PEER_DISCUSSION: 'chat_peer_discussion',
    TEACHER_ASSISTANT: 'chat_teacher_assistant',
  },
} as const;

/**
 * Metadata for each prompt key - description and category
 */
export const PROMPT_KEY_METADATA: Record<string, { label: string; category: string; description: string }> = {
  // Generation
  [PROMPT_KEYS.GENERATION.SCENE_OUTLINE]: {
    label: 'Scene Outline Generator',
    category: 'GENERATION',
    description: 'Generates educational scene outlines from topic/content',
  },
  [PROMPT_KEYS.GENERATION.SCENE_CONTENT]: {
    label: 'Scene Content Generator',
    category: 'GENERATION',
    description: 'Generates classroom scene content (slides and visual content)',
  },
  [PROMPT_KEYS.GENERATION.SCRIPT]: {
    label: 'Script Generator',
    category: 'GENERATION',
    description: 'Creates presentation scripts for scenes',
  },
  [PROMPT_KEYS.GENERATION.IMAGE_DESCRIPTION]: {
    label: 'Image Description',
    category: 'GENERATION',
    description: 'Generates image prompts and descriptions',
  },
  [PROMPT_KEYS.GENERATION.VIDEO_CONCEPT]: {
    label: 'Video Concept',
    category: 'GENERATION',
    description: 'Develops video content concepts',
  },
  [PROMPT_KEYS.GENERATION.QUIZ_QUESTION]: {
    label: 'Quiz Question Generator',
    category: 'GENERATION',
    description: 'Generates quiz questions from content',
  },
  // Grading
  [PROMPT_KEYS.GRADING.QUIZ_EVALUATION]: {
    label: 'Quiz Evaluator',
    category: 'GRADING',
    description: 'Evaluates and scores quiz answers',
  },
  [PROMPT_KEYS.GRADING.ASSIGNMENT_FEEDBACK]: {
    label: 'Assignment Feedback',
    category: 'GRADING',
    description: 'Provides feedback on assignments',
  },
  [PROMPT_KEYS.GRADING.RUBRIC_SCORING]: {
    label: 'Rubric Scorer',
    category: 'GRADING',
    description: 'Scores assignments against rubrics',
  },
  // System
  [PROMPT_KEYS.SYSTEM.AGENT_BEHAVIOR]: {
    label: 'Agent Behavior',
    category: 'SYSTEM',
    description: 'Default system prompt for agent behavior',
  },
  [PROMPT_KEYS.SYSTEM.CLASSROOM_CONTEXT]: {
    label: 'Classroom Context',
    category: 'SYSTEM',
    description: 'Template for classroom context setup',
  },
  [PROMPT_KEYS.SYSTEM.USER_INSTRUCTIONS]: {
    label: 'User Instructions',
    category: 'SYSTEM',
    description: 'User-facing instructions template',
  },
  // Analysis
  [PROMPT_KEYS.ANALYSIS.CONTENT_CLASSIFICATION]: {
    label: 'Content Classification',
    category: 'ANALYSIS',
    description: 'Classifies content types and topics',
  },
  [PROMPT_KEYS.ANALYSIS.KEYWORD_EXTRACTION]: {
    label: 'Keyword Extraction',
    category: 'ANALYSIS',
    description: 'Extracts keywords and topics',
  },
  [PROMPT_KEYS.ANALYSIS.SENTIMENT]: {
    label: 'Sentiment Analysis',
    category: 'ANALYSIS',
    description: 'Analyzes sentiment in text',
  },
  // Chat
  [PROMPT_KEYS.CHAT.CLASSROOM_INSTRUCTOR]: {
    label: 'Classroom Instructor',
    category: 'CHAT',
    description: 'Classroom chat behavior for the instructor agent',
  },
  [PROMPT_KEYS.CHAT.CLASSROOM_ASSISTANT]: {
    label: 'Classroom Assistant',
    category: 'CHAT',
    description: 'Classroom chat behavior for the assistant agent',
  },
  [PROMPT_KEYS.CHAT.CLASSROOM_CLASSMATE]: {
    label: 'Classroom Classmate',
    category: 'CHAT',
    description: 'Classroom chat behavior for the classmate/student agent',
  },
  [PROMPT_KEYS.CHAT.STUDENT_TUTOR]: {
    label: 'Student Tutor',
    category: 'CHAT',
    description: 'Tutoring assistant for students',
  },
  [PROMPT_KEYS.CHAT.PEER_DISCUSSION]: {
    label: 'Peer Discussion',
    category: 'CHAT',
    description: 'Facilitates peer discussions',
  },
  [PROMPT_KEYS.CHAT.TEACHER_ASSISTANT]: {
    label: 'Teacher Assistant',
    category: 'CHAT',
    description: 'Assistant prompt for teachers',
  },
};

/**
 * Get all prompts for initial seeding
 */
export function getAllPromptKeys(): string[] {
  return Object.values(PROMPT_KEYS).flatMap((category) => Object.values(category));
}

/**
 * Get metadata for a prompt key
 */
export function getPromptKeyMetadata(key: string) {
  return PROMPT_KEY_METADATA[key];
}
