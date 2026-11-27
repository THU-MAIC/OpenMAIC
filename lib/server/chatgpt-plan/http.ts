import 'server-only';

import { llmFetchTimeoutMs } from '@/lib/ai/providers';
import { toCallerSafeTransportError } from '@/lib/server/llm-provider-fetch';
import { providerFetch } from '@/lib/server/provider-fetch';

// Every ChatGPT plan request goes to a fixed public OpenAI host. Redirects are
// refused, so a bearer token or an authorization code never follows one.

const AUTH_TIMEOUT_MS = 30_000;

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

/** For the OAuth endpoints, which `oauth.ts` only takes from the issuer's origin. */
export const authFetch: typeof fetch = (input, init) =>
  providerFetch(requestUrl(input), init, {
    allowLocalNetworks: false,
    rejectRedirects: true,
    headersTimeout: AUTH_TIMEOUT_MS,
    bodyTimeout: AUTH_TIMEOUT_MS,
  });

/** For inference, with the time budget of other model calls. */
export const inferenceFetch: typeof fetch = async (input, init) => {
  try {
    return await providerFetch(requestUrl(input), init, {
      allowLocalNetworks: false,
      rejectRedirects: true,
      headersTimeout: llmFetchTimeoutMs(),
      bodyTimeout: llmFetchTimeoutMs(),
    });
  } catch (error) {
    throw toCallerSafeTransportError(error);
  }
};
