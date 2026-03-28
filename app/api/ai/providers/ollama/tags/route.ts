/**
 * Ollama API endpoint to get list of available local models
 * GET /api/ai/providers/ollama/tags
 */

import { NextResponse } from 'next/server';
import type { ModelInfo } from '@/lib/types/provider';
import { getProvider } from '@/lib/ai/providers';
import { resolveBaseUrl } from '@/lib/server/provider-config';

/**
 * Response from Ollama /api/tags endpoint
 * @see https://ollama.com/docs/api
 */
interface OllamaModel {
  name: string;
  model: string;
  digest: string;
  size: number;
  modified_at: string;
  details: {
    parameter_size: string;
    quantization_level: string;
  };
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

/**
 * Convert Ollama model info to OpenMAIC ModelInfo format
 */
function convertOllamaModelToModelInfo(model: OllamaModel): ModelInfo {
  // Estimate context window based on parameter size
  // This is a rough heuristic - actual depends on how the user loaded the model
  let contextWindow = 8192;
  const paramSize = model.details.parameter_size?.toLowerCase() || '';
  
  if (paramSize.includes('1b') || paramSize.includes('2b')) {
    contextWindow = 32768;
  } else if (paramSize.includes('7b') || paramSize.includes('8b')) {
    contextWindow = 128000;
  } else if (paramSize.includes('13b') || paramSize.includes('14b')) {
    contextWindow = 128000;
  } else if (paramSize.includes('30b') || paramSize.includes('34b')) {
    contextWindow = 200000;
  } else if (paramSize.includes('70b')) {
    contextWindow = 200000;
  }

  // Check if model is vision-capable by name
  const hasVision = /vision|vl|multimodal/i.test(model.name);
  
  // Check if model is a reasoning model (deepseek-r1, etc.)
  const isReasoning = /r1|reason|thinking/i.test(model.name);

  const capabilities: ModelInfo['capabilities'] = {
    streaming: true,
    vision: hasVision,
    tools: !hasVision, // Most Llama-based models support tools except vision-only
  };

  if (isReasoning) {
    capabilities.thinking = {
      toggleable: false,
      budgetAdjustable: false,
      defaultEnabled: true,
    };
  }

  return {
    id: model.name,
    name: `${model.name} (${model.details.parameter_size} ${model.details.quantization_level})`,
    contextWindow,
    outputWindow: Math.floor(contextWindow / 4),
    capabilities,
  };
}

export async function GET() {
  try {
    // Get provider configuration
    const provider = getProvider('ollama');
    if (!provider) {
      return NextResponse.json({ error: 'Ollama provider not configured' }, { status: 404 });
    }

    // Get base URL from environment or use default
    const serverBaseUrl = resolveBaseUrl('ollama');
    const baseUrl = serverBaseUrl || provider.defaultBaseUrl;

    if (!baseUrl) {
      return NextResponse.json({ error: 'Base URL not configured for Ollama' }, { status: 400 });
    }

    // Strip trailing slash and /v1 if present (Ollama's tags endpoint is at /api/tags)
    let cleanBaseUrl = baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const tagsUrl = `${cleanBaseUrl}/api/tags`;

    // Fetch models from local Ollama
    const response = await fetch(tagsUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          error: `Failed to connect to Ollama: ${response.status} ${response.statusText}`,
          details: `Is Ollama running at ${cleanBaseUrl}?`,
        },
        { status: response.status }
      );
    }

    const data = (await response.json()) as OllamaTagsResponse;
    
    if (!data.models || !Array.isArray(data.models)) {
      return NextResponse.json({ models: [] });
    }

    // Convert to OpenMAIC format
    const models: ModelInfo[] = data.models.map(convertOllamaModelToModelInfo);

    return NextResponse.json({ models });
  } catch (error) {
    console.error('[Ollama Tags API] Error:', error);
    
    const message = error instanceof Error ? error.message : String(error);
    
    return NextResponse.json(
      {
        error: 'Connection error',
        details: `Could not connect to Ollama: ${message}`,
        hint: 'Please ensure Ollama is running and the Base URL is configured correctly',
      },
      { status: 503 }
    );
  }
}
