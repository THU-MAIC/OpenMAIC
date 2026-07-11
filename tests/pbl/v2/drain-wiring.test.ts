import { afterEach, describe, expect, it, vi } from 'vitest';

const { drainProjectRuntimeMock } = vi.hoisted(() => ({
  drainProjectRuntimeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/pbl/v2/runtime/drain', () => ({
  drainProjectRuntime: (...args: unknown[]) => drainProjectRuntimeMock(...args),
}));

import { installPblDrainOnSave } from '@/lib/pbl/v2/runtime/drain-wiring';
import { emitStageSaved } from '@/lib/store/stage-save-signal';

const uninstallers: Array<() => void> = [];

function install(): () => void {
  const uninstall = installPblDrainOnSave();
  uninstallers.push(uninstall);
  return uninstall;
}

afterEach(() => {
  for (const uninstall of new Set(uninstallers)) {
    uninstall();
  }
  uninstallers.length = 0;
  drainProjectRuntimeMock.mockReset();
  drainProjectRuntimeMock.mockResolvedValue(undefined);
});

describe('installPblDrainOnSave', () => {
  it('drains the persisted PBL payload without any mounted renderer', () => {
    const projectA = { title: 'Persisted A' };
    const projectB = { title: 'Persisted B' };
    drainProjectRuntimeMock.mockRejectedValueOnce(new Error('first drain failed'));
    install();

    emitStageSaved({
      stageId: 'stage-1',
      pblScenes: [
        { sceneId: 'scene-a', project: projectA },
        { sceneId: 'scene-b', project: projectB },
      ],
    });

    expect(drainProjectRuntimeMock).toHaveBeenCalledTimes(2);
    expect(drainProjectRuntimeMock).toHaveBeenNthCalledWith(1, {
      stageId: 'stage-1',
      sceneId: 'scene-a',
      project: projectA,
    });
    expect(drainProjectRuntimeMock).toHaveBeenNthCalledWith(2, {
      stageId: 'stage-1',
      sceneId: 'scene-b',
      project: projectB,
    });
  });

  it('uses one save-signal subscription for repeated installs', () => {
    const firstUninstall = install();
    const secondUninstall = install();
    expect(secondUninstall).toBe(firstUninstall);

    emitStageSaved({
      stageId: 'stage-1',
      pblScenes: [{ sceneId: 'scene-a', project: { title: 'Persisted A' } }],
    });

    expect(drainProjectRuntimeMock).toHaveBeenCalledTimes(1);

    firstUninstall();
    drainProjectRuntimeMock.mockClear();
    emitStageSaved({
      stageId: 'stage-1',
      pblScenes: [{ sceneId: 'scene-b', project: { title: 'Persisted B' } }],
    });

    expect(drainProjectRuntimeMock).not.toHaveBeenCalled();
  });
});
