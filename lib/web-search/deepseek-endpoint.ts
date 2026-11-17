/** The DeepSeek tool APIs served under `/v1/tools/*` with the platform API key. */
export type DeepSeekTool = 'search' | 'fetch' | 'asr' | 'tts' | 'ocr';

/** The official DeepSeek API root the tool endpoints hang off. */
export const DEEPSEEK_TOOLS_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';

/** Normalize the official API root while preserving gateway path prefixes. */
export function deepseekToolsEndpoint(baseUrl: string, tool: DeepSeekTool): string {
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
