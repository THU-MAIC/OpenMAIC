// @vitest-environment jsdom

/**
 * The settings "Skills" section seams, per the acceptance criteria:
 *
 *  1. the list renders from the API shape (`AgentSkillInfo` rows: display
 *     name + the English id, one-line description, kind/constraint pills);
 *  2. every row's Download action is a real link to the export route
 *     (`GET /api/skills/:id`) — no client-side mock, no dead button;
 *  3. owner-skill rows appear only for the owner — rows are grouped by the
 *     registry's `source`, and the owner group shows its empty state when the
 *     owner has no skills;
 *  4. the detail view loads a user skill's body from the owner-scoped detail
 *     route (`GET /api/agent/skills/:id`) and never fires that request for a
 *     built-in skill (the route only serves user skills).
 *
 * The registry and the i18n hook are mocked; the dialog primitives render for
 * real so the detail view's fetch behavior is exercised through the actual
 * component.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSkillInfo } from '@/lib/workbench/agent-skills';

const mocks = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
  registry: {
    skills: [] as AgentSkillInfo[],
    loading: false,
    error: null as string | null,
  },
  reload: vi.fn(async () => {}),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: mocks.t, locale: 'en-US', setLocale: () => {} }),
}));

vi.mock('@/lib/workbench/agent-skills', () => ({
  useAgentSkills: () => ({
    skills: mocks.registry.skills,
    loading: mocks.registry.loading,
    error: mocks.registry.error,
    reload: mocks.reload,
  }),
  skillTitle: (skill: { name: string; title?: string | null }) => skill.title ?? undefined,
  agentSkillsErrorText: (snapshot: { error: string | null }, t: (key: string) => string) =>
    snapshot.error ? t(snapshot.error) : null,
}));

import { SkillSettings } from '@/components/settings/skill-settings';

const roots: Root[] = [];
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const userSkill = (overrides: Partial<AgentSkillInfo> = {}): AgentSkillInfo => ({
  id: 'usk_1',
  name: 'my-demo',
  title: 'My demo skill',
  description: 'A skill the owner created from chat history.',
  hasConstraints: true,
  source: 'user',
  ...overrides,
});

const builtinSkill = (overrides: Partial<AgentSkillInfo> = {}): AgentSkillInfo => ({
  id: 'stage-design',
  name: 'stage-design',
  title: 'Classroom design',
  description: 'Plans a classroom from a teaching goal.',
  hasConstraints: false,
  source: 'builtin',
  ...overrides,
});

afterEach(() => {
  mocks.t.mockClear();
  mocks.registry.skills = [];
  mocks.registry.loading = false;
  mocks.registry.error = null;
  mocks.reload.mockClear();
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(SkillSettings)));
  return host;
}

/** Flush a fetch → json → state chain, then the re-render. */
async function flush() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

describe('the skills list renders from the API shape', () => {
  it('renders a row per skill with the display name, the English id, and the description', () => {
    mocks.registry.skills = [userSkill(), builtinSkill()];
    const host = mount();

    const myRow = host.querySelector('[data-testid="skill-settings-row-my-demo"]');
    expect(myRow).not.toBeNull();
    expect(myRow!.textContent).toContain('My demo skill');
    expect(myRow!.textContent).toContain('/my-demo');
    expect(myRow!.textContent).toContain('A skill the owner created from chat history.');

    const builtinRow = host.querySelector('[data-testid="skill-settings-row-stage-design"]');
    expect(builtinRow).not.toBeNull();
    expect(builtinRow!.textContent).toContain('Classroom design');
    expect(builtinRow!.textContent).toContain('/stage-design');
  });

  it('shows the owner and built-in groups, each under its own heading', () => {
    mocks.registry.skills = [userSkill(), builtinSkill()];
    const host = mount();

    expect(host.querySelector('[data-testid="skill-settings-my-group"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="skill-settings-builtin-group"]')).not.toBeNull();
    expect(host.textContent).toContain('settings.skills.mySkills');
    expect(host.textContent).toContain('settings.skills.builtinSkills');
  });

  it('renders the loading state from the registry snapshot', () => {
    mocks.registry.skills = [];
    mocks.registry.loading = true;
    const host = mount();
    expect(host.querySelector('[data-testid="skill-settings-loading"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="skill-settings-my-group"]')).toBeNull();
  });

  it('renders the list-error state without empty group boxes underneath', () => {
    mocks.registry.loading = false;
    mocks.registry.error = 'workbench.skill.listFailed';
    const host = mount();
    // A failed list answers BOTH groups at once — no empty boxes underneath.
    expect(host.querySelector('[data-testid="skill-settings-list-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="skill-settings-list-retry"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="skill-settings-my-group"]')).toBeNull();
    expect(host.querySelector('[data-testid="skill-settings-builtin-group"]')).toBeNull();
  });
});

describe('the download action targets the export route', () => {
  it('renders each row download as a real anchor to /api/skills/:id', () => {
    mocks.registry.skills = [userSkill(), builtinSkill()];
    const host = mount();

    const userDownload = host.querySelector<HTMLAnchorElement>(
      '[data-testid="skill-settings-download-my-demo"]',
    );
    expect(userDownload).not.toBeNull();
    expect(userDownload!.getAttribute('href')).toBe('/api/skills/usk_1');
    expect(userDownload!.getAttribute('download')).toBe('my-demo-skill.zip');

    const builtinDownload = host.querySelector<HTMLAnchorElement>(
      '[data-testid="skill-settings-download-stage-design"]',
    );
    expect(builtinDownload!.getAttribute('href')).toBe('/api/skills/stage-design');
    expect(builtinDownload!.getAttribute('download')).toBe('stage-design-skill.zip');
  });
});

describe('owner-skill rows appear only for the owner', () => {
  it('keeps owner rows in the owner group and built-in rows in the built-in group', () => {
    mocks.registry.skills = [userSkill(), builtinSkill()];
    const host = mount();

    const myGroup = host.querySelector('[data-testid="skill-settings-my-group"]');
    const builtinGroup = host.querySelector('[data-testid="skill-settings-builtin-group"]');
    expect(myGroup!.querySelector('[data-testid="skill-settings-row-my-demo"]')).not.toBeNull();
    expect(myGroup!.querySelector('[data-testid="skill-settings-row-stage-design"]')).toBeNull();
    expect(
      builtinGroup!.querySelector('[data-testid="skill-settings-row-stage-design"]'),
    ).not.toBeNull();
    expect(builtinGroup!.querySelector('[data-testid="skill-settings-row-my-demo"]')).toBeNull();
  });

  it('shows the owner group empty state when the owner has no skills', () => {
    mocks.registry.skills = [builtinSkill()];
    const host = mount();

    const myGroup = host.querySelector('[data-testid="skill-settings-my-group"]');
    expect(myGroup!.textContent).toContain('settings.skills.emptyMySkills');
    expect(myGroup!.querySelector('[data-testid^="skill-settings-row-"]')).toBeNull();
  });
});

describe('owner skill controls', () => {
  it('confirms deletion, calls DELETE, refreshes, and removes the owner row', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    mocks.registry.skills = [userSkill(), builtinSkill()];
    const host = mount();

    const remove = host.querySelector<HTMLButtonElement>(
      '[data-testid="skill-settings-delete-my-demo"]',
    );
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    expect(
      document.body.querySelector('[data-testid="skill-settings-delete-dialog"]'),
    ).not.toBeNull();

    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="skill-settings-delete-confirm"]',
    );
    await act(async () => confirm!.click());
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/agent/skills/usk_1', { method: 'DELETE' });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="skill-settings-row-my-demo"]')).toBeNull();
  });

  it('uploads a file with POST, refreshes, and shows the returned owner skill', async () => {
    const uploaded = userSkill({ id: 'usk_2', name: 'my-uploaded', title: 'Uploaded skill' });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 201,
      json: async () => uploaded,
    }));
    vi.stubGlobal('fetch', fetchMock);
    mocks.registry.skills = [builtinSkill()];
    const host = mount();
    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="skill-settings-upload-input"]',
    );
    const file = new File(['skill zip bytes'], 'my-uploaded-skill.zip', {
      type: 'application/zip',
    });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input!.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/agent/skills');
    expect(init).toMatchObject({ method: 'POST' });
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="skill-settings-row-my-uploaded"]')).not.toBeNull();
  });

  it('never renders delete controls on built-in rows', () => {
    mocks.registry.skills = [builtinSkill()];
    const host = mount();
    const row = host.querySelector('[data-testid="skill-settings-row-stage-design"]');
    expect(row!.querySelector('[data-testid^="skill-settings-delete-"]')).toBeNull();
    expect(host.querySelector('[data-testid="skill-settings-delete-stage-design"]')).toBeNull();
  });
});

describe('the detail view', () => {
  it('loads a user skill body from /api/agent/skills/:id and renders it', async () => {
    const content = '# My demo skill\n\nFull SKILL.md body.';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'usk_1', content }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    mocks.registry.skills = [userSkill()];
    const host = mount();

    const details = host.querySelector<HTMLButtonElement>(
      '[data-testid="skill-settings-details-my-demo"]',
    );
    expect(details).not.toBeNull();
    await act(async () => details!.click());
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/agent/skills/usk_1');
    const dialog = document.body.querySelector('[data-testid="skill-settings-detail-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(content);
    expect(dialog!.querySelector('[data-testid="skill-settings-detail-content"]')).not.toBeNull();
    // Download stays available in the detail view too.
    const download = dialog!.querySelector<HTMLAnchorElement>(
      '[data-testid="skill-settings-download-my-demo"]',
    );
    expect(download!.getAttribute('href')).toBe('/api/skills/usk_1');
  });

  it('never fetches the detail route for a built-in skill', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    mocks.registry.skills = [builtinSkill()];
    const host = mount();

    const details = host.querySelector<HTMLButtonElement>(
      '[data-testid="skill-settings-details-stage-design"]',
    );
    await act(async () => details!.click());
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[data-testid="skill-settings-detail-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('[data-testid="skill-settings-detail-note"]')).not.toBeNull();
    expect(dialog!.querySelector('[data-testid="skill-settings-detail-content"]')).toBeNull();
  });

  it('shows an error with retry when the detail request fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    mocks.registry.skills = [userSkill()];
    const host = mount();

    const details = host.querySelector<HTMLButtonElement>(
      '[data-testid="skill-settings-details-my-demo"]',
    );
    await act(async () => details!.click());
    await flush();

    const dialog = document.body.querySelector('[data-testid="skill-settings-detail-dialog"]');
    expect(dialog!.querySelector('[data-testid="skill-settings-detail-error"]')).not.toBeNull();
    expect(dialog!.querySelector('[data-testid="skill-settings-detail-retry"]')).not.toBeNull();
  });
});

describe('the settings surface mounts the section', () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('adds skills to the SettingsSection union', () => {
    const types = read('lib/types/settings.ts');
    expect(types).toContain("| 'skills'");
  });

  it('renders SkillSettings when the skills section is active', () => {
    const dialog = read('components/settings/index.tsx');
    expect(dialog).toContain("import { SkillSettings } from './skill-settings'");
    expect(dialog).toContain("{activeSection === 'skills' && <SkillSettings />}");
    expect(dialog).toContain("setActiveSection('skills')");
    expect(dialog).toContain("t('settings.skills.nav')");
    expect(dialog).toContain("t('settings.skills.title')");
  });
});
