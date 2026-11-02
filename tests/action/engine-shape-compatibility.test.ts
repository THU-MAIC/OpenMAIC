import { describe, expect, it, vi } from 'vitest';
import type { StageStore } from '@/lib/api/stage-api';
import type { Action } from '@/lib/types/action';
import { ActionEngine } from '@/lib/action/engine';
const mocks = vi.hoisted(() => ({ get: vi.fn(), addElement: vi.fn(), setWhiteboardOpen: vi.fn() }));
vi.mock('@/lib/api/stage-api', () => ({
  createStageAPI: () => ({ whiteboard: { get: mocks.get, addElement: mocks.addElement } }),
}));
vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    getState: () => ({ whiteboardOpen: false, setWhiteboardOpen: mocks.setWhiteboardOpen }),
  },
}));

describe('Legacy ActionEngine shape compatibility', () => {
  it.each([
    { shape: 'custom', path: 'M0 0 L4 0 L0 3 Z', viewBox: [4, 3] },
    { shape: 'rectangle', rotate: 30 },
    { shape: 'rectangle', stroke: { color: '#111', width: 2 } },
    { shape: 'unknown' },
    { shape: 'rectangle', expectedLastSeq: null },
  ])('rejects unsupported shape $shape before opening or creating a board', async (params) => {
    const engine = new ActionEngine({} as StageStore);
    // Deliberately cross the wire-version boundary, bypassing the persisted Action type.
    const action = {
      id: 'legacy',
      type: 'wb_draw_shape',
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      ...params,
    } as unknown as Action;
    await expect(engine.execute(action, { silent: true })).rejects.toThrow('Legacy wb_draw_shape');
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.addElement).not.toHaveBeenCalled();
    expect(mocks.setWhiteboardOpen).not.toHaveBeenCalled();
    engine.dispose();
  });
});
