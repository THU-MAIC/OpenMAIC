'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Bot,
  Crosshair,
  Gauge,
  LocateFixed,
  MapPinned,
  Navigation,
  Play,
  Radio,
  Route,
  Square,
} from 'lucide-react';
import { AgentMap } from '@/components/cyberphysical/agent-map';
import { Button } from '@/components/ui/button';
import {
  CYBERPHYSICAL_TELEMETRY_CHANNEL,
  CYBERPHYSICAL_TELEMETRY_EVENT,
  distanceMeters,
  formatCoordinate,
  parseAgentGeoTelemetry,
  type AgentGeoTelemetry,
  type GeoPoint,
} from '@/lib/cyberphysical/geo';
import { cyberphysicalText as t } from '@/lib/cyberphysical/ui-text';

const DEMO_ROUTE: GeoPoint[] = [
  { latitude: 40.00055, longitude: 116.3224 },
  { latitude: 40.00098, longitude: 116.32352 },
  { latitude: 40.00123, longitude: 116.32488 },
  { latitude: 40.00088, longitude: 116.32618 },
  { latitude: 40.00022, longitude: 116.3272 },
  { latitude: 39.99942, longitude: 116.32792 },
];

function initialTelemetry(): AgentGeoTelemetry {
  return {
    agentId: 'openmaic-agent-01',
    current: DEMO_ROUTE[0],
    destination: DEMO_ROUTE.at(-1),
    route: DEMO_ROUTE,
    trail: [DEMO_ROUTE[0]],
    headingDeg: 68,
    speedMps: 1.2,
    state: 'idle',
    updatedAt: new Date().toISOString(),
    source: 'simulation',
  };
}

function metric(value: number | undefined, suffix: string, digits = 1) {
  return value === undefined ? '—' : `${value.toFixed(digits)} ${suffix}`;
}

export function CyberphysicalClient() {
  const [telemetry, setTelemetry] = useState<AgentGeoTelemetry>(() => initialTelemetry());
  const [simulationRunning, setSimulationRunning] = useState(false);
  const [simulationIndex, setSimulationIndex] = useState(0);
  const [geolocationActive, setGeolocationActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const watchRef = useRef<number | null>(null);

  const stopLocation = () => {
    if (watchRef.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    setGeolocationActive(false);
  };

  useEffect(() => {
    let channel: BroadcastChannel | null = null;

    const accept = (value: unknown) => {
      const parsed = parseAgentGeoTelemetry(value);
      if (!parsed) return;
      stopLocation();
      setSimulationRunning(false);
      setTelemetry(parsed);
      setBridgeConnected(true);
    };

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel(CYBERPHYSICAL_TELEMETRY_CHANNEL);
      channel.onmessage = (event) => accept(event.data);
    }

    const onTelemetry = (event: Event) => accept((event as CustomEvent<unknown>).detail);
    window.addEventListener(CYBERPHYSICAL_TELEMETRY_EVENT, onTelemetry);

    return () => {
      channel?.close();
      window.removeEventListener(CYBERPHYSICAL_TELEMETRY_EVENT, onTelemetry);
      if (watchRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(watchRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!simulationRunning) return;

    const timer = window.setTimeout(() => {
      const next = simulationIndex + 1;
      if (next >= DEMO_ROUTE.length) {
        const destination = DEMO_ROUTE[DEMO_ROUTE.length - 1];
        setSimulationRunning(false);
        setTelemetry((current) => ({
          ...current,
          current: destination,
          destination,
          route: [destination],
          trail: DEMO_ROUTE,
          speedMps: 0,
          state: 'arrived',
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      setSimulationIndex(next);
      setTelemetry((current) => ({
        ...current,
        current: DEMO_ROUTE[next],
        destination: DEMO_ROUTE.at(-1),
        route: DEMO_ROUTE.slice(next),
        trail: DEMO_ROUTE.slice(0, next + 1),
        headingDeg: 45 + next * 13,
        speedMps: 1.2 + (next % 2) * 0.3,
        state: 'moving',
        source: 'simulation',
        updatedAt: new Date().toISOString(),
      }));
    }, 900);

    return () => window.clearTimeout(timer);
  }, [simulationIndex, simulationRunning]);

  const runDemo = () => {
    stopLocation();
    setBridgeConnected(false);
    setSimulationIndex(0);
    setTelemetry(initialTelemetry());
    setSimulationRunning(true);
  };

  const stopDemo = () => {
    setSimulationRunning(false);
    setTelemetry((current) => ({ ...current, speedMps: 0, state: 'paused' }));
  };

  const startLocation = () => {
    setError(null);
    setSimulationRunning(false);
    setBridgeConnected(false);

    if (!('geolocation' in navigator)) {
      setError(t('cyberphysical.geolocationUnavailable'));
      return;
    }

    stopLocation();
    const id = navigator.geolocation.watchPosition(
      (position) => {
        const point: GeoPoint = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          altitude: position.coords.altitude ?? undefined,
          accuracy: position.coords.accuracy,
          timestamp: new Date(position.timestamp).toISOString(),
        };
        setGeolocationActive(true);
        setTelemetry((current) => ({
          ...current,
          agentId: 'browser-agent',
          current: point,
          trail: [
            ...(current.source === 'browser-geolocation' ? (current.trail ?? []) : []),
            point,
          ].slice(-200),
          route: current.destination ? [point, current.destination] : undefined,
          headingDeg: position.coords.heading ?? current.headingDeg,
          speedMps: position.coords.speed ?? current.speedMps,
          state: 'moving',
          source: 'browser-geolocation',
          updatedAt: new Date().toISOString(),
        }));
      },
      (geoError) => {
        setError(geoError.message || t('cyberphysical.locationReadError'));
        setGeolocationActive(false);
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    );
    watchRef.current = id;
  };

  const setDestination = (destination: GeoPoint) => {
    setTelemetry((current) => ({
      ...current,
      destination,
      route: [current.current, destination],
      updatedAt: new Date().toISOString(),
    }));
  };

  const targetDistance = useMemo(
    () =>
      telemetry.destination ? distanceMeters(telemetry.current, telemetry.destination) : undefined,
    [telemetry.current, telemetry.destination],
  );

  return (
    <main className="min-h-[100dvh] bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-50">
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4 px-4 py-3 md:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              aria-label={t('cyberphysical.backToOpenMAIC')}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600 text-white">
              <MapPinned className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{t('cyberphysical.title')}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {t('cyberphysical.subtitle')}
              </div>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs text-slate-500 md:flex">
            <Radio className="h-3.5 w-3.5" />
            {telemetry.source ?? t('cyberphysical.unknownSource')}
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] gap-5 px-4 py-5 md:px-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0">
          <div className="mb-4 flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-violet-600 dark:text-violet-400">
                <Route className="h-3.5 w-3.5" /> {t('cyberphysical.observabilityBadge')}
              </div>
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
                {t('cyberphysical.heroTitle')}
              </h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-400">
                {t('cyberphysical.heroDescription')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={simulationRunning ? stopDemo : runDemo}>
                {simulationRunning ? (
                  <Square className="mr-2 h-4 w-4" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                {simulationRunning ? t('cyberphysical.stopSimulation') : t('cyberphysical.runDemo')}
              </Button>
              <Button onClick={geolocationActive ? stopLocation : startLocation}>
                <LocateFixed className="mr-2 h-4 w-4" />
                {geolocationActive
                  ? t('cyberphysical.stopLiveLocation')
                  : t('cyberphysical.useBrowserLocation')}
              </Button>
            </div>
          </div>

          <AgentMap telemetry={telemetry} onDestinationChange={setDestination} />

          {error && (
            <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
              {error}
            </div>
          )}

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <InfoCard
              title={t('cyberphysical.routeAwarenessTitle')}
              text={t('cyberphysical.routeAwarenessDescription')}
            />
            <InfoCard
              title={t('cyberphysical.runtimeBridgeTitle')}
              text={t('cyberphysical.runtimeBridgeDescription')}
            />
            <InfoCard
              title={t('cyberphysical.observeFirstTitle')}
              text={t('cyberphysical.observeFirstDescription')}
            />
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.16em] text-slate-400">
                  {t('cyberphysical.activeAgent')}
                </div>
                <div className="mt-1 flex items-center gap-2 text-lg font-semibold">
                  <Bot className="h-5 w-5 text-violet-500" /> {telemetry.agentId}
                </div>
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold dark:bg-slate-800">
                {t(`cyberphysical.state.${telemetry.state ?? 'idle'}`)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Metric
                icon={<Gauge className="h-3.5 w-3.5" />}
                label={t('cyberphysical.speed')}
                value={metric(telemetry.speedMps, 'm/s')}
              />
              <Metric
                icon={<Crosshair className="h-3.5 w-3.5" />}
                label={t('cyberphysical.toTarget')}
                value={
                  targetDistance === undefined
                    ? '—'
                    : targetDistance >= 1000
                      ? `${(targetDistance / 1000).toFixed(2)} km`
                      : `${Math.round(targetDistance)} m`
                }
              />
              <Metric
                icon={<Navigation className="h-3.5 w-3.5" />}
                label={t('cyberphysical.heading')}
                value={metric(telemetry.headingDeg, '°', 0)}
              />
              <Metric
                icon={<Activity className="h-3.5 w-3.5" />}
                label={t('cyberphysical.accuracy')}
                value={metric(telemetry.current.accuracy, 'm', 0)}
              />
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 text-sm font-semibold">{t('cyberphysical.position')}</div>
            <dl className="space-y-2 text-sm">
              <Row
                label={t('cyberphysical.latitude')}
                value={formatCoordinate(telemetry.current.latitude)}
              />
              <Row
                label={t('cyberphysical.longitude')}
                value={formatCoordinate(telemetry.current.longitude)}
              />
              <Row
                label={t('cyberphysical.updated')}
                value={new Date(telemetry.updatedAt).toLocaleTimeString()}
              />
            </dl>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">{t('cyberphysical.bridgeTitle')}</div>
              <span
                className={`h-2.5 w-2.5 rounded-full ${bridgeConnected ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
              />
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {t('cyberphysical.bridgeDescription')}
            </p>
            <div className="mt-3 rounded-xl bg-slate-950 p-3 font-mono text-[11px] leading-5 text-slate-200">
              <div className="text-slate-500">BroadcastChannel</div>
              <div className="break-all">{CYBERPHYSICAL_TELEMETRY_CHANNEL}</div>
              <div className="mt-2 text-slate-500">CustomEvent</div>
              <div className="break-all">{CYBERPHYSICAL_TELEMETRY_EVENT}</div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-sm font-semibold">{title}</div>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-400">{text}</p>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3 dark:bg-slate-950">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-mono text-xs">{value}</dd>
    </div>
  );
}
