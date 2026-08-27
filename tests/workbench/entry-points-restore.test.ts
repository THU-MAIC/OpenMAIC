// @vitest-environment jsdom

/**
 * The three restored entry points, pinned:
 *
 *  1. the workspace rail's courses tab carries an upload control next to the
 *     name filter (it imports a course package from disk into the list);
 *  2. the Pro launch composer (and the chat composer) carries an attach
 *     control in the glyph row, rendered exactly when the material upload
 *     path can serve a request;
 *  3. the rail's foot cluster — the bottom-left utilities — mounts the
 *     settings trigger for the model/provider dialog, in the slot the removed
 *     saved-courses drawer left.
 *
 * Items 1 and 3 are pinned from source (the rail and the shell are heavy
 * client surfaces the suite renders nowhere else); item 2 is pinned by an
 * actual render of `AttachButton` under both probe answers, plus source pins
 * for where it is mounted and the copy it carries in every locale.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

const hosts: Array<{ root: Root; host: HTMLDivElement }> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const { root, host } of hosts.splice(0)) {
    root.unmount();
    host.remove();
  }
});

/** Load a fresh module copy so the probe cache starts empty — the cache is
 *  module-level and remembered for the life of the tab, exactly as in the app,
 *  so one test's probe answer must not leak into the next. */
async function importFreshExtras(): Promise<
  typeof import('@/components/workbench/compose-extras')
> {
  vi.resetModules();
  return await import('@/components/workbench/compose-extras');
}

function mount(children: ReactNode): Root {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  hosts.push({ root, host });
  return root;
}

/** Flush the probe's fetch → json → state chain, then the re-render. */
async function flushProbe() {
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
}

describe('entry point 1 — the courses-tab upload control', () => {
  const rail = read('components/workbench/workspace/WorkspaceRail.tsx');
  const shell = read('components/workbench/workspace/WorkspaceShell.tsx');
  const discovery = read('lib/hooks/use-home-discovery.tsx');

  it('renders the upload button beside the course name filter', () => {
    // The find row lives under the tab strip and above the tabpanel.
    const findRow = rail.slice(
      rail.indexOf('pro-nav-search-input'),
      rail.indexOf('role="tabpanel"'),
    );
    expect(findRow).toContain('data-testid="pro-nav-import-course"');
    expect(findRow).toContain('<Upload className="size-4"');
  });

  it('opens the same course-package import the home surface uses, disabled while one runs', () => {
    const button = rail.slice(
      rail.indexOf('data-testid="pro-nav-import-course"'),
      rail.indexOf('data-testid="pro-nav-new-folder"'),
    );
    // Clearing the filter first means the imported course is not hidden by a
    // stale query, then the discovery hook's import trigger fires.
    expect(button).toContain("coursesSection.setQuery('')");
    expect(button).toContain('courses.triggerImport()');
    expect(button).toContain('disabled={courses.importing}');
    expect(button).toContain("aria-label={t('import.classroom')}");
    expect(button).toContain("title={t('import.classroom')}");
  });

  it('is gated by the same condition as its action: the courses tab', () => {
    const coursesTab = rail.indexOf("{tab === 'courses' ? (");
    const upload = rail.indexOf('pro-nav-import-course');
    const conditionalEnd = rail.indexOf(') : null}', upload);
    expect(coursesTab).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(coursesTab);
    // The button sits inside the conditional (before its close), so a session-
    // tab view never shows an import affordance.
    expect(upload).toBeLessThan(conditionalEnd);
  });

  it('mounts the hidden file input once, from the discovery hook the button calls', () => {
    expect(shell).toContain('{courses.importInput}');
    expect(discovery).toContain('triggerFileSelect');
    expect(discovery).toContain('triggerImport');
    expect(discovery).toContain('importing: isImporting');
    expect(discovery).toContain('accept=".zip"');
  });
});

describe('entry point 2 — the composer attach control', () => {
  const extras = read('components/workbench/compose-extras.tsx');
  const launch = read('components/workbench/ProLaunchPanel.tsx');
  const chat = read('components/workbench/WorkbenchChat.tsx');

  it('is mounted in the Pro launch composer’s glyph row, before the mention and skill', () => {
    expect(launch).toContain('testId="pro-launch-attach"');
    const row = launch.slice(launch.indexOf('pro-launch-attach'), launch.indexOf('<ProLaunchSend'));
    expect(row).toContain('<AtSignButton');
    expect(row).toContain('<SkillButton');
  });

  it('is mounted in the chat composer’s glyph row too', () => {
    expect(chat).toContain('<AttachButton');
    expect(chat).toContain('testId="workbench-attach"');
  });

  it('renders when the runtime says the upload path is live', async () => {
    // The probe resolves to this branch's runtime `enabled` field — the same
    // value that gates `POST /api/materials`, the upload action's precondition.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ enabled: true, runtimeEnabled: true })),
    );
    const { AttachButton } = await importFreshExtras();
    const root = mount(null);
    await act(async () => {
      root.render(createElement(AttachButton, { onFiles: () => undefined, label: 'attach' }));
    });
    await flushProbe();
    const host = hosts[hosts.length - 1].host;
    expect(host.querySelector('[data-testid="workbench-attach"]')).not.toBeNull();
    expect(host.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('stays hidden while the upload path is off (no dead button)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ enabled: false })),
    );
    const { AttachButton } = await importFreshExtras();
    const root = mount(null);
    await act(async () => {
      root.render(createElement(AttachButton, { onFiles: () => undefined, label: 'attach' }));
    });
    await flushProbe();
    const host = hosts[hosts.length - 1].host;
    expect(host.querySelector('[data-testid="workbench-attach"]')).toBeNull();
  });

  it('reads the runtime `enabled` field, this branch’s upload precondition', () => {
    // The reference probes `materialsEnabled` (its runtime answers
    // `enabled && isAgentMaterialsEnabled()`); this port has no separate
    // materials flag, so the probe must read `enabled` — otherwise the button
    // could never render.
    expect(extras).toContain('(body as { enabled?: unknown }).enabled === true');
    expect(extras).not.toContain('materialsEnabled === true');
    expect(extras).not.toContain('materialsEnabled?: unknown');
  });

  it('carries the reference’s own copy in every locale', () => {
    const expected: Record<string, string> = {
      'ar-SA': 'إرفاق مواد',
      'de-DE': 'Attach material',
      'en-US': 'Attach material',
      'es-MX': 'Adjuntar material',
      'fr-FR': 'Joindre un support',
      'ja-JP': '教材を添付',
      'ko-KR': '자료 첨부',
      'pt-BR': 'Anexar material',
      'ru-RU': 'Прикрепить материал',
      'vi-VN': 'Đính kèm tài liệu',
      'zh-CN': '添加材料',
      'zh-TW': '添加材料',
    };
    for (const [locale, copy] of Object.entries(expected)) {
      const parsed = JSON.parse(read(`lib/i18n/locales/${locale}.json`)) as {
        proMode?: { attach?: string };
      };
      expect(parsed.proMode?.attach, locale).toBe(copy);
    }
  });
});

describe('entry point 3 — the settings entry in the rail’s foot cluster', () => {
  const rail = read('components/workbench/workspace/WorkspaceRail.tsx');

  it('mounts the settings trigger in the expanded foot cluster', () => {
    const utilities = rail.slice(rail.indexOf('function RailUtilities'));
    expect(utilities).toContain('data-testid="pro-nav-settings"');
    expect(utilities).toContain('<Settings className="size-4"');
    expect(utilities).toContain("aria-label={t('settings.title')}");
    expect(utilities).toContain("title={t('settings.title')}");
  });

  it('keeps the trigger on the collapsed strip too', () => {
    const mini = rail.slice(
      rail.indexOf('pro-rail-utilities-mini'),
      rail.indexOf('renderCourseRow'),
    );
    expect(mini).toContain('data-testid="pro-nav-settings-mini"');
    expect(mini).toContain('onClick={() => setSettingsOpen(true)}');
  });

  it('opens the model/provider dialog, mounted by the rail itself', () => {
    expect(rail).toContain("import { SettingsDialog } from '@/components/settings'");
    expect(rail).toContain('<SettingsDialog');
    expect(rail).toContain('open={settingsOpen}');
    const trigger = rail.slice(rail.indexOf('data-testid="pro-nav-settings"'));
    expect(trigger.slice(0, trigger.indexOf('</button>'))).toContain('onClick={onOpenSettings}');
  });

  it('sits beside the language and display toggles in the cluster order', () => {
    const utilities = rail.slice(rail.indexOf('function RailUtilities'));
    const order = ['<LanguageSwitcher', '<ThemeToggle', 'pro-nav-settings'].map((token) =>
      utilities.indexOf(token),
    );
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });
});
