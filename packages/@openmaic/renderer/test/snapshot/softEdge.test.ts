import { afterEach, expect, it, vi } from 'vitest';
import { bakeImageSoftEdge } from '../../src/snapshot/bakeImageSoftEdge';

afterEach(() => vi.unstubAllGlobals());
it.each([
  [400, 100],
  [100, 400],
  [200, 200],
])(
  'preserves CSS feather width for an intrinsic square displayed at %sx%s',
  async (width, height) => {
    const gradients: number[][] = [];
    const ctx = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      createLinearGradient: () => {
        const stops: number[] = [];
        gradients.push(stops);
        return { addColorStop: (offset: number) => stops.push(offset) };
      },
    };
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => ctx,
        toDataURL: () => 'data:image/png;base64,test',
      }),
    });
    let loaded: (() => void) | undefined;
    const img = {
      dataset: { softEdge: '10' },
      complete: true,
      naturalWidth: 1000,
      naturalHeight: 1000,
      offsetWidth: width,
      offsetHeight: height,
      style: {},
      removeAttribute: vi.fn(),
      addEventListener: (event: string, cb: () => void) => {
        if (event === 'load') loaded = cb;
      },
      set src(_value: string) {
        loaded?.();
      },
    };
    await bakeImageSoftEdge(img as unknown as HTMLImageElement);
    expect(gradients[0][1] * width).toBeCloseTo(10);
    expect(gradients[1][1] * height).toBeCloseTo(10);
  },
);
