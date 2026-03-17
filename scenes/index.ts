/**
 * Scene Engine
 *
 * Pluggable scene system for the OpenMAIC platform.
 * Supports: Lecture, Quiz, Simulation, Discussion, Debate, Project
 */
export type {
  SceneDefinition,
  WidgetType,
  LectureSceneConfig,
  LectureSlide,
  QuizSceneConfig,
  QuizQuestionConfig,
  SimulationSceneConfig,
  SimulationEnvironment,
  SimulationRule,
  SimulationAgentRole,
  DiscussionSceneConfig,
  DebateSceneConfig,
  DebateFormat,
  DebateSide,
  DebateModeratorConfig,
  ProjectSceneConfig,
  ProjectMilestone,
  ProjectRole,
  SceneConfig,
} from './types';

export { sceneRegistry } from './registry';
