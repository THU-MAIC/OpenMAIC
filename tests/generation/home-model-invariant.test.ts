// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClassicHomePage } from '@/app/classic-home';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { modelSettingsClient } from '@/lib/model-settings/client';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useSettingsStore } from '@/lib/store/settings';
import { modelSettingsViewFor } from '../helpers/model-settings-view';
import { makeView, workspaceProvider } from '../model-settings/fixtures';

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/adaptive/adaptive-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adaptive/adaptive-provider')>()),
  useMobileLayout: () => false,
}));

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  useAgentRegistry.setState({ customAgentsLoaded: true });
  useSettingsStore.setState({ agentMode: 'auto', presetAgentChoice: [] });
  toastError.mockClear();
  toastSuccess.mockClear();
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  modelSettingsClient.adopt(null);
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'gates generation with a typed requirement when configured=%s',
  async (configured) => {
    const target = { registryId: 'acme', providerId: 'acme', modelId: 'acme-large' };
    const view = configured
      ? {
          ...makeView({ providers: [workspaceProvider('acme')] }),
          slots: modelSettingsViewFor({
            llm: target,
            'course.outline': target,
            'course.content.slide': target,
            'course.actions': target,
          }).slots,
        }
      : makeView();
    modelSettingsClient.adopt(view);
    await act(async () =>
      root.render(createElement(ThemeProvider, null, createElement(ClassicHomePage))),
    );
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="home-requirement"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Explain how photosynthesis works',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const enter = document.querySelector<HTMLButtonElement>('[data-testid="home-generate"]')!;
    expect(enter).not.toBeNull();
    expect(enter.disabled).toBe(!configured);
    const setup = [...document.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('toolbar.configureProvider'),
    );
    expect(setup).toHaveLength(configured ? 0 : 1);
    const pill = document.querySelector('button[aria-label*=" / "]');
    if (configured) expect(pill?.getAttribute('aria-label')).toBe('Acme / acme-large');
    else expect(pill).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  },
);
