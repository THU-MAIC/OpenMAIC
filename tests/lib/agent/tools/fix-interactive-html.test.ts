import { describe, expect, it, vi } from 'vitest';
import { makeFixInteractiveHtmlTool } from '@/lib/agent/tools/fix-interactive-html';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';
import type { SceneContent } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const BROKEN =
  '<!DOCTYPE html><html><head></head><body><button id="go">Go</button></body></html>';
const FIXED =
  '<!DOCTYPE html><html><head></head><body><button id="go">Go</button>' +
  '<script>document.getElementById("go").addEventListener("click",()=>{});</script></body></html>';

function outline(id: string, type: SceneOutline['type']): SceneOutline {
  return {
    id,
    type,
    title: 'Widget',
    description: 'd',
    keyPoints: [],
    order: 0,
  } as unknown as SceneOutline;
}

function interactiveCtx(id: string, html?: string): SceneContext {
  return {
    outline: outline(id, 'interactive'),
    allOutlines: [outline(id, 'interactive')],
    content: {
      type: 'interactive',
      url: 'about:blank',
      html,
      widgetType: 'simulation',
    } as unknown as SceneContent,
    stageId: 'stage-1',
  };
}

function slideCtx(id: string): SceneContext {
  return {
    outline: outline(id, 'slide'),
    allOutlines: [outline(id, 'slide')],
    content: { type: 'slide', canvas: { elements: [] } } as unknown as SceneContent,
    stageId: 'stage-1',
  };
}

describe('fix_interactive_html tool', () => {
  it('fixes the interactive page and returns the fixed html', async () => {
    let seenUser = '';
    const aiCall = vi.fn(async (_system: string, user: string) => {
      seenUser = user;
      return FIXED;
    });
    const tool = makeFixInteractiveHtmlTool({
      aiCall,
      getSceneContext: (id) => (id === 'w1' ? interactiveCtx('w1', BROKEN) : undefined),
    });

    const res = await tool.execute('call-1', {
      sceneId: 'w1',
      bugDescription: 'the Go button does nothing',
    });

    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(res.details.sceneId).toBe('w1');
    expect(res.details.html).toContain('addEventListener');
    expect(seenUser).toContain('the Go button does nothing');
    expect(seenUser).toContain('<button id="go">Go</button>');
  });

  it('refuses a non-interactive scene', async () => {
    const aiCall = vi.fn(async () => FIXED);
    const tool = makeFixInteractiveHtmlTool({
      aiCall,
      getSceneContext: (id) => (id === 's1' ? slideCtx('s1') : undefined),
    });

    const res = await tool.execute('call-1', { sceneId: 's1', bugDescription: 'x' });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.html).toBeNull();
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('refuses an interactive scene with no embedded html', async () => {
    const aiCall = vi.fn(async () => FIXED);
    const tool = makeFixInteractiveHtmlTool({
      aiCall,
      getSceneContext: (id) => (id === 'w2' ? interactiveCtx('w2', undefined) : undefined),
    });

    const res = await tool.execute('call-1', { sceneId: 'w2', bugDescription: 'x' });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.html).toBeNull();
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('errors when the scene context is missing', async () => {
    const aiCall = vi.fn(async () => FIXED);
    const tool = makeFixInteractiveHtmlTool({
      aiCall,
      getSceneContext: () => undefined,
    });

    const res = await tool.execute('call-1', { sceneId: 'nope', bugDescription: 'x' });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.html).toBeNull();
  });
});
