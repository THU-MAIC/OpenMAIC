import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import {
  isRejectedRedirectError,
  providerFetch,
  type ProviderFetchPolicy,
} from '@/lib/server/provider-fetch';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';
import {
  ALIDOCMIND_ENDPOINT_NOT_ALLOWED_MESSAGE,
  resolveSafeClientAliDocMindEndpoint,
} from '@/lib/server/alidocmind-endpoint';
import { MINERU_CLOUD_DEFAULT_BASE } from '@/lib/pdf/constants';

const log = createLogger('Verify PDF Provider');

// Probes of a caller-supplied base URL run under the operator address policy
// (the same one `validateClientBaseUrl` applied above: `allowLocalNetworks` unset
// falls back to ALLOW_LOCAL_NETWORKS), so a self-hosted provider on a local
// network still verifies when the operator opted in. A server-managed base URL
// is operator configuration and may reach a local network without the opt-in.
// The strict transport pins the connect address to the vetted DNS answers,
// closing the gap between validation and connect, and a 3xx is refused rather
// than followed.
function probePolicy(managed: boolean): ProviderFetchPolicy {
  return { allowLocalNetworks: managed ? true : undefined, rejectRedirects: true };
}

// Fixed messages: the probe target's body, status text and transport errors
// are logged server-side only and never echoed back to the caller.
const AUTH_FAILED_MESSAGE = 'Authentication failed, please check the API Key';
const CONNECTION_FAILED_MESSAGE = 'Cannot connect to server, please check the Base URL';

export async function POST(req: NextRequest) {
  let providerId: string | undefined;
  try {
    const body = await req.json();
    providerId = body.providerId;
    const { apiKey, baseUrl, accessKeyId, accessKeySecret } = body;

    if (!providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Provider ID is required');
    }

    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('pdf', providerId);

    // AliDocMind: verify AK/SK by issuing a lightweight authenticated probe.
    if (providerId === 'alidocmind') {
      let ak: string | undefined;
      let sk: string | undefined;
      let endpoint: string | undefined;

      if (managed) {
        // Managed: use server-owned credentials + endpoint only. Ignore any
        // client-supplied AK/SK/baseUrl.
        const serverCreds = resolveManagedAliDocMindCredentials();
        if (!serverCreds) {
          return apiError('INTERNAL_ERROR', 500, 'AliDocMind is not configured on the server');
        }
        ak = serverCreds.accessKeyId;
        sk = serverCreds.accessKeySecret;
        endpoint = serverCreds.baseUrl;
      } else {
        // Unmanaged: client credentials only — never fall back to server env.
        ak = (accessKeyId as string | undefined) || undefined;
        sk = (accessKeySecret as string | undefined) || undefined;
        endpoint = (baseUrl as string | undefined) || undefined;
        if (!ak || !sk) {
          return apiError(
            'MISSING_REQUIRED_FIELD',
            400,
            'AccessKey ID and AccessKey Secret are required for AliDocMind',
          );
        }
        // The DocMind SDK resolves and connects on its own, so a
        // client-supplied endpoint must be an official DocMind host; anything
        // else is refused before we sign a request to it.
        if (endpoint) {
          const safeEndpoint = resolveSafeClientAliDocMindEndpoint(endpoint);
          if (!safeEndpoint) {
            return apiError('INVALID_URL', 403, ALIDOCMIND_ENDPOINT_NOT_ALLOWED_MESSAGE);
          }
          endpoint = safeEndpoint;
        }
      }

      const { verifyAliDocMindCredentials } = await import('@/lib/pdf/alidocmind-client');
      const result = await verifyAliDocMindCredentials({
        accessKeyId: ak,
        accessKeySecret: sk,
        endpoint,
      });
      if (!result.ok) {
        return apiError('INVALID_CREDENTIALS', 400, `Authentication failed: ${result.error}`);
      }
      return apiSuccess({ message: 'Connection successful' });
    }

    // MinerU Cloud: verify by calling the cloud API with the token
    if (providerId === 'mineru-cloud') {
      const clientCloudBase = managed ? undefined : (baseUrl as string | undefined) || undefined;
      if (clientCloudBase) {
        const ssrfError = await validateClientBaseUrl(clientCloudBase);
        if (ssrfError) {
          return apiError('INVALID_URL', 403, ssrfError);
        }
      }

      const resolvedApiKey = resolvePDFApiKey(providerId, managed ? undefined : apiKey);
      if (!resolvedApiKey) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'API Key is required for MinerU Cloud');
      }

      const cloudBase = (
        resolvePDFBaseUrl(providerId, clientCloudBase) || MINERU_CLOUD_DEFAULT_BASE
      ).replace(/\/+$/, '');

      // Probe the batch endpoint with an empty body to verify auth
      const response = await providerFetch(
        `${cloudBase}/extract-results/batch/test-connection`,
        {
          headers: {
            Authorization: `Bearer ${resolvedApiKey}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        },
        probePolicy(managed),
      );
      // Only the status matters; release the connection without reading the body.
      await response.body?.cancel().catch(() => undefined);

      // Other responses (including 4xx for "batch not found") mean auth + connectivity works.
      // Only network errors, redirects, or 401/403 indicate a problem.
      if (response.status === 401 || response.status === 403) {
        log.warn(`MinerU Cloud probe rejected credentials [status=${response.status}]`);
        return apiError('INTERNAL_ERROR', 500, AUTH_FAILED_MESSAGE);
      }

      return apiSuccess({ message: 'Connection successful' });
    }

    // Self-hosted providers: verify by connecting to the base URL
    const clientBaseUrl = managed ? undefined : (baseUrl as string | undefined) || undefined;
    if (clientBaseUrl) {
      const ssrfError = await validateClientBaseUrl(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const resolvedBaseUrl = resolvePDFBaseUrl(providerId, clientBaseUrl);
    if (!resolvedBaseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    const resolvedApiKey = resolvePDFApiKey(providerId, managed ? undefined : apiKey);

    const headers: Record<string, string> = {};
    if (resolvedApiKey) {
      headers['Authorization'] = `Bearer ${resolvedApiKey}`;
    }

    const response = await providerFetch(
      resolvedBaseUrl,
      { headers, signal: AbortSignal.timeout(10000) },
      probePolicy(managed),
    );
    await response.body?.cancel().catch(() => undefined);

    // MinerU's FastAPI root returns 404 (no root route), but the server is reachable.
    // Any HTTP response (including 404) means the server is up.
    return apiSuccess({ message: 'Connection successful' });
  } catch (error) {
    log.error(`PDF provider verification failed [provider=${providerId ?? 'unknown'}]:`, error);

    if (isRejectedRedirectError(error)) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }
    // Refused, unresolvable, timed-out and policy-blocked targets all get the
    // same answer so the probe cannot be used to map internal services.
    return apiError('INTERNAL_ERROR', 500, CONNECTION_FAILED_MESSAGE);
  }
}
