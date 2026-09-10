import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/**
 * The legacy editor canvas must render its box from the viewport hook's LOCAL
 * fit scale, never from the shared global `canvasScale` in the canvas store:
 * sibling canvases (crossfade-exiting panes, keep-alive course tabs) write the
 * global value, so a canvas that reads it can stick at a scale computed for
 * another container — the slide then renders mis-sized (overflowing the 16:9
 * card, or under-filling it) until a seam drag forces a re-measure. The hook
 * publishes the local value and the store write is kept for out-of-tree
 * consumers, matching the reference.
 */
describe('canvas fit-scale wiring', () => {
  it('renders the legacy editor canvas from the local fitScale', () => {
    const canvas = source('components/slide-renderer/Editor/Canvas/index.tsx');
    expect(canvas).toContain('fitScale');
    expect(canvas).toContain('const canvasScale = fitScale;');
    expect(canvas).not.toContain('useCanvasStore.use.canvasScale()');
  });

  it('publishes a local fitScale from the viewport hook', () => {
    const hook = source('components/slide-renderer/Editor/Canvas/hooks/useViewportSize.ts');
    expect(hook).toContain('const [fitScale, setFitScale] = useState(() =>');
    expect(hook).toContain('setFitScale(nextScale)');
    expect(hook).toContain('fitScale,');
  });
});
