import { describe, expect, it } from 'vitest';
import { prepareInteractiveHtmlScenes } from '@/lib/video-export-app/prepare-interactive-html';
import type { Scene } from '@/lib/types/stage';

function scene(html?: string): Scene {
  return {
    id: 'widget',
    stageId: 'stage',
    title: 'Widget',
    order: 0,
    type: 'interactive',
    content: { type: 'interactive', url: '', html },
    actions: [],
  } as Scene;
}

describe('prepareInteractiveHtmlScenes', () => {
  it('produces a bounded packaged page with CSP, iframe shims, and freeze runtime', async () => {
    const prepared = await prepareInteractiveHtmlScenes([
      scene('<!doctype html><html><head></head><body><h1>Ready</h1></body></html>'),
    ]);
    const meta = prepared.html(scene());
    const html = prepared.content('interactive:widget');

    expect(meta).toMatchObject({
      id: 'interactive:widget',
      present: true,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(html).toContain('data-openmaic-static-csp');
    expect(html).toContain('data-iframe-storage-shim');
    expect(html).toContain('data-iframe-error-shim');
    expect(html).toContain('data-openmaic-static-capture');
    expect(html).toContain(
      "document.documentElement.setAttribute('data-openmaic-static-state', 'frozen')",
    );
    expect(html).toContain("connect-src 'none'");
  });

  it('inlines supported remote assets and removes the network URL', async () => {
    const prepared = await prepareInteractiveHtmlScenes(
      [scene('<html><head></head><body><img src="https://cdn.test/pixel.png"></body></html>')],
      {
        fetcher: async (url) =>
          url === 'https://cdn.test/pixel.png'
            ? { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }
            : null,
      },
    );

    expect(prepared.html(scene())?.present).toBe(true);
    expect(prepared.content('interactive:widget')).toContain('src="data:image/png;base64,');
    expect(prepared.content('interactive:widget')).not.toContain('https://cdn.test/pixel.png');
  });

  it('rejects unresolved remote or relative resources with an explicit failure', async () => {
    const remote = await prepareInteractiveHtmlScenes(
      [scene('<img src="https://cdn.test/missing.png">')],
      { fetcher: async () => null },
    );
    expect(remote.html(scene())).toMatchObject({
      present: false,
      failure: 'unresolved-resource',
      message: expect.stringContaining('https://cdn.test/missing.png'),
    });
    expect(remote.content('interactive:widget')).toBeUndefined();

    const relative = await prepareInteractiveHtmlScenes([
      scene('<script src="./app.js"></script>'),
    ]);
    expect(relative.html(scene())).toMatchObject({
      present: false,
      failure: 'unresolved-resource',
      message: expect.stringContaining('./app.js'),
    });
  });

  it('rejects a page whose packaged bytes exceed the configured cap', async () => {
    const prepared = await prepareInteractiveHtmlScenes([scene('<p>large</p>')], {
      maxHtmlBytes: 32,
    });

    expect(prepared.html(scene())).toMatchObject({
      present: false,
      failure: 'too-large',
      message: expect.stringContaining('/32'),
    });
  });

  it('records missing embedded HTML without throwing', async () => {
    const prepared = await prepareInteractiveHtmlScenes([scene('')]);
    expect(prepared.html(scene())).toMatchObject({
      present: false,
      failure: 'missing-html',
    });
  });

  it('removes KaTeX about:invalid font fallbacks from the packaged page', async () => {
    const prepared = await prepareInteractiveHtmlScenes([
      scene('<style>@font-face{src:url(about:invalid) format("woff")}</style>'),
    ]);

    expect(prepared.html(scene())).toMatchObject({ present: true });
    expect(prepared.content('interactive:widget')).not.toContain('about:invalid');
  });
});
