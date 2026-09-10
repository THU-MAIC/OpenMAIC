/** An extraction failure whose retryability is known at the point of origin. */
export class MaterialExtractionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MaterialExtractionError';
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
