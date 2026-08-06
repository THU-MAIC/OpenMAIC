import type { WidgetType } from '@openmaic/dsl';

export type { WidgetType } from '@openmaic/dsl';

/** Image extracted from a source document with metadata used by outline prompts. */
export interface PdfImage {
  id: string;
  src: string;
  pageNumber: number;
  description?: string;
  storageId?: string;
  width?: number;
  height?: number;
  originalId?: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  sourceDocumentOrder?: number;
  visionPriority?: number;
}

export type ImageMapping = Record<string, string>;

/** Free-form requirements accepted by outline generation. */
export interface UserRequirements {
  requirement: string;
  userNickname?: string;
  userBio?: string;
  webSearch?: boolean;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
}

export interface WidgetOutline {
  concept?: string;
  keyVariables?: string[];
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action';
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom';
  objects?: string[];
  interactions?: string[];
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom';
  task?: string;
  tools?: string[];
  steps?: string[];
  successCriteria?: string[];
  errorConsequences?: string[];
  challenge?: string;
  playerControls?: string[];
  nodeCount?: number;
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>;
  challengeType?: string;
}

export interface MediaGenerationRequest {
  type: 'image' | 'video';
  prompt: string;
  elementId: string;
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16';
  style?: string;
}

/** A generation-ready description of one course scene. */
export interface SceneOutline {
  id: string;
  type: 'slide' | 'quiz' | 'interactive' | 'pbl';
  title: string;
  description: string;
  keyPoints: string[];
  teachingObjective?: string;
  estimatedDuration?: number;
  order: number;
  languageNote?: string;
  suggestedImageIds?: string[];
  mediaGenerations?: MediaGenerationRequest[];
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: ('single' | 'multiple' | 'text')[];
  };
  /**
   * @deprecated Use widgetType + widgetOutline instead
   * Legacy interactive config - kept for backward compatibility only
   */
  interactiveConfig?: {
    conceptName: string;
    conceptOverview: string;
    designIdea: string;
    subject?: string;
  };
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    scenarioRoleplay?: boolean;
    scenarioBrief?: string;
  };
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}
