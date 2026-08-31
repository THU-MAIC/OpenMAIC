import { describe, expect, it } from 'vitest';
import {
  MAX_ROUTE_POINTS,
  distanceMeters,
  parseAgentGeoTelemetry,
  projectGeoPoint,
  unprojectWorldPoint,
} from '@/lib/cyberphysical/geo';

describe('cyberphysical geospatial helpers', () => {
  it('round-trips coordinates through Web Mercator projection', () => {
    const source = { latitude: 40.00055, longitude: 116.3224 };
    const projected = projectGeoPoint(source, 16);
    const restored = unprojectWorldPoint(projected, 16);

    expect(restored.latitude).toBeCloseTo(source.latitude, 6);
    expect(restored.longitude).toBeCloseTo(source.longitude, 6);
  });

  it('computes realistic great-circle distances', () => {
    const start = { latitude: 40, longitude: 116 };
    const north = { latitude: 40.001, longitude: 116 };

    expect(distanceMeters(start, start)).toBe(0);
    expect(distanceMeters(start, north)).toBeGreaterThan(110);
    expect(distanceMeters(start, north)).toBeLessThan(112);
  });

  it('validates and normalizes telemetry from runtime bridges', () => {
    const parsed = parseAgentGeoTelemetry({
      agentId: 'robot-7',
      current: { latitude: 40, longitude: 116 },
      headingDeg: 725,
      speedMps: 1.4,
      state: 'moving',
      updatedAt: '2026-08-30T11:00:00.000Z',
    });

    expect(parsed?.agentId).toBe('robot-7');
    expect(parsed?.headingDeg).toBe(5);
    expect(parsed?.state).toBe('moving');
  });

  it('rejects invalid coordinates and caps route and trail payloads with the right edge', () => {
    expect(
      parseAgentGeoTelemetry({
        agentId: 'bad-agent',
        current: { latitude: 100, longitude: 116 },
      }),
    ).toBeNull();

    const points = Array.from({ length: MAX_ROUTE_POINTS + 50 }, (_, index) => ({
      latitude: 40,
      longitude: 116 + index / 100_000,
    }));
    const parsed = parseAgentGeoTelemetry({
      agentId: 'bounded-agent',
      current: points[0],
      route: points,
      trail: points,
    });

    expect(parsed?.route).toHaveLength(MAX_ROUTE_POINTS);
    expect(parsed?.route?.[0]).toEqual(points[0]);
    expect(parsed?.route?.at(-1)).toEqual(points[MAX_ROUTE_POINTS - 1]);

    expect(parsed?.trail).toHaveLength(MAX_ROUTE_POINTS);
    expect(parsed?.trail?.[0]).toEqual(points[50]);
    expect(parsed?.trail?.at(-1)).toEqual(points.at(-1));
  });
});
