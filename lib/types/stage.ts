// Stage and Scene data types
import type { Slide } from '@/lib/types/slides';
import type { Action } from '@/lib/types/action';
import type { PBLProjectConfig } from '@/lib/pbl/types';

export type SceneType = 'slide' | 'quiz' | 'interactive' | 'pbl' | 'lesson_plan';

export type StageMode = 'autonomous' | 'playback';

export type Whiteboard = Omit<Slide, 'theme' | 'turningMode' | 'sectionTag' | 'type'>;

/**
 * Stage - Represents the entire classroom/course
 */
export interface Stage {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  // Stage metadata
  language?: string;
  /** BCP-47 code for the learner's base language (for explanations/hints/teacher-chat). */
  explanationLanguage?: string;
  style?: string;
  // Whiteboard data
  whiteboard?: Whiteboard[];
  // Agent IDs selected when this classroom was created
  agentIds?: string[];
  /**
   * Server-generated agent configurations.
   * Embedded in persisted classroom JSON so clients can hydrate
   * the agent registry without relying on IndexedDB pre-population.
   * Only present for API-generated classrooms.
   */
  generatedAgentConfigs?: Array<{
    id: string;
    name: string;
    role: string;
    persona: string;
    avatar: string;
    color: string;
    priority: number;
  }>;
}

/**
 * Scene - Represents a single page/scene in the course
 */
export interface Scene {
  id: string;
  stageId: string; // ID of the parent stage (for data integrity checks)
  type: SceneType;
  title: string;
  order: number; // Display order

  // Type-specific content
  content: SceneContent;

  // Actions to execute during playback
  actions?: Action[];

  // Whiteboards to explain deeply
  whiteboards?: Slide[];

  // Multi-agent discussion configuration
  multiAgent?: {
    enabled: boolean; // Enable multi-agent for this scene
    agentIds: string[]; // Which agents to include (from registry)
    directorPrompt?: string; // Optional custom director instructions
  };

  // Metadata
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Scene content based on type
 */
export type SceneContent = SlideContent | QuizContent | InteractiveContent | PBLContent | LessonPlanContent;

/**
 * Slide content - PPTist Canvas data
 */
export interface SlideContent {
  type: 'slide';
  // PPTist slide data structure
  canvas: Slide;
}

/**
 * Quiz content - React component props/data
 */
export interface QuizContent {
  type: 'quiz';
  questions: QuizQuestion[];
}

export interface QuizOption {
  label: string; // Display text
  value: string; // Selection key: "A", "B", "C", "D"
}

export interface QuizQuestion {
  id: string;
  type: 'single' | 'multiple' | 'short_answer';
  question: string;
  options?: QuizOption[];
  answer?: string[]; // Correct answer values: ["A"], ["A","C"], or undefined for text
  analysis?: string; // Explanation shown after grading
  commentPrompt?: string; // Grading guidance for text questions
  hasAnswer?: boolean; // Whether auto-grading is possible
  points?: number; // Points per question (default 1)
}

/**
 * Interactive content - Interactive web page (iframe)
 */
export interface InteractiveContent {
  type: 'interactive';
  url: string; // URL of the interactive page
  // Optional: embedded HTML content
  html?: string;
}

/**
 * PBL content - Project-based learning
 */
export interface PBLContent {
  type: 'pbl';
  projectConfig: PBLProjectConfig;
}

// ---------------------------------------------------------------------------
// Lesson Plan content — structured exercise-card deck for language learning
// ---------------------------------------------------------------------------

export type CEFRLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

export interface LithuanianWord {
  lithuanian: string;
  pronunciation: string;
  english: string;
  emoji?: string;
}

export interface DialogTurn {
  speaker: string;
  lithuanian: string;
  english: string;
  pronunciation?: string;
  isGap?: boolean;
}

export interface Carrier {
  lithuanian: string;
  english: string;
  pronunciation?: string;
  groundingId: string;
}

export interface GroundingItem {
  imageUrl?: string;
  pronunciation?: string;
}

export interface LessonPlanContent {
  type: 'lesson_plan';
  microGoal: {
    grammarPoint: string;
    topic: string;
    cefrLevel: CEFRLevel;
  };
  groundingIds: string[];
  cards: ExerciseCard[];
  groundingMap?: Record<string, GroundingItem>;
}

export type ExerciseCard =
  | PhraseChunkCard
  | DialogSnippetCard
  | ShadowCard
  | RoleplayCard
  | DialogueCompletionCard
  | GrammarPatternCard
  | FillBlankCard
  | CaseTransformCard
  | TenseTransformCard
  | VocabInContextCard
  | MatchingCard
  | MultipleChoiceCard
  | TranslateSentenceCard
  | MistakeSpotlightCard;

export interface PhraseChunkCard {
  kind: 'phrase_chunk';
  situation: string;
  phrase: LithuanianWord;
  groundingId: string;
}

export interface DialogSnippetCard {
  kind: 'dialog_snippet';
  primer: string;
  turns: DialogTurn[];
  groundingId: string;
}

export interface ShadowCard {
  kind: 'shadow';
  instruction: string;
  target: LithuanianWord;
  groundingId: string;
}

export interface RoleplayCard {
  kind: 'roleplay';
  scenario: string;
  cue: string;
  mode: 'closed' | 'free';
  options?: string[];
  answer: string;
  groundingIds: string[];
}

export interface DialogueCompletionCard {
  kind: 'dialogue_completion';
  primer: string;
  turns: DialogTurn[];
  options: string[];
  answer: string;
  groundingId: string;
}

export interface GrammarPatternCard {
  kind: 'grammar_pattern';
  observation: string;
  examples: Carrier[];
  groundingIds: string[];
}

export interface FillBlankCard {
  kind: 'fill_blank';
  sentence: {
    before: string;
    blank: string;
    after: string;
    english: string;
  };
  options: string[];
  answer: string;
  groundingId: string;
}

export interface CaseTransformCard {
  kind: 'case_transform';
  source: Carrier;
  instruction: string;
  expected: string;
  hint?: string;
  groundingId: string;
}

export interface TenseTransformCard {
  kind: 'tense_transform';
  source: Carrier;
  instruction: string;
  expected: string;
  hint?: string;
  groundingId: string;
}

export interface VocabInContextCard {
  kind: 'vocab_in_context';
  word: LithuanianWord;
  carrier: Carrier;
}

export interface MatchingCard {
  kind: 'matching';
  pairs: Array<{ left: string; right: string; groundingId: string }>;
}

export interface MultipleChoiceCard {
  kind: 'multiple_choice';
  prompt: string;
  english?: string;
  options: string[];
  answer: string;
  groundingIds: string[];
}

export interface TranslateSentenceCard {
  kind: 'translate_sentence';
  source: { text: string; language: string };
  mode: 'closed' | 'free';
  options?: string[];
  answer: string;
  groundingId: string;
}

export interface MistakeSpotlightCard {
  kind: 'mistake_spotlight';
  wrong: string;
  correct: string;
  explanation: string;
  carrier?: Carrier;
  groundingId: string;
}

// Re-export generation types for convenience
export type {
  UserRequirements,
  SceneOutline,
  GenerationSession,
  GenerationProgress,
  UploadedDocument,
} from './generation';
