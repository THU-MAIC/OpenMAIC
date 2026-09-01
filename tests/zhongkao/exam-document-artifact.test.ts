import { describe, expect, it } from 'vitest';

import {
  EXAM_DOCUMENT_ARTIFACT_LIMITS,
  EXAM_DOCUMENT_ARTIFACT_VERSION,
  EXAM_EXTRACTION_VERSION,
  normalizeExamDocumentText,
  parseExamDocumentArtifact,
  serializeExamDocumentArtifact,
  type ExamDocumentArtifactV1,
} from '@/lib/zhongkao/exam-document-artifact';

const FINGERPRINT = 'a'.repeat(64);

function artifact(overrides: Partial<ExamDocumentArtifactV1> = {}): ExamDocumentArtifactV1 {
  return {
    schemaVersion: EXAM_EXTRACTION_VERSION,
    artifactVersion: EXAM_DOCUMENT_ARTIFACT_VERSION,
    examSessionId: 'exm_fixture',
    examDocumentId: 'doc_question_paper',
    sourceSnapshotFingerprint: FINGERPRINT,
    mimeType: 'application/pdf',
    pageCount: 2,
    pages: [
      {
        pageNumber: 1,
        blocks: [{ blockIndex: 0, kind: 'text', text: '1. x² + √4 = 2\r\n-2 ± 1 ≤ 3' }],
      },
      { pageNumber: 2, blocks: [{ blockIndex: 0, kind: 'text', text: '2. 继续作答' }] },
    ],
    ...overrides,
  };
}

describe('ExamDocumentArtifactV1', () => {
  it('normalizes only Unicode composition and line endings without damaging math symbols', () => {
    const parsed = parseExamDocumentArtifact(artifact());

    expect(parsed.pages[0]?.blocks[0]?.text).toBe('1. x² + √4 = 2\n-2 ± 1 ≤ 3');
    expect(normalizeExamDocumentText('e\u0301\r\n−2 ≥ -3')).toBe('é\n−2 ≥ -3');
    expect(normalizeExamDocumentText('  x   -  1  ')).toBe('  x   -  1  ');
  });

  it('serializes canonical field order independently of caller key insertion order', () => {
    const normal = serializeExamDocumentArtifact(artifact());
    const reordered = serializeExamDocumentArtifact({
      pages: artifact().pages,
      pageCount: 2,
      mimeType: 'application/pdf',
      sourceSnapshotFingerprint: FINGERPRINT,
      examDocumentId: 'doc_question_paper',
      examSessionId: 'exm_fixture',
      artifactVersion: EXAM_DOCUMENT_ARTIFACT_VERSION,
      schemaVersion: EXAM_EXTRACTION_VERSION,
    });

    expect(reordered.equals(normal)).toBe(true);
    expect(parseExamDocumentArtifact(normal)).toEqual(
      parseExamDocumentArtifact(normal.toString('utf8')),
    );
  });

  it('preserves page and page-local block ordering', () => {
    const parsed = parseExamDocumentArtifact({
      ...artifact(),
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          blocks: [
            { blockIndex: 0, kind: 'text', text: 'first' },
            { blockIndex: 1, kind: 'formula', text: 'x² + y²' },
            { blockIndex: 2, kind: 'table', text: 'A | B' },
          ],
        },
      ],
    });

    expect(parsed.pages[0]?.blocks.map((block) => block.kind)).toEqual([
      'text',
      'formula',
      'table',
    ]);
  });

  it.each([
    [
      'zero page number',
      { ...artifact(), pages: [{ pageNumber: 0, blocks: [] }, artifact().pages[1]] },
    ],
    [
      'duplicate page number',
      { ...artifact(), pages: [artifact().pages[0], { ...artifact().pages[1], pageNumber: 1 }] },
    ],
    [
      'out-of-order block index',
      {
        ...artifact(),
        pageCount: 1,
        pages: [{ pageNumber: 1, blocks: [{ blockIndex: 1, kind: 'text', text: 'body' }] }],
      },
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => parseExamDocumentArtifact(value)).toThrow('EXAM_DOCUMENT_ARTIFACT_INVALID');
  });

  it('rejects malformed or out-of-page bbox coordinates', () => {
    expect(() =>
      parseExamDocumentArtifact({
        ...artifact(),
        pageCount: 1,
        pages: [
          {
            pageNumber: 1,
            blocks: [
              {
                blockIndex: 0,
                kind: 'text',
                text: 'body',
                bbox: { x: 0.8, y: 0, width: 0.3, height: 0.1 },
              },
            ],
          },
        ],
      }),
    ).toThrow('EXAM_DOCUMENT_ARTIFACT_INVALID');
  });

  it('rejects oversized block text instead of truncating it', () => {
    expect(() =>
      parseExamDocumentArtifact({
        ...artifact(),
        pageCount: 1,
        pages: [
          {
            pageNumber: 1,
            blocks: [
              {
                blockIndex: 0,
                kind: 'text',
                text: 'x'.repeat(EXAM_DOCUMENT_ARTIFACT_LIMITS.maxBlockTextBytes + 1),
              },
            ],
          },
        ],
      }),
    ).toThrow('EXAM_DOCUMENT_ARTIFACT_INVALID');
  });

  it('rejects unsafe control characters in otherwise valid block text', () => {
    expect(() =>
      parseExamDocumentArtifact({
        ...artifact(),
        pageCount: 1,
        pages: [
          {
            pageNumber: 1,
            blocks: [{ blockIndex: 0, kind: 'text', text: '1. safe\u0000injected' }],
          },
        ],
      }),
    ).toThrow('EXAM_DOCUMENT_ARTIFACT_INVALID');
  });

  it('rejects extra fields at artifact, page, block, and bbox boundaries', () => {
    const values = [
      { ...artifact(), injectedEventType: 'exam_deleted' },
      {
        ...artifact(),
        pages: [{ ...artifact().pages[0], injectedPath: '../secret' }, artifact().pages[1]],
      },
      {
        ...artifact(),
        pages: [
          {
            pageNumber: 1,
            blocks: [{ blockIndex: 0, kind: 'text', text: 'body', injectedKey: true }],
          },
          artifact().pages[1],
        ],
      },
      {
        ...artifact(),
        pages: [
          {
            pageNumber: 1,
            blocks: [
              {
                blockIndex: 0,
                kind: 'text',
                text: 'body',
                bbox: { x: 0, y: 0, width: 1, height: 1, units: 'px' },
              },
            ],
          },
          artifact().pages[1],
        ],
      },
    ];

    for (const value of values) {
      expect(() => parseExamDocumentArtifact(value)).toThrow('EXAM_DOCUMENT_ARTIFACT_INVALID');
    }
  });

  it('fails closed for malformed JSON and an artifact with no extracted text', () => {
    expect(() => parseExamDocumentArtifact('{not json')).toThrow('EXAM_DOCUMENT_ARTIFACT_INVALID');
    expect(() =>
      parseExamDocumentArtifact({
        ...artifact(),
        pageCount: 1,
        pages: [{ pageNumber: 1, blocks: [] }],
      }),
    ).toThrow('EXAM_DOCUMENT_ARTIFACT_INVALID');
  });
});
