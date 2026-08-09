import { describe, expect, it, vi } from 'vitest';
import { makeEditElementsTool } from '@/lib/agent/tools/edit-elements';
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

describe('edit_elements tool', () => {
  it('maps direct JSON Patch to validated style and content intents without a nested LLM call', async () => {
    const aiCall = vi.fn(async () => 'must not be called');
    const tool = makeEditElementsTool({
      aiCall,
      getSceneContext: (id) => (id === 's1' ? slideCtx('s1', [title]) : undefined),
    });
    const res = await tool.execute('call-1', {
      sceneId: 's1',
      reason: 'Update the title wording and color',
      patches: [
        { op: 'test', path: '/elements/0/id', value: 'title-1' },
        { op: 'replace', path: '/elements/0/content', value: '<p>New title</p>' },
        { op: 'replace', path: '/elements/0/defaultColor', value: '#0000ff' },
      ],
    });

    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(res.details).toMatchObject({
      sceneId: 's1',
      updateCount: 1,
      targetElementTypes: { 'title-1': 'text' },
      targetElementFingerprints: { 'title-1': expect.any(String) },
      inventoryFingerprint: expect.any(String),
    });
    expect(res.details.intents).toEqual([
      {
        type: 'element.update',
        id: 'title-1',
        props: { defaultColor: '#0000ff' },
      },
      {
        type: 'text.updateContent',
        id: 'title-1',
        content: '<p>New title</p>',
        target: 'text',
      },
    ]);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('refuses an unguarded element patch', async () => {
    const tool = makeEditElementsTool({
      aiCall: vi.fn(),
      getSceneContext: (id) => (id === 's1' ? slideCtx('s1', [title]) : undefined),
    });
    const res = await tool.execute('call-1', {
      sceneId: 's1',
      reason: 'Move the title',
      patches: [{ op: 'replace', path: '/elements/0/top', value: 40 }],
    });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.intents).toBeNull();
    expect(res.details.updateCount).toBe(0);
    expect((res.content[0] as { text?: string }).text).toMatch(/guarded/i);
  });

  it('refuses non-slide scenes', async () => {
    const tool = makeEditElementsTool({
      aiCall: vi.fn(),
      getSceneContext: () => ({
        outline: outline('i1', 'interactive'),
        allOutlines: [outline('i1', 'interactive')],
        content: { type: 'interactive', html: '<html></html>' } as unknown as SceneContent,
        stageId: 'stage-1',
      }),
    });
    const res = await tool.execute('call-1', {
      sceneId: 'i1',
      reason: 'Make it blue',
      patches: [{ op: 'test', path: '/elements/0/id', value: 'x' }],
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.intents).toBeNull();
  });

  it('refuses an empty patch array', async () => {
    const tool = makeEditElementsTool({
      aiCall: vi.fn(),
      getSceneContext: (id) => (id === 's1' ? slideCtx('s1', [title]) : undefined),
    });
    const res = await tool.execute('call-1', {
      sceneId: 's1',
      reason: 'No changes',
      patches: [],
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
