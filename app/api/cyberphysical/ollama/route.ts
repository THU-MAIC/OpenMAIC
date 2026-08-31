import { NextResponse } from 'next/server';
import { parseAgentGeoTelemetry, type AgentGeoTelemetry } from '@/lib/cyberphysical/geo';
import { readOllamaConfig } from '@/lib/cyberphysical/ollama';

const MAX_AI_ROUTE_POINTS = 20;
const REQUEST_TIMEOUT_MS = 60_000;

interface OllamaChatResponse {
  model?: string;
  message?: {
    content?: string;
  };
  error?: string;
}

function compactTelemetry(telemetry: AgentGeoTelemetry) {
  return {
    agentId: telemetry.agentId,
    current: telemetry.current,
    destination: telemetry.destination ?? null,
    route: telemetry.route?.slice(-MAX_AI_ROUTE_POINTS),
    trail: telemetry.trail?.slice(-MAX_AI_ROUTE_POINTS),
    headingDeg: telemetry.headingDeg,
    speedMps: telemetry.speedMps,
    state: telemetry.state,
    updatedAt: telemetry.updatedAt,
    source: telemetry.source,
  };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const telemetry = parseAgentGeoTelemetry(body?.telemetry);

  if (!telemetry) {
    return NextResponse.json(
      { error: 'A valid AgentGeoTelemetry payload is required.' },
      { status: 400 },
    );
  }

  const config = readOllamaConfig();
  if (config.deployment === 'cloud' && !config.apiKey) {
    return NextResponse.json(
      {
        error:
          'Ollama Cloud is configured but OLLAMA_API_KEY is missing. Add it to the server environment.',
      },
      { status: 503 },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(config.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'You are a cyberphysical observability assistant. Analyze telemetry for route progress, anomalies, motion state, and operator-relevant observations. Be concise and evidence-based. This interface is telemetry-only: do not issue motor, actuator, navigation, or remote-control commands.',
          },
          {
            role: 'user',
            content: `Analyze this agent telemetry and summarize what the operator should notice:\n${JSON.stringify(compactTelemetry(telemetry))}`,
          },
        ],
      }),
      cache: 'no-store',
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as OllamaChatResponse | null;
    if (!response.ok) {
      const upstreamMessage = payload?.error?.trim();
      return NextResponse.json(
        {
          error: upstreamMessage
            ? `Ollama request failed: ${upstreamMessage}`
            : `Ollama request failed with status ${response.status}.`,
        },
        { status: response.status >= 400 && response.status < 600 ? response.status : 502 },
      );
    }

    const analysis = payload?.message?.content?.trim();
    if (!analysis) {
      return NextResponse.json({ error: 'Ollama returned an empty analysis.' }, { status: 502 });
    }

    return NextResponse.json({
      provider: 'ollama',
      deployment: config.deployment,
      model: payload?.model || config.model,
      analysis,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return NextResponse.json(
      {
        error: timedOut
          ? 'Ollama analysis timed out.'
          : 'Unable to reach the configured Ollama endpoint.',
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
