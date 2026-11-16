import { describe, expect, it } from 'vitest';
import { supportedLocales } from '@/lib/i18n/locales';
import { materialModelCopy } from '@/lib/server/agent-runtime/material-model-copy';
import { documentExtractionFailure } from '@/lib/server/material-extraction/extract';
import { MaterialExtractionError } from '@/lib/server/material-extraction/errors';
import { selfHostedMinerUFailure } from '@/lib/pdf/pdf-providers';
import {
  failedExtraction,
  MaterialExtractionTimeoutError,
} from '@/lib/server/materials/extraction';
import {
  extractionReasonCodeOf,
  extractionReasonValuesOf,
  extractionFailureDescription,
} from '@/lib/types/material-extraction-failure';

describe('failed PDF page range', () => {
  it('retains a service page-limit refusal in classic without relabeling it as failed pages', () => {
    const error = selfHostedMinerUFailure(
      422,
      JSON.stringify({
        error: {
          code: 'pdf_too_many_pages',
          message: 'PDF has 50 pages, which exceeds the 20-page limit',
        },
      }),
    );
    expect(failedExtraction(error)).toMatchObject({
      status: 'failed',
      retryable: false,
      reasonCode: 'too_many_pages',
      reasonValues: { pages: 50, maxPages: 20 },
    });
    expect(
      failedExtraction(
        new MaterialExtractionError('private failure', false, {
          reasonCode: 'storage_full',
        }),
      ),
    ).not.toHaveProperty('reasonCode');
  });
  it('allows only positive safe integer counts and strips unrelated fields', () => {
    expect(extractionReasonCodeOf('pages_failed')).toBe('pages_failed');
    expect(
      extractionReasonValuesOf('pages_failed', {
        firstPage: 101,
        lastPage: 150,
        pages: 999,
        note: 'private diagnostic',
      }),
    ).toEqual({ firstPage: 101, lastPage: 150 });
    for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '101', null]) {
      expect(
        extractionReasonValuesOf('pages_failed', { firstPage: bad, lastPage: bad }),
      ).toBeUndefined();
      expect(extractionReasonValuesOf('pages_failed', { firstPage: 101, lastPage: bad })).toEqual({
        firstPage: 101,
      });
    }
    expect(
      extractionReasonValuesOf('too_many_pages', { pages: 461, maxPages: 200, firstPage: 101 }),
    ).toEqual({ pages: 461, maxPages: 200 });
    expect(extractionReasonValuesOf(undefined, { firstPage: 101, lastPage: 150 })).toBeUndefined();
  });

  it('uses wording without a range when stored counts are incomplete or reversed', () => {
    for (const values of [
      undefined,
      { firstPage: 101 },
      { lastPage: 150 },
      { firstPage: 150, lastPage: 101 },
    ]) {
      expect(extractionFailureDescription('pages_failed', values)).toEqual({
        key: 'descriptionWithoutCount',
        values: {},
      });
    }
    expect(extractionFailureDescription('pages_failed', { firstPage: 101, lastPage: 101 })).toEqual(
      { key: 'description', values: { firstPage: 101, lastPage: 101 } },
    );
  });

  it('keeps the existing aggregate retryability when a later fallback fails transiently', () => {
    const failed = new MaterialExtractionError('page failure', false, {
      reasonCode: 'pages_failed',
      reasonValues: { firstPage: 101, lastPage: 150 },
    });
    expect(documentExtractionFailure(['page failure'], [failed])).toMatchObject({
      retryable: false,
      reasonCode: 'pages_failed',
    });
    expect(
      documentExtractionFailure(['page failure', 'HTTP 503'], [failed, new Error('HTTP 503')]),
    ).toMatchObject({
      retryable: true,
      reasonCode: 'pages_failed',
      reasonValues: { firstPage: 101, lastPage: 150 },
    });
  });

  it('gives the agent localized page numbers and says the material cannot be read', async () => {
    for (const { code } of supportedLocales) {
      const copy = await materialModelCopy(code);
      const failure = copy.failure('pages_failed', 'library', {
        firstPage: 101,
        lastPage: 150,
        note: 'private diagnostic',
      });
      expect(failure.reasonCode).toBe('pages_failed');
      expect(failure.guidance).toContain('101');
      expect(failure.guidance).toContain('150');
      expect(failure.guidance).not.toMatch(/\{\{|private diagnostic/);
      expect(copy.failure('pages_failed').guidance).not.toContain('{{');
    }
    expect(
      (await materialModelCopy('zh-CN')).failure('pages_failed', 'library', {
        firstPage: 101,
        lastPage: 150,
      }).guidance,
    ).toBe('PDF 第 101–150 页解析失败，这份资料暂时无法读取，可以稍后重新解析。');
    expect(
      (await materialModelCopy('en-US')).failure('pages_failed', 'library', {
        firstPage: 101,
        lastPage: 150,
      }).guidance,
    ).toContain('this material cannot be read yet');
  });
});

it('marks an exhausted course upload budget as non-retryable without changing transient provider failures', () => {
  const error = new MaterialExtractionTimeoutError('source', 300_000);
  expect(failedExtraction(error)).toMatchObject({
    status: 'failed',
    errorCode: 'EXTRACTION_TIMEOUT',
    retryable: false,
  });
  for (const error of [
    Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    new Error('HTTP 503'),
    new Error('network timeout'),
  ]) {
    expect(failedExtraction(error)).toMatchObject({
      status: 'failed',
      errorCode: 'EXTRACTION_FAILED',
      retryable: true,
    });
  }
});
