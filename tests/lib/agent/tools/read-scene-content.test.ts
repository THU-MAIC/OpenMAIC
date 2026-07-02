import { describe, expect, it } from 'vitest';

import { makeReadSceneContentTool } from '@/lib/agent/tools/read-scene-content';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';
import type { SceneOutline } from '@/lib/types/generation';
import type { SceneContent } from '@/lib/types/stage';

function slideOutline(id: string, title: string): SceneOutline {
  return { id, type: 'slide', title, description: 'd', keyPoints: ['a', 'b'], order: 0 };
}

function slideContent(): SceneContent {
  return {
    type: 'slide',
    canvas: {
      id: 'cv',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [
        {
          id: 'text_1',
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          content: '<p>READ-CONTENT-SENTINEL</p>',
          defaultFontName: '',
          defaultColor: '#000',
          rotate: 0,
        },
        {
          id: 'shape_1',
          type: 'shape',
          left: 0,
          top: 50,
          width: 100,
          height: 40,
          viewBox: [200, 200],
          path: 'M 0 0',
          fixedRatio: false,
          fill: '#fff',
          rotate: 0,
          text: {
            content: '<p>SHAPE-TEXT-SENTINEL</p>',
            defaultFontName: '',
            defaultColor: '#000',
            align: 'middle',
          },
        },
        {
          id: 'table_1',
          type: 'table',
          left: 0,
          top: 100,
          width: 200,
          height: 80,
          rotate: 0,
          outline: { width: 1, style: 'solid', color: '#000' },
          colWidths: [0.5, 0.5],
          cellMinHeight: 20,
          data: [
            [
              { id: 'c1', colspan: 1, rowspan: 1, text: 'TABLE-CELL-SENTINEL' },
              { id: 'c2', colspan: 1, rowspan: 1, text: 'B2' },
            ],
          ],
        },
        {
          id: 'code_1',
          type: 'code',
          left: 0,
          top: 200,
          width: 200,
          height: 80,
          rotate: 0,
          language: 'python',
          lines: [
            { id: 'L1', content: 'print("CODE-SENTINEL")' },
            { id: 'L2', content: 'x = 1' },
          ],
        },
      ],
    },
  } as unknown as SceneContent;
}

function ctxFor(id: string): SceneContext {
  return {
    outline: slideOutline(id, 'Scene Title'),
    allOutlines: [slideOutline(id, 'Scene Title')],
    content: slideContent(),
    stageId: 'stage-1',
  };
}

describe('read_scene_content tool', () => {
  it('returns the trusted scene projection for a known sceneId', async () => {
    const tool = makeReadSceneContentTool({
      getSceneContext: (id) => (id === 's1' ? ctxFor('s1') : undefined),
    });
    const res = await tool.execute('call-1', { sceneId: 's1' });

    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(res.details.sceneId).toBe('s1');
    expect(res.details.title).toBe('Scene Title');
    expect(res.details.type).toBe('slide');
    // details is compact metadata only — the raw content object must NOT be
    // echoed back (it streams megabytes for base64 images and is never consumed
    // by the client apply path).
    expect((res.details as unknown as Record<string, unknown>).content).toBeUndefined();
    expect(JSON.stringify(res.details)).not.toContain('READ-CONTENT-SENTINEL');
  });

  it('puts a content projection (element text snippet) in the model-visible text', async () => {
    const tool = makeReadSceneContentTool({
      getSceneContext: (id) => (id === 's1' ? ctxFor('s1') : undefined),
    });
    const res = await tool.execute('call-1', { sceneId: 's1' });

    // The model only sees content[].text, not details — the projection must be there.
    const text = res.content.map((p) => (p as { text?: string }).text ?? '').join('\n');
    expect(text).toContain('READ-CONTENT-SENTINEL');
  });

  it('extracts text from shape / table / code elements (not just bare type)', async () => {
    const tool = makeReadSceneContentTool({
      getSceneContext: (id) => (id === 's1' ? ctxFor('s1') : undefined),
    });
    const res = await tool.execute('call-1', { sceneId: 's1' });

    const text = res.content.map((p) => (p as { text?: string }).text ?? '').join('\n');
    // shape-text content surfaced (not a bare "- shape").
    expect(text).toContain('SHAPE-TEXT-SENTINEL');
    expect(text).not.toMatch(/^- shape$/m);
    // table cell text surfaced.
    expect(text).toContain('TABLE-CELL-SENTINEL');
    expect(text).not.toMatch(/^- table$/m);
    // code line content surfaced.
    expect(text).toContain('CODE-SENTINEL');
    expect(text).not.toMatch(/^- code$/m);
  });

  it('defaults to the active scene when sceneId is omitted', async () => {
    const tool = makeReadSceneContentTool({
      getSceneContext: (id) => (id === 's1' ? ctxFor('s1') : undefined),
      activeSceneId: 's1',
    });
    const res = await tool.execute('call-1', {});

    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(res.details.sceneId).toBe('s1');
  });

  it('errors when the scene context is missing', async () => {
    const tool = makeReadSceneContentTool({ getSceneContext: () => undefined });
    const res = await tool.execute('call-1', { sceneId: 'nope' });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it('reads non-slide scenes too (read is safe for all types)', async () => {
    const quizCtx: SceneContext = {
      outline: { id: 'q1', type: 'quiz', title: 'Quiz', description: '', keyPoints: [], order: 1 },
      allOutlines: [],
      content: { type: 'quiz', questions: [] } as unknown as SceneContent,
      stageId: 'stage-1',
    };
    const tool = makeReadSceneContentTool({ getSceneContext: () => quizCtx });
    const res = await tool.execute('call-1', { sceneId: 'q1' });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(res.details.type).toBe('quiz');
  });
});
