'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Scan } from 'lucide-react';

import type { ModelSettingsView, ApplyChange } from '@/lib/model-settings/client';
import { findSlot } from '@/lib/model-settings/client';
import {
  CANVAS_WIDTH,
  CHILD_GAP,
  CHILD_WIDTH,
  FLOW,
  NODE_WIDTH,
  PER_PAGE,
  ROOT_WIDTH,
  ROW_1,
  ROW_2,
  STATIONS,
  edgeKind,
  placeStations,
  stationLit,
  type PlacedStation,
} from '@/lib/model-settings/diagram';
import type { OffMemory } from '@/lib/model-settings/edit';
import { cn } from '@/lib/utils';

import { MS } from './slot-meta';
import { StationNode, type NodeContext } from './station-node';

type T = (key: string, options?: Record<string, unknown>) => string;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Viewport {
  x: number;
  y: number;
  k: number;
}

/** What each media switch turned off, kept for the page across the dialog opening and closing. */
const PAGE_OFF_MEMORY: OffMemory = new Map();

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;
const DEFAULT_HEIGHT = 96;
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** A fit of the world into the canvas; on a narrow canvas, a readable zoom from the left. */
function fitView(width: number, height: number, worldHeight: number): Viewport {
  const pad = 28;
  const k = clampZoom(
    Math.min((width - pad * 2) / CANVAS_WIDTH, (height - pad * 2) / worldHeight, 1.1),
  );
  // Too small to read: keep a readable zoom, centred on the root the rest hangs from.
  if (width < 600 && k < 0.62) {
    const rootCentre = STATIONS[0].x + ROOT_WIDTH / 2;
    return { k: 0.62, x: Math.min(12, width / 2 - rootCentre * 0.62), y: 16 };
  }
  return {
    k,
    x: (width - CANVAS_WIDTH * k) / 2,
    y: Math.max(16, (height - worldHeight * k) / 2),
  };
}

const PAN_STEP = 60;
/** Arrow keys move the map (the content follows the arrow's opposite, like scrolling). */
const PAN_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [PAN_STEP, 0],
  ArrowRight: [-PAN_STEP, 0],
  ArrowUp: [0, PAN_STEP],
  ArrowDown: [0, -PAN_STEP],
};

/**
 * The viewport moved just enough for a box (world coordinates) to show inside
 * the canvas with a margin; the same viewport when it already shows. A box
 * larger than the canvas shows from its top left.
 */
export function revealBox(v: Viewport, box: Box, width: number, height: number): Viewport {
  const margin = 16;
  const shift = (start: number, size: number, extent: number) => {
    if (start < margin || size > extent - margin * 2) return margin - start;
    if (start + size > extent - margin) return extent - margin - (start + size);
    return 0;
  };
  const dx = shift(v.x + box.x * v.k, box.w * v.k, width);
  const dy = shift(v.y + box.y * v.k, box.h * v.k, height);
  return dx || dy ? { ...v, x: v.x + dx, y: v.y + dy } : v;
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

function childStation(parent: PlacedStation, index: number): PlacedStation {
  const slot = parent.children[index];
  return {
    id: `child:${slot.slot}`,
    kind: 'station',
    x: 0,
    y: 0,
    lines: [{ slot: slot.slot, view: slot }],
    children: [],
  };
}

/**
 * The course model map: a pannable, zoomable canvas with the pipeline as a
 * two-row serpentine flow, the default language model above the stations
 * that inherit from it, and edges drawn solid for inheritance and dashed for
 * a setting of the station's own.
 */
export function ModelMap({
  view,
  apply,
  t,
  onManageProviders,
  offMemory = PAGE_OFF_MEMORY,
}: {
  view: ModelSettingsView;
  apply: ApplyChange;
  t: T;
  onManageProviders: () => void;
  /** What the switches turned off; kept for the page unless a test passes its own. */
  offMemory?: OffMemory;
}) {
  const stations = useMemo(() => placeStations(view), [view]);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const expandable = stations.find((station) => station.expandable && station.children.length);
  const [expanded, setExpanded] = useState(
    () => !!expandable?.children.some((slot) => slot.assignment !== undefined || slot.locked),
  );

  // Card heights vary with their lines; edges and the children follow the measured boxes.
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    let changed = false;
    for (const [id, element] of nodes.current) {
      next[id] = element.offsetHeight;
      if (heights[id] !== next[id]) changed = true;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- layout measurement: heights are only known after the cards render
    if (changed) setHeights(next);
  }, [view, expanded, heights]);

  const children =
    expanded && expandable ? expandable.children.map((_, i) => childStation(expandable, i)) : [];
  const boxes = new Map<string, Box>();
  for (const station of stations) {
    boxes.set(station.id, {
      x: station.x,
      y: station.y,
      w: station.kind === 'root' ? ROOT_WIDTH : NODE_WIDTH,
      h: heights[station.id] ?? DEFAULT_HEIGHT,
    });
  }
  if (expandable && children.length) {
    const parent = boxes.get(expandable.id)!;
    const span = children.length * CHILD_WIDTH + (children.length - 1) * CHILD_GAP;
    const x0 = parent.x + parent.w - span;
    children.forEach((child, index) => {
      boxes.set(child.id, {
        x: x0 + index * (CHILD_WIDTH + CHILD_GAP),
        y: parent.y + parent.h + 48,
        w: CHILD_WIDTH,
        h: heights[child.id] ?? DEFAULT_HEIGHT,
      });
    });
  }
  const worldHeight = Math.max(...[...boxes.values()].map((box) => box.y + box.h)) + 40;

  // ── viewport ──
  const canvas = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, k: 1 });
  const [animating, setAnimating] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const worldHeightRef = useRef(worldHeight);
  useLayoutEffect(() => {
    worldHeightRef.current = worldHeight;
  }, [worldHeight]);
  // Until the user pans or zooms, the map keeps fitting its content.
  const touched = useRef(false);

  const fit = useCallback((animate: boolean) => {
    const element = canvas.current;
    if (!element) return;
    if (animate) {
      setAnimating(true);
      window.setTimeout(() => setAnimating(false), 470);
    }
    setViewport(fitView(element.clientWidth, element.clientHeight, worldHeightRef.current));
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setNarrow(element.clientWidth < 600);
      touched.current = false;
      fit(false);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refit to the measured content until the user takes over
    if (!touched.current) fit(false);
  }, [worldHeight, fit]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    touched.current = true;
    setOpenKey(null);
    setViewport((v) => {
      const k = clampZoom(v.k * factor);
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  }, []);
  const zoomBy = (factor: number) => {
    const element = canvas.current;
    if (element) zoomAt(factor, element.clientWidth / 2, element.clientHeight / 2);
  };

  // Scrolling pans; with Ctrl or ⌘ it zooms at the pointer. Needs a non-passive listener.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        touched.current = true;
        setOpenKey(null);
        setViewport((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(
    null,
  );
  const [panning, setPanning] = useState(false);
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button,a,input,select,textarea,[role="switch"]')) {
      return;
    }
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      vx: viewport.x,
      vy: viewport.y,
      moved: false,
    };
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      if (!state.moved && Math.hypot(dx, dy) > 4) {
        state.moved = true;
        touched.current = true;
        setPanning(true);
        setOpenKey(null);
      }
      if (state.moved) setViewport((v) => ({ ...v, x: state.vx + dx, y: state.vy + dy }));
    };
    const up = () => {
      drag.current = null;
      setPanning(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

  // ── edges ──
  const byId = new Map(stations.map((station) => [station.id, station]));
  const flowEdges: { d: string; off: boolean; key: string }[] = [];
  const flow = FLOW.map((id) => byId.get(id)).filter(
    (station): station is PlacedStation => !!station,
  );
  for (let i = 0; i < flow.length - 1; i++) {
    const a = boxes.get(flow[i].id)!;
    const b = boxes.get(flow[i + 1].id)!;
    const ya = a.y + 22;
    const yb = b.y + 22;
    let d: string;
    if (flow[i].row === 1 && flow[i + 1].row === 1) d = `M${a.x + a.w + 4} ${ya} L${b.x - 6} ${yb}`;
    else if (flow[i].row === 2 && flow[i + 1].row === 2) {
      d = `M${a.x - 4} ${ya} L${b.x + b.w + 6} ${yb}`;
    } else {
      const xo = Math.max(a.x + a.w, b.x + b.w) + 46;
      d = `M${a.x + a.w + 4} ${ya} C ${xo} ${ya}, ${xo} ${yb}, ${b.x + b.w + 6} ${yb}`;
    }
    flowEdges.push({ d, off: !stationLit(flow[i + 1]), key: `${flow[i].id}>${flow[i + 1].id}` });
  }

  const root = byId.get('llm');
  const rootBox = root ? boxes.get(root.id) : undefined;
  const treeEdges: { d: string; kind: ReturnType<typeof edgeKind>; key: string }[] = [];
  if (rootBox) {
    const rx = rootBox.x + rootBox.w / 2;
    const ry = rootBox.y + rootBox.h;
    for (const station of stations) {
      const slot = station.lines[0].view;
      if (station.kind === 'root' || slot.parent !== 'llm') continue;
      const b = boxes.get(station.id)!;
      const tx = b.x + b.w / 2;
      let d: string;
      if (station.kind === 'aside') {
        const y = b.y + b.h / 2;
        const ey = rootBox.y + rootBox.h / 2;
        d =
          b.x < rootBox.x
            ? `M${rootBox.x} ${ey} C ${rootBox.x - 70} ${ey}, ${b.x + b.w + 70} ${y}, ${b.x + b.w} ${y}`
            : `M${rootBox.x + rootBox.w} ${ey} C ${rootBox.x + rootBox.w + 70} ${ey}, ${b.x - 70} ${y}, ${b.x} ${y}`;
      } else if (station.row === 1) {
        d = `M${rx} ${ry} C ${rx} ${ry + 40}, ${tx} ${b.y - 50}, ${tx} ${b.y}`;
      } else {
        const bend = ROW_1 - 26;
        d = `M${rx} ${ry} C ${rx} ${ry + 30}, ${tx} ${bend - 40}, ${tx} ${bend} L ${tx} ${b.y}`;
      }
      treeEdges.push({ d, kind: edgeKind(slot), key: `llm>${station.id}` });
    }
  }
  if (expandable && children.length) {
    const parent = boxes.get(expandable.id)!;
    const cx = parent.x + parent.w / 2;
    const cy = parent.y + parent.h;
    for (const child of children) {
      const b = boxes.get(child.id)!;
      const tx = b.x + b.w / 2;
      treeEdges.push({
        d: `M${cx} ${cy} C ${cx} ${cy + 26}, ${tx} ${b.y - 26}, ${tx} ${b.y}`,
        kind: edgeKind(child.lines[0].view),
        key: child.id,
      });
    }
  }

  // The band around the stations generated page by page.
  const bandBoxes = [
    ...PER_PAGE.map((id) => boxes.get(id)).filter((box): box is Box => !!box),
    ...children.map((child) => boxes.get(child.id)!),
  ];
  const band = bandBoxes.length
    ? {
        left: Math.min(...bandBoxes.map((box) => box.x)) - 14,
        right: Math.max(...bandBoxes.map((box) => box.x + box.w)) + 14,
        bottom: Math.max(...bandBoxes.map((box) => box.y + box.h)) + 18,
      }
    : null;

  const ctx: NodeContext = {
    view,
    apply,
    t,
    openKey,
    setOpenKey,
    onManageProviders,
    offMemory,
  };

  // Keyboard focus on a card outside the view pans the map to it.
  const revealFocused = (event: React.FocusEvent) => {
    const element = canvas.current;
    const id = (event.target as HTMLElement)
      .closest?.('[data-station]')
      ?.getAttribute('data-station');
    const box = id ? boxes.get(id) : undefined;
    if (!element || !box || !element.clientWidth) return;
    setViewport((v) => {
      const next = revealBox(v, box, element.clientWidth, element.clientHeight);
      if (next === v) return v;
      touched.current = true;
      return next;
    });
  };
  // No default model and nothing that offers one (the server's providers
  // included): the root says where to set one up.
  const llm = findSlot(view, 'llm');
  const empty =
    llm &&
    llm.effective.status === 'unassigned' &&
    !llm.locked &&
    !view.providers.some((provider) => provider.capabilities.chat)
      ? view.policy.allowWorkspaceProviders &&
        view.presets.some((preset) => preset.capabilities.chat)
        ? ('workspace' as const)
        : ('server' as const)
      : undefined;
  const followers = view.slots.filter(
    (slot) =>
      slot.capability === 'chat' &&
      slot.slot !== 'llm' &&
      !slot.configOnly &&
      slot.effective.status === 'assigned' &&
      slot.effective.resolvedAt === 'llm',
  ).length;
  const register = (id: string) => (element: HTMLDivElement | null) => {
    if (element) nodes.current.set(id, element);
    else nodes.current.delete(id);
  };
  const agent = byId.get('agent');
  const asr = byId.get('asr');

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60">
      <div
        ref={canvas}
        tabIndex={0}
        role="group"
        aria-label={t(`${MS}.map.label`)}
        onPointerDown={onPointerDown}
        // Focusing a card scrolls this clipped box to reveal it; the viewport
        // transform does the moving, so the box stays put.
        onScroll={(event) => {
          event.currentTarget.scrollLeft = 0;
          event.currentTarget.scrollTop = 0;
        }}
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('[data-station]')) fit(true);
        }}
        onFocus={revealFocused}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const pan = PAN_KEYS[event.key];
          if (pan) {
            event.preventDefault();
            touched.current = true;
            setOpenKey(null);
            setViewport((v) => ({ ...v, x: v.x + pan[0], y: v.y + pan[1] }));
          } else if (event.key === '+' || event.key === '=') zoomBy(1.2);
          else if (event.key === '-') zoomBy(1 / 1.2);
          else if (event.key === '0') fit(true);
        }}
        className={cn(
          'absolute inset-0 touch-none overflow-hidden bg-muted/20 outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          panning ? 'cursor-grabbing' : 'cursor-grab',
        )}
        style={{
          backgroundImage:
            'radial-gradient(color-mix(in oklab, var(--foreground) 11%, transparent) 1px, transparent 1.2px)',
          backgroundSize: '20px 20px',
        }}
      >
        <div
          className={cn(
            'absolute left-0 top-0 origin-top-left',
            animating && 'transition-transform duration-[450ms] ease-[cubic-bezier(.16,1,.3,1)]',
          )}
          style={{
            width: CANVAS_WIDTH,
            height: worldHeight,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
          }}
        >
          {band && (
            <div
              className="absolute rounded-[14px] border border-dashed border-primary/20 bg-primary/[0.035] transition-[height] duration-300"
              style={{
                left: band.left,
                top: ROW_2 - 18,
                width: band.right - band.left,
                height: band.bottom - ROW_2 + 18,
              }}
            >
              <span className="absolute -top-2.5 left-3.5 rounded-full border bg-card px-2 py-px text-[11px] font-medium text-muted-foreground">
                {t(`${MS}.map.perPage`)}
              </span>
            </div>
          )}

          <svg
            width={CANVAS_WIDTH}
            height={worldHeight}
            className="pointer-events-none absolute inset-0 overflow-visible"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="model-map-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path
                  d="M0 0.5 L7 4 L0 7.5"
                  fill="none"
                  className="stroke-muted-foreground/50"
                  strokeWidth={1.4}
                  strokeLinecap="round"
                />
              </marker>
            </defs>
            {flowEdges.map((edge) => (
              <path
                key={edge.key}
                d={edge.d}
                fill="none"
                strokeWidth={1.5}
                className="stroke-muted-foreground/35"
                strokeDasharray={edge.off ? '4 4' : undefined}
                markerEnd="url(#model-map-arrow)"
              />
            ))}
            {treeEdges.map((edge) => (
              <path
                key={edge.key}
                d={edge.d}
                fill="none"
                strokeWidth={1.5}
                className={cn(
                  'transition-[stroke] duration-500',
                  edge.kind === 'inherit' && 'stroke-primary/50',
                  edge.kind === 'detached' && 'stroke-muted-foreground/40',
                  edge.kind === 'none' && 'stroke-border',
                )}
                strokeDasharray={edge.kind === 'inherit' ? undefined : '3 5'}
              />
            ))}
          </svg>

          {agent && (
            <p className="absolute left-0.5 top-[18px] text-[11px] font-medium text-muted-foreground/70">
              {t(`${MS}.map.outside`)}
            </p>
          )}
          {asr && (
            <p
              className="absolute top-[18px] text-[11px] font-medium text-muted-foreground/70"
              style={{ left: asr.x + 2 }}
            >
              {t(`${MS}.map.standalone`)}
            </p>
          )}

          {stations.map((station) => {
            const box = boxes.get(station.id)!;
            return (
              <StationNode
                key={station.id}
                ref={register(station.id)}
                station={station}
                ctx={ctx}
                x={box.x}
                y={box.y}
                width={box.w}
                empty={station.kind === 'root' ? empty : undefined}
                followers={station.kind === 'root' ? followers : undefined}
                expanded={station.expandable ? expanded : undefined}
                onExpand={
                  station.expandable
                    ? () => {
                        setOpenKey(null);
                        setExpanded((value) => !value);
                      }
                    : undefined
                }
              />
            );
          })}
          {children.map((child) => {
            const box = boxes.get(child.id)!;
            return (
              <StationNode
                key={child.id}
                ref={register(child.id)}
                station={child}
                ctx={ctx}
                x={box.x}
                y={box.y}
                width={box.w}
              />
            );
          })}
        </div>
      </div>

      <div
        role="group"
        aria-label={t(`${MS}.map.zoom`)}
        className="absolute bottom-3 left-3 z-[1] flex items-center gap-0.5 rounded-[10px] border bg-card p-[3px] shadow-sm"
      >
        <ZoomButton label={t(`${MS}.map.zoomOut`)} onClick={() => zoomBy(1 / 1.2)}>
          <Minus className="size-4" />
        </ZoomButton>
        <button
          type="button"
          title={t(`${MS}.map.reset`)}
          onClick={() => zoomBy(1 / viewport.k)}
          className="h-7 min-w-12 rounded-[7px] px-2 text-xs tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {Math.round(viewport.k * 100)}%
        </button>
        <ZoomButton label={t(`${MS}.map.zoomIn`)} onClick={() => zoomBy(1.2)}>
          <Plus className="size-4" />
        </ZoomButton>
        <ZoomButton label={t(`${MS}.map.fit`)} onClick={() => fit(true)}>
          <Scan className="size-4" />
        </ZoomButton>
      </div>
      {!narrow && (
        <p className="pointer-events-none absolute bottom-4 right-3.5 z-[1] text-[11.5px] text-muted-foreground/70">
          {t(`${MS}.map.hint`)}
        </p>
      )}
    </div>
  );
}
