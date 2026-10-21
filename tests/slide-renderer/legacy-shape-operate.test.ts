// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShapePathFormulasKeys, type PPTShapeElement } from '@openmaic/dsl';
import { useCanvasStore } from '@/lib/store/canvas';
import { Operate } from '@/components/slide-renderer/Editor/Canvas/Operate';
import { MultiSelectOperate } from '@/components/slide-renderer/Editor/Canvas/Operate/MultiSelectOperate';

vi.mock('@/lib/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/store')>()),
  useSceneSelector: () => ({ elements: [] }),
}));

const shape: PPTShapeElement = {
  id: 'broken',
  type: 'shape',
  left: NaN,
  top: Infinity,
  width: 0,
  height: NaN,
  rotate: 25,
  path: 'M0 0 Z1 1',
  viewBox: [100, 100],
  fixedRatio: false,
  fill: '#fff',
  pathFormula: ShapePathFormulasKeys.ROUND_RECT,
  keypoints: [0.125],
  text: {
    content: '<p>Recovered</p>',
    align: 'middle',
    defaultColor: '#000',
    defaultFontName: 'Arial',
  },
};
let root: Root;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function operate(elementInfo: PPTShapeElement) {
  const host = document.createElement('div');
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(Operate, {
        elementInfo,
        isSelected: true,
        isActive: true,
        isActiveGroupElement: false,
        isMultiSelect: false,
        rotateElement: vi.fn(),
        scaleElement: vi.fn(),
        dragLineElement: vi.fn(),
        moveShapeKeypoint: vi.fn(),
        openLinkDialog: vi.fn(),
      }),
    ),
  );
  return host;
}

describe('legacy shape operation bounds', () => {
  beforeEach(() => useCanvasStore.setState({ canvasScale: 2 }));
  afterEach(() => act(() => root?.unmount()));

  it.each(['M0 0 Z1 1', 'M0 0 L100 100'])(
    'aligns selection and rotation with the recovered box and hides invalid resize controls: %s',
    (path) => {
      const host = operate({ ...shape, path });
      const frame = host.querySelector<HTMLElement>('.operate')!;
      expect(frame.style.left).toBe('0px');
      expect(frame.style.top).toBe('0px');
      expect(frame.style.transformOrigin).toBe('100px 100px');
      expect(host.querySelector<HTMLElement>('.operate-border-line')!.style.width).toBe('200px');
      expect(host.querySelector('.operate-resize-handler')).toBeNull();
      expect(host.querySelector('.operate-keypoint-handler')).toBeNull();
      expect(host.querySelector('.operate-rotate-handler')).not.toBeNull();
    },
  );

  it('keeps resize and path keypoints available for a writable shape', () => {
    const host = operate({
      ...shape,
      left: 10,
      top: 20,
      width: 200,
      height: 100,
      path: 'M0 0 L100 100',
    });
    expect(host.querySelector('.operate-resize-handler')).not.toBeNull();
    expect(host.querySelector('.operate-keypoint-handler')).not.toBeNull();
  });

  it('uses recovered bounds for a mixed selection and disables resizing invalid geometry', () => {
    const recovered = { ...shape, rotate: 0 };
    const other = {
      ...shape,
      id: 'good',
      left: 200,
      top: 150,
      width: 100,
      height: 50,
      rotate: 0,
      path: 'M0 0 L100 100',
    };
    useCanvasStore.setState({ activeElementIdList: ['broken', 'good'] });
    const host = document.createElement('div');
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(MultiSelectOperate, {
          elementList: [recovered, other],
          scaleMultiElement: vi.fn(),
        }),
      ),
    );
    expect(host.querySelector<HTMLElement>('.multi-select-operate')!.style.left).toBe('0px');
    expect(host.querySelector<HTMLElement>('.border-line')!.style.width).toBe('600px');
    expect(host.querySelector('.resize-handler')).toBeNull();
  });

  it('omits controls for a historical shape without a visible label', () => {
    expect(operate({ ...shape, text: undefined }).innerHTML).toBe('');
  });
});
