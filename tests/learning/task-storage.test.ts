import { describe, expect, it } from 'vitest';

import {
  LEARNING_TASK_STORAGE_KEY,
  LEARNING_TASK_DRAFT_SESSION_KEY,
  findLearningTaskByClassroomId,
  getLearningTask,
  loadLearningTasks,
  recordVisitedScene,
  saveLearningTaskNote,
  toggleLearningTaskReviewScene,
  updateLearningTask,
  upsertLearningTask,
  type LearningTaskStorage,
} from '@/lib/learning/task-storage';
import { createConceptLearningTask } from '@/lib/learning/task-template';

function createMemoryStorage(initial?: string): LearningTaskStorage {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(LEARNING_TASK_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('learning task storage', () => {
  it('uses separate versioned keys for durable tasks and active-tab recovery', () => {
    expect(LEARNING_TASK_STORAGE_KEY).toBe('zhigou.learning.tasks.v1');
    expect(LEARNING_TASK_DRAFT_SESSION_KEY).toBe('zhigou.learning.activeDraft.v1');
  });

  it('fails soft for damaged or unsupported data', () => {
    expect(loadLearningTasks(createMemoryStorage('{broken'))).toEqual([]);
    expect(loadLearningTasks(createMemoryStorage(JSON.stringify([{ schemaVersion: 99 }])))).toEqual(
      [],
    );
  });

  it('upserts, orders, reads and updates tasks without changing identity', () => {
    const storage = createMemoryStorage();
    const older = createConceptLearningTask(
      { courseName: 'A', knowledgePoint: 'A1', learningGoal: 'A2' },
      { id: 'older', now: 10 },
    );
    const newer = createConceptLearningTask(
      { courseName: 'B', knowledgePoint: 'B1', learningGoal: 'B2' },
      { id: 'newer', now: 20 },
    );

    expect(upsertLearningTask(older, storage)).toBe(true);
    expect(upsertLearningTask(newer, storage)).toBe(true);
    expect(loadLearningTasks(storage).map((task) => task.id)).toEqual(['newer', 'older']);

    const updated = updateLearningTask('older', { status: 'generating' }, { storage, now: 30 });
    expect(updated).toMatchObject({
      id: 'older',
      createdAt: 10,
      updatedAt: 30,
      status: 'generating',
    });
    expect(getLearningTask('older', storage)?.status).toBe('generating');
  });

  it('tracks classroom activity without duplicating visits', () => {
    const storage = createMemoryStorage();
    const task = {
      ...createConceptLearningTask(
        { courseName: 'A', knowledgePoint: 'A1', learningGoal: 'A2' },
        { id: 'task', now: 10 },
      ),
      classroomId: 'classroom-1',
      status: 'ready' as const,
    };
    upsertLearningTask(task, storage);

    recordVisitedScene('task', 'scene-1', { storage, now: 20 });
    recordVisitedScene('task', 'scene-1', { storage, now: 30 });
    saveLearningTaskNote('task', 'scene-1', '  关键区别是递归顺序  ', { storage, now: 40 });
    toggleLearningTaskReviewScene('task', 'scene-1', { storage, now: 50 });

    const updated = findLearningTaskByClassroomId('classroom-1', storage);
    expect(updated?.visitedSceneIds).toEqual(['scene-1']);
    expect(updated?.notes['scene-1']).toMatchObject({
      content: '关键区别是递归顺序',
      updatedAt: 40,
    });
    expect(updated?.reviewSceneIds).toEqual(['scene-1']);

    toggleLearningTaskReviewScene('task', 'scene-1', { storage, now: 60 });
    saveLearningTaskNote('task', 'scene-1', ' ', { storage, now: 70 });
    expect(getLearningTask('task', storage)?.reviewSceneIds).toEqual([]);
    expect(getLearningTask('task', storage)?.notes['scene-1']).toBeUndefined();
  });
});
