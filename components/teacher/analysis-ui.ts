import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import type { TeacherAnalysisCopy } from '@/lib/i18n/teacher-analysis';
import { TeacherRequestError } from './student-ui';

export function analysisRequestHeaders(): Record<string, string> {
  const model = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const pdf = settings.pdfProvidersConfig[settings.pdfProviderId];
  return {
    'x-model': model.modelString,
    'x-api-key': model.apiKey,
    'x-base-url': model.baseUrl,
    'x-provider-type': model.providerType ?? '',
    'x-pdf-provider': settings.pdfProviderId,
    'x-pdf-api-key': pdf?.apiKey ?? '',
    'x-pdf-base-url': pdf?.baseUrl ?? '',
    ...(settings.pdfProviderId === 'alidocmind'
      ? {
          'x-pdf-access-key-id': pdf?.accessKeyId ?? '',
          'x-pdf-access-key-secret': pdf?.accessKeySecret ?? '',
        }
      : {}),
  };
}

export function analysisErrorMessage(error: unknown, copy: TeacherAnalysisCopy): string {
  const code = error instanceof TeacherRequestError ? error.code : undefined;
  switch (code) {
    case 'ANALYSIS_INPUT_INVALID':
      return copy.inputInvalid;
    case 'ANALYSIS_NOT_FOUND':
      return copy.notFound;
    case 'ANALYSIS_CONFLICT':
      return copy.conflict;
    case 'ANALYSIS_UNAVAILABLE':
      return copy.unavailable;
    case 'ANALYSIS_LIMIT_REACHED':
      return copy.limitReached;
    case 'ANALYSIS_SOURCE_INVALID':
      return copy.sourceInvalid;
    case 'ANALYSIS_INPUT_TOO_LARGE':
      return copy.tooLarge;
    case 'ANALYSIS_OCR_REQUIRED':
      return copy.ocrRequired;
    case 'ANALYSIS_EXTRACTION_FAILED':
      return copy.extractionFailed;
    case 'ANALYSIS_MODEL_UNAVAILABLE':
      return copy.modelUnavailable;
    case 'ANALYSIS_OUTPUT_INVALID':
      return copy.outputInvalid;
    case 'ANALYSIS_CANCELED':
      return copy.canceled;
    case 'ANALYSIS_STORAGE_CORRUPT':
      return copy.storageCorrupt;
    default:
      return copy.failed;
  }
}

export function analysisCollectionUrl(profileId: string): string {
  return `/api/teacher/students/${encodeURIComponent(profileId)}/analyses`;
}

export function localWorkDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
