export type OllamaDeployment = 'cloud' | 'local';

export interface OllamaConfig {
  baseUrl: string;
  chatUrl: string;
  apiKey?: string;
  model: string;
  deployment: OllamaDeployment;
}

export const DEFAULT_LOCAL_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_LOCAL_OLLAMA_MODEL = 'gemma3:4b';
export const DEFAULT_CLOUD_OLLAMA_MODEL = 'gpt-oss:120b';

function normalizeBaseUrl(baseUrl: string): URL {
  const value = baseUrl.trim() || DEFAULT_LOCAL_OLLAMA_BASE_URL;
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

export function isOllamaCloud(baseUrl: string): boolean {
  try {
    const url = normalizeBaseUrl(baseUrl);
    return url.hostname.toLowerCase() === 'ollama.com';
  } catch {
    return false;
  }
}

/**
 * Convert an Ollama host, native `/api` base, or OpenAI-compatible `/v1` base
 * into the native chat endpoint used by both local Ollama and Ollama Cloud.
 */
export function buildOllamaChatUrl(baseUrl: string): string {
  const url = normalizeBaseUrl(baseUrl);
  let path = url.pathname.replace(/\/+$/, '');

  if (path.endsWith('/v1')) {
    path = path.slice(0, -3);
  }
  if (path.endsWith('/api')) {
    path = path.slice(0, -4);
  }

  url.pathname = `${path}/api/chat`.replace(/\/+/g, '/');
  return url.toString().replace(/\/$/, '');
}

function firstConfiguredModel(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.OLLAMA_MODEL?.trim();
  if (explicit) return explicit;

  return env.OLLAMA_MODELS?.split(',')
    .map((model) => model.trim())
    .find(Boolean);
}

export function readOllamaConfig(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  const baseUrl = env.OLLAMA_BASE_URL?.trim() || DEFAULT_LOCAL_OLLAMA_BASE_URL;
  const deployment: OllamaDeployment = isOllamaCloud(baseUrl) ? 'cloud' : 'local';
  const model =
    firstConfiguredModel(env) ??
    (deployment === 'cloud' ? DEFAULT_CLOUD_OLLAMA_MODEL : DEFAULT_LOCAL_OLLAMA_MODEL);
  const apiKey = env.OLLAMA_API_KEY?.trim() || undefined;

  return {
    baseUrl,
    chatUrl: buildOllamaChatUrl(baseUrl),
    apiKey,
    model,
    deployment,
  };
}
