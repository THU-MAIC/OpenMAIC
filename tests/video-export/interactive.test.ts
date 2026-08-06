import { describe, expect, it } from 'vitest';
import { compileVideoTimeline, VideoTimelineSchema } from '@/lib/video-export';
import { NO_ASSETS, NO_PROBE, interactive, stubInteractiveHtml } from './helpers';

describe('compileVideoTimeline — static interactive HTML', () => {
  it('promotes prepared HTML to a supported base and plans its asset', () => {
    const ir = compileVideoTimeline(
      {
        stage: { id: 'stage', name: 'Interactive' },
        scenes: [interactive('widget', '<!doctype html><h1>Widget</h1>')],
      },
      {
        timing: NO_PROBE,
        assets: NO_ASSETS,
        interactive: stubInteractiveHtml({
          widget: {
            id: 'interactive:widget',
            present: true,
            contentHash: 'a'.repeat(64),
          },
        }),
      },
    );

    expect(() => VideoTimelineSchema.parse(ir)).not.toThrow();
    expect(ir.scenes[0]).toMatchObject({
      supported: true,
      base: {
        kind: 'interactive-html',
        assetId: 'interactive:widget',
        assetRef: 'interactive/001-widget.html',
        contentHash: 'a'.repeat(64),
        readyTimeoutMs: 8000,
        settleMs: 250,
      },
    });
    expect(ir.assets.entries).toContainEqual({
      assetId: 'interactive:widget',
      kind: 'html',
      path: 'interactive/001-widget.html',
      present: true,
    });
    expect(ir.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'interactive-static-html', sceneId: 'widget' }),
    );
    expect(ir.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'unsupported-scene', sceneId: 'widget' }),
    );
  });

  it('uses the existing placeholder for missing embedded HTML', () => {
    const ir = compileVideoTimeline(
      {
        stage: { id: 'stage', name: 'Interactive' },
        scenes: [interactive('missing', '')],
      },
      { timing: NO_PROBE, assets: NO_ASSETS },
    );

    expect(ir.scenes[0]).toMatchObject({
      supported: false,
      base: { kind: 'placeholder', reason: expect.stringContaining('missing') },
    });
    expect(ir.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'missing-interactive-html', sceneId: 'missing' }),
    );
  });

  it('surfaces unresolved resources and falls back without failing compile', () => {
    const ir = compileVideoTimeline(
      {
        stage: { id: 'stage', name: 'Interactive' },
        scenes: [interactive('remote', '<img src="https://example.test/a.png">')],
      },
      {
        timing: NO_PROBE,
        assets: NO_ASSETS,
        interactive: stubInteractiveHtml({
          remote: {
            id: 'interactive:remote',
            present: false,
            failure: 'unresolved-resource',
            message: 'Interactive HTML has unresolved resources: https://example.test/a.png.',
          },
        }),
      },
    );

    expect(ir.scenes[0].base).toMatchObject({
      kind: 'placeholder',
      reason: expect.stringContaining('unresolved resources'),
    });
    expect(ir.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unresolved-interactive-resource', sceneId: 'remote' }),
    );
  });
});
