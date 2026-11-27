import 'server-only';

import { APICallError } from 'ai';

import { CHATGPT_PLAN_PROVIDER_ID, CHATGPT_USAGE_SETTINGS_URL } from '@/lib/chatgpt-plan/shared';
import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';

/**
 * Failures of the ChatGPT connection itself. Each code has a fixed message;
 * the settings UI shows its own localized text for the code.
 */
export type ChatGPTPlanErrorCode =
  /** The provider is off here (`availability.ts`). */
  | 'unavailable'
  | 'not-connected'
  /** Signed in without allowing plan usage on the consent screen. */
  | 'sharing-disabled'
  /** The connection expired or was revoked; signing in again restores it. */
  | 'reauth-required'
  /** No sign-in is waiting for this callback: it expired or was completed. */
  | 'sign-in-expired'
  | 'sign-in-denied'
  /** The pasted address is not the one this sign-in redirects to. */
  | 'invalid-callback'
  | 'sign-in-failed'
  /** OpenAI could not be reached or answered unexpectedly. */
  | 'upstream';

const MESSAGES: Record<ChatGPTPlanErrorCode, string> = {
  unavailable: 'The ChatGPT plan provider is not available on this installation.',
  'not-connected': 'Connect a ChatGPT account in settings to use this provider.',
  'sharing-disabled':
    'The connected ChatGPT account has not allowed plan usage in OpenMAIC. Sign in again and allow it.',
  'reauth-required': 'The ChatGPT connection has expired. Sign in again in settings.',
  'sign-in-expired': 'This sign-in has expired or was already completed. Start a new one.',
  'sign-in-denied': 'The ChatGPT sign-in was cancelled.',
  'invalid-callback': 'That address does not belong to this sign-in. Paste the full address.',
  'sign-in-failed': 'The ChatGPT sign-in could not be completed. Try again.',
  upstream: 'ChatGPT could not be reached. Try again shortly.',
};

export class ChatGPTPlanError extends Error {
  constructor(
    readonly code: ChatGPTPlanErrorCode,
    options?: ErrorOptions,
  ) {
    super(MESSAGES[code], options);
    this.name = 'ChatGPTPlanError';
  }
}

const CONNECTION_STATUS: Record<ChatGPTPlanErrorCode, number> = {
  unavailable: 403,
  'not-connected': 401,
  'sharing-disabled': 403,
  'reauth-required': 401,
  'sign-in-expired': 400,
  'sign-in-denied': 400,
  'invalid-callback': 400,
  'sign-in-failed': 502,
  upstream: 502,
};

/** The HTTP status a route answers a connection failure with. */
export function connectionErrorStatus(error: ChatGPTPlanError): number {
  return CONNECTION_STATUS[error.code];
}

// Errors this module produced: the stream policy leaves them as they are.
const planErrors = new WeakSet<object>();

export function isPlanCallError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && planErrors.has(error);
}

/** A connection failure met while sending a model request. */
export function connectionCallError(error: ChatGPTPlanError, url: string): APICallError {
  const callError = new APICallError({
    message: error.message,
    url,
    requestBodyValues: {},
    statusCode: CONNECTION_STATUS[error.code],
    isRetryable: error.code === 'upstream',
    cause: error,
  });
  planErrors.add(callError);
  return callError;
}

/** What an inference endpoint reported, read from its body or stream frame. */
export interface UpstreamFailure {
  /** HTTP status; absent for a failure reported inside a stream. */
  status?: number;
  code?: string;
  /** For an unsupported capability: the request field it concerns. */
  param?: string;
  requestId?: string;
}

interface PlanRule {
  status: number;
  retryable: boolean;
  message: string;
  quota?: true;
}

const USAGE_LIMIT: PlanRule = {
  status: 429,
  retryable: false,
  quota: true,
  message: `This app has reached its usage limit on your ChatGPT plan. Review the limit at ${CHATGPT_USAGE_SETTINGS_URL}.`,
};
const TEMPORARILY_UNAVAILABLE: PlanRule = {
  status: 503,
  retryable: true,
  message: 'ChatGPT plan usage is temporarily unavailable. Try again shortly.',
};

// Plan usage codes without their `subscription_sharing_` (or legacy
// `subscription_sharing_v2_`) prefix.
const PLAN_RULES: Record<string, PlanRule> = {
  usage_limit_exceeded: USAGE_LIMIT,
  workplace_individual_usage_limit_exceeded: USAGE_LIMIT,
  usage_unavailable: TEMPORARILY_UNAVAILABLE,
  user_unavailable: TEMPORARILY_UNAVAILABLE,
  user_not_eligible: {
    status: 403,
    retryable: false,
    message: 'This ChatGPT account cannot use its plan in other apps.',
  },
  unsupported_capability: {
    status: 400,
    retryable: false,
    message: 'ChatGPT plan usage does not support part of this request.',
  },
  route_not_supported: {
    status: 400,
    retryable: false,
    message: 'ChatGPT plan usage does not support this request.',
  },
  invalid_user: {
    status: 401,
    retryable: false,
    message:
      'ChatGPT could not confirm the connected account. Try again; if this continues, sign in again in settings.',
  },
};
const PLAN_ACCESS_DENIED: PlanRule = {
  status: 403,
  retryable: false,
  message: 'ChatGPT plan usage is not available for this account right now.',
};
const REQUEST_TOO_LARGE: PlanRule = {
  status: 413,
  retryable: false,
  message:
    'This request is too large for ChatGPT plan usage. Try a shorter conversation or fewer attachments.',
};

/** Reported when a response stream ends before a terminal event. */
export const ENDED_EARLY = 'openmaic_stream_ended_early';
const ENDED_EARLY_RULE: PlanRule = {
  status: 502,
  retryable: true,
  message: 'ChatGPT ended the response before it was complete. Try again.',
};

const SAFE_TOKEN = /^[A-Za-z0-9_.:[\]-]{1,128}$/;

function planRule(code: string | undefined): PlanRule | undefined {
  if (!code) return undefined;
  const plan = /^subscription_sharing_(?:v2_)?(.+)$/.exec(code);
  if (plan) return PLAN_RULES[plan[1]!];
  return code.startsWith('chatpass_') ? PLAN_ACCESS_DENIED : undefined;
}

/** Whether the failure is one of plan usage's own codes (not a token problem). */
export function isPlanUsageFailure(failure: UpstreamFailure): boolean {
  return planRule(failure.code) !== undefined;
}

function genericRule({ status, code }: UpstreamFailure): PlanRule {
  if (status === 413) return REQUEST_TOO_LARGE;
  if (code === ENDED_EARLY) return ENDED_EARLY_RULE;
  if (status === undefined) {
    // Reported inside a stream that had started: no HTTP status to keep.
    return {
      status: 502,
      retryable: /server_error|rate_limit|overloaded|timeout|unavailable/.test(code ?? ''),
      message: `The ChatGPT plan request failed${code && SAFE_TOKEN.test(code) ? ` (${code})` : ''}.`,
    };
  }
  return {
    status,
    retryable: status === 408 || status === 409 || status === 429 || status >= 500,
    message: `The ChatGPT plan request failed (HTTP ${status}).`,
  };
}

/**
 * The error an inference failure surfaces as. The message is fixed text, never
 * the server's (it can echo the request); the request ID is kept for support.
 * Plan usage codes are not retried; an exhausted usage limit is reported as a
 * quota refusal, so a configured fallback model may still serve the request.
 */
export function planCallError(
  failure: UpstreamFailure,
  request: { url: string; requestBodyValues?: unknown },
): APICallError {
  const rule = planRule(failure.code) ?? genericRule(failure);
  let message = rule.message;
  if (failure.code?.endsWith('unsupported_capability') && SAFE_TOKEN.test(failure.param ?? '')) {
    message += ` (unsupported: ${failure.param})`;
  }
  if (failure.requestId && SAFE_TOKEN.test(failure.requestId)) {
    message += ` Request ID: ${failure.requestId}.`;
  }
  const callError = new APICallError({
    message,
    url: request.url,
    requestBodyValues: request.requestBodyValues ?? {},
    statusCode: rule.status,
    isRetryable: rule.retryable,
    data: { code: failure.code },
    ...(rule.quota
      ? { cause: new ProviderQuotaExhaustedError(CHATGPT_PLAN_PROVIDER_ID, rule.message) }
      : {}),
  });
  planErrors.add(callError);
  return callError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read a failure from an error body (`{ error: { code, param } }`, or an
 * admission error's `{ detail }`) or from a stream frame (`error`, or the
 * `response.error` of `response.failed`).
 */
export function failureFrom(body: unknown): Pick<UpstreamFailure, 'code' | 'param'> {
  if (!isRecord(body)) return {};
  const nested =
    body.type === 'response.failed' && isRecord(body.response) ? body.response.error : body.error;
  const source = isRecord(nested) ? nested : isRecord(body.detail) ? body.detail : body;
  const code =
    typeof source.code === 'string'
      ? source.code
      : typeof body.detail === 'string' && /^[a-z0-9_]+$/.test(body.detail)
        ? body.detail
        : undefined;
  return {
    ...(code ? { code } : {}),
    ...(typeof source.param === 'string' ? { param: source.param } : {}),
  };
}
