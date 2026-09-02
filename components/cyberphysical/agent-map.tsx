'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Minus, Navigation, Plus } from 'lucide-react';
import { cyberphysicalText } from '@/lib/cyberphysical/ui-text';
import { cn } from '@/lib/utils';
import {
  projectGeoPoint,
  unprojectWorldPoint,
  type AgentGeoTelemetry,
  type GeoPoint,
  type WorldPoint,
} from '@/lib/cyberphysical/geo';

const TILE_SIZE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 19;

interface AgentMapProps {
  telemetry: AgentGeoTelemetry;
  onDestinationChange?: (point: GeoPoint) => void;
  className?: string;
}

interface MapSize {
  width: number;
  height: number;
}

interface TileDescriptor {
  key: string;
  url: string;
  left: number;
  top: number;
}

function wrappedDelta(delta: number, worldSize: number): number {
  if (delta > worldSize / 2) return delta - worldSize;
  if (delta < -worldSize / 2) return delta + worldSize;
  return delta;
}

function clampTileY(value: number, tileCount: number): number {
  return Math.max(0, Math.min(tileCount - 1, value));
}

function wrapTileX(value: number, tileCount: number): number {
  return ((value % tileCount) + tileCount) % tileCount;
}

export function AgentMap({ telemetry, onDestinationChange, className }: AgentMapProps) {
  const t = cyberphysicalText;
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<MapSize>({ width: 900, height: 560 });
  const [zoom, setZoom] = useState(16);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateSize = () => {
      const bounds = element.getBoundingClientRect();
      setSize({
        width: Math.max(320, bounds.width),
        height: Math.max(360, bounds.height),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const worldSize = TILE_SIZE * 2 ** zoom;
  const centerWorld = useMemo(
    () => projectGeoPoint(telemetry.current, zoom),
    [telemetry.current, zoom],
  );

  const toScreen = (point: GeoPoint): WorldPoint => {
    const projected = projectGeoPoint(point, zoom);
    return {
      x: size.width / 2 + wrappedDelta(projected.x - centerWorld.x, worldSize),
      y: size.height / 2 + projected.y - centerWorld.y,
    };
  };

  const tiles = useMemo<TileDescriptor[]>(() => {
    const tileCount = 2 ** zoom;
    const minWorldX = centerWorld.x - size.width / 2;
    const maxWorldX = centerWorld.x + size.width / 2;
    const minWorldY = centerWorld.y - size.height / 2;
    const maxWorldY = centerWorld.y + size.height / 2;
    const minTileX = Math.floor(minWorldX / TILE_SIZE) - 1;
    const maxTileX = Math.floor(maxWorldX / TILE_SIZE) + 1;
    const minTileY = Math.floor(minWorldY / TILE_SIZE) - 1;
    const maxTileY = Math.floor(maxWorldY / TILE_SIZE) + 1;
    const result: TileDescriptor[] = [];

    for (let rawY = minTileY; rawY <= maxTileY; rawY += 1) {
      if (rawY < 0 || rawY >= tileCount) continue;
      const tileY = clampTileY(rawY, tileCount);
      for (let rawX = minTileX; rawX <= maxTileX; rawX += 1) {
        const tileX = wrapTileX(rawX, tileCount);
        result.push({
          key: `${zoom}:${rawX}:${rawY}`,
          url: `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`,
          left: rawX * TILE_SIZE - minWorldX,
          top: rawY * TILE_SIZE - minWorldY,
        });
      }
    }

    return result;
  }, [centerWorld.x, centerWorld.y, size.height, size.width, zoom]);

  const trailPoints = (telemetry.trail ?? []).map(toScreen);
  const routePoints = (telemetry.route ?? []).map(toScreen);
  const currentPoint = toScreen(telemetry.current);
  const destinationPoint = telemetry.destination ? toScreen(telemetry.destination) : null;

  const pointsToPath = (points: WorldPoint[]) =>
    points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');

  const handleMapClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onDestinationChange) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-map-control]')) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const worldPoint = {
      x: centerWorld.x + localX - size.width / 2,
      y: centerWorld.y + localY - size.height / 2,
    };
    onDestinationChange(unprojectWorldPoint(worldPoint, zoom));
  };

  const updateZoom = (nextZoom: number) => {
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom)));
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative min-h-[440px] w-full overflow-hidden rounded-3xl border border-slate-200 bg-slate-100 shadow-inner dark:border-slate-700 dark:bg-slate-900',
        className,
      )}
      onClick={handleMapClick}
      aria-label={t('cyberphysical.mapAria')}
    >
      <div className="absolute inset-0 bg-slate-200 dark:bg-slate-950" aria-hidden="true" />
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className="absolute bg-cover bg-center"
          style={{
            width: TILE_SIZE,
            height: TILE_SIZE,
            left: tile.left,
            top: tile.top,
            backgroundImage: `url(${tile.url})`,
          }}
          aria-hidden="true"
        />
      ))}

      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        {trailPoints.length > 1 && (
          <polyline
            points={pointsToPath(trailPoints)}
            fill="none"
            stroke="rgb(14 165 233)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.82"
          />
        )}
        {routePoints.length > 1 && (
          <polyline
            points={pointsToPath(routePoints)}
            fill="none"
            stroke="rgb(124 58 237)"
            strokeWidth="4"
            strokeDasharray="10 8"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.9"
          />
        )}
      </svg>

      {destinationPoint && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full"
          style={{ left: destinationPoint.x, top: destinationPoint.y }}
        >
          <div className="mb-1 rounded-full bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-md dark:bg-slate-900/95 dark:text-slate-200">
            {t('cyberphysical.destination')}
          </div>
          <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full border-4 border-white bg-violet-600 text-white shadow-lg dark:border-slate-900">
            <Crosshair className="h-4 w-4" />
          </div>
        </div>
      )}

      <div
        className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: currentPoint.x, top: currentPoint.y }}
      >
        <div className="relative flex h-12 w-12 items-center justify-center rounded-full border-4 border-white bg-sky-500 text-white shadow-xl dark:border-slate-900">
          <div className="absolute inset-0 animate-ping rounded-full bg-sky-400/30" />
          <Navigation
            className="relative h-5 w-5 fill-current"
            style={{ transform: `rotate(${telemetry.headingDeg ?? 0}deg)` }}
          />
        </div>
      </div>

      <div
        data-map-control
        className="absolute left-4 top-4 flex flex-col overflow-hidden rounded-xl border border-white/70 bg-white/90 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/90"
      >
        <button
          type="button"
          onClick={() => updateZoom(zoom + 1)}
          className="flex h-10 w-10 items-center justify-center text-slate-700 transition hover:bg-slate-100 disabled:opacity-40 dark:text-slate-200 dark:hover:bg-slate-800"
          disabled={zoom >= MAX_ZOOM}
          aria-label={t('cyberphysical.zoomIn')}
        >
          <Plus className="h-4 w-4" />
        </button>
        <div className="h-px bg-slate-200 dark:bg-slate-700" />
        <button
          type="button"
          onClick={() => updateZoom(zoom - 1)}
          className="flex h-10 w-10 items-center justify-center text-slate-700 transition hover:bg-slate-100 disabled:opacity-40 dark:text-slate-200 dark:hover:bg-slate-800"
          disabled={zoom <= MIN_ZOOM}
          aria-label={t('cyberphysical.zoomOut')}
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>

      <div
        data-map-control
        className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/60 bg-white/85 px-3 py-2 text-[11px] text-slate-600 shadow-md backdrop-blur dark:border-slate-700 dark:bg-slate-950/85 dark:text-slate-300"
      >
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-5 rounded-full bg-sky-500" />{' '}
            {t('cyberphysical.observedTrail')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-5 border-t-2 border-dashed border-violet-600" />{' '}
            {t('cyberphysical.plannedRoute')}
          </span>
        </div>
        <span>
          ©{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            OpenStreetMap contributors
          </a>
        </span>
      </div>
    </div>
  );
}
