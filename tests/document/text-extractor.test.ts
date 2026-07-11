import { describe, expect, it } from 'vitest';

import { extractDocument } from '@/lib/document';

describe('plain text document extractor', () => {
  it('extracts TXT content locally', async () => {
    const artifact = await extractDocument({
      buffer: Buffer.from('Hello OpenMAIC\nLine 2', 'utf-8'),
      fileName: 'test.txt',
      fileSize: 20,
      mimeType: 'text/plain',
      config: { providerId: 'plain-text' },
    });

    expect(artifact.metadata).toMatchObject({
      fileName: 'test.txt',
      mimeType: 'text/plain',
      providerId: 'plain-text',
    });
    expect(artifact.blocks).toEqual([
      {
        id: 'text_1',
        type: 'text',
        text: 'Hello OpenMAIC\nLine 2',
      },
    ]);
  });

  it('extracts Markdown content locally as markdown blocks', async () => {
    const artifact = await extractDocument({
      buffer: Buffer.from('# Title', 'utf-8'),
      fileName: 'test.md',
      fileSize: 7,
      mimeType: 'text/markdown',
      config: { providerId: 'plain-text' },
    });

    expect(artifact.blocks[0]).toMatchObject({
      type: 'markdown',
      text: '# Title',
    });
  });

  it('detects UTF-16LE text from a BOM when MIME charset has been normalized away', async () => {
    const artifact = await extractDocument({
      buffer: Buffer.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]),
      fileName: 'test.txt',
      fileSize: 6,
      mimeType: 'text/plain',
      config: { providerId: 'plain-text' },
    });

    expect(artifact.blocks[0]).toMatchObject({
      type: 'text',
      text: '你好',
    });
  });
});
