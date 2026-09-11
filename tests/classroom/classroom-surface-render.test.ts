// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentGoneError } from '@openmaic/storage';
import { useStageStore } from '@/lib/store';
import type { StageMetaResult } from '@/lib/classroom/stage-meta-client';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...props }, children),
}));

vi.mock('@/components/stage', () => ({
  Stage: () => createElement('div', { 'data-testid': 'stage-rendered' }, 'Stage'),
}));

vi.mock('@/lib/hooks/use-theme', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

const mockStop = vi.fn();
const mockGenerateRemaining = vi.fn();
const mockRetrySingleOutline = vi.fn();
vi.mock('@/lib/hooks/use-scene-generator', () => ({
  useSceneGenerator: () => ({
    generateRemaining: mockGenerateRemaining,
    retrySingleOutline: mockRetrySingleOutline,
    stop: mockStop,
  }),
}));

const mockFetchStageMeta = vi.fn<(...args: unknown[]) => Promise<StageMetaResult>>(() => {
  return Promise.resolve({ outcome: 'absent' });
});
vi.mock('@/lib/classroom/stage-meta-client', () => ({
  fetchStageMeta: (...args: unknown[]) => mockFetchStageMeta(...args),
}));

const mockRunClassroomLoad = vi.fn((..._args: unknown[]) => {
  return Promise.resolve();
});
vi.mock('@/lib/classroom/load-classroom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/classroom/load-classroom')>();
  return {
    ...actual,
    runClassroomLoad: (...args: unknown[]) => mockRunClassroomLoad(...args),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ClassroomSurface } from '@/components/classroom/ClassroomSurface';

describe('ClassroomSurface rendering for gone and never-existed courses', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useStageStore.setState({ stage: null, scenes: [], currentSceneId: null });
    mockFetchStageMeta.mockReset();
    mockRunClassroomLoad.mockReset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    root = null;
    container.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('variant="pane" renders not-found card immediately for gone course without spinning forever', async () => {
    mockRunClassroomLoad.mockRejectedValue(
      new DocumentGoneError('stage-deleted', '2026-03-01T00:00:00.000Z'),
    );
    mockFetchStageMeta.mockResolvedValue({
      outcome: 'gone',
      deletedAt: '2026-03-01T00:00:00.000Z',
    });

    await act(async () => {
      root?.render(
        createElement(ClassroomSurface, { classroomId: 'stage-deleted', variant: 'pane' }),
      );
    });

    const notFound = container.querySelector('[data-testid="classroom-not-found"]');
    expect(notFound).not.toBeNull();
    expect(container.textContent).toContain('classroom.notFound');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('variant="pane" renders not-found card after backoff exhausts for never-existed course without spinning forever', async () => {
    vi.useFakeTimers();
    mockRunClassroomLoad.mockResolvedValue(undefined);
    mockFetchStageMeta.mockResolvedValue({ outcome: 'absent' });

    await act(async () => {
      root?.render(createElement(ClassroomSurface, { classroomId: 'stage-404', variant: 'pane' }));
    });

    // Initially in backoff retry loop, loading spinner is rendered
    expect(container.querySelector('[data-testid="classroom-not-found"]')).toBeNull();
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    // Fast-forward through the availability backoff retry schedule: 1s, 2s, 4s, 8s, 16s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(32_000);
    });

    // After schedule exhausts, not-found should be visible and spinner unmounted
    const notFound = container.querySelector('[data-testid="classroom-not-found"]');
    expect(notFound).not.toBeNull();
    expect(container.textContent).toContain('classroom.notFound');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('variant="page" renders not-found card immediately for gone course', async () => {
    mockRunClassroomLoad.mockRejectedValue(
      new DocumentGoneError('stage-deleted', '2026-03-01T00:00:00.000Z'),
    );
    mockFetchStageMeta.mockResolvedValue({
      outcome: 'gone',
      deletedAt: '2026-03-01T00:00:00.000Z',
    });

    await act(async () => {
      root?.render(
        createElement(ClassroomSurface, { classroomId: 'stage-deleted', variant: 'page' }),
      );
    });

    const notFound = container.querySelector('[data-testid="classroom-not-found"]');
    expect(notFound).not.toBeNull();
    expect(container.textContent).toContain('classroom.notFound');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('variant="page" renders not-found card immediately for never-existed course without 31s delay', async () => {
    mockRunClassroomLoad.mockResolvedValue(undefined);
    mockFetchStageMeta.mockResolvedValue({ outcome: 'absent' });

    await act(async () => {
      root?.render(createElement(ClassroomSurface, { classroomId: 'stage-404', variant: 'page' }));
    });

    // Page variant does not schedule the 31s retry loop — should show notFound immediately!
    const notFound = container.querySelector('[data-testid="classroom-not-found"]');
    expect(notFound).not.toBeNull();
    expect(container.textContent).toContain('classroom.notFound');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});
