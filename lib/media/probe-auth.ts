import { isRejectedRedirectError } from '@/lib/utils/rejected-redirect';

type ConnectivityResult = {
  success: boolean;
  message: string;
};

interface ProbeAuthOptions {
  providerName: string;
  request: () => Promise<Response>;
}

// Connectivity results are shown to the caller, so they carry fixed text only:
// never the provider's body, and never the transport error (which would tell a
// refused port from an unresolvable host or a timeout).

/** Result for a probe whose provider answered `status` (not a success). */
export function connectivityHttpFailure(providerName: string, status: number): ConnectivityResult {
  if (status >= 300 && status < 400) {
    return {
      success: false,
      message: `${providerName} connectivity error: Redirects are not allowed`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      success: false,
      message: `${providerName} auth failed (${status}), please check the API Key`,
    };
  }
  return { success: false, message: `${providerName} returned HTTP ${status}` };
}

/** Result for a probe whose request threw before any answer. */
export function connectivityTransportFailure(
  providerName: string,
  error: unknown,
): ConnectivityResult {
  if (isRejectedRedirectError(error)) {
    return {
      success: false,
      message: `${providerName} connectivity error: Redirects are not allowed`,
    };
  }
  return {
    success: false,
    message: `${providerName} connectivity error: cannot reach the provider, please check the Base URL`,
  };
}

/**
 * Auth-only probe: any answer except a redirect or 401/403 counts as connected
 * (a 4xx for a made-up task id still proves the key was accepted).
 */
export async function probeAuth({
  providerName,
  request,
}: ProbeAuthOptions): Promise<ConnectivityResult> {
  let response: Response;
  try {
    response = await request();
  } catch (err) {
    return connectivityTransportFailure(providerName, err);
  }
  // Only the status matters; release the connection without reading the body.
  await response.body?.cancel().catch(() => undefined);
  if (
    (response.status >= 300 && response.status < 400) ||
    response.status === 401 ||
    response.status === 403
  ) {
    return connectivityHttpFailure(providerName, response.status);
  }
  return { success: true, message: `Connected to ${providerName}` };
}
