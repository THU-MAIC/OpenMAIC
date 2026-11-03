// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomePage from '@/app/page';
import { selectedRunAgents } from '@/lib/generation-run-client/start';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { useRestorePresetAgentChoice } from '@/lib/hooks/use-restore-preset-agent-choice';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useSettingsStore } from '@/lib/store/settings';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/adaptive/adaptive-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adaptive/adaptive-provider')>()),
  useMobileLayout: () => true,
}));
vi.mock('@/components/agent/agent-bar', () => ({
  AgentBar: () => {
    throw new Error('the AgentBar must stay closed for this test to mean anything');
  },
}));

/** Left behind by a course whose roster stood in for the user's preset choice. */
function keepPresetChoice() {
  useSettingsStore.setState({
    agentMode: 'auto',
    selectedAgentIds: ['gen-a', 'gen-b'],
    agentSelectionIsUserSet: false,
    presetAgentChoice: ['default-1'],
  });
}

const restored = {
  agentMode: 'preset',
  selectedAgentIds: ['default-1'],
  agentSelectionIsUserSet: true,
  presetAgentChoice: [],
};

function HookOnly() {
  useRestorePresetAgentChoice();
  return null;
}

describe('a preset choice kept aside for a course with a roster', () => {
  let root: Root | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    // The rest of the page waits on the server; the restore must not.
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    useAgentRegistry.setState({ customAgentsLoaded: true });
    keepPresetChoice();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  async function render(element: React.ReactElement) {
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () =>
      root!.render(createElement(ThemeProvider, null, createElement(I18nProvider, null, element))),
    );
  }

  it('is the selection again as soon as the mobile home page renders', async () => {
    await render(createElement(HomePage));

    expect(useSettingsStore.getState()).toMatchObject(restored);
    await expect(selectedRunAgents()).resolves.toEqual({
      mode: 'preset',
      agentIds: ['default-1'],
    });
  });

  it('is restored by the hook alone, and only once', async () => {
    await render(createElement(HookOnly));
    expect(useSettingsStore.getState()).toMatchObject(restored);

    // A later selection on the same page is left alone.
    await act(async () => useSettingsStore.getState().setAgentMode('auto'));
    expect(useSettingsStore.getState().agentMode).toBe('auto');
  });

  it('is also picked up when it arrives after the home page rendered', async () => {
    useSettingsStore.setState({ presetAgentChoice: [] });
    await render(createElement(HookOnly));
    expect(useSettingsStore.getState().agentMode).toBe('auto');

    await act(async () => keepPresetChoice());
    expect(useSettingsStore.getState()).toMatchObject(restored);
  });
});
