/** Preserve the regional origin, gateway prefix and query parameters across MiniMax APIs. */
export function minimaxEndpoint(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const v1 = basePath.endsWith('/v1') ? basePath : `${basePath}/v1`;
  url.pathname = `${v1}/${path}`;
  url.hash = '';
  return url;
}

export function minimaxStatusCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
