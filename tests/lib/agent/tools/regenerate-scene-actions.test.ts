import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/generation/generation-pipeline', () => ({
  generateSceneActions: vi.fn(async () => [{ type: 'speech', id: 'a1', title: 'hi', text: 'hi' }]),
}));

import {
  makeRegenerateSceneActionsTool,
  type SceneContext,
} from '@/lib/agent/tools/regenerate-scene-actions';
import { generateSceneActions } from '@/lib/generation/generation-pipeline';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement, Slide } from '@maic/dsl';

/** Minimal SceneOutline stub */
const stubOutline = (id: string, title: string, order = 1) => ({
  id,
  type: 'slide' as const,
  title,
  description: '',
  keyPoints: [],
  order,
});

/** Minimal SlideContent stub — runtime DSL shape with canvas wrapping elements */
const stubSlideContent: SlideContent = {
  type: 'slide',
  canvas: {
    id: 'slide1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    elements: [
      {
        id: 'el1',
        type: 'text',
        content: 'Hello',
        left: 0,
        top: 0,
        width: 100,
        height: 50,
      } as unknown as PPTElement,
    ],
    background: { type: 'solid', color: '#ffffff' },
  } as unknown as Slide,
};

/** Build a deps object with a single scene context entry */
function makeDeps(sceneId: string, extra?: Partial<SceneContext>) {
  const ctx: SceneContext = {
    outline: stubOutline(sceneId, 'T'),
    allOutlines: [stubOutline(sceneId, 'T')],
    content: stubSlideContent,
    stageId: 'stage1',
    ...extra,
  };
  return {
    aiCall: async () => '',
    getSceneContext: (id: string) => (id === sceneId ? ctx : undefined),
  };
}

const mockGen = vi.mocked(generateSceneActions);

describe('regenerate_scene_actions', () => {
  beforeEach(() => {
    mockGen.mockReset();
    mockGen.mockResolvedValue([{ type: 'speech', id: 'a1', title: 'hi', text: 'hi' } as never]);
  });

  it('returns regenerated actions for the scene in details', async () => {
    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    const res = await tool.execute('tc1', { sceneId: 's1' });
    expect(res.details).toMatchObject({ sceneId: 's1' });
    expect(Array.isArray((res.details as { actions: unknown[] }).actions)).toBe(true);
  });

  // ── Bug 1 regression: SlideContent shape conversion ──────────────────────────
  // The runtime scene stores SlideContent = { type:'slide', canvas: Slide }
  // but generateSceneActions expects GeneratedSlideContent = { elements, background? }.
  // Without conversion, 'elements' in content is false → returns [] immediately.
  it('converts SlideContent (runtime) to GeneratedSlideContent before calling the generator', async () => {
    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    await tool.execute('tc-shape', { sceneId: 's1' });

    expect(mockGen).toHaveBeenCalledOnce();
    const [, passedContent] = mockGen.mock.lastCall ?? [];
    // The generator must receive the flattened shape with 'elements' at top level
    expect(passedContent).toHaveProperty('elements');
    expect(Array.isArray((passedContent as { elements: unknown }).elements)).toBe(true);
    // Must NOT receive the raw canvas wrapper
    expect(passedContent).not.toHaveProperty('canvas');
    expect(passedContent).not.toHaveProperty('type');
  });

  it('includes the action count in the content text', async () => {
    const multiCtx: SceneContext = {
      outline: stubOutline('s2', 'Quiz', 2),
      allOutlines: [stubOutline('s1', 'T', 1), stubOutline('s2', 'Quiz', 2)],
      content: { type: 'quiz', questions: [] },
      stageId: 'stage1',
    };
    const deps = {
      aiCall: async () => '',
      getSceneContext: (id: string) => (id === 's2' ? multiCtx : undefined),
    };
    const tool = makeRegenerateSceneActionsTool(deps);
    const res = await tool.execute('tc2', { sceneId: 's2' });
    expect(res.content[0].type).toBe('text');
    expect((res.content[0] as { type: string; text: string }).text).toContain('1');
  });

  it('passes previousSpeeches to the generator', async () => {
    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    await tool.execute('tc3', { sceneId: 's1', previousSpeeches: ['hello'] });

    expect(mockGen).toHaveBeenCalledOnce();
    // Verify via the last call's options arg (4th positional param)
    const [, , , options] = mockGen.mock.lastCall ?? [];
    expect(options?.ctx?.previousSpeeches).toEqual(['hello']);
  });

  it('returns an error result when sceneId is not in the context map', async () => {
    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    const res = await tool.execute('tc4', { sceneId: 'unknown' });
    // Should return isError and empty actions, not throw
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.details as { actions: unknown[] }).actions).toHaveLength(0);
  });

  // ── Bug 1 & Bug 2: empty generation is surfaced as an error ──────────────────
  it('returns isError when generateSceneActions yields an empty array', async () => {
    mockGen.mockResolvedValueOnce([]);

    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    const res = await tool.execute('tc-empty', { sceneId: 's1' });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.details as { actions: unknown[] }).actions).toHaveLength(0);
    const text = (res.content[0] as { type: string; text: string }).text;
    expect(text).toMatch(/no actions|no action|0 action/i);
  });

  it('tool has expected metadata', () => {
    const tool = makeRegenerateSceneActionsTool(makeDeps('s1'));
    expect(tool.name).toBe('regenerate_scene_actions');
    expect(typeof tool.label).toBe('string');
    expect(typeof tool.description).toBe('string');
  });
});
