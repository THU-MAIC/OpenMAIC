/**
 * Scene Engine Types
 *
 * Defines the pluggable scene interface and core scene type implementations.
 * Each scene type defines its content structure, agent roles, and interactive widgets.
 */

import type { SceneTypeId } from '@/courses/types';

/**
 * Base scene definition - all scene types implement this interface
 */
export interface SceneDefinition {
  /** Unique scene type identifier */
  typeId: SceneTypeId;
  /** Human-readable name */
  name: string;
  /** Short description of the scene type */
  description: string;
  /** Icon identifier for the UI */
  icon: string;
  /** Default agent roles for this scene type */
  defaultAgentRoles: string[];
  /** Available widgets for this scene type */
  availableWidgets: WidgetType[];
  /** Default configuration */
  defaultConfig: Record<string, unknown>;
}

/**
 * Widget types available in scenes
 */
export type WidgetType =
  | 'slides'
  | 'whiteboard'
  | 'poll'
  | 'timer'
  | 'code-editor'
  | 'chat'
  | 'video'
  | 'notepad'
  | 'file-upload'
  | 'graph-viewer';

/**
 * Lecture scene - Traditional teaching with slides and narration
 */
export interface LectureSceneConfig {
  type: 'lecture';
  slides: LectureSlide[];
  narrationEnabled: boolean;
  whiteboardEnabled: boolean;
  interactiveQuestionsEnabled: boolean;
}

export interface LectureSlide {
  id: string;
  title: string;
  content: string;
  notes?: string;
  mediaUrl?: string;
  order: number;
}

/**
 * Quiz scene - Assessment with various question types
 */
export interface QuizSceneConfig {
  type: 'quiz';
  questions: QuizQuestionConfig[];
  timeLimit?: number;
  shuffleQuestions: boolean;
  showFeedback: boolean;
  passingScore: number;
}

export interface QuizQuestionConfig {
  id: string;
  type: 'single-choice' | 'multiple-choice' | 'short-answer' | 'essay' | 'code';
  question: string;
  options?: { label: string; value: string }[];
  correctAnswer?: string[];
  explanation?: string;
  points: number;
  hints?: string[];
}

/**
 * Simulation scene - Interactive simulations with rules and events
 */
export interface SimulationSceneConfig {
  type: 'simulation';
  simulationType: string;
  environment: SimulationEnvironment;
  rules: SimulationRule[];
  initialState: Record<string, unknown>;
  agentRoles: SimulationAgentRole[];
}

export interface SimulationEnvironment {
  name: string;
  description: string;
  variables: Record<string, unknown>;
}

export interface SimulationRule {
  id: string;
  condition: string;
  action: string;
  priority: number;
}

export interface SimulationAgentRole {
  roleId: string;
  name: string;
  objectives: string[];
  constraints: string[];
}

/**
 * Discussion scene - Guided group discussion
 */
export interface DiscussionSceneConfig {
  type: 'discussion';
  topic: string;
  guidingQuestions: string[];
  moderatorEnabled: boolean;
  turnTakingMode: 'free' | 'round-robin' | 'moderated';
  maxParticipants?: number;
}

/**
 * Debate scene - Structured debate with pro/con positions
 */
export interface DebateSceneConfig {
  type: 'debate';
  motion: string;
  format: DebateFormat;
  sides: DebateSide[];
  moderatorConfig: DebateModeratorConfig;
  timePerTurn?: number;
}

export type DebateFormat = 'oxford' | 'parliamentary' | 'lincoln-douglas' | 'free-form';

export interface DebateSide {
  id: string;
  name: string;
  position: 'pro' | 'con';
  agentIds: string[];
}

export interface DebateModeratorConfig {
  enabled: boolean;
  agentId?: string;
  enforceTurnOrder: boolean;
  allowRebuttals: boolean;
}

/**
 * Project scene - Project-based learning workspace
 */
export interface ProjectSceneConfig {
  type: 'project';
  projectTitle: string;
  projectDescription: string;
  milestones: ProjectMilestone[];
  roles: ProjectRole[];
  deliverables: string[];
  mentorAgentId?: string;
}

export interface ProjectMilestone {
  id: string;
  title: string;
  description: string;
  order: number;
  dueDate?: string;
}

export interface ProjectRole {
  id: string;
  name: string;
  description: string;
  responsibilities: string[];
}

/**
 * Union type for all scene configurations
 */
export type SceneConfig =
  | LectureSceneConfig
  | QuizSceneConfig
  | SimulationSceneConfig
  | DiscussionSceneConfig
  | DebateSceneConfig
  | ProjectSceneConfig;
