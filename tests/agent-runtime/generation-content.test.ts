import { describe, expect, it } from 'vitest';
import type { PPTElement, Slide } from '@openmaic/dsl';
import { toGenerationContent } from '@/lib/server/agent-runtime/generation-content';
import type { SlideContent } from '@/lib/types/stage';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

describe('toGenerationContent', () => {
  it('flattens runtime slide canvas content for action generation', () => {
    const content: SlideContent = {
      type: 'slide',
      canvas: {
        id: 'slide-1',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [{ id: 'element-1', type: 'text', content: 'Hello' } as unknown as PPTElement],
        background: { type: 'solid', color: '#ffffff' },
      } as unknown as Slide,
    };

    const result = toGenerationContent(content);

    expect(result).toMatchObject({
      elements: [{ id: 'element-1' }],
      background: { type: 'solid', color: '#ffffff' },
    });
    expect(result).not.toHaveProperty('canvas');
    expect(result).not.toHaveProperty('type');
  });

  it('normalizes legacy PBL content at the server-runtime boundary', () => {
    const content = structuredClone(legacyPBLSceneFixture.content);
    if (content.type !== 'pbl') throw new Error('expected PBL fixture');

    expect(toGenerationContent(content)).toHaveProperty('projectV2');
  });
});
