// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        'workspace.classroomPaneAria': '课堂',
        'workspace.startLearning': '开始学习',
      })[key] ?? key,
  }),
}));
vi.mock('@/components/classroom/ClassroomSurface', () => ({ ClassroomSurface: () => null }));
vi.mock('@/lib/workbench/panel-context', () => ({
  WorkbenchPanelProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/lib/workbench/use-workbench-pro-edit', () => ({
  useWorkbenchProEditing: () => undefined,
}));
vi.mock('@/components/workbench/workspace/WorkspaceCourseTabs', () => ({
  WorkspaceCourseTabs: () => null,
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: (selector: (state: { scenes: unknown[] }) => unknown) =>
    selector({ scenes: [{ id: 'scene-1' }] }),
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (selector: (state: { setPlaybackOn: () => void }) => unknown) =>
    selector({ setPlaybackOn: vi.fn() }),
}));

import { WorkspaceClassroomPane } from '@/components/workbench/workspace/WorkspaceClassroomPane';

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('workspace classroom header', () => {
  it('does not present conversation progress as classroom persistence state', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(WorkspaceClassroomPane, {
          browser: {
            tabs: [{ id: 'stage-1', name: 'Course' }],
            activeCourseId: 'stage-1',
            onActivateCourse: vi.fn(),
            onCloseCourse: vi.fn(),
          },
          readOnly: false,
          playback: false,
          hidden: false,
        }),
      ),
    );

    const indicator = container.querySelector('[data-testid="workspace-course-persistence"]');
    expect(indicator).toBeNull();
  });
});
