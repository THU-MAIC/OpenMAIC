/**
 * Stage API - Default Content & Utility Functions
 *
 * Shared utility functions for ID generation, scene validation,
 * and default content creation.
 */

import { nanoid } from 'nanoid';
import type {
  Scene,
  SceneType,
  SceneContent,
  SlideContent,
  QuizContent,
  InteractiveContent,
  PBLContent,
} from '@/lib/types/stage';

// ==================== Utility Functions ====================

/**
 * Generate a unique ID
 */
export function generateId(prefix?: string): string {
  return prefix ? `${prefix}_${nanoid(10)}` : nanoid(10);
}

/**
 * Validate whether a Scene ID exists
 */
export function validateSceneId(scenes: Scene[], sceneId: string): boolean {
  return scenes.some((s) => s.id === sceneId);
}

/**
 * Get a Scene
 */
export function getScene(scenes: Scene[], sceneId: string): Scene | null {
  return scenes.find((s) => s.id === sceneId) || null;
}

/**
 * Create default SlideContent
 */
export function createDefaultSlideContent(): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: generateId('slide'),
      viewportSize: 1000,
      viewportRatio: 0.5625, // 16:9
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
        outline: {
          color: '#d14424',
          width: 2,
          style: 'solid',
        },
        shadow: {
          h: 0,
          v: 0,
          blur: 10,
          color: '#000000',
        },
      },
      elements: [],
    },
  };
}

/**
 * Create default QuizContent
 */
export function createDefaultQuizContent(): QuizContent {
  return {
    type: 'quiz',
    questions: [],
  };
}

/**
 * Create default InteractiveContent
 */
export function createDefaultInteractiveContent(): InteractiveContent {
  return {
    type: 'interactive',
    url: '',
  };
}

/**
 * Create default PBLContent
 */
export function createDefaultPBLContent(): PBLContent {
  return {
    type: 'pbl',
    projectConfig: {
      projectInfo: { title: '', description: '' },
      agents: [],
      issueboard: { agent_ids: [], issues: [], current_issue_id: null },
      chat: { messages: [] },
    },
  };
}

/**
 * Create default Content based on type
 */
export function createDefaultContent(type: SceneType): SceneContent {
  switch (type) {
    case 'slide':
      return createDefaultSlideContent();
    case 'quiz':
      return createDefaultQuizContent();
    case 'interactive':
      return createDefaultInteractiveContent();
    case 'pbl':
      return createDefaultPBLContent();
    default:
      throw new Error(`Unknown scene type: ${type}`);
  }
}
