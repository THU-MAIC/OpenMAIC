/**
 * Scene Type Registry
 *
 * Central registry for all available scene types.
 * New scene types can be registered via the plugin system.
 */

import type { SceneDefinition, WidgetType } from './types';
import type { SceneTypeId } from '@/courses/types';

/**
 * Built-in scene type definitions
 */
const BUILT_IN_SCENES: Record<string, SceneDefinition> = {
  lecture: {
    typeId: 'lecture',
    name: 'Lecture',
    description: 'Traditional teaching with slides, narration, and whiteboard',
    icon: 'presentation',
    defaultAgentRoles: ['teacher', 'assistant'],
    availableWidgets: ['slides', 'whiteboard', 'notepad', 'chat'] as WidgetType[],
    defaultConfig: {
      narrationEnabled: true,
      whiteboardEnabled: true,
      interactiveQuestionsEnabled: false,
    },
  },
  quiz: {
    typeId: 'quiz',
    name: 'Quiz',
    description: 'Assessment with multiple question types and AI-powered grading',
    icon: 'clipboard-check',
    defaultAgentRoles: ['examiner'],
    availableWidgets: ['timer', 'notepad'] as WidgetType[],
    defaultConfig: {
      shuffleQuestions: false,
      showFeedback: true,
      passingScore: 70,
    },
  },
  simulation: {
    typeId: 'simulation',
    name: 'Simulation',
    description: 'Interactive simulation with rules, events, and AI agent societies',
    icon: 'flask',
    defaultAgentRoles: ['teacher', 'assistant'],
    availableWidgets: ['whiteboard', 'chat', 'graph-viewer'] as WidgetType[],
    defaultConfig: {
      simulationType: 'generic',
    },
  },
  discussion: {
    typeId: 'discussion',
    name: 'Discussion',
    description: 'Guided group discussion with optional AI moderation',
    icon: 'messages-square',
    defaultAgentRoles: ['moderator', 'assistant'],
    availableWidgets: ['chat', 'poll', 'notepad'] as WidgetType[],
    defaultConfig: {
      moderatorEnabled: true,
      turnTakingMode: 'free',
    },
  },
  debate: {
    typeId: 'debate',
    name: 'Debate',
    description: 'Structured debate with pro/con agents and moderator',
    icon: 'scale',
    defaultAgentRoles: ['moderator', 'debater-pro', 'debater-con'],
    availableWidgets: ['chat', 'timer', 'poll'] as WidgetType[],
    defaultConfig: {
      format: 'free-form',
      timePerTurn: 120,
    },
  },
  project: {
    typeId: 'project',
    name: 'Project',
    description: 'Project-based learning with milestones, roles, and AI mentor',
    icon: 'folder-kanban',
    defaultAgentRoles: ['mentor', 'assistant'],
    availableWidgets: ['chat', 'file-upload', 'notepad', 'code-editor'] as WidgetType[],
    defaultConfig: {},
  },
};

/**
 * Scene registry - manages available scene types
 */
class SceneRegistry {
  private scenes: Map<string, SceneDefinition> = new Map();

  constructor() {
    // Register built-in scenes
    for (const [key, scene] of Object.entries(BUILT_IN_SCENES)) {
      this.scenes.set(key, scene);
    }
  }

  /**
   * Register a new scene type (for plugins)
   */
  register(scene: SceneDefinition): void {
    this.scenes.set(scene.typeId, scene);
  }

  /**
   * Get a scene definition by type ID
   */
  get(typeId: SceneTypeId): SceneDefinition | undefined {
    return this.scenes.get(typeId);
  }

  /**
   * List all registered scene types
   */
  list(): SceneDefinition[] {
    return Array.from(this.scenes.values());
  }

  /**
   * Check if a scene type is registered
   */
  has(typeId: string): boolean {
    return this.scenes.has(typeId);
  }
}

/** Singleton scene registry instance */
export const sceneRegistry = new SceneRegistry();
