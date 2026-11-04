import { sandboxErrorMessage } from '@/lib/sandbox/error-message';
export class SandboxRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}
export const sandboxBase = '/api/sandbox/environments';
export async function sandboxApi<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  return sandboxRequest(sandboxBase + path, method, body);
}
export async function sandboxRequest<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    headers: { 'X-OpenMAIC-Sandbox': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok || !json.success)
    throw new SandboxRequestError(
      sandboxErrorMessage(json.error),
      response.status,
      json.error?.code,
      json.error?.reason,
    );
  return json.data;
}
