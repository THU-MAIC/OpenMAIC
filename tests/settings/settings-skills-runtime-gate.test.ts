// @vitest-environment jsdom

/**
 * The settings dialog offers the Skills section only when the agent runtime
 * can serve it. `/api/agent/skills` 404s without the runtime, so showing the
 * item there would only ever show a load error.
 *
 *  1. runtime off (`enabled: false` from `/api/agent/runtime`): no Skills item;
 *  2. runtime on: the Skills item is listed;
 *  3. while the probe is unanswered the item stays hidden (no error flash);
 *  4. opening the dialog on `skills` with the runtime off lands on the first
 *     section instead of the skills panel.
 *
 * The section panels are stubbed; the dialog and the runtime probe are real.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsSection } from '@/lib/types/settings';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: () => {} }),
}));
vi.mock('@/components/settings/general-settings', () => ({
  GeneralSettings: () => createElement('div', { 'data-testid': 'panel-general' }),
}));
vi.mock('@/components/settings/skill-settings', () => ({
  SkillSettings: () => createElement('div', { 'data-testid': 'panel-skills' }),
}));
vi.mock('@/components/settings/token-plan-settings', () => ({
  TokenPlanSettings: () => createElement('div', { 'data-testid': 'panel-token-plan' }),
}));
vi.mock('@/components/settings/models', () => ({
  CourseModelMap: () => createElement('div', { 'data-testid': 'panel-course-models' }),
}));
vi.mock('@/components/settings/model-services', () => ({
  ModelServicesPanel: () => createElement('div', { 'data-testid': 'panel-model-services' }),
  SERVICE_TABS: ['providers'],
  SERVICE_TAB_DESCRIPTIONS: { providers: 'providers' },
  SERVICE_TAB_LABELS: { providers: 'providers' },
  TAB_CAPABILITY: { providers: 'chat' },
}));
vi.mock('@/components/settings/server-settings', () => ({
  ServerSettingsGate: ({ children }: { children: (view: null, apply: null) => unknown }) =>
    children(null, null),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  // The runtime probe caches per module instance; start every case fresh.
  vi.resetModules();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function stubRuntime(enabled: boolean) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    // The model settings are not what this file is about: none are kept.
    String(input).includes('/api/model-config')
      ? new Response('Not found', { status: 404 })
      : Response.json({ enabled, runtimeEnabled: enabled, persistence: true }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function mountDialog(initialSection?: SettingsSection) {
  const { SettingsDialog } = await import('@/components/settings');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(SettingsDialog, { open: true, onOpenChange: () => {}, initialSection }),
    ),
  );
}

async function flush() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

const skillsNav = () => document.querySelector('[data-testid="settings-nav-skills"]');
const panel = (id: string) => document.querySelector(`[data-testid="panel-${id}"]`);

describe('the Skills section follows the agent runtime', () => {
  it('hides the Skills item when the runtime is off', async () => {
    const fetchMock = stubRuntime(false);
    await mountDialog();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/agent/runtime');
    expect(document.querySelector('[data-testid="settings-nav-token-plan"]')).not.toBeNull();
    expect(skillsNav()).toBeNull();
  });

  it('shows the Skills item when the runtime is on', async () => {
    stubRuntime(true);
    await mountDialog();
    await flush();

    expect(skillsNav()).not.toBeNull();
    act(() => (skillsNav() as HTMLButtonElement).click());
    expect(panel('skills')).not.toBeNull();
  });

  it('keeps the Skills item hidden while the runtime status is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    await mountDialog('skills');
    await flush();

    expect(skillsNav()).toBeNull();
    expect(panel('skills')).toBeNull();
    expect(panel('token-plan')).not.toBeNull();
  });

  it('opens on the first section when asked for skills with the runtime off', async () => {
    stubRuntime(false);
    await mountDialog('skills');
    await flush();

    expect(panel('skills')).toBeNull();
    expect(panel('token-plan')).not.toBeNull();
  });

  it('opens on skills when asked for it with the runtime on', async () => {
    stubRuntime(true);
    await mountDialog('skills');
    await flush();

    expect(panel('skills')).not.toBeNull();
  });
});
