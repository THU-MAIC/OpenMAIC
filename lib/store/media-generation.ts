/**
 * Media Generation Store
 *
 * Tracks per-element media generation status (pending → generating → done/failed).
 * Drives skeleton loading in slide renderer components.
 * Persistence is handled by IndexedDB (mediaFiles table), not Zustand middleware.
 */

import { create } from 'zustand';
import type { MediaGenerationRequest } from '@/lib/media/types';
import { db } from '@/lib/utils/database';
import { createLogger } from '@/lib/logger';

const log = createLogger('MediaGenerationStore');

// ==================== Types ====================

export type MediaTaskStatus = 'pending' | 'generating' | 'done' | 'failed';

export interface MediaTask {
  elementId: string;
  type: 'image' | 'video';
  status: MediaTaskStatus;
  prompt: string;
  params: {
    aspectRatio?: string;
    style?: string;
    duration?: number;
  };
  objectUrl?: string; // URL.createObjectURL() for rendering
  poster?: string; // Video poster objectUrl
  error?: string;
  errorCode?: string; // Structured error code (e.g. 'CONTENT_SENSITIVE')
  retryCount: number;
  stageId: string;
}

interface MediaGenerationState {
  tasks: Record<string, MediaTask>;

  // Batch enqueue
  enqueueTasks: (stageId: string, requests: MediaGenerationRequest[]) => void;

  // Status transitions
  markGenerating: (elementId: string) => void;
  markDone: (elementId: string, objectUrl: string, poster?: string) => void;
  markFailed: (elementId: string, error: string, errorCode?: string) => void;

  // Retry support
  markPendingForRetry: (elementId: string) => void;

  // Queries
  getTask: (elementId: string) => MediaTask | undefined;
  isReady: (elementId: string) => boolean;

  // Restore from IndexedDB on page load
  restoreFromDB: (stageId: string) => Promise<void>;

  // Cleanup
  clearStage: (stageId: string) => void;
  revokeObjectUrls: () => void;
}

// ==================== Helper ====================

/** Check if a src string is a generated media placeholder ID */
export function isMediaPlaceholder(src: string): boolean {
  return /^gen_(img|vid)_[\w-]+$/i.test(src);
}

// ==================== Store ====================

export const useMediaGenerationStore = create<MediaGenerationState>()((set, get) => ({
  tasks: {},

  enqueueTasks: (stageId, requests) => {
    const newTasks: Record<string, MediaTask> = {};
    for (const req of requests) {
      // Skip if already tracked
      if (get().tasks[req.elementId]) continue;
      newTasks[req.elementId] = {
        elementId: req.elementId,
        type: req.type,
        status: 'pending',
        prompt: req.prompt,
        params: {
          aspectRatio: req.aspectRatio,
          style: req.style,
        },
        retryCount: 0,
        stageId,
      };
    }
    if (Object.keys(newTasks).length > 0) {
      set((s) => ({ tasks: { ...s.tasks, ...newTasks } }));
    }
  },

  markGenerating: (elementId) =>
    set((s) => {
      const task = s.tasks[elementId];
      if (!task) return s;
      return {
        tasks: { ...s.tasks, [elementId]: { ...task, status: 'generating' } },
      };
    }),

  markDone: (elementId, objectUrl, poster) =>
    set((s) => {
      const task = s.tasks[elementId];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [elementId]: {
            ...task,
            status: 'done',
            objectUrl,
            poster,
            error: undefined,
          },
        },
      };
    }),

  markFailed: (elementId, error, errorCode) =>
    set((s) => {
      const task = s.tasks[elementId];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [elementId]: { ...task, status: 'failed', error, errorCode },
        },
      };
    }),

  markPendingForRetry: (elementId) =>
    set((s) => {
      const task = s.tasks[elementId];
      if (!task) return s;
      return {
        tasks: {
          ...s.tasks,
          [elementId]: {
            ...task,
            status: 'pending',
            error: undefined,
            errorCode: undefined,
            retryCount: task.retryCount + 1,
          },
        },
      };
    }),

  getTask: (elementId) => get().tasks[elementId],

  isReady: (elementId) => get().tasks[elementId]?.status === 'done',

  restoreFromDB: async (stageId) => {
    try {
      const records = await db.mediaFiles.where('stageId').equals(stageId).toArray();
      const restored: Record<string, MediaTask> = {};
      for (const rec of records) {
        // Extract elementId from compound key (stageId:elementId)
        const elementId = rec.id.includes(':') ? rec.id.split(':').slice(1).join(':') : rec.id;
        const params = JSON.parse(rec.params || '{}');

        if (rec.error) {
          // Restore as failed task (persisted non-retryable error)
          restored[elementId] = {
            elementId,
            type: rec.type,
            status: 'failed',
            prompt: rec.prompt,
            params,
            error: rec.error,
            errorCode: rec.errorCode,
            retryCount: 0,
            stageId,
          };
        } else {
          // Re-wrap blob with stored mimeType — IndexedDB may drop Blob.type
          const blob = rec.blob.type ? rec.blob : new Blob([rec.blob], { type: rec.mimeType });
          const objectUrl = URL.createObjectURL(blob);
          const poster = rec.poster ? URL.createObjectURL(rec.poster) : undefined;
          restored[elementId] = {
            elementId,
            type: rec.type,
            status: 'done',
            prompt: rec.prompt,
            params,
            objectUrl,
            poster,
            retryCount: 0,
            stageId,
          };
        }
      }
      if (Object.keys(restored).length > 0) {
        set((s) => ({ tasks: { ...s.tasks, ...restored } }));
      }
    } catch (err) {
      log.error('Failed to restore from DB:', err);
    }
  },

  clearStage: (stageId) =>
    set((s) => {
      const remaining: Record<string, MediaTask> = {};
      for (const [id, task] of Object.entries(s.tasks)) {
        if (task.stageId !== stageId) {
          remaining[id] = task;
        } else if (task.objectUrl) {
          URL.revokeObjectURL(task.objectUrl);
          if (task.poster) URL.revokeObjectURL(task.poster);
        }
      }
      return { tasks: remaining };
    }),

  revokeObjectUrls: () => {
    const tasks = get().tasks;
    for (const task of Object.values(tasks)) {
      if (task.objectUrl) URL.revokeObjectURL(task.objectUrl);
      if (task.poster) URL.revokeObjectURL(task.poster);
    }
  },
}));
