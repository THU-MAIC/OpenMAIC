import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stageState: {
    stage: { name: 'Course' },
    scenes: [
      {
        id: 'scene-1',
        stageId: 'stage-1',
        title: 'Intro',
        order: 1,
        type: 'slide',
        content: { type: 'slide', canvas: { width: 960, height: 540, elements: [] } },
        actions: [{ id: 'speech-1', type: 'speech', text: 'Hello' }],
      },
    ],
    generatingOutlines: [] as unknown[],
    failedOutlines: [] as unknown[],
  },
  mediaState: { tasks: {} as Record<string, { status: string }> },
  saveAs: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  setExporting: vi.fn(),
}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(value: T) => [value, mocks.setExporting] as const,
}));
vi.mock('file-saver', () => ({ saveAs: mocks.saveAs }));
vi.mock('sonner', () => ({
  toast: { warning: mocks.warning, success: mocks.success, error: mocks.error },
}));
vi.mock('@/lib/store', () => ({ useStageStore: { getState: () => mocks.stageState } }));
vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: { getState: () => mocks.mediaState },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: mocks.error }) }));

import { useExportScript } from '@/lib/export/use-export-script';

describe('useExportScript readiness', () => {
  beforeEach(() => {
    mocks.stageState.generatingOutlines = [];
    mocks.stageState.failedOutlines = [];
    mocks.mediaState.tasks = {};
    vi.clearAllMocks();
  });

  it('re-reads readiness at click time and refuses a stale menu action', () => {
    const { exportScriptMd } = useExportScript();

    mocks.stageState.generatingOutlines = [{}];
    exportScriptMd();

    expect(mocks.warning).toHaveBeenCalledWith('share.notReady');
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('downloads when all current generation work is terminal', () => {
    const { exportScriptMd } = useExportScript();

    mocks.mediaState.tasks = { failedImage: { status: 'failed' } };
    exportScriptMd();

    expect(mocks.saveAs).toHaveBeenCalledOnce();
    expect(mocks.success).toHaveBeenCalledWith('export.exportSuccess');
  });
});
