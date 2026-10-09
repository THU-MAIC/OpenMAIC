import { APICallError, RetryError } from 'ai';

import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';

const HTTP_ERROR_MIN = 400;
const HTTP_ERROR_MAX = 599;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toHttpErrorStatus(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed >= HTTP_ERROR_MIN && parsed <= HTTP_ERROR_MAX
    ? parsed
    : undefined;
}

/** The provider's HTTP error status carried by an AI SDK (or similar) error, if any. */
export function upstreamHttpStatus(error: unknown): number | undefined {
  return statusFromError(error);
}

function statusFromError(error: unknown, seen = new Set<unknown>()): number | undefined {
  if (!error || seen.has(error)) return undefined;
  seen.add(error);

  if (APICallError.isInstance(error)) {
    return toHttpErrorStatus(error.statusCode);
  }

  if (RetryError.isInstance(error)) {
    return (
      statusFromError(error.lastError, seen) ??
      error.errors
        .map((nested) => statusFromError(nested, seen))
        .find((status): status is number => status !== undefined)
    );
  }

  if (!isRecord(error)) return undefined;

  const status = toHttpErrorStatus(error.statusCode ?? error.status ?? error.status_code);
  if (status !== undefined) return status;

  return statusFromError(error.cause, seen) ?? statusFromError(error.lastError, seen);
}

// Explicit billing/quota codes of the OpenAI-compatible wire format, not a
// provider's generic rate-limit signal. A vendor's native codes are its
// adapter's to translate into ProviderQuotaExhaustedError.
// https://developers.openai.com/api/docs/guides/error-codes
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_usage_limit_exceeded',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
]);

function quotaResponse(body: unknown): boolean {
  if (!isRecord(body)) return false;
  // OpenAI's stream adapter may retain a flat error frame, or a
  // response.failed event whose error is nested under response.
  const error =
    body.type === 'response.failed' && isRecord(body.response)
      ? body.response.error
      : (body.error ?? body);
  if (!isRecord(error)) return false;
  return (
    (typeof error.code === 'string' && QUOTA_CODES.has(error.code)) ||
    error.type === 'insufficient_quota'
  );
}

/**
 * An explicit quota refusal: an adapter's {@link ProviderQuotaExhaustedError},
 * or an OpenAI-compatible quota code in the provider response. Never inferred
 * from a 429 or a message.
 */
export function isUpstreamQuotaExhausted(error: unknown, seen = new Set<unknown>()): boolean {
  if (!isRecord(error) || seen.has(error)) return false;
  seen.add(error);

  // The last attempt is what the run reports; an earlier quota failure must
  // not replace a later provider failure with a different cause.
  if (RetryError.isInstance(error)) return isUpstreamQuotaExhausted(error.lastError, seen);

  if (error instanceof ProviderQuotaExhaustedError) return true;
  if (quotaResponse(error) || quotaResponse(error.data)) return true;
  if (typeof error.responseBody === 'string') {
    try {
      if (quotaResponse(JSON.parse(error.responseBody))) return true;
    } catch {
      // An unreadable/non-JSON response has no explicit quota signal.
    }
  }
  return (
    isUpstreamQuotaExhausted(error.cause, seen) || isUpstreamQuotaExhausted(error.lastError, seen)
  );
}
