import { describe, expect, it } from 'vitest';

import {
  allocateDocumentTextBudgets,
  buildDocumentBundle,
  sortDocumentImagesForVision,
  type ParsedDocumentPart,
} from '@/lib/document/bundle';

function part(order: number, overrides: Partial<ParsedDocumentPart> = {}): ParsedDocumentPart {
  return {
    source: {
      id: `source-${order}`,
      name: `Source ${order}.pdf`,
      size: 1024,
      lastModified: order,
      mimeType: 'application/pdf',
      order,
    },
    text: `Document ${order} references image_${order}.`,
    rawTextLength: `Document ${order} references image_${order}.`.length,
    pageCount: order + 1,
    images: [
      {
        id: `image_${order}`,
        src: `data:image/png;base64,${order}`,
        pageNumber: order,
        description: `figure ${order}`,
        width: 100 + order,
        height: 80 + order,
      },
    ],
    ...overrides,
  };
}

describe('document bundle', () => {
  it('allocates a base text budget before proportional remainder', () => {
    const budgets = allocateDocumentTextBudgets([100, 5000, 10000], 6000);

    expect(budgets).toHaveLength(3);
    expect(budgets[0]).toBe(100);
    expect(budgets[1]).toBeGreaterThan(1500);
    expect(budgets[2]).toBeGreaterThan(budgets[1]);
    expect(budgets.reduce((sum, value) => sum + value, 0)).toBe(6000);
  });

  it('merges documents in source order and rewrites image IDs globally', () => {
    const bundle = buildDocumentBundle([part(2), part(1)], {
      maxChars: 2000,
      maxVisionImages: 4,
    });

    expect(bundle.text.indexOf('## Source Document 1: Source 1.pdf')).toBeLessThan(
      bundle.text.indexOf('## Source Document 2: Source 2.pdf'),
    );
    expect(bundle.text).toContain('Document 1 references img_1.');
    expect(bundle.text).toContain('Document 2 references img_2.');
    expect(bundle.images).toMatchObject([
      {
        id: 'img_1',
        originalId: 'image_1',
        sourceDocumentId: 'source-1',
        sourceDocumentName: 'Source 1.pdf',
        sourceDocumentOrder: 1,
      },
      {
        id: 'img_2',
        originalId: 'image_2',
        sourceDocumentId: 'source-2',
        sourceDocumentName: 'Source 2.pdf',
        sourceDocumentOrder: 2,
      },
    ]);
  });

  it('assigns vision priority round-robin across source documents', () => {
    const bundle = buildDocumentBundle(
      [
        part(1, {
          images: [
            {
              id: 'a1',
              src: 'data:image/png;base64,a1',
              pageNumber: 1,
              description: 'first source primary',
              width: 500,
              height: 500,
            },
            {
              id: 'a2',
              src: 'data:image/png;base64,a2',
              pageNumber: 2,
              description: 'first source secondary',
              width: 500,
              height: 500,
            },
          ],
        }),
        part(2, {
          images: [
            {
              id: 'b1',
              src: 'data:image/png;base64,b1',
              pageNumber: 1,
              description: 'second source primary',
              width: 500,
              height: 500,
            },
          ],
        }),
      ],
      { maxChars: 2000, maxVisionImages: 2 },
    );

    const priorities = new Map(
      bundle.images.map((image) => [image.originalId, image.visionPriority]),
    );

    expect(priorities.get('a1')).toBe(2);
    expect(priorities.get('b1')).toBe(1);
    expect(priorities.get('a2')).toBe(0);
  });

  it('does not truncate into a rewritten image ID', () => {
    const images = Array.from({ length: 11 }, (_, index) => ({
      id: `image_${index + 1}`,
      src: `data:image/png;base64,${index + 1}`,
      pageNumber: 1,
    }));
    const header =
      '## Source Document 1: Source 1.pdf\n' +
      '- Order: 1\n' +
      '- MIME type: application/pdf\n' +
      '- Pages: 2\n\n';

    const bundle = buildDocumentBundle(
      [
        part(1, {
          text: 'prefix image_11 suffix',
          rawTextLength: 'prefix image_11 suffix'.length,
          images,
        }),
      ],
      { maxChars: header.length + 'prefix img_1'.length, maxVisionImages: 4 },
    );

    expect(bundle.text).not.toContain('prefix img_1');
  });

  it('sorts same-priority img_N IDs numerically', () => {
    const sorted = sortDocumentImagesForVision([
      { id: 'img_10', pageNumber: 1, visionPriority: 0 },
      { id: 'img_2', pageNumber: 1, visionPriority: 0 },
      { id: 'img_1', pageNumber: 1, visionPriority: 0 },
    ]);

    expect(sorted.map((image) => image.id)).toEqual(['img_1', 'img_2', 'img_10']);
  });
});
