# Cyberphysical geospatial telemetry

The Cyberphysical workspace adds an observe-first geospatial surface for physical AI agents. It shows the current position, observed trail, destination, planned route, heading, speed, accuracy and runtime source on an OpenStreetMap base layer.

## Open the workspace

Navigate to `/cyberphysical`.

The page includes two built-in data sources:

- **Demo route** — animates a small example route so the UI can be evaluated without hardware.
- **Browser geolocation** — uses `navigator.geolocation.watchPosition()` after explicit user interaction and renders the live trail locally in the browser.

## Runtime telemetry bridge

The map is deliberately decoupled from any particular robot, drone, vehicle or simulator. A same-origin runtime can publish the following payload shape:

```ts
interface AgentGeoTelemetry {
  agentId: string;
  current: {
    latitude: number;
    longitude: number;
    altitude?: number;
    accuracy?: number;
    timestamp?: string;
  };
  destination?: GeoPoint | null;
  route?: GeoPoint[]; // planned future path
  trail?: GeoPoint[]; // observed past path
  headingDeg?: number;
  speedMps?: number;
  state?: 'idle' | 'moving' | 'paused' | 'arrived' | 'offline';
  updatedAt: string;
  source?: string;
}
```

### BroadcastChannel

```ts
const channel = new BroadcastChannel('openmaic:cyberphysical-telemetry');
channel.postMessage({
  agentId: 'robot-1',
  current: { latitude: 40.00055, longitude: 116.3224, accuracy: 1.8 },
  destination: { latitude: 39.99942, longitude: 116.32792 },
  route: [
    { latitude: 40.00055, longitude: 116.3224 },
    { latitude: 40.00088, longitude: 116.32618 },
    { latitude: 39.99942, longitude: 116.32792 },
  ],
  state: 'moving',
  headingDeg: 82,
  speedMps: 1.3,
  updatedAt: new Date().toISOString(),
  source: 'ros2-web-bridge',
});
```

### In-process CustomEvent

```ts
window.dispatchEvent(
  new CustomEvent('openmaic:cyberphysical-telemetry', {
    detail: telemetry,
  }),
);
```

Incoming payloads are validated before rendering and route/trail arrays are capped to 500 points to keep the client bounded.

## Ollama telemetry analysis

`POST /api/cyberphysical/ollama` sends a bounded snapshot of the validated telemetry to an Ollama model and returns an operator-oriented summary. The prompt is deliberately observability-only: it asks for route progress, motion-state and anomaly observations, and explicitly excludes motor, actuator, navigation and remote-control commands.

The adapter uses Ollama's native `/api/chat` endpoint and accepts the same `OLLAMA_BASE_URL` style already used by OpenMAIC. A configured `/v1` suffix is normalized automatically, so both of these work:

- local/Compose: `http://ollama:11434/v1` -> `http://ollama:11434/api/chat`
- Ollama Cloud: `https://ollama.com/v1` -> `https://ollama.com/api/chat`

Only the server reads `OLLAMA_API_KEY`; it is never sent to the browser.

### Ollama Cloud example

Ollama Cloud can be called directly and does not require a local GPU or an Ollama container.

```bash
cp .env.ollama-cloud.example .env.local
# Edit .env.local and replace OLLAMA_API_KEY with your Ollama Cloud API key.
docker compose up --build
```

Example configuration:

```env
OLLAMA_BASE_URL=https://ollama.com/v1
OLLAMA_API_KEY=replace-with-your-ollama-cloud-api-key
OLLAMA_MODEL=gpt-oss:120b
OLLAMA_MODELS=gpt-oss:120b
```

Example request through OpenMAIC:

```bash
curl -X POST http://localhost:3000/api/cyberphysical/ollama \
  -H 'Content-Type: application/json' \
  -d '{
    "telemetry": {
      "agentId": "robot-1",
      "current": {"latitude": 40.00055, "longitude": 116.3224},
      "destination": {"latitude": 39.99942, "longitude": 116.32792},
      "headingDeg": 82,
      "speedMps": 1.3,
      "state": "moving",
      "updatedAt": "2026-08-30T17:00:00.000Z",
      "source": "ros2-web-bridge"
    }
  }'
```

The response shape is:

```json
{
  "provider": "ollama",
  "deployment": "cloud",
  "model": "gpt-oss:120b",
  "analysis": "..."
}
```

### Local Ollama with Docker Compose

The repository includes `docker-compose.ollama.yml` as an optional extension to the existing Compose stack. It starts the official Ollama image only when the `local-ollama` profile is enabled and keeps downloaded models in a named volume.

```bash
cp .env.ollama-local.example .env.local

docker compose \
  -f docker-compose.yml \
  -f docker-compose.ollama.yml \
  --profile local-ollama \
  up --build
```

Pull the example model once the service is running:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.ollama.yml \
  --profile local-ollama \
  exec ollama ollama pull gemma3:4b
```

The local configuration is:

```env
OLLAMA_BASE_URL=http://ollama:11434/v1
OLLAMA_MODEL=gemma3:4b
OLLAMA_MODELS=gemma3:4b
```

For host-native Ollama rather than the Compose service, use `http://localhost:11434/v1` when OpenMAIC itself is also running on the host.

## Safety boundary

This first cyberphysical capability is **telemetry-only**. It does not expose motor, actuator, navigation or other remote-control commands. Device-specific control should be introduced separately with explicit authentication, authorization, safety interlocks and auditability rather than being coupled to the visualization channel.

The Ollama integration preserves that boundary: model output is returned as analysis text only and is not wired to any actuator channel.

## Map data

Raster tiles are loaded from OpenStreetMap and attribution is always visible in the map UI. Production deployments with sustained traffic should follow the OpenStreetMap tile usage policy or configure an appropriate tile provider in a follow-up adapter.
