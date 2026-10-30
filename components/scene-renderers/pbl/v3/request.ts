import { readPblJson } from '@/lib/pbl/v3/response';
import { sandboxErrorMessage } from '@/lib/sandbox/error-message';
import { SandboxRequestError } from '@/components/sandbox/client';

const headers = { 'content-type': 'application/json', 'x-openmaic-sandbox': '1' };
export async function pblRequest<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers,
    ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await readPblJson(response);
  if (!response.ok)
    throw new SandboxRequestError(
      sandboxErrorMessage(data.error),
      response.status,
      data.error?.code,
      data.error?.reason,
    );
  return data as T;
}
