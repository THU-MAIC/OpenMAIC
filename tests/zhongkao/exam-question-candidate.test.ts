import { describe, expect, it } from 'vitest';

import {
  EXAM_QUESTION_SEGMENTATION_LIMITS,
  normalizeExamQuestionMarker,
  parseExamQuestionCandidatesArtifact,
  segmentExamQuestionCandidates,
  serializeExamQuestionCandidatesArtifact,
  validateExamQuestionCandidatesArtifact,
  type SegmentableExamDocumentArtifact,
} from '@/lib/zhongkao/exam-question-candidate';

const EXAM_SESSION_ID = 'exam-session-fixture';
const EXAM_DOCUMENT_ID = 'exam-document-question-paper';

function artifact(...pageTexts: string[]): SegmentableExamDocumentArtifact {
  return {
    schemaVersion: 1,
    artifactVersion: 1,
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: EXAM_DOCUMENT_ID,
    sourceSnapshotFingerprint: 'a'.repeat(64),
    mimeType: 'application/pdf',
    pageCount: pageTexts.length,
    pages: pageTexts.map((text, index) => ({
      pageNumber: index + 1,
      blocks: text.length === 0 ? [] : [{ blockIndex: 0, kind: 'text' as const, text }],
    })),
  };
}

function segment(source: SegmentableExamDocumentArtifact) {
  return segmentExamQuestionCandidates({
    artifact: source,
    examSessionId: EXAM_SESSION_ID,
    examDocumentId: EXAM_DOCUMENT_ID,
  });
}

describe('exam question marker normalization', () => {
  it.each(['1.', '1．', '1、', '１．'])(
    'recognizes top-level marker %s without changing the raw label',
    (rawLabel) => {
      expect(normalizeExamQuestionMarker(`${rawLabel} 虚构题干`)).toEqual({
        kind: 'question',
        rawLabel,
        printedNumber: '1',
      });
    },
  );

  it.each([
    ['17(1)', '17(1)'],
    ['17（1）', '17（1）'],
    ['17. (1)', '17. (1)'],
    ['17．（1）', '17．（1）'],
  ])('recognizes combined marker %s', (source, rawLabel) => {
    expect(normalizeExamQuestionMarker(`${source} 虚构小题`)).toEqual({
      kind: 'question_subquestion',
      rawLabel,
      printedNumber: '17',
      subquestionNumber: '1',
    });
  });

  it.each(['(1)', '（1）'])('recognizes standalone subquestion marker %s', (rawLabel) => {
    expect(normalizeExamQuestionMarker(`${rawLabel} 虚构小题`)).toEqual({
      kind: 'subquestion',
      rawLabel,
      subquestionNumber: '1',
    });
  });

  it.each([
    ['一、选择题', 'section:1'],
    ['二、填空题', 'section:2'],
    ['三、解答题', 'section:3'],
  ])('classifies %s as a section instead of a question', (rawLabel, normalizedSectionId) => {
    expect(normalizeExamQuestionMarker(rawLabel)).toEqual({
      kind: 'section',
      rawLabel,
      normalizedSectionId,
    });
  });

  it.each(['2026年', '1:2', 'x=1.5', '第1页', '得分：10', '2025-2026', '(1)+2'])(
    'rejects false positive %s',
    (text) => {
      expect(normalizeExamQuestionMarker(text)).toBeNull();
    },
  );
});

describe('deterministic ExamQuestionCandidate segmentation', () => {
  it('segments multiple sections without emitting a question for a section heading', () => {
    const result = segment(
      artifact(
        [
          '一、选择题',
          '1．虚构选择题',
          'A. 甲',
          'B. 乙',
          'C. 丙',
          '2、另一道题',
          '二、填空题',
          '3. 虚构填空题',
        ].join('\n'),
      ),
    );

    expect(result.candidateCount).toBe(3);
    expect(result.candidates.map((candidate) => candidate.locator)).toEqual([
      {
        sectionPath: [{ normalizedId: 'section:1', rawLabel: '一、选择题' }],
        printedNumber: '1',
        subquestionPath: [],
      },
      {
        sectionPath: [{ normalizedId: 'section:1', rawLabel: '一、选择题' }],
        printedNumber: '2',
        subquestionPath: [],
      },
      {
        sectionPath: [{ normalizedId: 'section:2', rawLabel: '二、填空题' }],
        printedNumber: '3',
        subquestionPath: [],
      },
    ]);
    expect(result.candidates[0]!.text).toContain('A. 甲\nB. 乙\nC. 丙');
    expect(
      result.candidates.every((candidate) => candidate.candidateQuestionType === 'unknown'),
    ).toBe(true);
  });

  it('creates one group plus leaf children and keeps common context only on the group', () => {
    const source = [
      '三、解答题',
      '17. 已知虚构条件',
      '公共题干',
      '(1) 求第一项',
      '(2) 求第二项',
    ].join('\n');
    const result = segment(artifact(source));
    const [group, first, second] = result.candidates;

    expect(result.candidateCount).toBe(3);
    expect(group).toMatchObject({
      candidateKind: 'group',
      rawLabel: '17.',
      locator: { printedNumber: '17', subquestionPath: [] },
      text: '17. 已知虚构条件\n公共题干',
      confidenceBand: 'medium',
    });
    expect(first).toMatchObject({
      candidateKind: 'leaf',
      parentCandidateId: group!.candidateId,
      locator: { printedNumber: '17', subquestionPath: ['1'] },
      text: '(1) 求第一项',
    });
    expect(second).toMatchObject({
      candidateKind: 'leaf',
      parentCandidateId: group!.candidateId,
      locator: { printedNumber: '17', subquestionPath: ['2'] },
      text: '(2) 求第二项',
    });
    expect(group!.sourceSpans[0]).toMatchObject({
      pageNumber: 1,
      startBlockIndex: 0,
      endBlockIndex: 0,
      startOffset: source.indexOf('17.'),
      endOffset: source.indexOf('(1)'),
    });
  });

  it('supports combined labels without inventing an empty group candidate', () => {
    const result = segment(artifact('17（1） 第一项\n17. (2) 第二项'));

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.locator.subquestionPath)).toEqual([
      ['1'],
      ['2'],
    ]);
    expect(result.candidates.every((candidate) => candidate.parentCandidateId === undefined)).toBe(
      true,
    );
  });

  it('preserves a cross-page question as multiple page-local source spans', () => {
    const result = segment(
      artifact('17. 题干从第一页开始\n第一页末尾内容', '第二页继续内容\n18. 下一题'),
    );
    const question = result.candidates[0]!;

    expect(question.text).toBe('17. 题干从第一页开始\n第一页末尾内容\n第二页继续内容');
    expect(question.sourceSpans).toEqual([
      { pageNumber: 1, startBlockIndex: 0, endBlockIndex: 0 },
      { pageNumber: 2, startBlockIndex: 0, endBlockIndex: 0, endOffset: '第二页继续内容\n'.length },
    ]);
    expect(question.confidenceReasonCodes).toContain('cross_page_span');
  });

  it('supports one question spanning the full bounded document page count', () => {
    const pageTexts = Array.from(
      { length: EXAM_QUESTION_SEGMENTATION_LIMITS.maxPages },
      (_, index) => (index === 0 ? '1. long bounded question' : `continued page ${index + 1}`),
    );
    const result = segment(artifact(...pageTexts));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceSpans).toHaveLength(
      EXAM_QUESTION_SEGMENTATION_LIMITS.maxPages,
    );
    expect(() => serializeExamQuestionCandidatesArtifact(result)).not.toThrow();
  });

  it('keeps duplicate locators, assigns stable discriminators, and marks all ambiguous', () => {
    const result = segment(artifact('三、解答题\n17(1) 第一份\n17（1） 第二份'));
    const duplicate = result.diagnostics.find(
      (diagnostic) => diagnostic.code === 'duplicate_locator',
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.ordinalDiscriminator)).toEqual([1, 2]);
    expect(result.candidates.map((candidate) => candidate.ambiguousLocator)).toEqual([true, true]);
    expect(new Set(result.candidates.map((candidate) => candidate.candidateId)).size).toBe(2);
    expect(duplicate?.candidateIds).toEqual(
      result.candidates.map((candidate) => candidate.candidateId),
    );
    expect(result.needsReview).toBe(true);
  });

  it('reports a possible number gap without declaring the extraction unsafe', () => {
    const result = segment(artifact('1. 第一题\n2. 第二题\n4. 第四题'));

    expect(result.diagnostics).toContainEqual({
      code: 'possible_number_gap',
      severity: 'info',
      previousPrintedNumber: '2',
      currentPrintedNumber: '4',
    });
    expect(result.needsReview).toBe(false);
  });

  it('reports number regression separately from duplicates', () => {
    const result = segment(artifact('3. 第三题\n2. 第二题'));

    expect(result.diagnostics).toContainEqual({
      code: 'number_regression',
      severity: 'needs_review',
      previousPrintedNumber: '3',
      currentPrintedNumber: '2',
    });
    expect(result.needsReview).toBe(true);
  });

  it('reports an orphan subquestion instead of fabricating a printed parent number', () => {
    const result = segment(artifact('(1) 没有父题\n后续文本'));

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      code: 'orphan_subquestion',
      severity: 'needs_review',
      pageNumber: 1,
      blockIndex: 0,
      subquestionPath: ['1'],
    });
  });

  it('keeps an empty-body candidate but makes it low confidence and review-required', () => {
    const result = segment(artifact('1.'));

    expect(result.candidates[0]).toMatchObject({
      text: '1.',
      confidenceBand: 'low',
      confidenceReasonCodes: expect.arrayContaining(['empty_body']),
    });
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'empty_question')).toBe(
      true,
    );
  });

  it('does not truncate oversized question text', () => {
    const first = `1. ${'甲'.repeat(30_000)}`;
    const second = '乙'.repeat(30_000);
    expect(Buffer.byteLength(`${first}\n${second}`, 'utf8')).toBeGreaterThan(
      EXAM_QUESTION_SEGMENTATION_LIMITS.maxQuestionTextBytes,
    );
    const result = segment(artifact(first, second));

    expect(result.candidates[0]).toMatchObject({
      contentStatus: 'oversized',
      confidenceBand: 'low',
    });
    expect(result.candidates[0]!.text).toContain(second);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'oversized_question')).toBe(
      true,
    );
  });

  it('is deterministic and changes source fingerprint when source facts change', () => {
    const source = artifact('1. 虚构题目');
    const first = segment(source);
    const replay = segment(structuredClone(source));
    const changed = segment(artifact('1. 另一道虚构题目'));

    expect(replay).toEqual(first);
    expect(changed.sourceArtifactFingerprint).not.toBe(first.sourceArtifactFingerprint);
    expect(changed.candidates[0]!.candidateId).toBe(first.candidates[0]!.candidateId);
    expect(segment(artifact('2. 虚构题目')).candidates[0]!.candidateId).not.toBe(
      first.candidates[0]!.candidateId,
    );
  });

  it('segments the canonical document form and always emits a serializable artifact', () => {
    const source = artifact('1. Cafe\u0301 question\r\ncontinued body');
    const result = segment(source);

    expect(result.candidates[0]?.text).toBe('1. Caf\u00e9 question\ncontinued body');
    expect(() => serializeExamQuestionCandidatesArtifact(result)).not.toThrow();
  });

  it('bounds structural diagnostics and records one aggregate overflow fact', () => {
    const orphanBlocks = Array.from({ length: 2_002 }, (_, index) => ({
      blockIndex: index % 1_000,
      kind: 'text' as const,
      text: `(1) orphan ${index}`,
    }));
    const source: SegmentableExamDocumentArtifact = {
      ...artifact('seed'),
      pageCount: 3,
      pages: [0, 1, 2].map((pageIndex) => ({
        pageNumber: pageIndex + 1,
        blocks: orphanBlocks
          .slice(pageIndex * 1_000, (pageIndex + 1) * 1_000)
          .map((block, blockIndex) => ({ ...block, blockIndex })),
      })),
    };

    const result = segment(source);
    expect(result.diagnostics).toHaveLength(EXAM_QUESTION_SEGMENTATION_LIMITS.maxDiagnostics);
    expect(result.diagnostics.at(-1)).toEqual({
      code: 'excessive_structure_diagnostics',
      severity: 'needs_review',
    });
    expect(() => serializeExamQuestionCandidatesArtifact(result)).not.toThrow();
  });
});

describe('question candidate artifact boundary', () => {
  it('serializes canonically and parses the closed schema', () => {
    const result = segment(artifact('1. 虚构题目'));
    const bytes = serializeExamQuestionCandidatesArtifact(result);

    expect(parseExamQuestionCandidatesArtifact(bytes)).toEqual(result);
    expect(
      serializeExamQuestionCandidatesArtifact(parseExamQuestionCandidatesArtifact(bytes)),
    ).toEqual(bytes);
    expect(validateExamQuestionCandidatesArtifact(result)).toEqual({ valid: true });
  });

  it('rejects extra fields and malformed spans', () => {
    const result = segment(artifact('1. 虚构题目'));
    expect(
      validateExamQuestionCandidatesArtifact({ ...result, objectKey: 'private/path' }).valid,
    ).toBe(false);
    expect(
      validateExamQuestionCandidatesArtifact({
        ...result,
        candidates: [
          {
            ...result.candidates[0],
            sourceSpans: [{ pageNumber: 1, startBlockIndex: 1, endBlockIndex: 0 }],
          },
        ],
      }).valid,
    ).toBe(false);
  });

  it('fails closed on malformed JSON and a changed deterministic id', () => {
    expect(() => parseExamQuestionCandidatesArtifact('{not json')).toThrow(
      'EXAM_QUESTION_CANDIDATES_ARTIFACT_INVALID',
    );
    const result = segment(artifact('1. 虚构题目'));
    const changed = {
      ...result,
      candidates: [{ ...result.candidates[0]!, candidateId: 'forged-candidate-id' }],
    };
    expect(validateExamQuestionCandidatesArtifact(changed).valid).toBe(false);
  });

  it('enforces total text limits before allocating candidates', () => {
    const oversizedBlock = `1. ${'甲'.repeat(EXAM_QUESTION_SEGMENTATION_LIMITS.maxBlockTextBytes)}`;
    expect(() => segment(artifact(oversizedBlock))).toThrow(
      'EXAM_QUESTION_SEGMENTATION_LIMIT_EXCEEDED',
    );
  });
});
