// @vitest-environment jsdom
/**
 * The standalone classroom page's header. Where the workbench is part of the
 * build it is the workspace's full-screen classroom header — the course and
 * page, the scene's title, the controls — for owners and viewers alike, with
 * the owner's controls only for the owner. Without the workbench, the classic
 * header, unchanged.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${JSON.stringify(options)})` : key,
  }),
}));
vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/export/use-export-pptx', () => ({
  useExportPPTX: () => ({ exporting: false, exportPPTX: vi.fn(), exportResourcePack: vi.fn() }),
}));
vi.mock('@/lib/export/use-export-classroom', () => ({
  useExportClassroom: () => ({ exporting: false, exportClassroomZip: vi.fn() }),
}));
vi.mock('@/lib/export/use-export-html', () => ({
  classroomHasPlaybackMedia: () => false,
  useExportHtml: () => ({ exporting: false, exportStandaloneHtml: vi.fn() }),
}));
vi.mock('@/lib/export/use-export-script', () => ({
  isScriptExportReady: () => false,
  useExportScript: () => ({ exporting: false, exportScriptDocx: vi.fn(), exportScriptMd: vi.fn() }),
}));
vi.mock('@/components/language-switcher', () => ({
  LanguageSwitcher: () => createElement('span', { 'data-testid': 'language-switcher' }),
}));
vi.mock('@/components/settings', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/stage/video-export-dialog', () => ({ VideoExportDialog: () => null }));

import { Header } from '@/components/header';
import { useStageStore } from '@/lib/store';

beforeEach(() => {
  useStageStore.setState({
    stage: { id: 'stage-1', name: 'Photosynthesis' } as never,
    scenes: [{ id: 'scene-1' }, { id: 'scene-2' }] as never,
    currentSceneId: 'scene-2',
  });
});

function render(props: Record<string, unknown>): string {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(Header, {
        currentSceneTitle: 'Leaves',
        mode: 'playback',
        canEdit: true,
        ...props,
      }),
    ),
  );
  const html = container.innerHTML;
  act(() => root.unmount());
  return html;
}

describe('the classroom page header with the workbench', () => {
  it('is the full-screen classroom header: the course, then the scene', () => {
    const html = render({ workbenchControls: true, onToggleEditMode: vi.fn() });
    expect(html).toContain('data-testid="classroom-full-header"');
    expect(html).toContain('Photosynthesis');
    // No page position: the playback toolbar already shows it.
    expect(html).not.toContain('pagePosition');
    expect(html).toContain('Leaves');
    // Not the classic header: no back arrow, no label, no settings pill.
    expect(html).not.toContain('classroom-exit');
    expect(html).not.toContain('stage.currentScene');
    expect(html).not.toContain('language-switcher');
  });

  it('gives the owner Learn | Edit and the way into the workspace', () => {
    const html = render({
      workbenchControls: true,
      onToggleEditMode: vi.fn(),
      onOpenInWorkspace: vi.fn(),
    });
    expect(html).toContain('workbench-mode-editing');
    expect(html).toContain('classroom-open-in-workspace');
    expect(html).not.toContain('classroom-make-own-course');
  });

  it('gives a viewer the way to a course of their own, and no owner controls', () => {
    const html = render({ workbenchControls: true, makeOwnCourseHref: '/' });
    expect(html).toContain('classroom-make-own-course');
    expect(html).not.toContain('workbench-mode-editing');
    expect(html).not.toContain('classroom-open-in-workspace');
  });
});

describe('the classroom page header without the workbench', () => {
  it('is the classic header, unchanged', () => {
    const html = render({ onToggleEditMode: vi.fn() });
    expect(html).not.toContain('classroom-full-header');
    expect(html).toContain('classroom-exit');
    expect(html).toContain('stage.currentScene');
    expect(html).toContain('language-switcher');
  });
});
