import { NextResponse } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { getModel } from '@/lib/ai/providers';
import { parseAgentGeoTelemetry, type AgentGeoTelemetry } from '@/lib/cyberphysical/geo';
import { readOllamaConfig } from '@/lib/cyberphysical/ollama';

const MAX_AI_ROUTE_POINTS = 20;
const REQUEST_TIMEOUT_MS = 60_000;

function compactTelemetry(telemetry: AgentGeoTelemetry) {
  return {
    agentId: telemetry.agentId,
    current: telemetry.current,
    destination: telemetry.destination ?? null,
    route: telemetry.route?.slice(0, MAX_AI_ROUTE_POINTS),
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
    const { model } = getModel({
      providerId: 'ollama',
      modelId: config.model,
      apiKey: config.apiKey ?? '',
      baseUrl: config.baseUrl,
    });

    const result = await callLLM(
      {
        model,
        system:
          'You are a cyberphysical observability assistant. Analyze telemetry for route progress, anomalies, motion state, and operator-relevant observations. Be concise and evidence-based. This interface is telemetry-only: do not issue motor, actuator, navigation, or remote-control commands.',
        prompt: `Analyze this agent telemetry and summarize what the operator should notice:\n${JSON.stringify(compactTelemetry(telemetry))}`,
        abortSignal: controller.signal,
      },
      'cyberphysical-ollama-telemetry',
    );

    const analysis = result.text.trim();
    if (!analysis) {
      return NextResponse.json({ error: 'Ollama returned an empty analysis.' }, { status: 502 });
    }

    return NextResponse.json({
      provider: 'ollama',
      deployment: config.deployment,
      model: config.model,
      analysis,
    });
  } catch (error) {
    const timedOut =
      controller.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
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
