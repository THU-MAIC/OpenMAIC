// @vitest-environment jsdom

/**
 * Connecting a token plan from the Token Plan panel, against the real settings
 * service: the plan's recommended configuration is applied, and when it would
 * replace models the workspace picked the panel asks first.
 *
 * The i18n hook returns keys (with interpolated values appended).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel opens on the side the interface language picks; most cases
// connect mainland plans, so they run with the Simplified Chinese interface.
const i18n = vi.hoisted(() => ({ locale: 'zh-CN' }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? [key, ...Object.values(options)].join('|') : key,
    locale: i18n.locale,
    setLocale: () => {},
  }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

import { TokenPlanSettings } from '@/components/settings/token-plan-settings';
import type {
  ApplyResult,
  ModelSettingsChange,
  ModelSettingsView,
} from '@/lib/model-settings/client';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { applyModelSettingsChange, modelSettingsView } from '@/lib/server/model-config/settings';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const deployment = (config: ModelConfigLayer['config'] | null) =>
  setDeploymentConfigForTests({
    layer: config ? { source: 'deployment', config } : null,
    legacy: false,
    notices: [],
  });

const roots: Root[] = [];
beforeEach(() => {
  vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  deployment(null);
  i18n.locale = 'zh-CN';
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
});

let revision = 0;
const viewOf = (config: ModelConfigFile | null) =>
  modelSettingsView(config ? { config, revision: ++revision, unreadableSecrets: [] } : null);

/** A workspace that picked DeepSeek for the default model and the slides. */
async function workspaceWithOwnPicks(): Promise<ModelConfigFile> {
  let config = await applyModelSettingsChange(null, {
    kind: 'provider',
    id: 'ds',
    preset: 'deepseek',
    apiKey: 'sk-ds-key-0001',
  });
  config = await applyModelSettingsChange(config, {
    kind: 'slots',
    set: { llm: 'ds:deepseek-v4-pro', 'course.content.slide': 'ds:deepseek-flash' },
  });
  return config;
}

/** The panel on a workspace, with an apply backed by the real settings service. */
function mountPanel(initial: ModelConfigFile | null) {
  let config = initial;
  const changes: ModelSettingsChange[] = [];
  const apply = vi.fn(async (change: ModelSettingsChange): Promise<ApplyResult> => {
    changes.push(change);
    config = await applyModelSettingsChange(config, change);
    return { ok: true, view: viewOf(config) };
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(TokenPlanSettings, { view: viewOf(initial), apply })));
  return { changes, config: () => config };
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((settle) => setTimeout(settle, 0));
    });
  }
}

function byText(text: string, selector = 'button'): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
  if (!found) throw new Error(`No ${selector} with ${text}`);
  return found;
}

async function connectPlan(name: string, key = 'td-key-123456') {
  act(() => byText(name).click());
  const input = document.body.querySelector<HTMLInputElement>(
    '[aria-label="settings.tokenPlan.apiKey"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, key);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    (document.body.querySelector('form') as HTMLFormElement).requestSubmit();
  });
  await flush();
}

const dialog = () => document.body.querySelector('[role="alertdialog"]');

describe('Token Plan → connecting applies the plan’s recommended configuration', () => {
  it('on a fresh workspace, assigns llm and the course stages without asking', async () => {
    const panel = mountPanel(null);
    await connectPlan('TokenDance');
    expect(dialog()).toBeNull();
    expect(panel.changes).toEqual([
      { kind: 'provider', id: 'tokendance', preset: 'tokendance', apiKey: 'td-key-123456' },
      {
        kind: 'slots',
        set: {
          llm: 'tokendance:cogevol-base',
          'course.content.slide': 'tokendance:cogevol-slide-0828',
          'course.content.interactive': 'tokendance:cogevol-interactive-0828',
          agent: 'tokendance:deepseek-v4.1-flash',
          tts: 'tokendance:minimax-speech-2.8-turbo',
          image: 'tokendance:seedream-5.0-lite',
          video: 'tokendance:minimax-h3',
          webSearch: 'tokendance',
        },
      },
    ]);
  });

  it('asks before replacing the models the workspace picked, and lists them', async () => {
    const panel = mountPanel(await workspaceWithOwnPicks());
    await connectPlan('TokenDance');
    // Nothing is written until the user chooses.
    expect(panel.changes).toEqual([]);
    const shown = dialog();
    expect(shown?.textContent).toContain('settings.tokenPlan.applyTitle');
    const rows = [...shown!.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    // Slot names as the course model map shows them (the id here: the test's
    // translations return keys), then current → recommended.
    expect(rows[0]).toMatch(/^llmDeepSeek V4 Pro · ds → Cogevol Base · TokenDance$/);
    expect(rows[1]).toMatch(/^course\.content\.slide.* → Cogevol Slide · TokenDance$/);
  });

  it("“Use plan's recommended setup” overwrites the workspace's picks in one change", async () => {
    const panel = mountPanel(await workspaceWithOwnPicks());
    await connectPlan('TokenDance');
    act(() => byText('settings.tokenPlan.applyRecommended', '[role="alertdialog"] button').click());
    await flush();
    expect(panel.changes).toHaveLength(2);
    expect(panel.changes[1]).toMatchObject({
      kind: 'slots',
      set: {
        llm: 'tokendance:cogevol-base',
        'course.content.slide': 'tokendance:cogevol-slide-0828',
        'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      },
    });
    expect(panel.config()?.slots).toMatchObject({
      llm: 'tokendance:cogevol-base',
      'course.content.slide': 'tokendance:cogevol-slide-0828',
    });
  });

  it('“Keep my current setup” connects and fills only the empty slots', async () => {
    const panel = mountPanel(await workspaceWithOwnPicks());
    await connectPlan('TokenDance');
    act(() => byText('settings.tokenPlan.applyKeep', '[role="alertdialog"] button').click());
    await flush();
    expect(panel.changes[0]).toMatchObject({ kind: 'provider', id: 'tokendance' });
    const set = (panel.changes[1] as Extract<ModelSettingsChange, { kind: 'slots' }>).set!;
    expect(set).not.toHaveProperty('llm');
    expect(set).not.toHaveProperty('course.content.slide');
    expect(set).toMatchObject({
      'course.content.interactive': 'tokendance:cogevol-interactive-0828',
      image: 'tokendance:seedream-5.0-lite',
    });
    expect(panel.config()?.slots).toMatchObject({
      llm: 'ds:deepseek-v4-pro',
      'course.content.slide': 'ds:deepseek-flash',
    });
  });

  it('leaves the slots the deployment locks out of the question and the change', async () => {
    const picks = await workspaceWithOwnPicks();
    // The deployment locks the slide model the workspace had picked.
    deployment({
      providers: { operator: { preset: 'deepseek', apiKey: 'sk-operator-secret-0001' } },
      slots: { 'course.content.slide': 'operator:deepseek-v4-pro' },
      lock: ['course.content.slide'],
    });
    const panel = mountPanel(picks);
    await connectPlan('TokenDance');
    const rows = [...dialog()!.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^llm/);
    act(() => byText('settings.tokenPlan.applyRecommended', '[role="alertdialog"] button').click());
    await flush();
    const set = (panel.changes[1] as Extract<ModelSettingsChange, { kind: 'slots' }>).set!;
    expect(set).not.toHaveProperty('course.content.slide');
    expect(set.llm).toMatch(/^tokendance:/);
  });
});

it('shows Kimi fetch in the capability list and connects without a builtin conflict', async () => {
  const panel = mountPanel(null);
  await connectPlan('Kimi');
  // The web fetch card says the plan includes it.
  const card = byText('settings.tokenPlan.capWebFetch', 'li');
  expect(card.textContent).toContain('settings.tokenPlan.capIncluded');
  expect(dialog()).toBeNull();
  expect(panel.changes).toHaveLength(2);
  expect(panel.config()?.slots?.webFetch).toBe('kimi-coding-plan');
});

it.each(['keep', 'overwrite'] as const)(
  'confirms a personal Kimi fetch choice and applies %s',
  async (mode) => {
    let initial = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'personal',
      preset: 'kimi',
      apiKey: 'sk-personal-key',
    });
    initial = await applyModelSettingsChange(initial, {
      kind: 'slots',
      set: { webFetch: 'personal' },
    });
    const panel = mountPanel(initial);
    await connectPlan('Kimi');
    expect(dialog()?.textContent).toContain('personal');
    expect(panel.changes).toEqual([]);
    act(() =>
      byText(
        mode === 'keep' ? 'settings.tokenPlan.applyKeep' : 'settings.tokenPlan.applyRecommended',
        '[role="alertdialog"] button',
      ).click(),
    );
    await flush();
    expect(panel.config()?.slots?.webFetch).toBe(mode === 'keep' ? 'personal' : 'kimi-coding-plan');
  },
);

it('confirms an explicit null fetch choice and preserves it when keeping the setup', async () => {
  const initial = await applyModelSettingsChange(null, { kind: 'slots', set: { webFetch: null } });
  const panel = mountPanel(initial);
  await connectPlan('Kimi');
  expect(dialog()).not.toBeNull();
  expect(panel.changes).toEqual([]);
  act(() => byText('settings.tokenPlan.applyKeep', '[role="alertdialog"] button').click());
  await flush();
  expect(panel.config()?.slots?.webFetch).toBeNull();
});

it('takes over the builtin reader when keeping an explicit chat choice', async () => {
  const panel = mountPanel(await workspaceWithOwnPicks());
  await connectPlan('Kimi');
  expect(dialog()!.querySelectorAll('li')).toHaveLength(1);
  expect(dialog()?.textContent).not.toContain('Built-in reader');
  act(() => byText('settings.tokenPlan.applyKeep', '[role="alertdialog"] button').click());
  await flush();
  expect(panel.config()?.slots).toMatchObject({
    llm: 'ds:deepseek-v4-pro',
    webFetch: 'kimi-coding-plan',
  });
});

describe('Token Plan → mainland and international sides', () => {
  const planNames = () =>
    [...document.body.querySelectorAll('[role="tab"]')].map(
      (tab) => tab.querySelector('.font-medium')?.textContent,
    );

  it('opens on the international side outside the Simplified Chinese interface', () => {
    i18n.locale = 'en-US';
    mountPanel(null);
    expect(planNames()).toEqual(['MiniMax', 'Kimi', 'DeepSeek']);
    expect(byText('settings.providerLinks.international').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.body.textContent).toContain('settings.tokenPlan.region');
    expect(document.body.textContent).toContain('settings.tokenPlan.regionHintInternational');
    expect(
      document.body
        .querySelector('[aria-label="settings.tokenPlan.apiKey"]')
        ?.getAttribute('placeholder'),
    ).toBe('sk-cp-...');
  });

  it('opens on the mainland side in Simplified Chinese and switches sides', () => {
    mountPanel(null);
    expect(planNames()).toEqual(['TokenDance', 'MiniMax', 'Seed', 'Kimi', 'DeepSeek']);
    expect(document.body.textContent).toContain('settings.tokenPlan.regionHintDomestic');
    act(() => byText('settings.providerLinks.international').click());
    expect(planNames()).toEqual(['MiniMax', 'Kimi', 'DeepSeek']);
    expect(document.body.textContent).toContain('settings.tokenPlan.regionHintInternational');
    expect(document.body.textContent).not.toContain('settings.tokenPlan.regionHintDomestic');
    expect(
      document.body.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toContain('MiniMax');
  });

  it('connects the international Kimi plan as its own provider', async () => {
    i18n.locale = 'en-US';
    const panel = mountPanel(null);
    await connectPlan('Kimi', 'sk-kimi-intl-0001');
    expect(panel.changes[0]).toMatchObject({
      kind: 'provider',
      id: 'kimi-intl',
      preset: 'kimi-intl',
    });
    expect(panel.config()?.slots?.llm).toBe('kimi-intl:kimi-for-coding');
    expect(panel.config()?.slots?.webFetch).toBe('kimi-intl');
  });
});

it("asks the plan's quota again after a new key is saved for it", async () => {
  i18n.locale = 'en-US';
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify({ quota: { status: 'unavailable' } }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  try {
    let connected = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'minimax-intl',
      preset: 'minimax-intl',
      apiKey: 'sk-cp-old-key-0001',
    });
    connected = await applyModelSettingsChange(connected, {
      kind: 'provider',
      id: 'kimi-intl',
      preset: 'kimi-intl',
      apiKey: 'test-kimi',
    });
    mountPanel(connected);
    await flush();
    const quotaCalls = (id: string) =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`plan-status?provider=${id}`))
        .length;
    const before = quotaCalls('minimax-intl');
    const kimiBefore = quotaCalls('kimi-intl');
    expect(kimiBefore).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    act(() => byText('settings.tokenPlan.updateKey').click());
    const input = document.body.querySelector<HTMLInputElement>(
      '[aria-label="settings.tokenPlan.apiKey"]',
    )!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'sk-cp-new-key-0002',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      (document.body.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    await flush();
    expect(quotaCalls('minimax-intl')).toBe(before + 1);
    expect(quotaCalls('kimi-intl')).toBe(kimiBefore);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('the plan page tells a tier without a capability from one switched off', () => {
  const mountView = (view: ModelSettingsView) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    const apply = vi.fn(async (): Promise<ApplyResult> => ({ ok: true, view }));
    act(() => root.render(createElement(TokenPlanSettings, { view, apply })));
  };
  const videoCard = () => byText('settings.tokenPlan.capVideo', 'li');
  const minimaxRow = () => byText('MiniMax', '[role="tab"]');

  beforeEach(() => {
    i18n.locale = 'en-US';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ quota: { status: 'unavailable' } }))),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a Go plan the vendor reported without video: not in tier, and a warning in the list', async () => {
    const config = await applyModelSettingsChange(
      null,
      { kind: 'provider', id: 'minimax-intl', preset: 'minimax-intl', apiKey: 'sk-cp-go-0001' },
      { unsupportedCapabilities: ['video'] },
    );
    mountView(viewOf(config));
    await flush();
    expect(videoCard().textContent).toContain('settings.tokenPlan.capNotInTier');
    expect(minimaxRow().textContent).toContain('settings.tokenPlan.missingCapability');
  });

  it('video the deployment switched off: unavailable on this connection, no tier warning', async () => {
    const config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'minimax-intl',
      preset: 'minimax-intl',
      apiKey: 'sk-cp-plus-0001',
    });
    const view = viewOf(config);
    // As the server answers when the operator switched MiniMax video off.
    const providers = view.providers.map((provider) => {
      if (provider.id !== 'minimax-intl') return provider;
      const { video: _video, ...capabilities } = provider.capabilities;
      return { ...provider, capabilities };
    });
    mountView({ ...view, providers });
    await flush();
    expect(videoCard().textContent).toContain('settings.tokenPlan.capUnavailable');
    expect(videoCard().textContent).not.toContain('settings.tokenPlan.capNotInTier');
    expect(minimaxRow().textContent).not.toContain('settings.tokenPlan.missingCapability');
  });

  it.each(['asr', 'document'] as const)(
    'omits disabled %s from the extra capabilities',
    async (capability) => {
      const config = await applyModelSettingsChange(null, {
        kind: 'provider',
        id: 'ds',
        preset: 'deepseek-token-plan',
        apiKey: 'test-plan-key',
      });
      const view = viewOf(config);
      const provider = view.providers.find((entry) => entry.id === 'ds')!;
      delete provider.capabilities[capability];
      mountView(view);
      act(() => byText('DeepSeek', '[role="tab"]').click());
      await flush();
      const extras = byText('settings.tokenPlan.alsoProvides', 'p');
      expect(extras.textContent).not.toContain(capability === 'asr' ? 'capAsr' : 'capDocument');
      expect(extras.textContent).toContain(capability === 'asr' ? 'capDocument' : 'capAsr');
    },
  );

  it('sums up each connected plan in the list: what is left, or that it cannot be looked up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        String(url).includes('minimax-intl')
          ? new Response(
              JSON.stringify({
                quota: {
                  status: 'available',
                  balances: [],
                  windows: [
                    { period: 'hours', hours: 5, remainingPercent: 91 },
                    { period: 'week', remainingPercent: 97 },
                  ],
                },
              }),
            )
          : new Response(JSON.stringify({ quota: { status: 'unavailable' } })),
      ),
    );
    let config = await applyModelSettingsChange(null, {
      kind: 'provider',
      id: 'minimax-intl',
      preset: 'minimax-intl',
      apiKey: 'sk-cp-go-0001',
    });
    config = await applyModelSettingsChange(config, {
      kind: 'provider',
      id: 'kimi-intl',
      preset: 'kimi-intl',
      apiKey: 'sk-kimi-0001',
    });
    mountView(viewOf(config));
    await flush();
    expect(minimaxRow().textContent).toContain('settings.tokenPlan.quotaRemaining|91');
    expect(byText('Kimi', '[role="tab"]').textContent).toContain('settings.tokenPlan.quotaNa');
    // The selected plan's card shows each window.
    expect(document.body.textContent).toContain('settings.tokenPlan.windowHours|5');
  });
});
