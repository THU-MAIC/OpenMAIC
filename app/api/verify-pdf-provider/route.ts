import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { MINERU_CLOUD_DEFAULT_BASE } from '@/lib/pdf/constants';

const log = createLogger('Verify PDF Provider');

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
        // Validate a client-supplied endpoint before we sign a request to it.
        if (endpoint && process.env.NODE_ENV === 'production') {
          const ssrfError = await validateUrlForSSRF(
            endpoint.startsWith('http') ? endpoint : `https://${endpoint}`,
          );
          if (ssrfError) {
            return apiError('INVALID_URL', 403, ssrfError);
          }
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
      if (clientCloudBase && process.env.NODE_ENV === 'production') {
        const ssrfError = await validateUrlForSSRF(clientCloudBase);
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
      const response = await fetch(`${cloudBase}/extract-results/batch/test-connection`, {
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
      }

      // Other responses (including 4xx for "batch not found") mean auth + connectivity works.
      // Only network errors, redirects, or 401/403 indicate a problem.
      if (response.status === 401 || response.status === 403) {
        const text = await response.text().catch(() => '');
        return apiError(
          'INTERNAL_ERROR',
          500,
          `Authentication failed: ${text || response.statusText}`,
        );
      }

      return apiSuccess({
        message: 'Connection successful',
        status: response.status,
      });
    }

    // Self-hosted providers: verify by connecting to the base URL
    const clientBaseUrl = managed ? undefined : (baseUrl as string | undefined) || undefined;
    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
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

    const response = await fetch(resolvedBaseUrl, {
      headers,
      signal: AbortSignal.timeout(10000),
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    // MinerU's FastAPI root returns 404 (no root route), but the server is reachable.
    // Any HTTP response (including 404) means the server is up.
    return apiSuccess({
      message: 'Connection successful',
      status: response.status,
    });
  } catch (error) {
    log.error(`PDF provider verification failed [provider=${providerId ?? 'unknown'}]:`, error);

    let errorMessage = 'Connection failed';
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED')) {
        errorMessage = 'Cannot connect to server, please check the Base URL';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = 'Server not found, please check the Base URL';
      } else if (error.message.includes('timeout') || error.name === 'TimeoutError') {
        errorMessage = 'Connection timed out';
      } else {
        errorMessage = error.message;
      }
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
}
