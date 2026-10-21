import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  mapInteractiveLibraryUrl,
  rewriteInteractiveLibraries,
} from '../src/interactive-library-mapper.js';
import { interactiveLibraryUrl, interactiveLibraryPrompt } from '../src/interactive-libraries.js';
import { postProcessInteractiveHtml } from '../src/interactive-post-processor.js';

const katex = interactiveLibraryUrl('katex');
describe('library URL compatibility', () => {
  it.each(['0.16.9', '^0.16.9', '~0.16.9', '0.16', '0.16.x', 'latest', ''])(
    'maps KaTeX version %s',
    (version) => {
      const suffix = version ? `@${version}` : '';
      expect(
        mapInteractiveLibraryUrl(`https://cdn.jsdelivr.net/npm/katex${suffix}/dist/katex.min.js`),
      ).toBe(katex);
      expect(mapInteractiveLibraryUrl(`https://unpkg.com/katex${suffix}/dist/katex.min.js`)).toBe(
        katex,
      );
    },
  );
  it.each(['0.15.6', '0.17.0', '^0.17', '0.16.99', 'next', '>=0.16', '0'])(
    'leaves incompatible or ambiguous version %s',
    (version) => {
      expect(
        mapInteractiveLibraryUrl(`https://unpkg.com/katex@${version}/dist/katex.min.js`),
      ).toBeUndefined();
    },
  );
  it.each([
    'https://unpkg.com/three@0.159.0/build/three.module.js',
    'https://cdn.jsdelivr.net/npm/chart.js@3/dist/chart.umd.js',
    'https://unpkg.com/katex@0.16.9/not-real.js',
    'https://unpkg.com/katex-extra@0.16.9/dist/katex.min.js',
    'https://unpkg.com.evil.test/katex@0.16.9/dist/katex.min.js',
    'https://user@unpkg.com/katex@0.16.9/dist/katex.min.js',
    'https://unpkg.com:8080/katex@0.16.9/dist/katex.min.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4?module',
    'https://cdn.tailwindcss.com',
  ])('preserves unknown URL %s', (url) => expect(mapInteractiveLibraryUrl(url)).toBeUndefined());
  it('maps package defaults, cdnjs aliases, scoped packages and protocol-relative URLs', () => {
    expect(mapInteractiveLibraryUrl('https://unpkg.com/chart.js@^4.0')).toBe(
      interactiveLibraryUrl('chart.js'),
    );
    expect(
      mapInteractiveLibraryUrl(
        'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js',
      ),
    ).toBe(interactiveLibraryUrl('chart.js'));
    expect(mapInteractiveLibraryUrl('https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4')).toBe(
      interactiveLibraryUrl('@tailwindcss/browser'),
    );
    expect(mapInteractiveLibraryUrl('//unpkg.com/katex@0.16.9/dist/katex.min.js')).toBe(katex);
  });
});

describe('HTML source mapping', () => {
  it('drops integrity, normalizes credentials, and leaves comments and script strings alone', () => {
    const input = `<script SRC='https://unpkg.com/chart.js@4' integrity='sha384-old' crossorigin='use-credentials'></script><!-- <script src='https://unpkg.com/chart.js'> --><script>const html='<script src="https://unpkg.com/chart.js">';</script>`;
    const { html } = rewriteInteractiveLibraries(input);
    expect(html).toContain(`src="${interactiveLibraryUrl('chart.js')}"`);
    expect(html).not.toContain('sha384-old');
    expect(html).toContain('crossorigin="anonymous"');
    expect(html).toContain("<!-- <script src='https://unpkg.com/chart.js'> -->");
    expect(html).toContain('const html=\'<script src="https://unpkg.com/chart.js">\'');
    expect(rewriteInteractiveLibraries(html).html).toBe(html);
  });
  it('supports CSS imports, ESM static/dynamic imports, and scoped import-map values', () => {
    const url = 'https://unpkg.com/chart.js@4';
    const input = `<style>@import url('${url}');</style><script type="module">import x from '${url}'; export * from '${url}'; import('${url}'); const literal='${url}';</script><script type="importmap">{"scopes":{"/scope/":{"chart":"${url}"}}}</script>`;
    const result = rewriteInteractiveLibraries(input).html;
    expect(result.match(/vendor\/interactive/g)).toHaveLength(5);
    expect(result).toContain(`const literal='${url}'`);
    expect(rewriteInteractiveLibraries(result).html).toBe(result);
  });
  it('preserves import-map layout and handles case-insensitive script types', () => {
    const three = 'https://unpkg.com/three@0.160.0/build/three.module.js';
    const input = `<script type="importmap">\n  {\n    "imports": { "three": "${three}", "x": "https://esm.sh/x" }\n  }\n</script><script type="Module">import "${three}";</script>`;
    const html = rewriteInteractiveLibraries(input).html;
    expect(html).toBe(input.replaceAll(three, interactiveLibraryUrl('three')));
  });
  it('counts unmatched external resource hosts', () => {
    const input =
      '<script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2"><script src="https://cdn.tailwindcss.com"></script>';
    expect(rewriteInteractiveLibraries(input).unmatchedExternalHosts).toEqual({
      'cdn.tailwindcss.com': 2,
      'fonts.googleapis.com': 1,
    });
  });
  it('uses a configurable base in mapping and prompts', () => {
    const base = 'https://assets.example.test/interactive';
    expect(mapInteractiveLibraryUrl('https://unpkg.com/chart.js@4', base)).toBe(
      `${base}/chart.js@4.4.8/dist/chart.umd.js`,
    );
    expect(interactiveLibraryPrompt()).toContain(interactiveLibraryUrl('three'));
  });
  const fixtures = new URL('./fixtures/interactive-libraries/', import.meta.url);
  for (const name of readdirSync(fixtures).filter((name) => name.endsWith('.html'))) {
    it(`maps corpus fixture ${name} without a second-pass change`, () => {
      const input = readFileSync(new URL(name, fixtures), 'utf8');
      const { html } = rewriteInteractiveLibraries(input);
      expect(html).toContain('/vendor/interactive/');
      expect(rewriteInteractiveLibraries(html).html).toBe(html);
      const processed = postProcessInteractiveHtml(input);
      expect(postProcessInteractiveHtml(processed)).toBe(processed);
    });
  }
});

describe('on-demand math', () => {
  const SYNC_KATEX =
    '<script data-openmaic-katex="2" src="/vendor/interactive/katex@0.16.38/dist/katex.min.js">';
  const SYNC_AUTO_RENDER =
    '<script data-openmaic-katex="2" src="/vendor/interactive/katex@0.16.38/dist/contrib/auto-render.min.js">';
  it.each([
    '<p>$x+1$</p>',
    '<p>$$2+2$$</p>',
    '<p>\\(x\\)</p>',
    '<p>\\[x\\]</p>',
    `<div id="a"></div><script>katex.render('x^2', document.getElementById('a'));</script>`,
    `<div id="a"></div><script type="module">a.innerHTML = katex.renderToString('x^2');</script>`,
    `<p>@@x@@</p><script>renderMathInElement(document.body, { delimiters: [{ left: '@@', right: '@@', display: false }] });</script>`,
    `<div id="a"></div><script>a.textContent = 'Area \\\\(\\\\pi r^2\\\\)';</script>`,
    `<script>const f = '\\\\frac{1}{2}';</script>`,
    '<p id="a"></p><script>a.textContent = String.raw`\\(\\frac{1}{2}\\)`;</script>',
    '<p id="a"></p><script>a.textContent = String.raw`Area: \\sqrt{${n}}`;</script>',
    '<p>$x$</p><script async src="/app.js"></script>',
  ])('loads hosted KaTeX synchronously for math in %s', (input) => {
    const html = postProcessInteractiveHtml(input);
    expect(html).toContain(SYNC_KATEX);
    expect(html).toContain(SYNC_AUTO_RENDER);
    expect(html).toContain(
      '<link data-openmaic-katex="2" rel="stylesheet" href="/vendor/interactive/katex@0.16.38/dist/katex.min.css">',
    );
    expect(html).not.toContain('defer');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(postProcessInteractiveHtml(html)).toBe(html);
  });
  it('injects nothing for a page without math that has a blocking script', () => {
    const input = '<p>No math</p><script src="/app.js"></script>';
    expect(postProcessInteractiveHtml(input)).toBe(input);
  });
  it.each([
    '<title>Save $5 or $10 today</title><p>No math</p>',
    '<title>$x$</title><p>No math</p>',
    '<p>Prices: $5 and $10</p>',
    '<script>const x="$x$"; const y=`${value}`;</script>',
    '<script>const re = /\\(\\d+\\)/; const t = `a\\(b`;</script>',
    '<script>const p = String.raw`C:\\temp\\new`;</script>',
    '<style>.x::before{content:"$x$"}</style>',
    '<p data-value="$x$">No math</p>',
    '<pre>$x$</pre><code>$x$</code>',
    '<p>Escaped \\$x$</p>',
  ])('makes no KaTeX request for %s', (input) =>
    expect(postProcessInteractiveHtml(input)).toBe(input),
  );
  it('upgrades stored #1966 markup and removes unnecessary resources', () => {
    const legacy =
      '<head><link data-openmaic-katex rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css"><script data-openmaic-katex>oldRuntime()</script></head><body>No math</body>';
    const output = postProcessInteractiveHtml(legacy);
    expect(output).not.toContain('katex');
    expect(output).not.toContain('oldRuntime');
    expect(postProcessInteractiveHtml(output)).toBe(output);
  });
});
