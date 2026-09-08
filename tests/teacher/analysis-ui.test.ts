import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analysisErrorMessage,
  analysisRequestHeaders,
  localWorkDate,
} from '@/components/teacher/analysis-ui';
import { TeacherRequestError } from '@/components/teacher/student-ui';
import { getTeacherAnalysisCopy } from '@/lib/i18n/teacher-analysis';
import { useSettingsStore } from '@/lib/store/settings';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

vi.mock('@/lib/store/settings', () => ({ useSettingsStore: { getState: vi.fn() } }));
vi.mock('@/lib/utils/model-config', () => ({ getCurrentModelConfig: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe('teacher analysis UI configuration', () => {
  it('reuses the selected model and OCR settings without unrelated provider credentials', () => {
    vi.mocked(getCurrentModelConfig).mockReturnValue({
      modelString: 'fictional:test-model',
      apiKey: 'fictional-model-key',
      baseUrl: 'http://localhost:1234',
      providerType: 'openai',
    } as ReturnType<typeof getCurrentModelConfig>);
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      pdfProviderId: 'alidocmind',
      pdfProvidersConfig: {
        alidocmind: {
          apiKey: '',
          baseUrl: '',
          accessKeyId: 'fictional-access-id',
          accessKeySecret: 'fictional-access-secret',
        },
        mineru: { apiKey: 'fictional-unselected-key' },
      },
      imageProvidersConfig: { fake: { apiKey: 'fictional-image-key' } },
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    const headers = analysisRequestHeaders();
    expect(headers).toMatchObject({
      'x-model': 'fictional:test-model',
      'x-api-key': 'fictional-model-key',
      'x-provider-type': 'openai',
      'x-pdf-provider': 'alidocmind',
      'x-pdf-access-key-id': 'fictional-access-id',
      'x-pdf-access-key-secret': 'fictional-access-secret',
    });
    expect(Object.values(headers)).not.toContain('fictional-unselected-key');
    expect(Object.values(headers)).not.toContain('fictional-image-key');
  });

  it('does not send AliDocMind credentials when the local text extractor is selected', () => {
    vi.mocked(getCurrentModelConfig).mockReturnValue({
      modelString: 'fictional:test-model',
      apiKey: '',
      baseUrl: '',
      providerType: 'openai',
    } as ReturnType<typeof getCurrentModelConfig>);
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      pdfProviderId: 'unpdf',
      pdfProvidersConfig: {
        unpdf: { apiKey: '', baseUrl: '' },
        alidocmind: { accessKeyId: 'fictional-id', accessKeySecret: 'fictional-secret' },
      },
    } as unknown as ReturnType<typeof useSettingsStore.getState>);
    const headers = analysisRequestHeaders();
    expect(headers['x-pdf-provider']).toBe('unpdf');
    expect(headers).not.toHaveProperty('x-pdf-access-key-secret');
  });

  it('uses the local calendar date when creating a new record', () => {
    expect(localWorkDate(new Date(2026, 0, 2, 0, 5))).toBe('2026-01-02');
  });

  it.each([
    ['ANALYSIS_MODEL_UNAVAILABLE', 'modelUnavailable'],
    ['ANALYSIS_OCR_REQUIRED', 'ocrRequired'],
    ['ANALYSIS_EXTRACTION_FAILED', 'extractionFailed'],
    ['ANALYSIS_CONFLICT', 'conflict'],
    ['ANALYSIS_LIMIT_REACHED', 'limitReached'],
  ] as const)('shows an actionable message for %s', (code, key) => {
    const copy = getTeacherAnalysisCopy('zh-CN');
    expect(analysisErrorMessage(new TeacherRequestError(409, code), copy)).toBe(copy[key]);
  });

  it('does not expose arbitrary server error details or fabricate an analysis', () => {
    const copy = getTeacherAnalysisCopy('en');
    expect(analysisErrorMessage(new Error('fictional internal details'), copy)).toBe(copy.failed);
    expect(copy.draft).toContain('inferred');
    expect(copy.insufficient).toContain('Exploration plan');
    expect(Object.keys(getTeacherAnalysisCopy('zh-CN')).sort()).toEqual(Object.keys(copy).sort());
    expect(getTeacherAnalysisCopy('fr-FR')).toBe(copy);
  });
});
