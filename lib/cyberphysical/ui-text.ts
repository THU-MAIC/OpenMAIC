export const CYBERPHYSICAL_TEXT: Record<string, string> = {
  'cyberphysical.openMonitor': 'Open cyberphysical geospatial monitor',
  'cyberphysical.backToOpenMAIC': 'Back to OpenMAIC',
  'cyberphysical.title': 'Cyberphysical',
  'cyberphysical.subtitle': 'Geospatial agent monitor',
  'cyberphysical.unknownSource': 'unknown source',
  'cyberphysical.observabilityBadge': 'Physical-world observability',
  'cyberphysical.heroTitle': 'See where the agent is—and where it is going',
  'cyberphysical.heroDescription':
    'Live position, observed trail, destination and planned route on an OpenStreetMap base layer. Click the map to set a target in the local preview.',
  'cyberphysical.stopSimulation': 'Stop simulation',
  'cyberphysical.runDemo': 'Run demo route',
  'cyberphysical.stopLiveLocation': 'Stop live location',
  'cyberphysical.useBrowserLocation': 'Use browser location',
  'cyberphysical.geolocationUnavailable':
    'Browser geolocation is not available in this environment.',
  'cyberphysical.locationReadError': 'Unable to read browser location.',
  'cyberphysical.routeAwarenessTitle': 'Route awareness',
  'cyberphysical.routeAwarenessDescription':
    'Separates observed history from the planned route, so operators can compare intent with physical execution.',
  'cyberphysical.runtimeBridgeTitle': 'Runtime telemetry bridge',
  'cyberphysical.runtimeBridgeDescription':
    'Same-origin agents can publish structured telemetry through BroadcastChannel or a DOM CustomEvent without coupling the map to one robot stack.',
  'cyberphysical.observeFirstTitle': 'Observe-first boundary',
  'cyberphysical.observeFirstDescription':
    'This section consumes telemetry only. It intentionally does not expose actuator or remote-control commands.',
  'cyberphysical.activeAgent': 'Active agent',
  'cyberphysical.speed': 'Speed',
  'cyberphysical.toTarget': 'To target',
  'cyberphysical.heading': 'Heading',
  'cyberphysical.accuracy': 'Accuracy',
  'cyberphysical.demoProgress': 'Demo route progress',
  'cyberphysical.position': 'Position',
  'cyberphysical.latitude': 'Latitude',
  'cyberphysical.longitude': 'Longitude',
  'cyberphysical.updated': 'Updated',
  'cyberphysical.bridgeTitle': 'Cyberphysical bridge',
  'cyberphysical.bridgeActive': 'Telemetry bridge active',
  'cyberphysical.bridgeWaiting': 'Waiting for telemetry bridge',
  'cyberphysical.bridgeDescription':
    'Publish an AgentGeoTelemetry payload on the channel below from any same-origin runtime adapter.',
  'cyberphysical.mapAria': 'Geospatial agent map. Click the map to choose a destination.',
  'cyberphysical.destination': 'Destination',
  'cyberphysical.zoomIn': 'Zoom in',
  'cyberphysical.zoomOut': 'Zoom out',
  'cyberphysical.observedTrail': 'observed trail',
  'cyberphysical.plannedRoute': 'planned route',
  'cyberphysical.state.idle': 'idle',
  'cyberphysical.state.moving': 'moving',
  'cyberphysical.state.paused': 'paused',
  'cyberphysical.state.arrived': 'arrived',
  'cyberphysical.state.offline': 'offline',
};

export function cyberphysicalText(key: string): string {
  return CYBERPHYSICAL_TEXT[key] ?? key;
}
