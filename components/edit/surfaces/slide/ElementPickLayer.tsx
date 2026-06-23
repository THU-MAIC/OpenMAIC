'use client';

/**
 * ElementPickLayer — canvas-side target picker for the timeline.
 *
 * When the ActionsBar arms "pick" mode (useCanvasStore.pickTarget, keyed by
 * actionId), this layer covers the slide canvas and lets the user bind a cue's
 * target either by clicking the element on the slide (hit-tested live) or by
 * clicking a row in the floating element panel (draggable + collapsible). Every
 * selectable element is outlined; the hovered one gets a solid ring + live
 * spotlight/laser preview. Click empty canvas or press Esc to cancel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, GripHorizontal, MousePointerClick } from 'lucide-react';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { setElementIdById } from '@/components/edit/ActionsBar/actions-edit';
import { cueLabel, elementLabel } from '@/components/edit/ActionsBar/cue-meta';
import { clearCuePreview, previewCueEffect } from '@/components/edit/ActionsBar/cue-preview';

const PREFIX = 'editable-element-';
const PANEL_W = 232;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface ElementLite {
  id: string;
  type: string;
  content?: string;
}

function elementHostAt(x: number, y: number): HTMLElement | null {
  for (const node of document.elementsFromPoint(x, y)) {
    const host = (node as HTMLElement).closest?.(`[id^="${PREFIX}"]`) as HTMLElement | null;
    if (host?.id?.startsWith(PREFIX)) return host;
  }
  return null;
}

export function ElementPickLayer() {
  const { t } = useI18n();
  const pickTarget = useCanvasStore.use.pickTarget();
  // Reactive scene lookup so the panel/binding state tracks store updates.
  const scene = useStageStore((s) =>
    pickTarget ? (s.scenes.find((x) => x.id === pickTarget.sceneId) ?? null) : null,
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ id: string; box: Box } | null>(null);
  const [outlines, setOutlines] = useState<Array<{ id: string; box: Box }>>([]);
  const [panel, setPanel] = useState<{ x: number; y: number }>({ x: 0, y: 16 });
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const moveRafRef = useRef<number | null>(null);

  const cueType = pickTarget?.cueType;
  const elements = useMemo<ElementLite[]>(
    () =>
      (scene?.content as { canvas?: { elements?: ElementLite[] } } | undefined)?.canvas?.elements ??
      [],
    [scene],
  );
  const currentBound =
    (
      scene?.actions?.find((a) => a.id === pickTarget?.actionId) as
        | { elementId?: string }
        | undefined
    )?.elementId ?? '';

  const preview = useCallback(
    (elementId: string) => {
      if (cueType) previewCueEffect(cueType, elementId);
    },
    [cueType],
  );

  const finish = useCallback(() => {
    clearCuePreview();
    useCanvasStore.getState().setPickTarget(null);
    setHover(null);
  }, []);

  const bind = useCallback(
    (elementId: string) => {
      const pt = useCanvasStore.getState().pickTarget;
      if (!pt) return;
      const sc = useStageStore.getState().scenes.find((s) => s.id === pt.sceneId);
      if (sc) {
        // Bind by actionId — index-stale-safe against concurrent reorder/delete.
        useStageStore.getState().updateScene(pt.sceneId, {
          actions: setElementIdById(sc.actions ?? [], pt.actionId, elementId),
        });
      }
      finish();
    },
    [finish],
  );

  // Local (canvas-relative) box for a viewport rect.
  const toLocal = useCallback((r: DOMRect): Box | null => {
    const cr = rootRef.current?.getBoundingClientRect();
    if (!cr) return null;
    return { left: r.left - cr.left, top: r.top - cr.top, width: r.width, height: r.height };
  }, []);

  const measureOutlines = useCallback(() => {
    const boxes: Array<{ id: string; box: Box }> = [];
    for (const el of elements) {
      const host = document.getElementById(`${PREFIX}${el.id}`);
      if (!host) continue;
      const b = toLocal(host.getBoundingClientRect());
      if (b) boxes.push({ id: el.id, box: b });
    }
    setOutlines(boxes);
  }, [elements, toLocal]);

  // On entering pick mode: outline every selectable element, dock panel top-right.
  useEffect(() => {
    if (!pickTarget) return;
    measureOutlines();
    const cr = rootRef.current?.getBoundingClientRect();
    if (cr) setPanel({ x: Math.max(8, cr.width - PANEL_W - 16), y: 16 });
    setCollapsed(false);
    const onResize = () => measureOutlines();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickTarget?.sceneId, pickTarget?.actionId, elements.length]);

  useEffect(() => {
    if (!pickTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickTarget, finish]);

  // Unmount cleanup: cancel any pending rAF, and — if this layer unmounts while
  // still armed (scene switch / leaving the slide surface before the user picks)
  // — clear the global pick target + preview. pickTarget lives in the canvas
  // store, so without this it survives the unmount and the next slide mount
  // renders a stale picker bound to the old scene/action. A normal finish()
  // already nulled pickTarget, so this is a no-op in that case.
  useEffect(
    () => () => {
      if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current);
      if (useCanvasStore.getState().pickTarget) {
        clearCuePreview();
        useCanvasStore.getState().setPickTarget(null);
      }
    },
    [],
  );

  if (!pickTarget) return null;

  const typeLabel = cueLabel(pickTarget.cueType, t);

  // Hit-test on mousemove, coalesced to one rAF per frame.
  const onCanvasMove = (e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    if (moveRafRef.current != null) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      const host = elementHostAt(clientX, clientY);
      if (!host) {
        if (hover) {
          setHover(null);
          preview('');
        }
        return;
      }
      const id = host.id.slice(PREFIX.length);
      if (id !== hover?.id) {
        const box = toLocal(host.getBoundingClientRect());
        setHover(box ? { id, box } : null);
        preview(id);
      }
    });
  };

  const onCanvasClick = () => {
    if (hover) bind(hover.id);
    else finish();
  };

  const highlightById = (id: string) => {
    const host = document.getElementById(`${PREFIX}${id}`);
    const box = host ? toLocal(host.getBoundingClientRect()) : null;
    setHover(box ? { id, box } : { id, box: { left: 0, top: 0, width: 0, height: 0 } });
    preview(id);
  };

  const onPanelDown = (e: React.PointerEvent) => {
    dragRef.current = { px: e.clientX, py: e.clientY, ox: panel.x, oy: panel.y };
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* best effort */
    }
  };
  const onPanelMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const cr = rootRef.current?.getBoundingClientRect();
    const maxX = cr ? cr.width - PANEL_W - 8 : 9999;
    const maxY = cr ? cr.height - 40 : 9999;
    setPanel({
      x: Math.min(Math.max(8, d.ox + (e.clientX - d.px)), Math.max(8, maxX)),
      y: Math.min(Math.max(8, d.oy + (e.clientY - d.py)), Math.max(8, maxY)),
    });
  };
  const onPanelUp = () => {
    dragRef.current = null;
  };

  return (
    <div ref={rootRef} className="absolute inset-0 z-[120]">
      {/* click-catcher (sibling of the panel, so panel clicks never reach it) */}
      <div
        className="absolute inset-0 cursor-crosshair"
        onMouseMove={onCanvasMove}
        onClick={onCanvasClick}
      />

      {/* every selectable element gets a faint outline → "this is clickable" */}
      {outlines.map((o) => (
        <div
          key={o.id}
          className="pointer-events-none absolute rounded-[3px] ring-1 ring-violet-400/40 bg-violet-400/[0.04]"
          style={{ left: o.box.left, top: o.box.top, width: o.box.width, height: o.box.height }}
        />
      ))}

      {/* hovered element — solid ring */}
      {hover && hover.box.width > 0 && (
        <div
          className="pointer-events-none absolute rounded-md ring-2 ring-violet-500 bg-violet-500/[0.06]"
          style={{
            left: hover.box.left - 2,
            top: hover.box.top - 2,
            width: hover.box.width + 4,
            height: hover.box.height + 4,
          }}
        />
      )}

      {/* instruction banner */}
      <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-violet-300/60 bg-popover/95 px-3.5 py-1.5 text-[12px] font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur">
        <span className="text-violet-600 dark:text-violet-400">
          {t('edit.pick.pickFor', { label: typeLabel })}
        </span>{' '}
        · {t('edit.pick.pickHint')}
      </div>

      {/* draggable + collapsible element panel, inside the canvas */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ left: panel.x, top: panel.y, width: PANEL_W }}
        className="absolute flex max-h-[70%] flex-col overflow-hidden rounded-2xl border border-border bg-popover/95 shadow-xl shadow-black/15 backdrop-blur"
      >
        <div
          onPointerDown={onPanelDown}
          onPointerMove={onPanelMove}
          onPointerUp={onPanelUp}
          onPointerCancel={onPanelUp}
          className="flex cursor-grab touch-none items-center gap-1.5 border-b border-border px-2.5 py-2 active:cursor-grabbing"
        >
          <GripHorizontal className="size-3.5 text-muted-foreground/40" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {t('edit.pick.pageElements', { count: elements.length })}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="ml-auto grid size-5 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            aria-label={collapsed ? t('edit.pick.expand') : t('edit.pick.collapse')}
          >
            <ChevronDown
              className={`size-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`}
            />
          </button>
        </div>

        {!collapsed && (
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {elements.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-muted-foreground/70">
                {t('edit.pick.noElements')}
              </p>
            ) : (
              elements.map((el) => (
                <button
                  key={el.id}
                  type="button"
                  onMouseEnter={() => highlightById(el.id)}
                  onMouseLeave={() => {
                    setHover(null);
                    preview('');
                  }}
                  onClick={() => bind(el.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-muted ${
                    el.id === currentBound
                      ? 'bg-violet-50 ring-1 ring-violet-200 dark:bg-violet-500/10 dark:ring-violet-500/30'
                      : ''
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-foreground/90">
                    {elementLabel(el, t)}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/45">
                    {el.id.slice(0, 6)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {collapsed && (
          <div className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] text-muted-foreground/50">
            <MousePointerClick className="size-3" /> {t('edit.pick.bindHint')}
          </div>
        )}
      </div>
    </div>
  );
}
