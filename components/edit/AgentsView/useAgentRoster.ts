'use client';

/**
 * useAgentRoster — the roster editor's state, and its one way into the stage.
 *
 * The roster is materialized from the stage document ONCE, at mount, and every
 * edit is applied to that local history (undo / redo included) before being
 * committed back through `setStageAgents`. Mount-time materialization is why the
 * dialog that hosts this hook must stay unmounted while closed: each open then
 * starts from the current cast instead of a snapshot taken hours ago. Within one
 * open session the local history is authoritative, so an agent run that rewrites
 * the roster in the same seconds loses to the next local commit — the dialog is a
 * short-lived, deliberate edit, and reconciling two authors mid-keystroke would
 * cost more than it buys.
 *
 * `setStageAgents` writes the stage document through the shared pending-change
 * scheduler (a granular `{kind:'stage'}` change), NOT through the whole-document
 * aggregate save — so a roster edit persists normally even while an agent session
 * holds the aggregate-save veto for the course on screen.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { nanoid } from 'nanoid';
import { materializeRoster } from '@/lib/edit/agent-roster';
import {
  applyAgentEditOperation,
  undoAgentEditOperation,
  redoAgentEditOperation,
  createAgentConfig,
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
    voiceConfig: cfg.voiceConfig,
    voiceDesign: cfg.voiceDesign,
  };
}

/** True when the id refers to a built-in global default agent (isDefault flag). */
function isGlobalDefault(id: string): boolean {
  return useAgentRegistry.getState().getAgent(id)?.isDefault === true;
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
  history: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentRoster(): AgentRosterController {
  const setStageAgents = useStageStore.use.setStageAgents();

  const [histState, setHistState] = useState<AgentRosterHistory>(() => {
    const stage = useStageStore.getState().stage;
    const roster: AgentRoster = stage
      ? materializeRoster(stage, resolvePreset, makeId, isGlobalDefault)
      : [];
    return { past: [], present: roster, future: [] };
  });

  const [selectedId, setSelectedId] = useState<string | null>(
    () => histState.present[0]?.id ?? null,
  );

  // Guard: only commit after a real user edit, not on initial materialization.
  // Set to true inside every mutation path (applyOp, add, undo, redo) so the
  // effect below is a no-op until the user actually touches the roster.
  const isDirtyRef = useRef(false);

  // Commit roster edits to the stage store. setStageAgents updates the stage
  // document (persisted through the shared pending-change scheduler) and
  // synchronously mirrors the roster into the agent registry + selection.
  // Depends only on `histState.present`: setStageAgents replaces `stage`, so
  // depending on the stage would re-trigger this effect in an infinite loop
  // (React #185). setStageAgents already no-ops when there is no stage.
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
    history: {
      canUndo: histState.past.length > 0,
      canRedo: histState.future.length > 0,
      undo,
      redo,
    },
  };
}
