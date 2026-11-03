import type {
  MaterialExtractionReasonCode,
  MaterialExtractionReasonValues,
} from '@/lib/types/material-extraction-failure';

/** An extraction failure whose retryability is known at the point of origin. */
export class MaterialExtractionError extends Error {
  readonly reasonCode?: MaterialExtractionReasonCode;
  /** The numbers the reason's explanation states (`too_many_pages`: pages, limit). */
  readonly reasonValues?: MaterialExtractionReasonValues;
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions & {
      reasonCode?: MaterialExtractionReasonCode;
      reasonValues?: MaterialExtractionReasonValues;
    },
  ) {
    super(message, options);
    this.name = 'MaterialExtractionError';
    this.reasonCode = options?.reasonCode;
    if (options?.reasonValues) this.reasonValues = options.reasonValues;
  }
}

/**
 * A parsing service refused the source itself (a PDF over its page limit):
 * the same bytes fail the same way again, so the attempt is not retried and
 * the provider walk stops here rather than handing the source to another
 * provider the deployment did not choose for it.
 */
export class MaterialSourceRefusedError extends MaterialExtractionError {
  constructor(
    message: string,
    options: ErrorOptions & {
      reasonCode: MaterialExtractionReasonCode;
      reasonValues?: MaterialExtractionReasonValues;
    },
  ) {
    super(message, false, options);
    this.name = 'MaterialSourceRefusedError';
  }
}

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Retry only errors carrying a concrete transient transport/runtime signal. */
export function isTransientExtractionError(error: unknown): boolean {
  if (error instanceof MaterialExtractionError) return error.retryable;
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { retryable?: unknown }).retryable === 'boolean'
  ) {
    return (error as { retryable: boolean }).retryable;
  }
  const status = numericStatus(error);
  if (status !== undefined) {
    if (status >= 500 && status <= 599) return true;
    if (status >= 400 && status <= 499) return false;
  }
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code.toUpperCase() : '';
  if (
    ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH'].includes(
      code,
    ) ||
    code.startsWith('08') ||
    code === '40001' ||
    code === '40P01' ||
    code.startsWith('53') ||
    ['57P01', '57P02', '57P03'].includes(code)
  ) {
    return true;
  }
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error ?? '');
  if (/\b(?:http(?: status)?|status(?: code)?)[ :=]*(5\d\d)\b/i.test(message)) return true;
  if (/\b(?:http(?: status)?|status(?: code)?)[ :=]*(4\d\d)\b/i.test(message)) return false;
  return (
    name === 'AbortError' ||
    /\b(?:timeout|timed out|network error|socket hang up|fetch failed)\b/i.test(message)
  );
}
