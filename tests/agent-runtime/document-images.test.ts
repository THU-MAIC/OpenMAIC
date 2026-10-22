/**
 * Document images for owner extraction: how a provider's references are
 * rewritten to keys, how keys resolve to a source's own derivatives, and that
 * MinerU's parser keeps the file each image is named by.
 */
import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';

import type { DocumentArtifact, DocumentExtractorProvider } from '@/lib/document/types';
import { textDocumentExtractorProvider } from '@/lib/document/extractors/text';
import { extractMinerUResult } from '@/lib/pdf/mineru-parser';
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
});
