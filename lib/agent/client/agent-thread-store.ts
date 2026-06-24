'use client';

/**
 * Lightweight per-course persistence for the AgentBar conversation.
 *
 * One thread per stage (keyed by `stage.id`), stored in localStorage via zustand
 * `persist` (same pattern as the settings store). Holds only the slim serialized
 * projection (see `serialize-thread.ts`), so it stays small. Full session
 * management (history list, rename, server sync) is intentionally out of scope.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SerializedMessage } from './serialize-thread';

export interface SerializedThread {
  messages: SerializedMessage[];
  /** Caller-stamped epoch ms (for future pruning); not read by the store. */
  updatedAt: number;
}

interface AgentThreadStoreState {
  threads: Record<string, SerializedThread>;
  save: (stageId: string, thread: SerializedThread) => void;
  load: (stageId: string) => SerializedThread | undefined;
  clear: (stageId: string) => void;
}

export const useAgentThreadStore = create<AgentThreadStoreState>()(
  persist(
    (set, get) => ({
      threads: {},
      save: (stageId, thread) => set((s) => ({ threads: { ...s.threads, [stageId]: thread } })),
      load: (stageId) => get().threads[stageId],
      clear: (stageId) =>
        set((s) => {
          if (!(stageId in s.threads)) return s;
          const next = { ...s.threads };
          delete next[stageId];
          return { threads: next };
        }),
    }),
    { name: 'maic-agent-threads', version: 1 },
  ),
);
