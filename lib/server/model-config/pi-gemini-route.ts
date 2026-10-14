/** The one Google compatible route known to be unsuitable for Pi tool calling. */
export function isPiGeminiCompatibleRoute(
  providerType: string | undefined,
  baseUrl: string | undefined,
): boolean {
  if (providerType !== 'openai' || !baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return (
      url.hostname === 'generativelanguage.googleapis.com' &&
      (url.pathname === '/v1beta/openai' || url.pathname === '/v1beta/openai/')
    );
  } catch {
    return false;
  }
}

export class PiGeminiNativeRequiredError extends Error {
  constructor() {
    super(
      'Pi classroom interaction with Gemini requires Google native. Add Google in Settings → Model Services using the google preset, then select it for Classroom Interaction in Course Model Config, or contact your administrator if this configuration is managed.',
    );
    this.name = 'PiGeminiNativeRequiredError';
  }
}
