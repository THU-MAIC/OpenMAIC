import { nanoid } from 'nanoid';

import {
  LEARNING_TASK_SCHEMA_VERSION,
  type ConceptLearningTaskInput,
  type LearningTask,
} from './types';

export function normalizeConceptLearningTaskInput(
  input: ConceptLearningTaskInput,
): ConceptLearningTaskInput {
  return {
    courseName: input.courseName.trim(),
    knowledgePoint: input.knowledgePoint.trim(),
    learningGoal: input.learningGoal.trim(),
    priorKnowledge: input.priorKnowledge?.trim() ?? '',
  };
}

export function validateConceptLearningTaskInput(
  input: ConceptLearningTaskInput,
): Partial<Record<keyof ConceptLearningTaskInput, string>> {
  const normalized = normalizeConceptLearningTaskInput(input);
  const errors: Partial<Record<keyof ConceptLearningTaskInput, string>> = {};

  if (!normalized.courseName) errors.courseName = '请输入课程名称';
  if (!normalized.knowledgePoint) errors.knowledgePoint = '请输入要理解的知识点';
  if (!normalized.learningGoal) errors.learningGoal = '请输入本次学习目标';

  return errors;
}

export function createConceptLearningTask(
  input: ConceptLearningTaskInput,
  options: { id?: string; now?: number } = {},
): LearningTask {
  const normalized = normalizeConceptLearningTaskInput(input);
  const errors = validateConceptLearningTaskInput(normalized);
  if (Object.keys(errors).length > 0) {
    throw new Error('Learning task is missing required fields');
  }

  const now = options.now ?? Date.now();
  return {
    schemaVersion: LEARNING_TASK_SCHEMA_VERSION,
    id: options.id ?? nanoid(12),
    template: 'concept-understanding',
    courseName: normalized.courseName,
    knowledgePoint: normalized.knowledgePoint,
    learningGoal: normalized.learningGoal,
    priorKnowledge: normalized.priorKnowledge ?? '',
    status: 'draft',
    visitedSceneIds: [],
    reviewSceneIds: [],
    notes: {},
    createdAt: now,
    updatedAt: now,
  };
}
