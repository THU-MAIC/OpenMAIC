import {
  LEARNING_TASK_SCHEMA_VERSION,
  type LearningTask,
  type LearningTaskPatch,
  type LearningTaskStatus,
} from './types';

export const LEARNING_TASK_STORAGE_KEY = 'zhigou.learning.tasks.v1';
export const LEARNING_TASK_DRAFT_SESSION_KEY = 'zhigou.learning.activeDraft.v1';

export interface LearningTaskStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STATUSES = new Set<LearningTaskStatus>(['draft', 'generating', 'ready', 'reviewed']);

function getBrowserStorage(): LearningTaskStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseTask(value: unknown): LearningTask | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Partial<LearningTask>;
  if (
    task.schemaVersion !== LEARNING_TASK_SCHEMA_VERSION ||
    typeof task.id !== 'string' ||
    task.template !== 'concept-understanding' ||
    typeof task.courseName !== 'string' ||
    typeof task.knowledgePoint !== 'string' ||
    typeof task.learningGoal !== 'string' ||
    typeof task.priorKnowledge !== 'string' ||
    typeof task.status !== 'string' ||
    !STATUSES.has(task.status as LearningTaskStatus) ||
    !isStringArray(task.visitedSceneIds) ||
    !isStringArray(task.reviewSceneIds) ||
    !task.notes ||
    typeof task.notes !== 'object' ||
    typeof task.createdAt !== 'number' ||
    typeof task.updatedAt !== 'number'
  ) {
    return null;
  }
  if (task.classroomId !== undefined && typeof task.classroomId !== 'string') return null;

  const notesAreValid = Object.entries(task.notes).every(
    ([sceneId, note]) =>
      !!note &&
      typeof note === 'object' &&
      (note as { sceneId?: unknown }).sceneId === sceneId &&
      typeof (note as { content?: unknown }).content === 'string' &&
      typeof (note as { updatedAt?: unknown }).updatedAt === 'number',
  );
  return notesAreValid ? (task as LearningTask) : null;
}

export function loadLearningTasks(storage = getBrowserStorage()): LearningTask[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LEARNING_TASK_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(parseTask)
      .filter((task): task is LearningTask => task !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveLearningTasks(tasks: LearningTask[], storage = getBrowserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LEARNING_TASK_STORAGE_KEY, JSON.stringify(tasks));
    return true;
  } catch {
    return false;
  }
}

export function getLearningTask(
  taskId: string,
  storage = getBrowserStorage(),
): LearningTask | null {
  return loadLearningTasks(storage).find((task) => task.id === taskId) ?? null;
}

export function findLearningTaskByClassroomId(
  classroomId: string,
  storage = getBrowserStorage(),
): LearningTask | null {
  return loadLearningTasks(storage).find((task) => task.classroomId === classroomId) ?? null;
}

export function recordVisitedScene(
  taskId: string,
  sceneId: string,
  options: { storage?: LearningTaskStorage | null; now?: number } = {},
): LearningTask | null {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const task = getLearningTask(taskId, storage);
  if (!task) return null;
  if (task.visitedSceneIds.includes(sceneId)) return task;
  return updateLearningTask(
    taskId,
    { visitedSceneIds: [...task.visitedSceneIds, sceneId] },
    { storage, now: options.now },
  );
}

export function saveLearningTaskNote(
  taskId: string,
  sceneId: string,
  content: string,
  options: { storage?: LearningTaskStorage | null; now?: number } = {},
): LearningTask | null {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const task = getLearningTask(taskId, storage);
  if (!task) return null;
  const now = options.now ?? Date.now();
  const notes = { ...task.notes };
  const normalized = content.trim();
  if (normalized) notes[sceneId] = { sceneId, content: normalized, updatedAt: now };
  else delete notes[sceneId];
  return updateLearningTask(taskId, { notes }, { storage, now });
}

export function toggleLearningTaskReviewScene(
  taskId: string,
  sceneId: string,
  options: { storage?: LearningTaskStorage | null; now?: number } = {},
): LearningTask | null {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const task = getLearningTask(taskId, storage);
  if (!task) return null;
  const exists = task.reviewSceneIds.includes(sceneId);
  return updateLearningTask(
    taskId,
    {
      reviewSceneIds: exists
        ? task.reviewSceneIds.filter((id) => id !== sceneId)
        : [...task.reviewSceneIds, sceneId],
    },
    { storage, now: options.now },
  );
}

export function upsertLearningTask(task: LearningTask, storage = getBrowserStorage()): boolean {
  const tasks = loadLearningTasks(storage);
  const existingIndex = tasks.findIndex((item) => item.id === task.id);
  if (existingIndex >= 0) tasks[existingIndex] = task;
  else tasks.unshift(task);
  return saveLearningTasks(tasks, storage);
}

export function updateLearningTask(
  taskId: string,
  patch: LearningTaskPatch,
  options: { storage?: LearningTaskStorage | null; now?: number } = {},
): LearningTask | null {
  const storage = options.storage === undefined ? getBrowserStorage() : options.storage;
  const tasks = loadLearningTasks(storage);
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;

  const updated: LearningTask = {
    ...tasks[index],
    ...patch,
    id: tasks[index].id,
    schemaVersion: LEARNING_TASK_SCHEMA_VERSION,
    template: tasks[index].template,
    createdAt: tasks[index].createdAt,
    updatedAt: options.now ?? Date.now(),
  };
  tasks[index] = updated;
  return saveLearningTasks(tasks, storage) ? updated : null;
}
