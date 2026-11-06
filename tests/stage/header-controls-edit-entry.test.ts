import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
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
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/components/settings', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/stage/video-export-dialog', () => ({ VideoExportDialog: () => null }));

import { HeaderControls } from '@/components/stage/header-controls';

function render(
  props: {
    readonly workbenchControls?: boolean;
    readonly onOpenInWorkspace?: () => void;
    readonly mode?: 'playback' | 'edit';
    readonly canEdit?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    createElement(HeaderControls, {
      mode: props.mode ?? 'playback',
      canEdit: props.canEdit ?? true,
      onToggleEditMode: vi.fn(),
      workbenchControls: props.workbenchControls,
      onOpenInWorkspace: props.onOpenInWorkspace,
    }),
  );
}

describe('classroom header edit entry', () => {
  it('is the workspace Learn | Edit switch plus the way into the workspace with the workbench', () => {
    const html = render({ workbenchControls: true, onOpenInWorkspace: vi.fn() });
    expect(html).toContain('data-testid="workbench-mode-learning"');
    expect(html).toContain('data-testid="workbench-mode-editing"');
    expect(html).toContain('data-testid="classroom-open-in-workspace"');
    expect(html).toContain('stage.openInWorkspace');
    expect(html).not.toContain('role="switch"');
    // The way into the workspace is the last control, where the workspace's
    // full-screen header keeps its collapse glyph.
    expect(html.lastIndexOf('classroom-open-in-workspace')).toBeGreaterThan(
      html.lastIndexOf('workbench-mode-editing'),
    );
  });

  it('reflects this page’s own editor in the switch', () => {
    const learning = render({ workbenchControls: true });
    expect(learning).toMatch(/data-testid="workbench-mode-learning" aria-pressed="true"/);
    const editing = render({ workbenchControls: true, mode: 'edit' });
    expect(editing).toMatch(/data-testid="workbench-mode-editing" aria-pressed="true"/);
  });

  it('offers no way into the workspace until it is known to be reachable', () => {
    const html = render({ workbenchControls: true });
    expect(html).toContain('data-testid="workbench-mode-learning"');
    expect(html).not.toContain('classroom-open-in-workspace');
  });

  it('stays the standalone edit switch without the workbench', () => {
    const html = render();
    expect(html).toContain('role="switch"');
    expect(html).toContain('stage.editToggle');
    expect(html).not.toContain('workbench-mode-learning');
    expect(html).not.toContain('classroom-open-in-workspace');
  });
});
