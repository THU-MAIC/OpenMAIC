import { describe, expect, it } from 'vitest';
import { makeEditInteractiveHtmlTool } from '@/lib/agent/tools/edit-interactive-html';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';
import type { SceneContent } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const BROKEN =
  '<!DOCTYPE html><html><head></head><body><button id="go">Go</button>' +
  '<script>document.getElementById("strt").addEventListener("click",fn);</script></body></html>';

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

const deps = (ctx: (id: string) => SceneContext | undefined) => ({
  aiCall: async () => '',
  getSceneContext: ctx,
});

describe('edit_interactive_html tool', () => {
  it('applies str_replace edits and returns the new html', async () => {
    const tool = makeEditInteractiveHtmlTool(
      deps((id) => (id === 'w1' ? interactiveCtx('w1', BROKEN) : undefined)),
    );
    const res = await tool.execute('call-1', {
      sceneId: 'w1',
      edits: [{ oldText: 'getElementById("strt")', newText: 'getElementById("go")' }],
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(res.details.sceneId).toBe('w1');
    expect(res.details.editCount).toBe(1);
    expect(res.details.html).toContain('getElementById("go").addEventListener');
    expect(res.details.html).not.toContain('strt');
  });

  it('errors (no apply) when an edit cannot be anchored', async () => {
    const tool = makeEditInteractiveHtmlTool(
      deps((id) => (id === 'w1' ? interactiveCtx('w1', BROKEN) : undefined)),
    );
    const res = await tool.execute('call-1', {
      sceneId: 'w1',
      edits: [{ oldText: 'this text is not in the page', newText: 'x' }],
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.html).toBeNull();
    expect(res.details.editCount).toBe(0);
    expect((res.content[0] as { text?: string }).text).toMatch(/could not find/i);
  });

  it('refuses a non-interactive scene', async () => {
    const tool = makeEditInteractiveHtmlTool(
      deps((id) => (id === 's1' ? slideCtx('s1') : undefined)),
    );
    const res = await tool.execute('call-1', {
      sceneId: 's1',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.html).toBeNull();
  });

  it('refuses an interactive scene with no embedded html', async () => {
    const tool = makeEditInteractiveHtmlTool(
      deps((id) => (id === 'w2' ? interactiveCtx('w2', undefined) : undefined)),
    );
    const res = await tool.execute('call-1', {
      sceneId: 'w2',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.html).toBeNull();
  });

  it('errors when the scene context is missing', async () => {
    const tool = makeEditInteractiveHtmlTool(deps(() => undefined));
    const res = await tool.execute('call-1', {
      sceneId: 'nope',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(res.details.html).toBeNull();
  });
});
