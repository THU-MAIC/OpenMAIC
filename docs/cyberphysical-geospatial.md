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

## Safety boundary

This first cyberphysical capability is **telemetry-only**. It does not expose motor, actuator, navigation or other remote-control commands. Device-specific control should be introduced separately with explicit authentication, authorization, safety interlocks and auditability rather than being coupled to the visualization channel.

## Map data

Raster tiles are loaded from OpenStreetMap and attribution is always visible in the map UI. Production deployments with sustained traffic should follow the OpenStreetMap tile usage policy or configure an appropriate tile provider in a follow-up adapter.
