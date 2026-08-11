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
    expect(html).toContain("worker-src 'none'");
    expect(html).toContain('interactive-worker-disabled');
  });

  it('keeps the doctype first when authored HTML omits an explicit head', async () => {
    const prepared = await prepareInteractiveHtmlScenes([
      scene('<!doctype html><html><body><h1>Standards mode</h1></body></html>'),
    ]);
    const html = prepared.content('interactive:widget')!;

    expect(html.toLowerCase().startsWith('<!doctype html><html><head>')).toBe(true);
    expect(html.indexOf('data-openmaic-static-csp')).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('<body>'));
  });

  it('does not inject into head-like text in comments or authored scripts', async () => {
    const authoredScript = 'const template = "<head>"; window.__template = template;';
    const prepared = await prepareInteractiveHtmlScenes([
      scene(
        `<!doctype html><!-- <head> --><html><body><script>${authoredScript}</script></body></html>`,
      ),
    ]);
    const html = prepared.content('interactive:widget')!;

    expect(prepared.html(scene())?.present).toBe(true);
    expect(html).toContain(`<script>${authoredScript}</script>`);
    expect(html.indexOf('data-openmaic-static-csp')).toBeLessThan(html.indexOf('<body>'));
  });

  it('ignores embedded-document markup inside authored script text', async () => {
    const authoredScript =
      'const template = `<iframe src="data:text/html,example"></iframe>`; window.__template = template;';
    const prepared = await prepareInteractiveHtmlScenes([
      scene(`<script>${authoredScript}</script><main>Ready</main>`),
    ]);

    expect(prepared.html(scene())).toMatchObject({ present: true });
    expect(prepared.content('interactive:widget')).toContain(`<script>${authoredScript}</script>`);
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

  it('accepts bare module imports resolved by the final offline import map', async () => {
    const prepared = await prepareInteractiveHtmlScenes(
      [
        scene(
          '<script type="importmap">{"imports":{"dep":"https://cdn.test/dep.js"}}</script>' +
            '<script type="module">import { value } from "dep"; window.__value = value;</script>',
        ),
      ],
      {
        fetcher: async (url) =>
          url === 'https://cdn.test/dep.js'
            ? {
                bytes: new TextEncoder().encode('export const value = 42;'),
                contentType: 'text/javascript',
              }
            : null,
      },
    );

    expect(prepared.html(scene())).toMatchObject({ present: true });
    expect(prepared.content('interactive:widget')).toContain('"dep":"data:text/javascript;base64,');
  });

  it('explicitly rejects scoped import maps instead of changing their semantics', async () => {
    const authored =
      '<script type="importmap">' +
      '{"imports":{},"scopes":{"https://app.test/":{"dep":"https://cdn.test/dep.js"}}}' +
      '</script><script type="module" src="https://app.test/main.js"></script>';
    const calls: string[] = [];
    const prepared = await prepareInteractiveHtmlScenes([scene(authored)], {
      fetcher: async (url) => {
        calls.push(url);
        return url === 'https://app.test/main.js'
          ? {
              bytes: new TextEncoder().encode('import { value } from "dep";'),
              contentType: 'text/javascript',
            }
          : null;
      },
    });

    expect(prepared.html(scene())).toMatchObject({
      present: false,
      failure: 'unresolved-resource',
      message: expect.stringContaining('unsupported-importmap-scopes'),
    });
    expect(prepared.content('interactive:widget')).toBeUndefined();
    expect(calls).toEqual([]);
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

    const responsive = await prepareInteractiveHtmlScenes(
      [scene('<img srcset="https://cdn.test/missing.png 2x">')],
      { fetcher: async () => null },
    );
    expect(responsive.html(scene())).toMatchObject({
      present: false,
      failure: 'unresolved-resource',
      message: expect.stringContaining('https://cdn.test/missing.png'),
    });

    const poster = await prepareInteractiveHtmlScenes(
      [scene('<video poster="https://cdn.test/missing-poster.jpg"></video>')],
      { fetcher: async () => null },
    );
    expect(poster.html(scene())).toMatchObject({
      present: false,
      failure: 'unresolved-resource',
      message: expect.stringContaining('https://cdn.test/missing-poster.jpg'),
    });

    for (const embedded of [
      '<iframe src="https://embed.test/frame"></iframe>',
      '<object data="https://embed.test/object"></object>',
      '<embed src="https://embed.test/plugin">',
      '<iframe src="data:text/html,%3Cp%3Eframe%3C/p%3E"></iframe>',
      '<object data="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></object>',
      '<embed src="blob:https://embed.test/plugin-id">',
      '<iframe srcdoc="<script>setInterval(function(){}, 10)<\/script>"></iframe>',
    ]) {
      const prepared = await prepareInteractiveHtmlScenes([scene(embedded)], {
        fetcher: async () => null,
      });
      expect(prepared.html(scene())).toMatchObject({
        present: false,
        failure: 'unresolved-resource',
        message: expect.stringMatching(/(?:https?|data|blob):|iframe\[srcdoc\]/),
      });
    }
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
