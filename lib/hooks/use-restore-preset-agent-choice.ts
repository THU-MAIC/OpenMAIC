import { useEffect } from 'react';

import { useSettingsStore } from '@/lib/store/settings';

/**
 * Back on the page that chooses agents for the next course: a preset choice a
 * course's own roster stood in for is the selection again. A generation reads
 * the selection directly, so this must run wherever the home page renders, not
 * only where the AgentBar happens to be mounted.
 */
export function useRestorePresetAgentChoice(): void {
  const presetAgentChoice = useSettingsStore((s) => s.presetAgentChoice);

  useEffect(() => {
    if (presetAgentChoice.length === 0) return;
    const settings = useSettingsStore.getState();
    settings.setAgentMode('preset');
    settings.setSelectedAgentIds(presetAgentChoice);
    settings.setAgentSelectionIsUserSet(true);
    settings.setPresetAgentChoice([]);
  }, [presetAgentChoice]);
}
