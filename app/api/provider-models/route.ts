import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';

function normalizeBaseUrl(input?: string): string {
  const raw = (input || '').trim();
  return raw.replace(/\/+$/, '');
}

export async function POST(req: NextRequest) {
  try {
    const {
      apiKey,
      baseUrl,
      providerType,
      requiresApiKey,
    }: {
      apiKey?: string;
      baseUrl?: string;
      providerType?: 'openai' | 'anthropic' | 'google';
      requiresApiKey?: boolean;
    } = await req.json();

    if (!providerType) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Provider type is required');
    }

    if (requiresApiKey !== false && !apiKey) {
      return apiError('INVALID_REQUEST', 400, 'API key is required');
    }

    const base = normalizeBaseUrl(baseUrl);
    if (!base) {
      return apiError('INVALID_REQUEST', 400, 'Base URL is required');
    }

    if (providerType === 'openai') {
      const res = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey || ''}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const text = await res.text();
        return apiError(
          'INTERNAL_ERROR',
          res.status,
          `Failed to fetch models: ${text || res.statusText}`,
        );
      }

      const data = (await res.json()) as {
        data?: Array<{ id: string; owned_by?: string }>;
      };

      const models = (data.data || [])
        .map((m) => ({ id: m.id, name: m.id }))
        .filter((m) => !!m.id)
        .sort((a, b) => a.id.localeCompare(b.id));

      return apiSuccess({ models });
    }

    if (providerType === 'anthropic') {
      const res = await fetch(`${base}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey || '',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const text = await res.text();
        return apiError(
          'INTERNAL_ERROR',
          res.status,
          `Failed to fetch models: ${text || res.statusText}`,
        );
      }

      const data = (await res.json()) as {
        data?: Array<{ id: string; display_name?: string }>;
      };

      const models = (data.data || [])
        .map((m) => ({ id: m.id, name: m.display_name || m.id }))
        .filter((m) => !!m.id)
        .sort((a, b) => a.id.localeCompare(b.id));

      return apiSuccess({ models });
    }

    if (providerType === 'google') {
      const key = encodeURIComponent(apiKey || '');
      const sep = base.includes('?') ? '&' : '?';
      const res = await fetch(`${base}/models${sep}key=${key}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const text = await res.text();
        return apiError(
          'INTERNAL_ERROR',
          res.status,
          `Failed to fetch models: ${text || res.statusText}`,
        );
      }

      const data = (await res.json()) as {
        models?: Array<{ name: string; displayName?: string }>;
      };

      const models = (data.models || [])
        .map((m) => {
          const id = (m.name || '').replace(/^models\//, '');
          return { id, name: m.displayName || id };
        })
        .filter((m) => !!m.id)
        .sort((a, b) => a.id.localeCompare(b.id));

      return apiSuccess({ models });
    }

    return apiError('INVALID_REQUEST', 400, `Unsupported provider type: ${providerType}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
