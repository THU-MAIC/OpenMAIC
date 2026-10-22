import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import * as parser from '@/lib/server/material-extraction/document-image-parser';
import {
  imagePathIndex,
  resolveDerivativeRefsAsync,
} from '@/lib/server/material-extraction/document-images';

vi.mock('mdast-util-from-markdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('mdast-util-from-markdown')>();
  return { ...original, fromMarkdown: vi.fn(original.fromMarkdown) };
});

const index = imagePathIndex([{ key: 'img-1', path: 'fig.png' }]);

describe('document-image production parser', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the main-thread image modules free of parser imports', () => {
    for (const file of [
      'document-images.ts',
      'document-image-parser.ts',
      'document-image-apply.mjs',
      'document-image-paths.mjs',
    ]) {
      const source = readFileSync(resolve('lib/server/material-extraction', file), 'utf8');
      // The worker path is a string passed to Worker, never a static import.
      expect(source).not.toMatch(
        /(?:from\s*|import\s*\()\s*['"][^'"]*(?:document-image-plan|parse5|mdast-util-from-markdown)/,
      );
    }
  });

  it.each([
    'If $a<b$ then ![same](images/fig.png) holds > 0.',
    // A tag name, whitespace, then words: not attribute names, so not a tag.
    'where n<k and ![a](images/fig.png) for k>0',
    'x<y then ![a](images/fig.png) and z>w',
    '<b ![a](images/fig.png) >',
  ])('does not mistake prose for a tag in write or either read path: %s', async (input) => {
    const written = await parser.runDocumentImageWorker({
      kind: 'rewrite',
      index,
      blocks: [{ type: 'markdown', text: input }],
    });
    expect(written.text).toBe(input.replace('images/fig.png', 'openmaic-derivative:img-1'));
    expect(written.refs).toHaveLength(1);
    expect(written.text.slice(written.refs[0].start, written.refs[0].end)).toBe(
      'openmaic-derivative:img-1',
    );
    const expected = input.replace('images/fig.png', 'material:own-image');
    expect(
      await resolveDerivativeRefsAsync(
        written.text,
        [{ key: 'img-1', id: 'own-image' }],
        `same-paragraph-published:${input}`,
        written.refs,
      ),
    ).toBe(expected);
    // Independently supply a legacy text: do not let a broken write hide a broken read.
    expect(
      await resolveDerivativeRefsAsync(
        input.replace('images/fig.png', 'openmaic-derivative:img-1'),
        [{ key: 'img-1', id: 'own-image' }],
        `same-paragraph-legacy:${input}`,
      ),
    ).toBe(expected);
  });

  it('keeps real tags, complex unquoted attributes, scripts and comments unchanged in meaning', async () => {
    const input = [
      '<img alt=a*b* src=images/fig.png>',
      '<b>bold ![i](images/fig.png)</b>',
      'inline <script>const example = "![x](images/fig.png)";</script>',
      '<!-- ![comment](images/fig.png) <img src=images/fig.png> -->',
    ].join('\n\n');
    const written = await parser.runDocumentImageWorker({
      kind: 'rewrite',
      index,
      blocks: [{ type: 'markdown', text: input }],
    });
    expect(written.refs).toHaveLength(2);
    for (const refs of [written.refs, undefined]) {
      const read = await resolveDerivativeRefsAsync(
        written.text,
        [{ key: 'img-1', id: 'own-image' }],
        'real-tags-legacy',
        refs,
      );
      expect(read).toContain('<img alt=a*b* src="material:own-image">');
      expect(read).toContain('<b>bold ![i](material:own-image)</b>');
      expect(read).toContain('inline <script>const example = "![x](images/fig.png)";</script>');
      expect(read).toContain('<!-- ![comment](images/fig.png) <img src=images/fig.png> -->');
    }
  });

  it.each([
    ['![x](./images/fig%201.png)', '![x](openmaic-derivative:img-1)'],
    ['![x](elsewhere/fig%201.png)', '![x](openmaic-derivative:img-1)'],
    ['![x](remote/dup.png)', String.raw`\[image: x\]`],
    ['![x](images/dup.png)', '![x](openmaic-derivative:img-2)'],
    ['![x](https://example.test/fig.png)', '![x](https://example.test/fig.png)'],
    ['![x](/images/fig.png)', '![x](/images/fig.png)'],
  ])('matches provider paths in the worker: %s', async (input, expected) => {
    const paths = imagePathIndex([
      { key: 'img-1', path: 'fig 1.png' },
      { key: 'img-2', path: 'images/dup.png' },
      { key: 'img-3', path: 'other/dup.png' },
    ]);
    const written = await parser.runDocumentImageWorker({
      kind: 'rewrite',
      index: paths,
      blocks: [{ type: 'markdown', text: input }],
    });
    expect(written.text).toBe(expected);
  });

  it('publishes exact positions across trimmed blocks, BOM, definitions, HTML and code', async () => {
    const written = await parser.runDocumentImageWorker({
      kind: 'rewrite',
      index,
      blocks: [
        { type: 'text', text: ' heading ' },
        {
          type: 'markdown',
          text: '\uFEFF  If $a<b$ then.\n\n![x][fig]\n\n[fig]: images/fig.png\n\n',
        },
        {
          type: 'markdown',
          text: '  text <img src=images/fig.png alt="*Figure*">\n\n`![code](images/fig.png)`\n\nLiteral openmaic-derivative:img-1.  ',
        },
      ],
    });
    expect(written.refs).toHaveLength(2);
    for (const ref of written.refs) {
      expect(written.text.slice(ref.start, ref.end)).toBe('openmaic-derivative:' + ref.key);
    }
    const worker = vi.spyOn(parser, 'runDocumentImageWorker');
    for (const id of ['first', 'second']) {
      const read = await resolveDerivativeRefsAsync(
        written.text,
        [{ key: 'img-1', id }],
        'published',
        written.refs,
      );
      expect(read).toContain(`![x](material:${id})`);
      expect(read).toContain(`src="material:${id}"`);
      expect(read).toContain('`![code](images/fig.png)`');
      expect(read).toContain('Literal openmaic-derivative:img-1.');
    }
    expect(worker).not.toHaveBeenCalled();
    expect(vi.mocked(fromMarkdown)).not.toHaveBeenCalled();
  });

  it('parses legacy positions off-thread once and reapplies each reader’s ids', async () => {
    const text =
      'If $a<b$ then.\n\n![x](openmaic-derivative:img-1)\n\ntext <img src=openmaic-derivative:img-1>\n\n`openmaic-derivative:img-1`';
    const worker = vi.spyOn(parser, 'runDocumentImageWorker');
    for (const id of ['legacy-a', 'legacy-b']) {
      const read = await resolveDerivativeRefsAsync(text, [{ key: 'img-1', id }], 'legacy-worker');
      expect(read).toContain(`![x](material:${id})`);
      expect(read).toContain(`src="material:${id}"`);
      expect(read).toContain('`openmaic-derivative:img-1`');
    }
    expect(worker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fromMarkdown)).not.toHaveBeenCalled();
  });

  it.each(['offset', 'bytes', 'order'])(
    'falls back from invalid %s positions without caching reader ids',
    async (corruption) => {
      const written = await parser.runDocumentImageWorker({
        kind: 'rewrite',
        index,
        blocks: [
          {
            type: 'markdown',
            text: '![one](images/fig.png)\n\n![two](images/fig.png)\n\n`openmaic-derivative:img-1`',
          },
        ],
      });
      const text = corruption === 'bytes' ? 'Changed bytes.\n\n' + written.text : written.text;
      const refs =
        corruption === 'offset'
          ? [{ ...written.refs[0], start: written.refs[0].start + 1 }, written.refs[1]]
          : corruption === 'order'
            ? [...written.refs].reverse()
            : written.refs;
      const worker = vi.spyOn(parser, 'runDocumentImageWorker');
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const key = JSON.stringify(['reader', 'text', 'result', `fallback-${corruption}:1`]);
      for (const id of ['first', 'second']) {
        const read = await resolveDerivativeRefsAsync(text, [{ key: 'img-1', id }], key, refs);
        expect(read).toBe(
          text.replaceAll(/(?<=\]\()openmaic-derivative:img-1(?=\))/g, `material:${id}`),
        );
        expect(read).toContain('`openmaic-derivative:img-1`');
      }
      expect(worker).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        '[document-images] Invalid published image positions; parsing current bytes',
      );
      expect(warning.mock.calls.flat().join(' ')).not.toContain('Changed bytes');
      // A changed byte revision must not reuse the earlier plan.
      await resolveDerivativeRefsAsync(
        text,
        [{ key: 'img-1', id: 'third' }],
        JSON.stringify(['reader', 'text', 'result', `fallback-${corruption}:2`]),
        refs,
      );
      expect(worker).toHaveBeenCalledTimes(2);
    },
  );

  it('merges simultaneous production reads but projects each caller s derivative ids', async () => {
    const text = '![x](openmaic-derivative:img-1)';
    const worker = vi.spyOn(parser, 'runDocumentImageWorker');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        resolveDerivativeRefsAsync(
          text,
          [{ key: 'img-1', id: `reader-${n}` }],
          'concurrent-production-key',
        ),
      ),
    );
    expect(results).toEqual(Array.from({ length: 8 }, (_, n) => `![x](material:reader-${n})`));
    // Callers share the scheduler entry identified by their exact cache key.
    expect(worker).toHaveBeenCalledWith(
      { kind: 'plan', text },
      'concurrent-production-key',
      undefined,
    );
  });

  it('does not cache a canceled legacy parse or return a cached plan to an aborted caller', async () => {
    const text = '<span>x</span>'.repeat(25_000) + '\n\n![x](openmaic-derivative:img-1)';
    const worker = vi.spyOn(parser, 'runDocumentImageWorker');
    const controller = new AbortController();
    const canceled = resolveDerivativeRefsAsync(
      text,
      [{ key: 'img-1', id: 'canceled' }],
      'cancel-cache',
      undefined,
      controller.signal,
    );
    const rejected = expect(canceled).rejects.toThrow('aborted');
    controller.abort();
    await rejected;
    expect(
      await resolveDerivativeRefsAsync(text, [{ key: 'img-1', id: 'fresh' }], 'cancel-cache'),
    ).toContain('material:fresh');
    expect(worker).toHaveBeenCalledTimes(2);
    await expect(
      resolveDerivativeRefsAsync(
        text,
        [{ key: 'img-1', id: 'canceled' }],
        'cancel-cache',
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
    expect(worker).toHaveBeenCalledTimes(2);
  });

  it('evicts legacy positions at the unchanged production cache entry limit', async () => {
    const text = '![x](openmaic-derivative:img-1)';
    // Exercise the production cache without starting 18 real parser workers.
    const plan = {
      markdown: [{ start: 0, end: text.length, target: 'openmaic-derivative:img-1', alt: 'x' }],
      html: [],
    };
    const worker = vi
      .spyOn(parser, 'runDocumentImageWorker')
      .mockImplementation(vi.fn().mockResolvedValue(plan));
    await resolveDerivativeRefsAsync(text, [{ key: 'img-1', id: 'first' }], 'worker-eviction-old');
    for (let n = 0; n < 16; n++) {
      await resolveDerivativeRefsAsync(
        text,
        [{ key: 'img-1', id: 'other' }],
        `worker-eviction-${n}`,
      );
    }
    expect(
      await resolveDerivativeRefsAsync(text, [{ key: 'img-1', id: 'last' }], 'worker-eviction-old'),
    ).toBe('![x](material:last)');
    expect(worker).toHaveBeenCalledTimes(18);
  });

  it('keeps the main event loop responsive during write and legacy cold-read parsing', async () => {
    const text = '<span>x</span>'.repeat(25_000) + '\n\n![x](images/fig.png)';
    const worker = vi.spyOn(parser, 'runDocumentImageWorker');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const written = await parser.runDocumentImageWorker({
        kind: 'rewrite',
        index,
        blocks: [{ type: 'markdown', text }],
      });
      expect(ticks).toBeGreaterThan(0);
      expect(written.refs).toHaveLength(1);
      ticks = 0;
      const read = await resolveDerivativeRefsAsync(
        written.text,
        [{ key: 'img-1', id: 'large' }],
        'large-legacy',
      );
      expect(ticks).toBeGreaterThan(0);
      expect(read).toContain('material:large');
      expect(worker).toHaveBeenCalledTimes(2);
      // A large *new* result's cold read never starts a parser.
      expect(
        await resolveDerivativeRefsAsync(
          written.text,
          [{ key: 'img-1', id: 'new' }],
          'large-new',
          written.refs,
        ),
      ).toContain('material:new');
      expect(worker).toHaveBeenCalledTimes(2);
      expect(vi.mocked(fromMarkdown)).not.toHaveBeenCalled();
    } finally {
      clearInterval(timer);
    }
  }, 20_000);
});
