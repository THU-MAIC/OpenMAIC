import { describe, expect, it } from 'vitest';
import {
  buildOllamaChatUrl,
  DEFAULT_CLOUD_OLLAMA_MODEL,
  DEFAULT_LOCAL_OLLAMA_MODEL,
  isOllamaCloud,
  readOllamaConfig,
} from '@/lib/cyberphysical/ollama';

describe('cyberphysical Ollama configuration', () => {
  it('maps local OpenAI-compatible URLs to the native chat endpoint', () => {
    expect(buildOllamaChatUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/api/chat');
    expect(buildOllamaChatUrl('http://ollama:11434/api')).toBe('http://ollama:11434/api/chat');
  });

  it('maps Ollama Cloud URLs to the native cloud chat endpoint', () => {
    expect(buildOllamaChatUrl('https://ollama.com/v1')).toBe('https://ollama.com/api/chat');
    expect(isOllamaCloud('https://ollama.com/v1')).toBe(true);
    expect(isOllamaCloud('http://ollama:11434/v1')).toBe(false);
  });

  it('uses a cloud model default and preserves the API key server-side', () => {
    const config = readOllamaConfig({
      OLLAMA_BASE_URL: 'https://ollama.com/v1',
      OLLAMA_API_KEY: 'test-key',
    });

    expect(config.deployment).toBe('cloud');
    expect(config.model).toBe(DEFAULT_CLOUD_OLLAMA_MODEL);
    expect(config.apiKey).toBe('test-key');
    expect(config.chatUrl).toBe('https://ollama.com/api/chat');
  });

  it('uses the first configured model for local Ollama', () => {
    const config = readOllamaConfig({
      OLLAMA_BASE_URL: 'http://ollama:11434/v1',
      OLLAMA_MODELS: 'qwen3:8b, gemma3:4b',
    });

    expect(config.deployment).toBe('local');
    expect(config.model).toBe('qwen3:8b');
  });

  it('falls back to a lightweight local model when no variables are configured', () => {
    const config = readOllamaConfig({});
    expect(config.deployment).toBe('local');
    expect(config.model).toBe(DEFAULT_LOCAL_OLLAMA_MODEL);
  });
});
