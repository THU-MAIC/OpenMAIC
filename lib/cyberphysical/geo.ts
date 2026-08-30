export const CYBERPHYSICAL_TELEMETRY_CHANNEL = 'openmaic:cyberphysical-telemetry';
export const CYBERPHYSICAL_TELEMETRY_EVENT = 'openmaic:cyberphysical-telemetry';
export const MAX_ROUTE_POINTS = 500;

const EARTH_RADIUS_METERS = 6_371_008.8;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const TILE_SIZE = 256;

export type AgentMotionState = 'idle' | 'moving' | 'paused' | 'arrived' | 'offline';

export interface GeoPoint {
  latitude: number;
  longitude: number;
  altitude?: number;
  accuracy?: number;
  timestamp?: string;
  label?: string;
}

export interface AgentGeoTelemetry {
  agentId: string;
  current: GeoPoint;
  destination?: GeoPoint | null;
  route?: GeoPoint[];
  trail?: GeoPoint[];
  headingDeg?: number;
  speedMps?: number;
  state?: AgentMotionState;
  updatedAt: string;
  source?: string;
}

export interface WorldPoint {
  x: number;
  y: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

export function clampMercatorLatitude(latitude: number): number {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

export function sanitizeGeoPoint(value: unknown): GeoPoint | null {
  if (!isRecord(value)) return null;

  const latitude = finiteNumber(value.latitude);
  const longitude = finiteNumber(value.longitude);
  if (latitude === undefined || longitude === undefined) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  const altitude = finiteNumber(value.altitude);
  const accuracy = finiteNumber(value.accuracy);
  const timestamp = optionalString(value.timestamp);
  const label = optionalString(value.label);

  return {
    latitude,
    longitude,
    ...(altitude !== undefined ? { altitude } : {}),
    ...(accuracy !== undefined && accuracy >= 0 ? { accuracy } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(label ? { label } : {}),
  };
}

function sanitizePointArray(value: unknown): GeoPoint[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const points = value
    .slice(0, MAX_ROUTE_POINTS)
    .map(sanitizeGeoPoint)
    .filter((point): point is GeoPoint => point !== null);

  return points.length ? points : undefined;
}

const MOTION_STATES = new Set<AgentMotionState>([
  'idle',
  'moving',
  'paused',
  'arrived',
  'offline',
]);

export function parseAgentGeoTelemetry(value: unknown): AgentGeoTelemetry | null {
  if (!isRecord(value)) return null;

  const agentId = optionalString(value.agentId);
  const current = sanitizeGeoPoint(value.current);
  if (!agentId || !current) return null;

  const destination = value.destination === null ? null : sanitizeGeoPoint(value.destination);
  const route = sanitizePointArray(value.route);
  const trail = sanitizePointArray(value.trail);
  const headingDeg = finiteNumber(value.headingDeg);
  const speedMps = finiteNumber(value.speedMps);
  const requestedState = optionalString(value.state);
  const state =
    requestedState && MOTION_STATES.has(requestedState as AgentMotionState)
      ? (requestedState as AgentMotionState)
      : undefined;

  return {
    agentId,
    current,
    ...(destination !== undefined ? { destination } : {}),
    ...(route ? { route } : {}),
    ...(trail ? { trail } : {}),
    ...(headingDeg !== undefined ? { headingDeg: ((headingDeg % 360) + 360) % 360 } : {}),
    ...(speedMps !== undefined && speedMps >= 0 ? { speedMps } : {}),
    ...(state ? { state } : {}),
    updatedAt: optionalString(value.updatedAt) ?? new Date().toISOString(),
    ...(optionalString(value.source) ? { source: optionalString(value.source) } : {}),
  };
}

export function projectGeoPoint(point: GeoPoint, zoom: number): WorldPoint {
  const latitude = clampMercatorLatitude(point.latitude);
  const longitude = normalizeLongitude(point.longitude);
  const sinLatitude = Math.sin((latitude * Math.PI) / 180);
  const worldSize = TILE_SIZE * 2 ** zoom;

  return {
    x: ((longitude + 180) / 360) * worldSize,
    y:
      (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) *
      worldSize,
  };
}

export function unprojectWorldPoint(point: WorldPoint, zoom: number): GeoPoint {
  const worldSize = TILE_SIZE * 2 ** zoom;
  const longitude = (point.x / worldSize) * 360 - 180;
  const mercatorY = 0.5 - point.y / worldSize;
  const latitude = 90 - (360 * Math.atan(Math.exp(-mercatorY * 2 * Math.PI))) / Math.PI;

  return {
    latitude: clampMercatorLatitude(latitude),
    longitude: normalizeLongitude(longitude),
  };
}

export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const deltaLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const deltaLon = ((b.longitude - a.longitude) * Math.PI) / 180;

  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const haversine = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function formatCoordinate(value: number): string {
  return value.toFixed(6);
}
