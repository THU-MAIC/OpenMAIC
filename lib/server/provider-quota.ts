/**
 * A provider's explicit refusal because a plan, credit or balance is
 * exhausted, as opposed to temporary rate limiting.
 *
 * The shared failure classification stays provider neutral: it recognizes this
 * marker and the OpenAI-compatible wire codes, never a vendor's own codes. A
 * provider adapter that knows its native quota codes translates them into this
 * error: it throws it, or attaches it as the `cause` of the error it throws
 * when that error's own type has to stay (a rate-limit error a route answers
 * 429 for). The marker carries no HTTP status. Generation skips automatic
 * retries of this provider but may still use a configured model fallback.
 */
export class ProviderQuotaExhaustedError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProviderQuotaExhaustedError';
  }
}
