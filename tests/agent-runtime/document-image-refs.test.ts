import { describe, expect, it, vi } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';

vi.mock('mdast-util-from-markdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('mdast-util-from-markdown')>();
  return { ...original, fromMarkdown: vi.fn(original.fromMarkdown) };
});

import { imagePathIndex } from '@/lib/server/material-extraction/document-images';
import { resolveDerivativeRefs, rewriteImageReferences } from '../helpers/document-image-sync';

const index = imagePathIndex([{ key: 'img-1', path: 'fig.png' }]);
const derivatives = [{ key: 'img-1', id: 'own-image' }];
const bothPasses = (text: string) =>
  resolveDerivativeRefs(rewriteImageReferences(text, index), derivatives);

describe('document image references through storage and reading', () => {
  it('does not treat inequalities as tags spanning later Markdown blocks', () => {
    for (const text of [
      'If $a<b$ then.\n\n![x](images/fig.png)\n\n| p | <b>q</b> |',
      'a<b\n\n<img src="images/fig.png">',
      'a<b\n\ntext <img src=images/fig.png>',
      '$$0<t<1$$\n\n![x](images/fig.png)\n\n<b>tail</b>',
    ]) {
      expect(rewriteImageReferences(text, index)).toContain('openmaic-derivative:img-1');
      const stored = text.replace('images/fig.png', 'openmaic-derivative:img-1');
      expect(resolveDerivativeRefs(stored, derivatives)).toContain('material:own-image');
    }
  });
  it('resolves real images and leaves literal keys, code, escapes and links untouched', () => {
    const literal = [
      'Literal openmaic-derivative:img-1.',
      '`![example](openmaic-derivative:img-1)`',
      '```md\n![example](openmaic-derivative:img-1)\n```',
      String.raw`\![escaped](openmaic-derivative:img-1)`,
      '[ordinary link](openmaic-derivative:img-1)',
      String.raw`\<img src=images/fig.png alt="escaped">`,
      '`<img src=images/fig.png>`',
      '```html\n<img src=images/fig.png>\n```',
      '<!-- <img src="openmaic-derivative:img-1"> -->',
      '<script>const example = \'<img src="openmaic-derivative:img-1">\';</script>',
    ].join('\n\n');
    expect(bothPasses(literal)).toBe(literal);
    expect(bothPasses('![Figure](images/fig.png)')).toBe('![Figure](material:own-image)');
    expect(bothPasses('![Figure][fig]\n\n[fig]: images/fig.png')).toBe(
      '![Figure](material:own-image)\n\n',
    );
  });

  it('rewrites valid quoted and unquoted HTML src attributes and preserves the rest', () => {
    for (const src of ['images/fig.png', '"images/fig.png"', "'images/fig.png'"]) {
      const text = `<img data-src="images/missing.png" src=${src} alt="Figure">`;
      const read = bothPasses(text);
      expect(read).toMatch(/src=["']material:own-image["']/);
      expect(read).toContain('data-src="images/missing.png"');
      expect(read).toContain('alt="Figure"');
    }
    expect(bothPasses('<img src=images/missing.png alt="Missing figure">')).toBe(
      String.raw`\[image: Missing figure\]`,
    );
  });

  it('ignores image-shaped HTML in comments and raw-text elements, including inline script', () => {
    for (const text of [
      '<!-- <img src="images/fig.png"> -->',
      '<script>const image = \'<img src="images/fig.png">\';</script>',
      'inline <script>const image = \'<img src="images/fig.png">\';</script> text',
    ])
      expect(bothPasses(text)).toBe(text);
  });

  it('leaves Markdown image examples inside inline script and HTML attributes untouched', () => {
    for (const target of ['images/fig.png', 'openmaic-derivative:img-1']) {
      const text = `inline <script>const example = "![x](${target})";</script> text`;
      expect(bothPasses(text)).toBe(text);
      const unclosed = `inline <script>const example = "![x](${target})";`;
      expect(bothPasses(unclosed)).toBe(unclosed);
      const attribute = `<img src=images/fig.png alt="![x](${target})">`;
      expect(bothPasses(attribute)).toBe(`<img src="material:own-image" alt="![x](${target})">`);
    }
  });

  it('keeps full unquoted tags when Markdown splits their attributes or path', () => {
    expect(bothPasses('text <img src=images/fig.png alt="*Figure*"> end')).toBe(
      'text <img src="material:own-image" alt="*Figure*"> end',
    );
    const starredIndex = imagePathIndex([{ key: 'img-1', path: 'images/a*b*.png' }]);
    const text = 'text <img src=images/a*b*.png alt="Figure"> end';
    expect(resolveDerivativeRefs(rewriteImageReferences(text, starredIndex), derivatives)).toBe(
      'text <img src="material:own-image" alt="Figure"> end',
    );
  });

  it('does not let unclosed prose tags hide images in later Markdown blocks', () => {
    for (const tag of ['title', 'script', 'textarea']) {
      for (const image of ['![after](images/fig.png)', '<img src="images/fig.png">']) {
        const prose = `The <${tag}> element holds text.`;
        const read = bothPasses(`${prose}\n\n${image}`);
        expect(read).toContain(prose);
        expect(read).toContain('material:own-image');
        expect(read).not.toContain('images/fig.png');
      }
    }
  });

  it('keeps real unclosed script blocks and closed multiline script examples intact', () => {
    for (const target of ['images/fig.png', 'openmaic-derivative:img-1']) {
      const block = `<script>\nconst example = "![x](${target})";\n\n<img src="${target}">`;
      expect(bothPasses(block)).toBe(block);
      const inline = `inline <script>const example = "![x](${target})";\n\nconst second = "![y](${target})";</script>`;
      expect(bothPasses(inline + '\n\n![after](images/fig.png)')).toBe(
        inline + '\n\n![after](material:own-image)',
      );
      const closed = `${block}\n</script>`;
      expect(bothPasses(closed + '\n\n![after](images/fig.png)')).toBe(
        closed + '\n\n![after](material:own-image)',
      );
    }
  });

  it('preserves images and code among many inline HTML ranges', () => {
    const row = 'row <b>x</b> text\n\n';
    const prefix = row.repeat(10_000);
    const image = '![Figure](images/fig.png)\n\n';
    const code = '`![literal](images/fig.png)`\n\n';
    const stored = rewriteImageReferences(prefix + image + code + prefix, index);
    expect(stored).toBe(prefix + '![Figure](openmaic-derivative:img-1)\n\n' + code + prefix);
    for (const id of ['image-one', 'image-two']) {
      expect(resolveDerivativeRefs(stored, [{ key: 'img-1', id }], 'many-html-ranges')).toBe(
        prefix + `![Figure](material:${id})\n\n` + code + prefix,
      );
    }
  }, 20_000);

  it('reuses the parsed positions while applying each result’s own derivative ids', () => {
    // This checks the synchronous helper cache; production coverage is in document-image-worker.test.ts.
    const text = '![Figure](openmaic-derivative:img-1)';
    const calls = vi.mocked(fromMarkdown).mock.calls.length;
    expect(resolveDerivativeRefs(text, derivatives, 'reuse-plan')).toBe(
      '![Figure](material:own-image)',
    );
    expect(resolveDerivativeRefs(text, [{ key: 'img-1', id: 'another-image' }], 'reuse-plan')).toBe(
      '![Figure](material:another-image)',
    );
    expect(vi.mocked(fromMarkdown).mock.calls.length).toBe(calls + 1);
    // A different revision gets its own positions.
    expect(resolveDerivativeRefs('prefix ' + text, derivatives, 'new-revision')).toBe(
      'prefix ![Figure](material:own-image)',
    );
    expect(vi.mocked(fromMarkdown).mock.calls.length).toBe(calls + 2);
  });

  it('evicts old parsed plans when the entry limit is reached', () => {
    // This checks the synchronous helper cache; production coverage is in document-image-worker.test.ts.
    const text = '![Figure](openmaic-derivative:img-1)';
    resolveDerivativeRefs(text, derivatives, 'old-plan');
    for (let i = 0; i < 16; i += 1) resolveDerivativeRefs(text, derivatives, `eviction-${i}`);
    const calls = vi.mocked(fromMarkdown).mock.calls.length;
    resolveDerivativeRefs(text, derivatives, 'old-plan');
    expect(vi.mocked(fromMarkdown).mock.calls.length).toBe(calls + 1);
  });

  it('keeps code and remote images while resolving each real image to the reader’s own id', () => {
    const text =
      '\uFEFF![a](<images/fig.png>) ![r](https://example.com/fig.png)\n\n`openmaic-derivative:img-1`';
    const stored = rewriteImageReferences(text, index);
    for (const id of ['image-one', 'image-two']) {
      expect(resolveDerivativeRefs(stored, [{ key: 'img-1', id }])).toBe(
        `\uFEFF![a](material:${id}) ![r](https://example.com/fig.png)\n\n\`openmaic-derivative:img-1\``,
      );
    }
  });
});
