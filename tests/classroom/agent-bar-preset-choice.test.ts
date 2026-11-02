// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentBar } from '@/components/agent/agent-bar';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';

describe('AgentBar and a kept preset choice', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it("makes a choice a course's roster stood in for the selection again", async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useSettingsStore.setState({
      agentMode: 'auto',
      selectedAgentIds: ['gen-a', 'gen-b'],
      agentSelectionIsUserSet: false,
      presetAgentChoice: ['default-1'],
    });
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    await act(async () => root.render(createElement(I18nProvider, null, createElement(AgentBar))));

    expect(useSettingsStore.getState()).toMatchObject({
      agentMode: 'preset',
      selectedAgentIds: ['default-1'],
      agentSelectionIsUserSet: true,
      presetAgentChoice: [],
    });
    await act(async () => root.unmount());
  });
});
