// @vitest-environment jsdom
/**
 * The request preview's tab selected in the strip is selection only: the
 * classroom kept alive behind it still shows (and loads) its real course.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  surfaceCourses: [] as string[],
  surfaceMounts: 0,
  selected: [] as string[],
}));

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/classroom/ClassroomSurface', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    ClassroomSurface: ({ classroomId }: { classroomId: string }) => {
      probe.surfaceCourses.push(classroomId);
      useEffect(() => {
        probe.surfaceMounts += 1;
      }, []);
      return null;
    },
  };
});
vi.mock('@/components/stage/header-controls', () => ({ HeaderControls: () => null }));
vi.mock('@/lib/workbench/use-workbench-pro-edit', () => ({ useWorkbenchProEditing: () => {} }));
vi.mock('@/components/workbench/workspace/WorkspaceCourseTabs', () => ({
  WorkspaceCourseTabs: ({ activeCourseId }: { activeCourseId: string }) => {
    probe.selected.push(activeCourseId);
    return null;
  },
}));
vi.mock('@/lib/workbench/session-store', () => ({
  useWorkbenchStore: (selector: (state: { setPlaybackOn: () => void }) => unknown) =>
    selector({ setPlaybackOn: () => {} }),
}));

import { WorkspaceClassroomPane } from '@/components/workbench/workspace/WorkspaceClassroomPane';

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const pane = (selectedTabId?: string) =>
  createElement(WorkspaceClassroomPane, {
    browser: {
      tabs: [
        { id: 'stage-1', name: 'Course' },
        { id: 'request-preview', name: 'Preview' },
      ],
      activeCourseId: 'stage-1',
      ...(selectedTabId ? { selectedTabId } : {}),
      onActivateCourse: vi.fn(),
      onCloseCourse: vi.fn(),
    },
    hidden: selectedTabId === 'request-preview',
    fullscreen: false,
    readOnly: false,
  });

describe('the classroom behind a selected preview tab', () => {
  it('keeps its real course and its mount; only the strip selects the preview', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(pane()));
    await act(async () => root!.render(pane('request-preview')));
    expect(probe.selected.at(-1)).toBe('request-preview');
    await act(async () => root!.render(pane()));
    expect(probe.selected.at(-1)).toBe('stage-1');
    // The surface never saw the sentinel and was never remounted.
    expect(new Set(probe.surfaceCourses)).toEqual(new Set(['stage-1']));
    expect(probe.surfaceMounts).toBe(1);
  });
});
