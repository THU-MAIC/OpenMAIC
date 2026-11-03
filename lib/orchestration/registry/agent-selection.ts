export interface AgentSelection {
  mode: 'preset' | 'auto';
  selectedAgentIds: string[];
}

export interface RestoredAgentSelection {
  selection: AgentSelection;
  /** Whether `selection` is the user's explicit choice (vs stage-derived defaults). */
  isUserSet: boolean;
  /**
   * The user's preset choice this course's own roster stands in for, kept for
   * when no roster applies. Absent: nothing is being kept.
   */
  presetChoice?: string[];
}

/**
 * Decide the agent mode/selection to apply when a classroom loads.
 *
 * A course with its own roster is taught by that roster. The only choice that
 * narrows it is an auto selection drawn from this stage's generated agents. A
 * user's preset choice (made in the AgentBar, `persistedIsUserSet`) is a choice
 * for courses that have no cast of their own, and for the next generation: it
 * does not replace this one's, and is handed back as `presetChoice` so that
 * visiting this course does not lose it.
 *
 * Without a roster, a valid preset choice applies, whether it is the persisted
 * selection or the one kept aside. Stage-derived defaults written by previous
 * classroom loads are NOT user choices and must never be re-read as one.
 *
 * The fallback: auto with all generated agents when the stage has them, else
 * the stage's preset agents, else the default trio.
 */
export function restoreAgentSelection(params: {
  persisted: AgentSelection;
  persistedIsUserSet: boolean;
  /** A preset choice kept aside by an earlier load of a course with a roster. */
  persistedPresetChoice?: string[];
  generatedAgentIds: string[];
  stageAgentIds?: string[];
  isPresetAgent: (id: string) => boolean;
}): RestoredAgentSelection {
  const { persisted, persistedIsUserSet, generatedAgentIds, stageAgentIds, isPresetAgent } = params;
  const keptChoice = params.persistedPresetChoice ?? [];
  const persistedPreset =
    persistedIsUserSet &&
    persisted.mode === 'preset' &&
    persisted.selectedAgentIds.length > 0 &&
    persisted.selectedAgentIds.every(isPresetAgent);
  const kept = keptChoice.length > 0 ? { presetChoice: keptChoice } : {};

  if (generatedAgentIds.length > 0) {
    if (persistedIsUserSet && persisted.mode === 'auto' && persisted.selectedAgentIds.length > 0) {
      const generated = new Set(generatedAgentIds);
      if (persisted.selectedAgentIds.every((id) => generated.has(id))) {
        return { selection: persisted, isUserSet: true, ...kept };
      }
    }
    return {
      selection: { mode: 'auto', selectedAgentIds: generatedAgentIds },
      isUserSet: false,
      ...(persistedPreset ? { presetChoice: persisted.selectedAgentIds } : kept),
    };
  }

  if (persistedPreset) return { selection: persisted, isUserSet: true };
  if (keptChoice.length > 0 && keptChoice.every(isPresetAgent)) {
    return { selection: { mode: 'preset', selectedAgentIds: keptChoice }, isUserSet: true };
  }
  const cleanIds = stageAgentIds?.filter(isPresetAgent) ?? [];
  return {
    selection: {
      mode: 'preset',
      selectedAgentIds: cleanIds.length > 0 ? cleanIds : ['default-1', 'default-2', 'default-3'],
    },
    isUserSet: false,
  };
}
