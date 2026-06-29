'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { nanoid } from 'nanoid';
import { materializeRoster } from '@/lib/edit/agent-roster';
import {
  applyAgentEditOperation,
  undoAgentEditOperation,
  redoAgentEditOperation,
  createAgentConfig,
  teacherCount,
  type AgentRoster,
  type AgentRosterHistory,
  type AgentConfigPatch,
  type AgentEditOperation,
} from '@/lib/edit/agent-ops';
import { useStageStore } from '@/lib/store/stage';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeId = () => 'gen-' + nanoid();

/**
 * Resolve a preset agent id from the registry and map it to the lighter
 * GeneratedAgentConfig shape used by the roster.
 */
function resolvePreset(id: string): GeneratedAgentConfig | undefined {
  const cfg = useAgentRegistry.getState().getAgent(id);
  if (!cfg) return undefined;
  return {
    id: cfg.id,
    name: cfg.name,
    role: cfg.role,
    persona: cfg.persona,
    avatar: cfg.avatar,
    color: cfg.color,
    priority: cfg.priority,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRosterController {
  roster: AgentRoster;
  selectedId: string | null;
  select: (id: string | null) => void;
  add: (role?: string) => void;
  update: (id: string, patch: AgentConfigPatch) => void;
  remove: (id: string) => void;
  reorder: (id: string, index: number) => void;
  canRemove: (id: string) => boolean;
  canChangeRole: (id: string, nextRole: string) => boolean;
  history: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentRoster(): AgentRosterController {
  const stage = useStageStore.use.stage();
  const setStageAgents = useStageStore.use.setStageAgents();

  const [histState, setHistState] = useState<AgentRosterHistory>(() => {
    const roster: AgentRoster = stage
      ? materializeRoster(stage, resolvePreset, makeId)
      : [];
    return { past: [], present: roster, future: [] };
  });

  const [selectedId, setSelectedId] = useState<string | null>(
    () => histState.present[0]?.id ?? null,
  );

  // Guard: only persist after a real user edit, not on initial materialization.
  // Set to true inside every mutation path (applyOp, add, undo, redo) so the
  // effect below is a no-op until the user actually touches the roster.
  const isDirtyRef = useRef(false);

  // Persist roster edits to the store. Depends only on `histState.present`.
  // `stage` is intentionally excluded: setStageAgents mutates `stage`, so
  // depending on it would re-trigger this effect in an infinite loop (React #185).
  // setStageAgents already no-ops when there is no stage (lib/store/stage.ts:287).
  useEffect(() => {
    if (!isDirtyRef.current) return;
    setStageAgents(histState.present);
  }, [histState.present, setStageAgents]);

  /**
   * Apply an operation to the history, swallowing LAST_TEACHER guard errors.
   * Uses a functional updater so rapid calls (fast typing, add+reorder in one
   * render) always see the latest state rather than a stale closure snapshot.
   * Returns true if the operation succeeded.
   */
  const applyOp = useCallback((op: AgentEditOperation): boolean => {
    let succeeded = true;
    isDirtyRef.current = true;
    setHistState((prev) => {
      try {
        return applyAgentEditOperation(prev, op);
      } catch {
        succeeded = false;
        return prev;
      }
    });
    return succeeded;
  }, []);

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  const add = useCallback((role = 'teacher') => {
    const id = makeId();
    isDirtyRef.current = true;
    setHistState((prev) => {
      try {
        const agent = createAgentConfig(role, prev.present.length, id);
        return applyAgentEditOperation(prev, { type: 'agent.add', agent });
      } catch {
        return prev;
      }
    });
    setSelectedId(id);
  }, []);

  const update = useCallback(
    (id: string, patch: AgentConfigPatch) => {
      applyOp({ type: 'agent.update', id, patch });
    },
    [applyOp],
  );

  const remove = useCallback(
    (id: string) => {
      const succeeded = applyOp({ type: 'agent.delete', id });
      if (succeeded) {
        setSelectedId((prev) => {
          if (prev !== id) return prev;
          // Auto-select another agent after deletion
          return histState.present.find((a) => a.id !== id)?.id ?? null;
        });
      }
    },
    [applyOp, histState.present],
  );

  const reorder = useCallback(
    (id: string, index: number) => {
      applyOp({ type: 'agent.reorder', id, index });
    },
    [applyOp],
  );

  const canRemove = useCallback(
    (id: string): boolean => {
      const agent = histState.present.find((a) => a.id === id);
      if (!agent) return false;
      if (agent.role === 'teacher' && teacherCount(histState.present) <= 1) return false;
      return true;
    },
    [histState.present],
  );

  const canChangeRole = useCallback(
    (id: string, nextRole: string): boolean => {
      const agent = histState.present.find((a) => a.id === id);
      if (!agent) return true;
      if (
        agent.role === 'teacher' &&
        nextRole !== 'teacher' &&
        teacherCount(histState.present) <= 1
      )
        return false;
      return true;
    },
    [histState.present],
  );

  const undo = useCallback(() => {
    isDirtyRef.current = true;
    setHistState((prev) => undoAgentEditOperation(prev));
  }, []);

  const redo = useCallback(() => {
    isDirtyRef.current = true;
    setHistState((prev) => redoAgentEditOperation(prev));
  }, []);

  return {
    roster: histState.present,
    selectedId,
    select,
    add,
    update,
    remove,
    reorder,
    canRemove,
    canChangeRole,
    history: {
      canUndo: histState.past.length > 0,
      canRedo: histState.future.length > 0,
      undo,
      redo,
    },
  };
}
