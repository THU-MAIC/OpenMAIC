import { APICallError, RetryError } from 'ai';

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

// Explicit billing/quota codes, not a provider's generic rate-limit signal.
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
  const error = body.error;
  if (isRecord(error)) {
    if (typeof error.code === 'string' && QUOTA_CODES.has(error.code)) return true;
    if (error.type === 'insufficient_quota') return true;
  }
  // MiniMax's native response distinguishes balance/plan exhaustion from
  // rate limits (1002/1039): https://platform.minimax.io/docs/api-reference/errorcode
  const code = isRecord(body.base_resp) ? body.base_resp.status_code : undefined;
  return code === 1008 || code === 2056 || code === '1008' || code === '2056';
}

/** A documented quota refusal in the provider response, never inferred from a 429 or message. */
export function isUpstreamQuotaExhausted(error: unknown, seen = new Set<unknown>()): boolean {
  if (!isRecord(error) || seen.has(error)) return false;
  seen.add(error);

  // The last attempt is what the run reports; an earlier quota failure must
  // not replace a later provider failure with a different cause.
  if (RetryError.isInstance(error)) return isUpstreamQuotaExhausted(error.lastError, seen);

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
