/**
 * Document images for owner extraction: how a provider's references are
 * rewritten to keys, how keys resolve to a source's own derivatives, and that
 * MinerU's parser keeps the file each image is named by.
 */
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';

import type { DocumentArtifact, DocumentExtractorProvider } from '@/lib/document/types';
import { textDocumentExtractorProvider } from '@/lib/document/extractors/text';
import { parsedPdfToDocumentArtifact } from '@/lib/document/pdf-compat';
import { MINERU_IMAGE_MIMES } from '@/lib/document/mime';
import { extractMinerUResult } from '@/lib/pdf/mineru-parser';
import * as providerResultFetch from '@/lib/server/provider-result-fetch';
import {
  imagePathIndex,
  ownerDocumentOutcome,
} from '@/lib/server/material-extraction/document-images';
import { resolveDerivativeRefs, rewriteImageReferences } from '../helpers/document-image-sync';

const index = imagePathIndex([
  { key: 'img-1', path: 'fig 1.jpg' },
  { key: 'img-2', path: 'fig-2.png' },
  { key: 'img-3', path: 'cell(1).png' },
]);

describe('rewriteImageReferences', () => {
  it('rewrites only the src attribute, outside quoted values and data-src', () => {
    expect(
      rewriteImageReferences('<img alt="images/fig-2.png" src="images/fig-2.png">', index),
    ).toBe('<img alt="images/fig-2.png" src="openmaic-derivative:img-2">');
    expect(
      rewriteImageReferences('<img data-src="images/missing.png" src="images/fig-2.png">', index),
    ).toBe('<img data-src="images/missing.png" src="openmaic-derivative:img-2">');
    const quoted = `<img alt="src='images/missing.png'" src='images/fig-2.png'>`;
    expect(rewriteImageReferences(quoted, index)).toBe(
      `<img alt="src='images/missing.png'" src='openmaic-derivative:img-2'>`,
    );
    expect(rewriteImageReferences('<img data-src="images/fig-2.png">', index)).toBe(
      '<img data-src="images/fig-2.png">',
    );
  });

  it('keeps missing-image alt text from becoming a link', () => {
    for (const input of [
      '![fig](images/missing.png)(Figure1)',
      String.raw`![a\](https://example.com)](images/missing.png)`,
      '![fig][gone](Figure1)\n\n[gone]: images/missing.png',
    ]) {
      const out = rewriteImageReferences(input, index);
      const paragraph = fromMarkdown(out).children[0];
      expect(paragraph?.type).toBe('paragraph');
      if (paragraph?.type === 'paragraph') {
        expect(paragraph.children.every((node) => node.type === 'text')).toBe(true);
      }
    }
  });

  it('preserves offsets and surrounding text when markdown starts with a BOM', () => {
    expect(rewriteImageReferences('\uFEFFhello ![a](images/fig-2.png) end', index)).toBe(
      '\uFEFFhello ![a](openmaic-derivative:img-2) end',
    );
  });

  it('names kept images by key, whatever form the reference takes', () => {
    expect(rewriteImageReferences('![a](images/fig%201.jpg)', index)).toBe(
      '![a](openmaic-derivative:img-1)',
    );
    // Rewriting the destination preserves the image's title.
    expect(rewriteImageReferences('![a](<./images/fig 1.jpg> "Figure 1")', index)).toBe(
      '![a](openmaic-derivative:img-1 "Figure 1")',
    );
    // Balanced parentheses belong to the destination.
    expect(rewriteImageReferences('![cell](images/cell(1).png)', index)).toBe(
      '![cell](openmaic-derivative:img-3)',
    );
    // Matched by its unique file name when the folder differs.
    expect(rewriteImageReferences('![](assets/fig-2.png)', index)).toBe(
      '![](openmaic-derivative:img-2)',
    );
    expect(
      rewriteImageReferences(
        '<table><tr><td><img alt="x" src="images/fig-2.png"></td></tr></table>',
        index,
      ),
    ).toBe('<table><tr><td><img alt="x" src="openmaic-derivative:img-2"></td></tr></table>');
  });

  it('writes reference images inline and drops a definition only images used', () => {
    const text = ['![cell][fig]', '', 'and ![again][fig]', '', '[fig]: images/fig-2.png'].join(
      '\n',
    );
    const rewritten = rewriteImageReferences(text, index);
    expect(rewritten).toContain('![cell](openmaic-derivative:img-2)');
    expect(rewritten).toContain('![again](openmaic-derivative:img-2)');
    expect(rewritten).not.toContain('images/fig-2.png');
  });

  it('turns references to files nothing keeps into alt text', () => {
    expect(rewriteImageReferences('see ![a cell](images/other.jpg) here', index)).toBe(
      String.raw`see \[image: a cell\] here`,
    );
    expect(rewriteImageReferences('![](images/other.jpg)', index)).toBe(String.raw`\[image\]`);
    expect(rewriteImageReferences('<img src="images/other.jpg">', index)).toBe(
      String.raw`\[image\]`,
    );
    expect(rewriteImageReferences('![x][gone]\n\n[gone]: images/gone.png', index)).toBe(
      String.raw`\[image: x\]` + '\n\n',
    );
  });

  it('leaves code, escaped text and non-provider references as written', () => {
    const text = [
      '```md',
      '![x](images/fig-2.png)',
      '```',
      '',
      'inline `![x](images/fig-2.png)` code',
      '',
      '\\![x](images/fig-2.png)',
      '',
      '![r](https://example.com/a.png) ![d](data:image/png;base64,AAAA) ![abs](/static/a.png)',
      '',
      '<img src="https://example.com/b.png">',
    ].join('\n');
    expect(rewriteImageReferences(text, index)).toBe(text);
  });
});

describe('imagePathIndex', () => {
  it('prefers all real paths over aliases, regardless of image order', () => {
    const images = [
      { key: 'img-1', path: 'x.jpg' },
      { key: 'img-2', path: 'images/x.jpg' },
    ];
    for (const ordered of [images, [...images].reverse()]) {
      expect(rewriteImageReferences('![b](images/x.jpg)', imagePathIndex(ordered))).toBe(
        '![b](openmaic-derivative:img-2)',
      );
    }
  });

  it('prefers a full path over another image’s file name', () => {
    const two = imagePathIndex([
      { key: 'img-1', path: 'other/fig.png' },
      { key: 'img-2', path: 'fig.png' },
    ]);
    expect(rewriteImageReferences('![](other/fig.png) ![](images/fig.png)', two)).toBe(
      '![](openmaic-derivative:img-1) ![](openmaic-derivative:img-2)',
    );
    // An ambiguous file name alone matches neither.
    expect(rewriteImageReferences('![](elsewhere/fig.png)', two)).toBe(String.raw`\[image\]`);
  });

  it('matches a kept image by the URL it was downloaded from, and no other URL', () => {
    const linked = imagePathIndex([
      { key: 'img-1', path: 'a.jpg', url: 'https://files.example.com/media/a' },
      { key: 'img-2', path: 'https://files.example.com/media/b' },
    ]);
    expect(
      rewriteImageReferences(
        '![](https://files.example.com/media/a) <img src="https://files.example.com/media/b"> ' +
          '![](images/a.jpg) ![](https://example.com/a.jpg)',
        linked,
      ),
    ).toBe(
      '![](openmaic-derivative:img-1) <img src="openmaic-derivative:img-2"> ' +
        '![](openmaic-derivative:img-1) ![](https://example.com/a.jpg)',
    );
  });
});

describe('ownerDocumentOutcome', () => {
  const provider = { id: 'test-doc', version: '1' } as unknown as DocumentExtractorProvider;
  const artifact = (type: 'text' | 'markdown'): DocumentArtifact => ({
    metadata: {},
    blocks: [{ id: 'b', type, text: 'Literal: ![x](images/a.png)' }],
    assets: [],
  });

  it('preserves uploaded markdown instead of treating its paths as provider files', async () => {
    const text = 'See ![arch](./arch.png) and ![logo][l]\n\n[l]: assets/logo.png';
    const buffer = Buffer.from(text);
    const extracted = await textDocumentExtractorProvider.extract({
      buffer,
      mimeType: 'text/markdown',
      fileName: 'notes.md',
      fileSize: buffer.length,
      config: { providerId: 'plain-text' },
    });
    expect((await ownerDocumentOutcome(extracted, textDocumentExtractorProvider)).text).toBe(text);
  });

  it('never rewrites a plain-text block', async () => {
    expect((await ownerDocumentOutcome(artifact('text'), provider)).text).toBe(
      'Literal: ![x](images/a.png)',
    );
  });

  it('rewrites a markdown block', async () => {
    expect((await ownerDocumentOutcome(artifact('markdown'), provider)).text).toBe(
      String.raw`Literal: \[image: x\]`,
    );
  });

  describe('images a MinerU gateway answers as URLs', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const linked = (images: Record<string, string>) =>
      parsedPdfToDocumentArtifact(
        extractMinerUResult({
          md_content: Object.keys(images)
            .map((file) => `![](images/${file})`)
            .join('\n\n'),
          images,
        }),
        { buffer: Buffer.alloc(0), mimeType: 'application/pdf', config: { providerId: 'mineru' } },
      );

    it('keeps the downloaded images as derivatives, and drops one it cannot download', async () => {
      const png = await sharp({
        create: { width: 4, height: 2, channels: 3, background: { r: 0, g: 128, b: 255 } },
      })
        .png()
        .toBuffer();
      const fetchResult = vi
        .spyOn(providerResultFetch, 'fetchProviderResultUrl')
        .mockImplementation(async (url) =>
          url.endsWith('/gone')
            ? new Response('gone', { status: 404 })
            : new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }),
        );

      const outcome = await ownerDocumentOutcome(
        linked({
          'a.jpg': 'https://files.example.com/media/a',
          'b.jpg': 'https://files.example.com/media/gone',
        }),
        provider,
      );

      expect(fetchResult.mock.calls.map(([url]) => url)).toEqual([
        'https://files.example.com/media/a',
        'https://files.example.com/media/gone',
      ]);
      expect(outcome.images).toEqual([
        expect.objectContaining({ key: 'img-1', mimeType: 'image/webp' }),
      ]);
      const kept = await sharp(Buffer.from(outcome.images[0]!.data, 'base64')).metadata();
      expect(kept).toMatchObject({ format: 'webp', width: 4, height: 2 });
      expect(outcome.text).toBe(
        String.raw`![](openmaic-derivative:img-1)` + '\n\n' + String.raw`\[image\]`,
      );
      expect(outcome.stats.diagnostics).toEqual([
        '1 document image(s) not kept (limit 100, or unreadable)',
        '1 document image(s) could not be downloaded',
      ]);
      expect(outcome.imagesNotDownloaded).toBe(1);
    });

    it('does not count as not downloaded what would be left out again', async () => {
      const png = await sharp({
        create: { width: 4, height: 2, channels: 3, background: { r: 0, g: 128, b: 255 } },
      })
        .png()
        .toBuffer();
      vi.spyOn(providerResultFetch, 'fetchProviderResultUrl').mockImplementation(async (url) => {
        if (url.endsWith('/login')) {
          return new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } });
        }
        if (url.endsWith('/huge')) {
          return new Response(new Uint8Array(8), {
            headers: { 'content-type': 'image/png', 'content-length': String(1024 ** 3) },
          });
        }
        return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
      });

      const outcome = await ownerDocumentOutcome(
        linked({
          'a.jpg': 'https://files.example.com/media/a',
          'b.jpg': 'https://files.example.com/media/login',
          'c.jpg': 'https://files.example.com/media/huge',
        }),
        provider,
      );

      expect(outcome.images).toHaveLength(1);
      // Not an image, too large: the same answer drops them again, so the
      // result stays cacheable.
      expect(outcome.imagesNotDownloaded).toBeUndefined();
      expect(outcome.stats.diagnostics).toEqual([
        '2 document image(s) not kept (limit 100, or unreadable)',
      ]);
    });

    it('rewrites the references that name an image by its URL', async () => {
      const png = await sharp({
        create: { width: 4, height: 2, channels: 3, background: { r: 0, g: 128, b: 255 } },
      })
        .png()
        .toBuffer();
      vi.spyOn(providerResultFetch, 'fetchProviderResultUrl').mockImplementation(
        async () => new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } }),
      );
      const a = 'https://files.example.com/shares/media/a';
      const b = 'https://files.example.com/shares/media/b';
      const artifact = parsedPdfToDocumentArtifact(
        extractMinerUResult({
          md_content: `![](${a})\n\n<img src="${b}">\n\n![](https://example.com/logo.png)`,
          images: { 'a.jpg': a, [b]: b },
        }),
        { buffer: Buffer.alloc(0), mimeType: 'application/pdf', config: { providerId: 'mineru' } },
      );

      const outcome = await ownerDocumentOutcome(artifact, provider);

      expect(outcome.images.map((image) => image.key)).toEqual(['img-1', 'img-2']);
      expect(outcome.text).toBe(
        '![](openmaic-derivative:img-1)\n\n<img src="openmaic-derivative:img-2">\n\n' +
          '![](https://example.com/logo.png)',
      );
      expect(outcome.imageRefs?.map((ref) => ref.key)).toEqual(['img-1', 'img-2']);
    });
  });
});

describe('resolveDerivativeRefs', () => {
  it('resolves each key to the derivative of the result being read', () => {
    const text = '![a](openmaic-derivative:img-1) <img src="openmaic-derivative:img-2">';
    expect(
      resolveDerivativeRefs(text, [
        { id: 'd-1', key: 'img-1' },
        { id: 'd-2', key: 'img-2' },
      ]),
    ).toBe('![a](material:d-1) <img src="material:d-2">');
  });

  it('leaves text without keys, and keys the result lacks, unchanged', () => {
    expect(resolveDerivativeRefs('plain', [{ id: 'd-1', key: 'img-1' }])).toBe('plain');
    expect(resolveDerivativeRefs('![](openmaic-derivative:img-9)', [{ id: 'd-1' }])).toBe(
      '![](openmaic-derivative:img-9)',
    );
  });
});

describe('MinerU parser', () => {
  const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString(
    'base64',
  );
  const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');

  it('keeps an image a gateway answers as a URL, and wraps only bare base64', () => {
    const url = 'https://files.example.com/media/abc';
    const parsed = extractMinerUResult({
      md_content: '',
      images: { 'abc.jpg': url, 'def.jpg': JPEG_BASE64, 'ghi.jpg': 'data:image/jpeg;base64,BBBB' },
    });
    expect(parsed.images).toEqual([
      url,
      `data:image/jpeg;base64,${JPEG_BASE64}`,
      'data:image/jpeg;base64,BBBB',
    ]);
    expect(parsed.metadata?.pdfImages?.[0]).toMatchObject({ src: url, path: 'abc.jpg' });
  });

  it('wraps base64 of an image only (a path is kept as is, to be dropped)', () => {
    // Paths made only of base64 characters, a dot-free name among them.
    const paths = ['/files/p1.jpg', '//cdn.example.com/p2.jpg', '/file_parse/abc', 'images/foo'];
    const parsed = extractMinerUResult({
      md_content: '',
      images: Object.fromEntries(paths.map((path, index) => [`p${index}.jpg`, path])),
    });
    expect(parsed.images).toEqual(paths);
  });

  const bytes = (...values: number[]) => Buffer.from([...values, 0, 0, 0, 0]).toString('base64');

  // Every type MinerU accepts as an input image may come back as an extracted one.
  const SIGNED: Array<[string, string, string]> = [
    ['PNG', 'image/png', PNG_BASE64],
    ['JPEG', 'image/jpeg', JPEG_BASE64],
    ['GIF', 'image/gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64')],
    [
      'WebP',
      'image/webp',
      Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64'),
    ],
    ['BMP', 'image/bmp', Buffer.from('BM\x46\x00\x00\x00', 'latin1').toString('base64')],
    ['little-endian TIFF', 'image/tiff', bytes(0x49, 0x49, 0x2a, 0x00)],
    ['big-endian TIFF', 'image/tiff', bytes(0x4d, 0x4d, 0x00, 0x2a)],
    [
      'boxed JPEG 2000',
      'image/jp2',
      bytes(0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a),
    ],
    ['JPEG 2000 codestream', 'image/jp2', bytes(0xff, 0x4f, 0xff, 0x51)],
  ];

  it.each(SIGNED)('wraps bare base64 of a %s image as %s', (_, mimeType, base64) => {
    expect(extractMinerUResult({ md_content: '', images: { 'a.jpg': base64 } }).images).toEqual([
      `data:${mimeType};base64,${base64}`,
    ]);
  });

  it('covers every image type MinerU accepts', () => {
    const covered = new Set(SIGNED.map(([, mimeType]) => mimeType));
    expect(MINERU_IMAGE_MIMES.filter((mime) => !covered.has(mime))).toEqual([]);
  });

  it('does not take a JPEG 2000 box of another kind for an image', () => {
    // A box of the same length that is not the JPEG 2000 signature.
    const other = bytes(0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x0d, 0x0a, 0x87, 0x0a);
    expect(extractMinerUResult({ md_content: '', images: { 'a.jpg': other } }).images).toEqual([
      other,
    ]);
  });

  it('finds the metadata of an image content_list names by its URL', () => {
    const url = 'https://files.example.com/media/abc';
    const parsed = extractMinerUResult({
      md_content: '',
      images: { 'abc.jpg': url },
      content_list: [
        {
          type: 'image',
          img_path: url,
          page_idx: 2,
          bbox: [100, 200, 400, 500],
          image_caption: ['Figure 1'],
        },
      ],
    });
    expect(parsed.metadata?.pdfImages?.[0]).toMatchObject({
      pageNumber: 3,
      description: 'Figure 1',
      width: 300,
      height: 300,
    });
  });

  it('records the file the markdown names each image by', () => {
    const parsed = extractMinerUResult({
      md_content: '![](images/abc.jpg)',
      images: { 'abc.jpg': 'AAAA' },
      content_list: [{ type: 'image', img_path: 'images/abc.jpg', page_idx: 1 }],
    });
    expect(parsed.metadata?.pdfImages).toEqual([
      expect.objectContaining({ id: 'img_1', path: 'abc.jpg', pageNumber: 2 }),
    ]);
  });

  it('keeps page, size and caption for table and equation crops', () => {
    const parsed = extractMinerUResult({
      md_content: '',
      images: { 'fig.jpg': 'AAAA', 'tab.jpg': 'BBBB', 'eq.jpg': 'CCCC' },
      content_list: [
        {
          type: 'image',
          img_path: 'images/fig.jpg',
          page_idx: 0,
          bbox: [10, 20, 110, 220],
          image_caption: ['Figure 1: Overview'],
        },
        {
          type: 'table',
          img_path: 'images/tab.jpg',
          page_idx: 3,
          bbox: [50, 100, 450, 300],
          table_caption: ['Table 2: Results'],
          table_footnote: ['* p < 0.05'],
        },
        {
          type: 'equation',
          img_path: 'images/eq.jpg',
          page_idx: 5,
          bbox: [100, 400, 400, 460],
          text: '$$E = mc^2$$',
        },
      ],
    });
    const byPath = Object.fromEntries(
      (parsed.metadata?.pdfImages ?? []).map((img) => [img.path, img]),
    );
    expect(byPath['fig.jpg']).toMatchObject({
      pageNumber: 1,
      description: 'Figure 1: Overview',
      width: 100,
      height: 200,
    });
    expect(byPath['tab.jpg']).toMatchObject({
      pageNumber: 4,
      description: 'Table 2: Results',
      width: 400,
      height: 200,
    });
    expect(byPath['eq.jpg']).toMatchObject({ pageNumber: 6, width: 300, height: 60 });
    expect(byPath['eq.jpg'].description).toBeUndefined();
  });
});
