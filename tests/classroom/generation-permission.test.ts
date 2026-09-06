/**
 * The retry affordances spend the same budget the resume effect does, so they
 * answer to the same permission. These tests cover the shared predicate, the
 * withdrawal of the retry affordance from a resolution, and the refusal inside
 * the function that affordance calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serverBacked: vi.fn(),
  settings: vi.fn(),
  mediaDelete: vi.fn(),
}));

vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settings },
}));

vi.mock('@/lib/utils/database', () => ({
  mediaFileKey: (stageId: string, ref: string) => `${stageId}:${ref}`,
  db: { mediaFiles: { put: vi.fn(), delete: mocks.mediaDelete } },
}));

import {
  mayGenerateForStage,
  noteStageGenerationOwnership,
  resetGenerationPermissionsForTests,
} from '@/lib/classroom/generation-permission';
import { withGenerationPermission } from '@/lib/media/resolve-media-ref';
import { retryMediaTask } from '@/lib/media/media-orchestrator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';

const stageId = 'permission-stage';

describe('shared generation permission', () => {
  beforeEach(() => {
    resetGenerationPermissionsForTests();
    mocks.serverBacked.mockReset().mockReturnValue(true);
  });

  it('refuses a course nobody has recorded an answer for', () => {
    expect(mayGenerateForStage(stageId)).toBe(false);
  });

  it('refuses a course with no id at all', () => {
    expect(mayGenerateForStage(undefined)).toBe(false);
  });

  it('answers per course, so one course cannot speak for another', () => {
    noteStageGenerationOwnership(stageId, 'owner');
    expect(mayGenerateForStage(stageId)).toBe(true);
    expect(mayGenerateForStage('another-stage')).toBe(false);
  });

  it.each(['not-owner', 'ownerless', 'unresolved'] as const)('refuses %s', (ownership) => {
    noteStageGenerationOwnership(stageId, ownership);
    expect(mayGenerateForStage(stageId)).toBe(false);
  });

  it('permits everything in browser-only mode', () => {
    mocks.serverBacked.mockReturnValue(false);
    noteStageGenerationOwnership(stageId, 'not-owner');
    expect(mayGenerateForStage(stageId)).toBe(true);
  });
});

describe('withdrawing the retry affordance', () => {
  it('clears retryability from a failed resolution', () => {
    expect(withGenerationPermission({ kind: 'failed', retryable: true }, false)).toEqual({
      kind: 'failed',
      retryable: false,
    });
  });

  it('clears retryability from a last-known-bytes resolution', () => {
    expect(
      withGenerationPermission({ kind: 'url', url: 'blob:x', retryable: true }, false),
    ).toEqual({ kind: 'url', url: 'blob:x', retryable: false });
  });

  it('leaves the resolution untouched when generation is permitted', () => {
    const state = { kind: 'failed', retryable: true } as const;
    expect(withGenerationPermission(state, true)).toBe(state);
  });

  it('leaves a resolution with no retry affordance untouched', () => {
    const state = { kind: 'pending' } as const;
    expect(withGenerationPermission(state, false)).toBe(state);
  });
});

describe('retryMediaTask honours the same permission', () => {
  beforeEach(() => {
    resetGenerationPermissionsForTests();
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.mediaDelete.mockReset().mockResolvedValue(undefined);
    mocks.settings.mockReset().mockReturnValue({
      imageGenerationEnabled: true,
      videoGenerationEnabled: true,
      imageProviderId: 'p',
      imageModelId: 'm',
      imageProvidersConfig: {},
      videoProviderId: 'p',
      videoModelId: 'm',
      videoProvidersConfig: {},
    });
    useMediaGenerationStore.setState({
      tasks: {
        gen_img_x: {
          elementId: 'gen_img_x',
          type: 'image',
          status: 'failed',
          prompt: 'A diagram',
          params: {},
          error: 'transient',
          retryCount: 0,
          stageId,
        },
      },
    });
  });

  it('does not touch the task or its cache row for a viewer', async () => {
    await retryMediaTask('gen_img_x');

    expect(mocks.mediaDelete).not.toHaveBeenCalled();
    expect(useMediaGenerationStore.getState().tasks.gen_img_x?.status).toBe('failed');
  });

  it('proceeds once the sidecar names this viewer the owner', async () => {
    noteStageGenerationOwnership(stageId, 'owner');
    const fetchMock = vi.fn().mockRejectedValue(new Error('provider unreachable'));
    vi.stubGlobal('fetch', fetchMock);

    await retryMediaTask('gen_img_x');

    expect(mocks.mediaDelete).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
