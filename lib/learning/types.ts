export const LEARNING_TASK_SCHEMA_VERSION = 1 as const;

export type LearningTaskStatus = 'draft' | 'generating' | 'ready' | 'reviewed';

export type LearningTaskTemplate = 'concept-understanding';

export interface LearningTaskNote {
  sceneId: string;
  content: string;
  updatedAt: number;
}

export interface LearningTask {
  schemaVersion: typeof LEARNING_TASK_SCHEMA_VERSION;
  id: string;
  template: LearningTaskTemplate;
  courseName: string;
  knowledgePoint: string;
  learningGoal: string;
  priorKnowledge: string;
  status: LearningTaskStatus;
  classroomId?: string;
  visitedSceneIds: string[];
  reviewSceneIds: string[];
  notes: Record<string, LearningTaskNote>;
  createdAt: number;
  updatedAt: number;
}

export interface ConceptLearningTaskInput {
  courseName: string;
  knowledgePoint: string;
  learningGoal: string;
  priorKnowledge?: string;
}

export type LearningTaskPatch = Partial<
  Pick<
    LearningTask,
    | 'courseName'
    | 'knowledgePoint'
    | 'learningGoal'
    | 'priorKnowledge'
    | 'status'
    | 'classroomId'
    | 'visitedSceneIds'
    | 'reviewSceneIds'
    | 'notes'
  >
>;
