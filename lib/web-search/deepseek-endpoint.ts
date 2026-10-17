/** Normalize the official API root while preserving gateway path prefixes. */
export function deepseekToolsEndpoint(baseUrl: string, tool: 'search' | 'fetch'): string {
  const base = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new Error('Invalid DeepSeek API base URL');
  }
  const path = base.hostname === 'api.deepseek.com' ? '/v1' : base.pathname.replace(/\/+$/, '');
  base.pathname = `${path || '/v1'}/tools/${tool}`;
  return base.href;
}
