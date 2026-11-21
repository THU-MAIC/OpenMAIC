// @vitest-environment jsdom
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stage } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  stageState: {
    stage: { id: 'stage-123', name: 'Course 101' } as unknown as Stage,
    isOwner: false,
    scenes: [],
    generatingOutlines: new Set<string>(),
    failedOutlines: new Set<string>(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'classroom.copyToMyCourses': 'Copy to my courses',
        'classroom.copying': 'Copying...',
        'classroom.copySuccess': 'Course copied to your courses',
        'classroom.copyFailed': 'Failed to copy course',
        'classroom.copyQuotaRefused': 'Storage quota exceeded',
        'classroom.copyPblV3Unsupported': 'Courses containing PBL v3 projects cannot be copied',
      };
      return translations[key] ?? key;
    },
  }),
}));

vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

vi.mock('@/lib/store', () => ({
  useStageStore: (selector: (state: typeof mocks.stageState) => unknown) =>
    selector(mocks.stageState),
}));

vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: () => ({}),
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

vi.mock('@/lib/config/feature-flags', () => ({
  isVideoExportEnabled: () => false,
  isWorkbenchEnabled: () => false,
}));

vi.mock('@/lib/store/video-render', () => ({
  useVideoRenderStore: () => false,
}));

vi.mock('@/components/language-switcher', () => ({
  LanguageSwitcher: () => null,
}));

vi.mock('@/components/settings', () => ({
  SettingsDialog: () => null,
}));

import { HeaderControls } from '@/components/stage/header-controls';

describe('HeaderControls Copy to my courses UI', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.stageState.isOwner = false;
    mocks.stageState.stage = { id: 'stage-123', name: 'Course 101' } as unknown as Stage;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders Copy to my courses button for non-owners when course actions are shown', () => {
    mocks.stageState.isOwner = false;

    act(() => {
      root.render(
        createElement(HeaderControls, { showCourseActions: true, makeOwnCourseHref: '/' }),
      );
    });

    const button = container.querySelector('button[title="Copy to my courses"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('Copy to my courses');
  });

  it('does NOT render Copy to my courses button for owners', () => {
    mocks.stageState.isOwner = true;

    act(() => {
      root.render(createElement(HeaderControls, { showCourseActions: true }));
    });

    const button = container.querySelector('button[title="Copy to my courses"]');
    expect(button).toBeNull();
  });

  it('does NOT render Copy to my courses button in edit mode', () => {
    mocks.stageState.isOwner = false;

    act(() => {
      root.render(createElement(HeaderControls, { showCourseActions: true, mode: 'edit' }));
    });

    const button = container.querySelector('button[title="Copy to my courses"]');
    expect(button).toBeNull();
  });

  it('does NOT render Copy to my courses button when showCourseActions is false', () => {
    mocks.stageState.isOwner = false;

    act(() => {
      root.render(createElement(HeaderControls, { showCourseActions: false }));
    });

    const button = container.querySelector('button[title="Copy to my courses"]');
    expect(button).toBeNull();
  });

  it('handles successful copy and navigates to the new course', async () => {
    mocks.stageState.isOwner = false;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'stage-new-copy-999' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(
        createElement(HeaderControls, { showCourseActions: true, makeOwnCourseHref: '/' }),
      );
    });

    const button = container.querySelector(
      'button[title="Copy to my courses"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => {
      button.click();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/stages/stage-123/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(mocks.toastSuccess).toHaveBeenCalledWith('Course copied to your courses');
    expect(mocks.routerPush).toHaveBeenCalledWith('/classroom/stage-new-copy-999');
  });

  it('handles quota refusal error and displays appropriate error toast', async () => {
    mocks.stageState.isOwner = false;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 507,
      json: async () => ({
        errorCode: 'ASSET_QUOTA_EXCEEDED',
        error: 'Asset storage quota exceeded.',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(
        createElement(HeaderControls, { showCourseActions: true, makeOwnCourseHref: '/' }),
      );
    });

    const button = container.querySelector(
      'button[title="Copy to my courses"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    expect(mocks.toastError).toHaveBeenCalledWith('Storage quota exceeded');
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });
});
