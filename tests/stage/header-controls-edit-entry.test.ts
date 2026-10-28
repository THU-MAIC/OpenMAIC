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

function render(editOpensWorkspace: boolean) {
  return renderToStaticMarkup(
    createElement(HeaderControls, {
      mode: 'playback',
      canEdit: true,
      onToggleEditMode: vi.fn(),
      editOpensWorkspace,
    }),
  );
}

describe('classroom header edit entry', () => {
  it('is a plain button that opens the workspace where the workbench is available', () => {
    const html = render(true);
    expect(html).toContain('stage.editInWorkspace');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('stage.editToggle');
  });

  it('stays the standalone edit switch otherwise', () => {
    const html = render(false);
    expect(html).toContain('role="switch"');
    expect(html).toContain('stage.editToggle');
    expect(html).not.toContain('stage.editInWorkspace');
  });
});
