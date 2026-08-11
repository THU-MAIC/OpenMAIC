import { describe, it, expect } from 'vitest';
import {
  collectAssetRefs,
  createAssetFetcher,
  toDataUri,
  inlineCssUrls,
  inlineHtmlAssets,
} from '@/lib/export/inline-assets';

describe('collectAssetRefs', () => {
  it('collects stylesheet link hrefs', () => {
    const refs = collectAssetRefs('<link rel="stylesheet" href="https://cdn.example/a.css">');
    expect(refs).toContainEqual({ kind: 'link', url: 'https://cdn.example/a.css' });
  });

  it('collects script srcs', () => {
    const refs = collectAssetRefs('<script src="https://cdn.example/b.js"></script>');
    expect(refs).toContainEqual({ kind: 'script', url: 'https://cdn.example/b.js' });
  });

  it('collects img srcs', () => {
    const refs = collectAssetRefs('<img src="https://cdn.example/c.png">');
    expect(refs).toContainEqual({ kind: 'img', url: 'https://cdn.example/c.png' });
  });

  it('collects every responsive image candidate', () => {
    const refs = collectAssetRefs(
      '<img srcset="https://cdn.example/c.png 1x, https://cdn.example/c@2x.png 2x">',
    );
    expect(refs).toContainEqual({ kind: 'srcset', url: 'https://cdn.example/c.png' });
    expect(refs).toContainEqual({ kind: 'srcset', url: 'https://cdn.example/c@2x.png' });
  });

  it('collects external video poster URLs', () => {
    const refs = collectAssetRefs('<video poster="https://cdn.example/poster.jpg"></video>');
    expect(refs).toContainEqual({ kind: 'poster', url: 'https://cdn.example/poster.jpg' });
  });

  it('collects unsupported embedded-document resources for rejection', () => {
    const refs = collectAssetRefs(
      '<iframe src="https://embed.example/frame"></iframe>' +
        '<object data="https://embed.example/object"></object>' +
        '<embed src="https://embed.example/plugin">' +
        '<iframe src="data:text/html,%3Cp%3Eframe%3C/p%3E"></iframe>' +
        '<object data="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"></object>' +
        '<embed src="blob:https://embed.example/plugin-id">',
    );
    expect(refs).toEqual(
      expect.arrayContaining([
        { kind: 'iframe-src', url: 'https://embed.example/frame' },
        { kind: 'object-data', url: 'https://embed.example/object' },
        { kind: 'embed-src', url: 'https://embed.example/plugin' },
        { kind: 'iframe-src', url: 'data:text/html,%3Cp%3Eframe%3C/p%3E' },
        { kind: 'object-data', url: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E' },
        { kind: 'embed-src', url: 'blob:https://embed.example/plugin-id' },
      ]),
    );
  });

  it('collects source srcs (video/audio)', () => {
    const refs = collectAssetRefs('<video><source src="https://cdn.example/d.mp4"></video>');
    expect(refs).toContainEqual({ kind: 'source', url: 'https://cdn.example/d.mp4' });
  });

  it('collects url() refs inside <style> blocks', () => {
    const refs = collectAssetRefs('<style>.x{background:url(https://cdn.example/e.png)}</style>');
    expect(refs).toContainEqual({ kind: 'css-url', url: 'https://cdn.example/e.png' });
  });

  it('collects importmap entry URLs', () => {
    const html =
      '<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js"}}</script>';
    const refs = collectAssetRefs(html);
    expect(refs).toContainEqual({
      kind: 'importmap',
      url: 'https://unpkg.com/three@0.160.0/build/three.module.js',
    });
  });

  it('IGNORES XML namespaces in xmlns (not a fetchable resource)', () => {
    const refs = collectAssetRefs('<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>');
    expect(refs.map((r) => r.url)).not.toContain('http://www.w3.org/2000/svg');
  });

  it('collects external SVG image and use references but keeps local fragments local', () => {
    const refs = collectAssetRefs(
      '<svg><image href="https://cdn.example/image.png" />' +
        '<use xlink:href="https://cdn.example/icons.svg#star" />' +
        '<use href="#local" /></svg>',
    );

    expect(refs).toContainEqual({ kind: 'svg-image', url: 'https://cdn.example/image.png' });
    expect(refs).toContainEqual({
      kind: 'svg-use',
      url: 'https://cdn.example/icons.svg#star',
    });
    expect(refs.map((ref) => ref.url)).not.toContain('#local');
  });

  it('collects CSS resources only from real url tokens', () => {
    const realUrl = 'https://cdn.example/real.png';
    const stringUrl = 'https://cdn.example/string.png';
    const commentUrl = 'https://cdn.example/comment.png';
    const refs = collectAssetRefs(
      `<style>.x{content:"url(${stringUrl})";background:url(${realUrl})}/* url(${commentUrl}) */</style>`,
      { includeRelative: true },
    );

    expect(refs).toContainEqual({ kind: 'css-url', url: realUrl });
    expect(refs.map((ref) => ref.url)).not.toContain(stringUrl);
    expect(refs.map((ref) => ref.url)).not.toContain(commentUrl);
  });

  it('IGNORES data: and relative URLs', () => {
    const html =
      '<img src="data:image/png;base64,AAAA"><link rel="stylesheet" href="/local.css"><script src="./rel.js"></script>';
    const refs = collectAssetRefs(html);
    expect(refs).toEqual([]);
  });

  it('only collects http(s) absolute URLs', () => {
    const html = '<script src="https://a/x.js"></script><script src="http://b/y.js"></script>';
    const refs = collectAssetRefs(html);
    expect(refs.map((r) => r.url).sort()).toEqual(['http://b/y.js', 'https://a/x.js']);
  });

  it('skips importmap scripts regardless of quote style or attribute order', () => {
    const a = collectAssetRefs(`<script type='importmap' src="https://x/i.js"></script>`);
    const b = collectAssetRefs(`<script src="https://x/i.js" type="importmap"></script>`);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it('collects direct module imports and CSS @import URLs', () => {
    const refs = collectAssetRefs(
      '<style>@import "https://cdn.example/theme.css";</style>' +
        '<script type="module">import "https://cdn.example/dep.js";</script>',
    );
    expect(refs).toContainEqual({ kind: 'css-import', url: 'https://cdn.example/theme.css' });
    expect(refs).toContainEqual({ kind: 'module-import', url: 'https://cdn.example/dep.js' });
  });
});

describe('createAssetFetcher', () => {
  function fakeFetch(map: Record<string, { body: string; contentType: string; status?: number }>) {
    return (async (url: string) => {
      const hit = map[String(url)];
      if (!hit) return new Response('not found', { status: 404 });
      return new Response(hit.body, {
        status: hit.status ?? 200,
        headers: { 'content-type': hit.contentType },
      });
    }) as unknown as typeof fetch;
  }

  it('fetches bytes + content-type', async () => {
    const fetchAsset = createAssetFetcher({
      fetchImpl: fakeFetch({
        'https://x/a.js': { body: 'console.log(1)', contentType: 'text/javascript' },
      }),
    });
    const got = await fetchAsset('https://x/a.js');
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.bytes)).toBe('console.log(1)');
    expect(got!.contentType).toBe('text/javascript');
  });

  it('returns null on 404 and caches the negative result', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    const fetchAsset = createAssetFetcher({ fetchImpl });
    expect(await fetchAsset('https://x/missing')).toBeNull();
    expect(await fetchAsset('https://x/missing')).toBeNull();
    expect(calls).toBe(1);
  });

  it('caches successful results (one network call per url)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('data', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch;
    const fetchAsset = createAssetFetcher({ fetchImpl });
    await fetchAsset('https://x/a');
    await fetchAsset('https://x/a');
    expect(calls).toBe(1);
  });

  it('strips content-type parameters (charset) to the bare mime', async () => {
    const fetchAsset = createAssetFetcher({
      fetchImpl: (async () =>
        new Response('x', {
          status: 200,
          headers: { 'content-type': 'text/css; charset=utf-8' },
        })) as unknown as typeof fetch,
    });
    const got = await fetchAsset('https://x/a.css');
    expect(got!.contentType).toBe('text/css');
  });

  it('falls back to extension-based mime when content-type missing', async () => {
    const fetchAsset = createAssetFetcher({
      // Use a Uint8Array body so Node does not auto-inject "text/plain;charset=UTF-8"
      fetchImpl: (async () =>
        new Response(new Uint8Array([120]), { status: 200 })) as unknown as typeof fetch,
    });
    const got = await fetchAsset('https://x/font.woff2');
    expect(got!.contentType).toBe('font/woff2');
  });

  it('skips assets larger than maxAssetBytes', async () => {
    const big = 'x'.repeat(100);
    const fetchAsset = createAssetFetcher({
      fetchImpl: (async () =>
        new Response(big, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })) as unknown as typeof fetch,
      maxAssetBytes: 10,
    });
    expect(await fetchAsset('https://x/big')).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    const fetchAsset = createAssetFetcher({
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });
    expect(await fetchAsset('https://x/err')).toBeNull();
  });
});

describe('toDataUri', () => {
  it('encodes bytes as base64 data uri with content type', () => {
    const uri = toDataUri(new TextEncoder().encode('hi'), 'text/plain');
    expect(uri).toBe('data:text/plain;base64,aGk=');
  });
});

describe('inlineCssUrls', () => {
  it('preserves @import layer, supports, and media conditions when inlining', async () => {
    const css =
      '@import "theme.css" layer(theme) supports(display: grid) screen and (min-width: 600px);';
    const { css: out } = await inlineCssUrls(
      css,
      'https://cdn.example/styles/base.css',
      async (url) =>
        url === 'https://cdn.example/styles/theme.css'
          ? { bytes: new TextEncoder().encode('.card{display:grid}'), contentType: 'text/css' }
          : null,
    );

    expect(out).toContain('@layer theme');
    expect(out).toContain('@supports (display: grid)');
    expect(out).toContain('@media screen and (min-width: 600px)');
    expect(out).toContain('.card{display:grid}');
    expect(out).not.toContain('@import');
  });

  it('preserves repeated imports of one stylesheet under different conditions', async () => {
    const css = '@import "theme.css" screen; @import "theme.css" print;';
    const { css: out } = await inlineCssUrls(
      css,
      'https://cdn.example/styles/base.css',
      async () => ({
        bytes: new TextEncoder().encode('.theme{color:blue}'),
        contentType: 'text/css',
      }),
    );

    expect(out).toContain('@media screen{.theme{color:blue}}');
    expect(out).toContain('@media print{.theme{color:blue}}');
    expect(out.match(/\.theme\{color:blue\}/g)).toHaveLength(2);
  });

  it('inlines relative font url() resolved against the css base url', async () => {
    const css = "@font-face{font-family:K;src:url(fonts/K.woff2) format('woff2')}";
    const fetchAsset = async (url: string) => {
      if (url === 'https://cdn.example/dist/fonts/K.woff2') {
        return { bytes: new TextEncoder().encode('FONT'), contentType: 'font/woff2' };
      }
      return null;
    };
    const { css: out } = await inlineCssUrls(
      css,
      'https://cdn.example/dist/katex.min.css',
      fetchAsset,
    );
    expect(out).toContain('data:font/woff2;base64,');
    expect(out).not.toContain('fonts/K.woff2');
  });

  it('inlines whatever url() is referenced (ttf etc.)', async () => {
    const css = 'src:url(a.ttf)';
    const fetchAsset = async () => ({ bytes: new Uint8Array([1]), contentType: 'font/ttf' });
    const { css: out } = await inlineCssUrls(css, 'https://x/base.css', fetchAsset);
    expect(out).toContain('data:font/ttf;base64,');
  });

  it('resolves absolute http url() too', async () => {
    const css = 'background:url(https://img.example/bg.png)';
    const fetchAsset = async (url: string) =>
      url === 'https://img.example/bg.png'
        ? { bytes: new Uint8Array([2]), contentType: 'image/png' }
        : null;
    const { css: out } = await inlineCssUrls(css, 'https://x/base.css', fetchAsset);
    expect(out).toContain('data:image/png;base64,');
  });

  it('leaves url() unmodified when fetch fails', async () => {
    const css = 'src:url(missing.woff2)';
    const fetchAsset = async () => null;
    const { css: out } = await inlineCssUrls(css, 'https://x/base.css', fetchAsset);
    expect(out).toContain('missing.woff2');
  });

  it('leaves data: url() untouched and does not fetch it', async () => {
    const css = 'src:url(data:font/woff2;base64,AAAA)';
    const fetchAsset = async () => {
      throw new Error('should not fetch');
    };
    const { css: out } = await inlineCssUrls(css, 'https://x/base.css', fetchAsset);
    expect(out).toContain('data:font/woff2;base64,AAAA');
  });

  it('leaves local CSS fragments untouched and does not fetch them', async () => {
    const calls: string[] = [];
    const { css: out, failed } = await inlineCssUrls(
      'svg{filter:url(#blur);mask:url("#mask")}',
      'about:blank',
      async (url) => {
        calls.push(url);
        return null;
      },
    );

    expect(out).toContain('url(#blur)');
    expect(out).toContain('url("#mask")');
    expect(calls).toEqual([]);
    expect(failed).toEqual([]);
  });

  it('preserves external SVG fragments while fetching only the resource URL', async () => {
    const calls: string[] = [];
    const { css: out, failed } = await inlineCssUrls(
      'svg{filter:url(https://cdn.test/filters.svg#blur)}',
      'about:blank',
      async (url) => {
        calls.push(url);
        return url === 'https://cdn.test/filters.svg'
          ? {
              bytes: new TextEncoder().encode('<svg><filter id="blur" /></svg>'),
              contentType: 'image/svg+xml',
            }
          : null;
      },
    );

    expect(calls).toEqual(['https://cdn.test/filters.svg']);
    expect(out).toContain('url(data:image/svg+xml;base64,');
    expect(out).toContain('#blur)');
    expect(failed).toEqual([]);
  });

  it('ignores url-like text in CSS comments and quoted strings', async () => {
    const realUrl = 'https://cdn.test/real.png';
    const stringUrl = 'https://cdn.test/string.png';
    const commentUrl = 'https://cdn.test/comment.png';
    const calls: string[] = [];
    const { css: out } = await inlineCssUrls(
      `.x{content:"url(${stringUrl})";background:url(${realUrl})}/* url(${commentUrl}) */`,
      'about:blank',
      async (url) => {
        calls.push(url);
        return { bytes: new Uint8Array([1]), contentType: 'image/png' };
      },
    );

    expect(out).toContain(`content:"url(${stringUrl})"`);
    expect(out).toContain(`/* url(${commentUrl}) */`);
    expect(out).toContain('background:url(data:image/png;base64,');
    expect(calls).toContain(realUrl);
    expect(calls).not.toContain(stringUrl);
    expect(calls).not.toContain(commentUrl);
  });

  it('handles quoted url() and multiple refs, fetching each unique once', async () => {
    let calls = 0;
    const css = `src:url("a.woff2"),url('a.woff2'),url(b.woff2)`;
    const fetchAsset = async (_url: string) => {
      calls++;
      return { bytes: new Uint8Array([9]), contentType: 'font/woff2' };
    };
    const { css: out } = await inlineCssUrls(css, 'https://x/base.css', fetchAsset);
    expect(out).not.toContain('a.woff2');
    expect(out).not.toContain('b.woff2');
    // a.woff2 (quoted twice, same resolved url) fetched once + b.woff2 once = 2
    expect(calls).toBe(2);
  });

  it('inlines only woff2 and drops sibling woff/ttf to about:invalid within an @font-face that has woff2', async () => {
    const css =
      '@font-face{font-family:K;src:url(K.woff2) format("woff2"),url(K.woff) format("woff"),url(K.ttf) format("truetype")}';
    const calls: string[] = [];
    const fetchAsset = async (url: string) => {
      calls.push(url);
      return { bytes: new Uint8Array([1]), contentType: 'font/woff2' };
    };
    const { css: out } = await inlineCssUrls(css, 'https://x/base.css', fetchAsset);
    expect(out).toContain('url(data:font/woff2;base64,'); // woff2 inlined
    expect(out).toContain('url(about:invalid) format("woff")'); // woff dropped
    expect(out).toContain('url(about:invalid) format("truetype")'); // ttf dropped
    expect(out).not.toContain('K.woff2');
    expect(out).not.toContain('K.woff)');
    expect(out).not.toContain('K.ttf');
    // only the woff2 was fetched
    expect(calls.filter((u) => u.endsWith('.woff') || u.endsWith('.ttf'))).toEqual([]);
    expect(calls.some((u) => u.endsWith('.woff2'))).toBe(true);
  });

  it('falls back to inlining a ttf-only @font-face (no woff2 present)', async () => {
    const css = '@font-face{font-family:T;src:url(T.ttf) format("truetype")}';
    const fetchAsset = async () => ({ bytes: new Uint8Array([2]), contentType: 'font/ttf' });
    const { css: out } = await inlineCssUrls(css, 'https://x/base.css', fetchAsset);
    expect(out).toContain('url(data:font/ttf;base64,'); // ttf inlined since no woff2 sibling
    expect(out).not.toContain('about:invalid');
  });

  it('still inlines non-font url() (images) outside @font-face', async () => {
    const css =
      '.bg{background:url(https://img/x.png)} @font-face{font-family:K;src:url(K.woff2) format("woff2"),url(K.ttf) format("truetype")}';
    const fetchAsset = async (url: string) => ({
      bytes: new Uint8Array([3]),
      contentType: url.includes('.png') ? 'image/png' : 'font/woff2',
    });
    const { css: out } = await inlineCssUrls(css, 'https://x/base.css', fetchAsset);
    expect(out).toContain('url(data:image/png;base64,'); // image inlined
    expect(out).toContain('url(data:font/woff2;base64,'); // woff2 inlined
    expect(out).toContain('url(about:invalid) format("truetype")'); // ttf dropped
  });

  it('reports nested url() assets that fail to fetch', async () => {
    const css = '@font-face{src:url(https://cdn.example/missing.woff2) format("woff2")}';
    const fetchAsset = async () => null; // all fetches fail
    const { css: out, failed } = await inlineCssUrls(
      css,
      'https://cdn.example/base.css',
      fetchAsset,
    );
    expect(out).toContain('https://cdn.example/missing.woff2'); // left as-is
    expect(failed.map((f) => f.url)).toContain('https://cdn.example/missing.woff2');
  });
});

describe('inlineHtmlAssets — importmap integration', () => {
  it('preserves supported top-level import-map fields while rewriting imports', async () => {
    const html =
      '<script type="importmap">' +
      '{"imports":{"dep":"https://cdn.test/dep.js"},"scopes":{},"integrity":{"https://cdn.test/dep.js":"sha384-example"}}' +
      '</script><script type="module">import "dep";</script>';
    const { html: out } = await inlineHtmlAssets(html, {
      fetcher: async (url) =>
        url === 'https://cdn.test/dep.js'
          ? {
              bytes: new TextEncoder().encode('export const value = 42;'),
              contentType: 'text/javascript',
            }
          : null,
    });

    expect(out).toContain('"dep":"data:text/javascript;base64,');
    expect(out).toContain('"scopes":{}');
    expect(out).toContain('"integrity":{"https://cdn.test/dep.js":"sha384-example"}');
  });

  it('inlines three + three/addons via importmap and retains the prefix as fallback', async () => {
    const base = 'https://unpkg.com/three@0.160.0/examples/jsm/';
    const fetchImpl = (async (url: string) => {
      const map: Record<string, string> = {
        'https://unpkg.com/three@0.160.0/build/three.module.js': 'export const THREE=1',
        [base + 'controls/OrbitControls.js']:
          "import * as THREE from 'three'; export class OrbitControls{}",
      };
      const body = map[String(url)];
      if (body === undefined) return new Response('', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } });
    }) as unknown as typeof fetch;

    const html = [
      '<script type="importmap">{"imports":{',
      '"three":"https://unpkg.com/three@0.160.0/build/three.module.js",',
      '"three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"',
      '}}</script>',
      "<script type=\"module\">import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js';</script>",
    ].join('');

    const { html: out } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toContain('"three":"data:text/javascript;base64,');
    expect(out).toContain('"three/addons/controls/OrbitControls.js":"data:text/javascript;base64,');
    // prefix is retained as online fallback for sub-paths not seen during static analysis
    expect(out).toContain('"three/addons/":');
  });

  it('keeps the three/addons/ prefix as fallback when an addon fails to fetch', async () => {
    const base = 'https://unpkg.com/three@0.160.0/examples/jsm/';
    const fetchImpl = (async (url: string) => {
      // three OK, OrbitControls OK, but a second addon 404s
      const map: Record<string, string> = {
        'https://unpkg.com/three@0.160.0/build/three.module.js': 'export const THREE=1',
        [base + 'controls/OrbitControls.js']: "import 'three'; export class OrbitControls{}",
      };
      const body = map[String(url)];
      if (body === undefined) return new Response('', { status: 404 });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } });
    }) as unknown as typeof fetch;
    const html = [
      '<script type="importmap">{"imports":{',
      '"three":"https://unpkg.com/three@0.160.0/build/three.module.js",',
      '"three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"',
      '}}</script>',
      "<script type=\"module\">import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';</script>",
    ].join('');
    const { html: out } = await inlineHtmlAssets(html, { fetchImpl });
    // OrbitControls inlined as explicit data: entry
    expect(out).toContain('"three/addons/controls/OrbitControls.js":"data:');
    // GLTFLoader failed → prefix retained as online fallback
    expect(out).toContain('"three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"');
  });
});

function fetchFromMap(map: Record<string, { body: string; ct: string }>): typeof fetch {
  return (async (url: string) => {
    const hit = map[String(url)];
    if (!hit) return new Response('', { status: 404 });
    return new Response(hit.body, { status: 200, headers: { 'content-type': hit.ct } });
  }) as unknown as typeof fetch;
}

describe('inlineHtmlAssets', () => {
  it('rewrites real elements without touching resource-like authored script text', async () => {
    const realUrl = 'https://cdn.test/real.png';
    const inertUrl = 'https://cdn.test/inert.png';
    const calls: string[] = [];
    const authoredScript = `const template = '<img src="${inertUrl}">';`;
    const { html: out } = await inlineHtmlAssets(
      `<script>${authoredScript}</script><img src="${realUrl}">`,
      {
        fetcher: async (url) => {
          calls.push(url);
          return { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' };
        },
      },
    );

    expect(out).toContain(`<script>${authoredScript}</script>`);
    expect(out).toContain('<img src="data:image/png;base64,');
    expect(calls).toContain(realUrl);
    expect(calls).not.toContain(inertUrl);
  });

  it('inlines external SVG href resources and preserves use fragments', async () => {
    const calls: string[] = [];
    const { html: out } = await inlineHtmlAssets(
      '<svg><defs><g id="local"></g></defs><use href="#local" />' +
        '<image href="https://cdn.test/image.png" />' +
        '<use xlink:href="https://cdn.test/icons.svg#star" /></svg>',
      {
        fetcher: async (url) => {
          calls.push(url);
          return {
            bytes: new TextEncoder().encode(url.endsWith('.svg') ? '<svg></svg>' : 'PNG'),
            contentType: url.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          };
        },
      },
    );

    expect(out).toContain('<use href="#local"');
    expect(out).toContain('<image href="data:image/png;base64,');
    expect(out).toContain('xlink:href="data:image/svg+xml;base64,');
    expect(out).toContain('#star"');
    expect(calls).toContain('https://cdn.test/image.png');
    expect(calls).toContain('https://cdn.test/icons.svg');
    expect(calls).not.toContain('https://cdn.test/icons.svg#star');
  });

  it('rewrites real style blocks without touching style-like authored script text', async () => {
    const realUrl = 'https://cdn.test/real.css-image.png';
    const inertUrl = 'https://cdn.test/inert.css-image.png';
    const authoredScript = `const template = '<style>.x{background:url(${inertUrl})}</style>';`;
    const calls: string[] = [];
    const { html: out } = await inlineHtmlAssets(
      `<script>${authoredScript}</script><style>.x{background:url(${realUrl})}</style>`,
      {
        fetcher: async (url) => {
          calls.push(url);
          return { bytes: new Uint8Array([1]), contentType: 'image/png' };
        },
      },
    );

    expect(out).toContain(`<script>${authoredScript}</script>`);
    expect(out).toContain('data:image/png;base64,');
    expect(calls).toContain(realUrl);
    expect(calls).not.toContain(inertUrl);
  });

  it('rewrites real script and link elements without touching authored tag text', async () => {
    const realScript = 'https://cdn.test/real.js';
    const realCss = 'https://cdn.test/real.css';
    const inertScript = 'https://cdn.test/inert.js';
    const inertCss = 'https://cdn.test/inert.css';
    const authoredScript =
      `const scriptTag = '<script src="${inertScript}">';` +
      `const linkTag = '<link rel="stylesheet" href="${inertCss}">';`;
    const calls: string[] = [];
    const { html: out } = await inlineHtmlAssets(
      `<script>${authoredScript}</script>` +
        `<script src="${realScript}"></script>` +
        `<link rel="stylesheet" href="${realCss}">`,
      {
        fetcher: async (url) => {
          calls.push(url);
          return {
            bytes: new TextEncoder().encode(
              url.endsWith('.css') ? '.real{color:red}' : 'window.real = true;',
            ),
            contentType: url.endsWith('.css') ? 'text/css' : 'text/javascript',
          };
        },
      },
    );

    expect(out).toContain(`<script>${authoredScript}</script>`);
    expect(out).toContain('<script src="data:text/javascript;base64,');
    expect(out).toContain('<style data-inlined-from=""');
    expect(calls).toContain(realScript);
    expect(calls).toContain(realCss);
    expect(calls).not.toContain(inertScript);
    expect(calls).not.toContain(inertCss);
  });

  it('inlines style-attribute resources while preserving local fragments', async () => {
    const url = 'https://cdn.test/background.png';
    const { html: out, report } = await inlineHtmlAssets(
      `<div style="background:url(${url});filter:url(#blur)"></div>`,
      {
        fetcher: async (requested) =>
          requested === url ? { bytes: new Uint8Array([1]), contentType: 'image/png' } : null,
      },
    );

    expect(out).toContain('background:url(data:image/png;base64,');
    expect(out).toContain('filter:url(#blur)');
    expect(report.failed).toEqual([]);
  });

  it('inlines URL-valued SVG presentation attributes and preserves fragments', async () => {
    const url = 'https://cdn.test/paint.svg';
    const { html: out, unresolved } = await inlineHtmlAssets(
      `<svg><rect fill="url(${url}#pattern)" filter="url(${url}#blur)" /></svg>`,
      {
        fetcher: async (requested) =>
          requested === url
            ? {
                bytes: new TextEncoder().encode('<svg></svg>'),
                contentType: 'image/svg+xml',
              }
            : null,
      },
    );

    expect(out).toContain('fill="url(data:image/svg+xml;base64,');
    expect(out).toContain('#pattern)"');
    expect(out).toContain('filter="url(data:image/svg+xml;base64,');
    expect(out).toContain('#blur)"');
    expect(out).not.toContain(url);
    expect(unresolved).toEqual([]);
  });

  it('inlines every responsive image candidate and preserves its descriptor', async () => {
    const { html, report } = await inlineHtmlAssets(
      '<img srcset="https://cdn.example/small.png 1x, https://cdn.example/large.png 2x">',
      {
        fetcher: async (url) => ({
          bytes: new TextEncoder().encode(url.endsWith('large.png') ? 'LARGE' : 'SMALL'),
          contentType: 'image/png',
        }),
      },
    );

    expect(html).not.toContain('https://cdn.example/');
    expect(html).toMatch(
      /srcset="data:image\/png;base64,[^\s]+ 1x, data:image\/png;base64,[^\s]+ 2x"/,
    );
    expect(report.inlined).toEqual([
      'https://cdn.example/small.png',
      'https://cdn.example/large.png',
    ]);
  });

  it('inlines external video posters', async () => {
    const url = 'https://cdn.example/poster.jpg';
    const { html, report } = await inlineHtmlAssets(`<video poster="${url}"></video>`, {
      fetcher: async (requested) =>
        requested === url
          ? { bytes: new TextEncoder().encode('POSTER'), contentType: 'image/jpeg' }
          : null,
    });

    expect(html).toContain('poster="data:image/jpeg;base64,');
    expect(html).not.toContain(url);
    expect(report.failed).toEqual([]);
  });

  it('reports a responsive image candidate that cannot be packaged', async () => {
    const url = 'https://cdn.example/missing.png';
    const { html, report } = await inlineHtmlAssets(`<img srcset="${url} 2x">`, {
      fetcher: async () => null,
    });

    expect(html).toContain(url);
    expect(report.failed).toContainEqual({ url, reason: 'fetch failed' });
  });

  it('inlines a stylesheet link into a <style> with fonts inlined', async () => {
    const html = '<head><link rel="stylesheet" href="https://cdn/x/katex.min.css"></head>';
    const fetchImpl = fetchFromMap({
      'https://cdn/x/katex.min.css': { body: '@font-face{src:url(fonts/a.woff2)}', ct: 'text/css' },
      'https://cdn/x/fonts/a.woff2': { body: 'FONT', ct: 'font/woff2' },
    });
    const { html: out, report } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toContain('<style');
    expect(out).toContain('data:font/woff2;base64,');
    expect(out).not.toContain('katex.min.css');
    expect(report.inlined).toContain('https://cdn/x/katex.min.css');
  });

  it('inlines a script src as a data: URI (preserving type=module)', async () => {
    const html = '<script type="module" src="https://cdn/app.js"></script>';
    const fetchImpl = fetchFromMap({
      'https://cdn/app.js': { body: 'export const a=1', ct: 'text/javascript' },
    });
    const { html: out } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toMatch(/<script[^>]*type="module"[^>]*src="data:text\/javascript;base64,/);
  });

  it('inlines an img src', async () => {
    const html = '<img src="https://cdn/p.png">';
    const fetchImpl = fetchFromMap({ 'https://cdn/p.png': { body: 'PNG', ct: 'image/png' } });
    const { html: out } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toContain('src="data:image/png;base64,');
  });

  it('inlines a Tailwind CDN runtime script', async () => {
    const html = '<script src="https://cdn.tailwindcss.com"></script>';
    const fetchImpl = fetchFromMap({
      'https://cdn.tailwindcss.com': { body: '/*tw*/', ct: 'text/javascript' },
    });
    const { html: out, report } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toContain('data:text/javascript;base64,');
    expect(report.inlined).toContain('https://cdn.tailwindcss.com');
  });

  it('inlines direct video and audio src attributes', async () => {
    const html =
      '<video src="https://cdn.test/demo.mp4"></video><audio src="https://cdn.test/demo.mp3"></audio>';
    const fetchImpl = fetchFromMap({
      'https://cdn.test/demo.mp4': { body: 'video', ct: 'video/mp4' },
      'https://cdn.test/demo.mp3': { body: 'audio', ct: 'audio/mpeg' },
    });
    const { html: out, report } = await inlineHtmlAssets(html, { fetchImpl });

    expect(out).toContain('<video src="data:video/mp4;base64,');
    expect(out).toContain('<audio src="data:audio/mpeg;base64,');
    expect(report.inlined).toEqual(
      expect.arrayContaining(['https://cdn.test/demo.mp4', 'https://cdn.test/demo.mp3']),
    );
  });

  it('records failures and leaves the URL in place', async () => {
    const html = '<img src="https://oss.example/blocked.png">';
    const fetchImpl = fetchFromMap({});
    const { html: out, report } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toContain('https://oss.example/blocked.png');
    expect(report.failed.map((f) => f.url)).toContain('https://oss.example/blocked.png');
  });

  it('does not touch SVG xmlns namespaces', async () => {
    const html = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const fetchImpl = fetchFromMap({});
    const { html: out, report } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toBe(html);
    expect(report.failed).toEqual([]);
  });

  it('dedups identical URLs (one fetch)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('X', { status: 200, headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    const html = '<img src="https://cdn/same.png"><img src="https://cdn/same.png">';
    await inlineHtmlAssets(html, { fetchImpl });
    expect(calls).toBe(1);
  });

  it('inlines url() inside authored <style> blocks', async () => {
    const html = '<style>.b{background:url(https://cdn/bg.png)}</style>';
    const fetchImpl = fetchFromMap({ 'https://cdn/bg.png': { body: 'IMG', ct: 'image/png' } });
    const { html: out } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toContain('data:image/png;base64,');
    expect(out).not.toContain('cdn/bg.png');
  });

  it('preserves the media attribute when converting a stylesheet link to <style>', async () => {
    const html = '<link rel="stylesheet" media="print" href="https://cdn/x.css">';
    const fetchImpl = (async () =>
      new Response('.a{color:red}', {
        status: 200,
        headers: { 'content-type': 'text/css' },
      })) as unknown as typeof fetch;
    const { html: out } = await inlineHtmlAssets(html, { fetchImpl });
    expect(out).toMatch(/<style[^>]*media="print"/);
  });

  it('reports a CSS-nested font that fails to fetch (stylesheet succeeds, font does not)', async () => {
    const html = '<link rel="stylesheet" href="https://cdn/x.css">';
    const fetchImpl = (async (url: string) => {
      if (String(url) === 'https://cdn/x.css')
        return new Response('@font-face{src:url(f.woff2) format("woff2")}', {
          status: 200,
          headers: { 'content-type': 'text/css' },
        });
      return new Response('', { status: 404 }); // the font 404s
    }) as unknown as typeof fetch;
    const { report } = await inlineHtmlAssets(html, { fetchImpl });
    expect(report.inlined).toContain('https://cdn/x.css'); // sheet itself inlined
    expect(report.failed.map((f) => f.url)).toContain('https://cdn/f.woff2'); // nested font reported
  });

  it('inlines nested CSS @import files and their assets', async () => {
    const fetchImpl = fetchFromMap({
      'https://cdn/x.css': { body: '@import "nested.css"; .a{color:red}', ct: 'text/css' },
      'https://cdn/nested.css': { body: '.b{background:url(bg.png)}', ct: 'text/css' },
      'https://cdn/bg.png': { body: 'IMG', ct: 'image/png' },
    });
    const { html: out, report } = await inlineHtmlAssets(
      '<link rel="stylesheet" href="https://cdn/x.css">',
      { fetchImpl },
    );
    expect(out).not.toContain('@import');
    expect(out).toContain('data:image/png;base64,');
    expect(report.inlined).toEqual(
      expect.arrayContaining(['https://cdn/nested.css', 'https://cdn/bg.png']),
    );
  });

  it('inlines relative imports in an external module without an importmap', async () => {
    const fetchImpl = fetchFromMap({
      'https://cdn/app.js': {
        body: "import './dep.js'; export const app = 1",
        ct: 'text/javascript',
      },
      'https://cdn/dep.js': { body: 'export const dep = 1', ct: 'text/javascript' },
    });
    const { html: out, report } = await inlineHtmlAssets(
      '<script type="module" src="https://cdn/app.js"></script>',
      { fetchImpl },
    );
    expect(out).toContain('src="data:text/javascript;base64,');
    expect(report.inlined).toContain('https://cdn/dep.js');
    expect(out).not.toContain("'./dep.js'");
  });

  it('keeps an importmap usable when the entry module is an external script', async () => {
    const fetchImpl = fetchFromMap({
      'https://cdn/app.js': {
        body: "import { dep } from 'dep'; export { dep }",
        ct: 'text/javascript',
      },
      'https://cdn/dep.js': { body: 'export const dep = 1', ct: 'text/javascript' },
    });
    const { html: out } = await inlineHtmlAssets(
      '<script type="importmap">{"imports":{"dep":"https://cdn/dep.js"}}</script>' +
        '<script type="module" src="https://cdn/app.js"></script>',
      { fetchImpl, keepImportmapFallbacks: false },
    );
    expect(out).toContain('"dep":"data:text/javascript;base64,');
    expect(out).toContain('src="data:text/javascript;base64,');
  });
});
