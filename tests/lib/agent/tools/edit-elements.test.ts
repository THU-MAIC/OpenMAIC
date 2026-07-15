import { describe, expect, it, vi } from 'vitest';
import { makeEditElementsTool, parseProposedUpdates } from '@/lib/agent/tools/edit-elements';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';
import type { SceneContent } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import type { PPTElement } from '@openmaic/dsl';

function outline(id: string, type: SceneOutline['type']): SceneOutline {
  return {
    id,
    type,
    title: 'Slide',
    description: 'd',
    keyPoints: [],
    order: 0,
  } as unknown as SceneOutline;
}

function slideCtx(id: string, elements: PPTElement[]): SceneContext {
  return {
    outline: outline(id, 'slide'),
    allOutlines: [outline(id, 'slide')],
    content: {
      type: 'slide',
      canvas: { id: 'c1', elements, viewportSize: 1000, viewportRatio: 0.5625 },
    } as unknown as SceneContent,
    stageId: 'stage-1',
  };
}

const title = {
  id: 'title-1',
  type: 'text',
  left: 100,
  top: 80,
  width: 400,
  height: 60,
  rotate: 0,
  content: '<p>Title</p>',
  defaultFontName: 'Arial',
  defaultColor: '#333333',
} as unknown as PPTElement;

describe('parseProposedUpdates', () => {
  it('parses fenced JSON updates', () => {
    const raw = '```json\n{"updates":[{"id":"title-1","props":{"top":40}}]}\n```';
    expect(parseProposedUpdates(raw)).toEqual([{ id: 'title-1', props: { top: 40 } }]);
  });

  it('throws on model refuse', () => {
    expect(() => parseProposedUpdates('{"refuse":"cannot change text content"}')).toThrow(
      /cannot change text content/,
    );
  });
});

describe('edit_elements tool', () => {
  it('returns validated intents for a color+position instruction', async () => {
    const aiCall = vi.fn(async () =>
      JSON.stringify({
        updates: [{ id: 'title-1', props: { defaultColor: '#0000ff', top: 40 } }],
      }),
    );
    const tool = makeEditElementsTool({
      aiCall,
      getSceneContext: (id) => (id === 's1' ? slideCtx('s1', [title]) : undefined),
      getSelection: () => ['title-1'],
    });
    const res = await tool.execute('call-1', {
      sceneId: 's1',
      instruction: 'make the title blue and move it up',
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(res.details.sceneId).toBe('s1');
    expect(res.details.updateCount).toBe(1);
    expect(res.details.targetElementTypes).toEqual({ 'title-1': 'text' });
    expect(res.details.targetElementFingerprints?.['title-1']).toEqual(expect.any(String));
    expect(res.details.inventoryFingerprint).toEqual(expect.any(String));
    expect(res.details.intents).toEqual([
      {
        type: 'element.update',
        id: 'title-1',
        props: { defaultColor: '#0000ff', top: 40 },
      },
    ]);
    expect(aiCall).toHaveBeenCalledOnce();
    const [, system] = aiCall.mock.calls[0] as unknown as [unknown, string, string];
    expect(system).toContain('Use defaultColor for text color');
    expect(system).toContain('Use fill for shape body color');
    expect(system).toContain('Use defaultColor for shape labels');
  });

  it('filters selection ids to the target slide inventory before prompting', async () => {
    const aiCall = vi.fn(async () =>
      JSON.stringify({
        updates: [{ id: 'title-1', props: { top: 40 } }],
      }),
    );
    const tool = makeEditElementsTool({
      aiCall,
      getSceneContext: (id) => (id === 's1' ? slideCtx('s1', [title]) : undefined),
      getSelection: () => ['title-1', 'other-scene-id'],
    });
    await tool.execute('call-1', {
      sceneId: 's1',
      instruction: 'move this up',
    });

    const [, , user] = aiCall.mock.calls[0] as unknown as [unknown, string, string];
    expect(user).toContain('Current selection');
    expect(user).toContain('title-1');
    expect(user).not.toContain('other-scene-id');
  });

  it('refuses unknown ids from the model (no intents)', async () => {
    const tool = makeEditElementsTool({
      aiCall: async () => JSON.stringify({ updates: [{ id: 'ghost', props: { top: 1 } }] }),
      getSceneContext: (id) => (id === 's1' ? slideCtx('s1', [title]) : undefined),
    });
    const res = await tool.execute('call-1', {
      sceneId: 's1',
      instruction: 'move the ghost',
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.intents).toBeNull();
    expect(res.details.updateCount).toBe(0);
    expect((res.content[0] as { text?: string }).text).toMatch(/unknown element id/i);
  });

  it('refuses non-slide scenes', async () => {
    const tool = makeEditElementsTool({
      aiCall: async () => '',
      getSceneContext: () => ({
        outline: outline('i1', 'interactive'),
        allOutlines: [outline('i1', 'interactive')],
        content: { type: 'interactive', html: '<html></html>' } as unknown as SceneContent,
        stageId: 'stage-1',
      }),
    });
    const res = await tool.execute('call-1', {
      sceneId: 'i1',
      instruction: 'make it blue',
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.intents).toBeNull();
  });

  it('refuses empty instruction', async () => {
    const tool = makeEditElementsTool({
      aiCall: async () => '',
      getSceneContext: (id) => (id === 's1' ? slideCtx('s1', [title]) : undefined),
    });
    const res = await tool.execute('call-1', { sceneId: 's1', instruction: '  ' });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
