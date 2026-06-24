export interface GenerationRetryEvent {
  label: string;
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number;
  reason: string;
}

export interface GenerationRetryOptions<T> {
  label: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  shouldRetryResult?: (result: T) => boolean;
  onRetry?: (event: GenerationRetryEvent) => Promise<void> | void;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 16000;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function statusCodeFrom(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;

  for (const key of ['statusCode', 'status', 'status_code']) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
}

function messageFrom(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (!isRecord(value)) return String(value);
  const message = stringField(value, 'message') ?? stringField(value, 'statusText');
  return message ?? '';
}

function retryableByMessage(value: unknown): boolean {
  const message = messageFrom(value);
  return /rate limit|too many requests|timeout|timed out|fetch failed|network|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up/i.test(
    message,
  );
}

function unwrapErrors(value: unknown): unknown[] {
  if (!isRecord(value)) return [];

  const nested: unknown[] = [];
  if ('lastError' in value) nested.push(value.lastError);
  if ('cause' in value) nested.push(value.cause);

  const errors = value.errors;
  if (Array.isArray(errors)) nested.push(...errors);

  return nested;
}

export function isRetryableGenerationError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) return false;
  seen.add(error);

  if (isRecord(error)) {
    const explicitRetryable = booleanField(error, 'isRetryable');
    if (explicitRetryable !== undefined) return explicitRetryable;

    if (stringField(error, 'name') === 'AbortError') return false;
  }

  if (error instanceof Error && error.name === 'AbortError') return false;

  const statusCode = statusCodeFrom(error);
  if (statusCode !== undefined) {
    if (RETRYABLE_STATUS_CODES.has(statusCode) || statusCode >= 500) return true;
    if (NON_RETRYABLE_STATUS_CODES.has(statusCode) || (statusCode >= 400 && statusCode < 500)) {
      return false;
    }
  }

  const nested = unwrapErrors(error);
  if (nested.length > 0) {
    return nested.some((nestedError) => isRetryableGenerationError(nestedError, seen));
  }

  if (isRecord(error) && stringField(error, 'name') === 'TimeoutError') return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;

  return retryableByMessage(error);
}

function retryReason(error: unknown): string {
  const statusCode = statusCodeFrom(error);
  if (statusCode !== undefined) return `HTTP ${statusCode}`;
  const message = messageFrom(error).trim();
  return message || 'retryable error';
}

function retryDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(exponentialDelay * Math.max(0, Math.min(random(), 1)) * 0.2);
  return Math.min(maxDelayMs, exponentialDelay + jitter);
}

export async function withGenerationRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: GenerationRetryOptions<T>,
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxAttempts = maxRetries + 1;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation(attempt);
      if (!options.shouldRetryResult?.(result) || attempt >= maxAttempts) {
        return result;
      }

      const nextDelayMs = retryDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      await options.onRetry?.({
        label: options.label,
        attempt,
        maxAttempts,
        nextDelayMs,
        reason: 'empty result',
      });
      await sleep(nextDelayMs);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableGenerationError(error)) {
        throw error;
      }

      const nextDelayMs = retryDelayMs(attempt, baseDelayMs, maxDelayMs, random);
      await options.onRetry?.({
        label: options.label,
        attempt,
        maxAttempts,
        nextDelayMs,
        reason: retryReason(error),
      });
      await sleep(nextDelayMs);
    }
  }

  throw new Error(`Generation retry loop exhausted for ${options.label}`);
}
