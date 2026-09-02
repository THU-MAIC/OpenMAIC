'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PPTElement } from '@openmaic/dsl';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { Scene } from '@/lib/types/stage';

const ELEMENT_ID_PREFIX = 'screen-element-';
const NEW_RENDERER_HIT_TARGET = 'slide-element-hit-target';
const NEW_RENDERER_PAINT_SELECTOR = '[class^="base-element-"], [class*=" base-element-"]';
const CANONICAL_ELEMENT_TYPES = new Set<PPTElement['type']>([
  'text',
  'latex',
  'shape',
  'image',
  'line',
  'chart',
  'table',
  'video',
  'audio',
  'code',
]);

type Outline = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

const DISPLAY_SUMMARY_MAX_CODE_POINTS = 80;

function normalizeDisplayText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

function normalizeRichText(value: string | undefined): string {
  return normalizeDisplayText((value ?? '').replace(/<[^>]*>/gu, ' '));
}

export function getSlideElementTypeLabel(elementType: PPTElement['type'], t: Translate): string {
  return t(`edit.element.${elementType}`);
}

export function getSlideElementDisplaySummary(element: PPTElement, t: Translate): string {
  switch (element.type) {
    case 'text':
      return normalizeRichText(element.content) || t('chat.elementReference.summary.emptyContent');
    case 'latex':
      return normalizeDisplayText(element.latex) || t('chat.elementReference.summary.emptyContent');
    case 'shape':
      return (
        normalizeRichText(element.text?.content) ||
        normalizeDisplayText(element.name) ||
        t('chat.elementReference.summary.noText')
      );
    case 'chart': {
      const data = (element as { data?: { labels?: unknown; legends?: unknown } }).data;
      const labels = Array.isArray(data?.labels) ? data.labels : [];
      const legends = Array.isArray(data?.legends) ? data.legends : [];
      const summary = [...labels, ...legends]
        .filter((value): value is string => typeof value === 'string')
        .map(normalizeDisplayText)
        .filter(Boolean)
        .join(' · ');
      return summary || t('chat.elementReference.summary.emptyContent');
    }
    case 'table': {
      const summary = element.data
        .flat()
        .map((cell) => normalizeRichText(cell.text))
        .filter(Boolean)
        .join(' ');
      return summary || t('chat.elementReference.summary.emptyContent');
    }
    case 'code':
      return (
        normalizeDisplayText(element.fileName) ||
        normalizeDisplayText(element.language) ||
        t('chat.elementReference.summary.code')
      );
    case 'line':
      return t('chat.elementReference.summary.line');
    case 'image':
      return normalizeDisplayText(element.name) || t('chat.elementReference.summary.imageMetadata');
    case 'video':
      return normalizeDisplayText(element.name) || t('chat.elementReference.summary.videoMetadata');
    case 'audio':
      return normalizeDisplayText(element.name) || t('chat.elementReference.summary.audioMetadata');
  }
}

export function getSlideElementPresentation(element: PPTElement, t: Translate) {
  const typeLabel = getSlideElementTypeLabel(element.type, t);
  const summary = normalizeDisplayText(getSlideElementDisplaySummary(element, t));
  return {
    typeLabel,
    displaySummary:
      Array.from(summary).slice(0, DISPLAY_SUMMARY_MAX_CODE_POINTS).join('') || typeLabel,
  };
}

function rendererPaintNode(elementId: string): HTMLElement | null {
  const host = document.getElementById(`${ELEMENT_ID_PREFIX}${elementId}`);
  if (!host) return null;

  const hitTarget = Array.from(host.children).find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains(NEW_RENDERER_HIT_TARGET),
  );
  if (hitTarget) {
    return hitTarget.querySelector<HTMLElement>(NEW_RENDERER_PAINT_SELECTOR);
  }

  // Legacy ScreenElement renders its positioned paint root as the host's direct child.
  return (
    Array.from(host.children).find((child): child is HTMLElement => child instanceof HTMLElement) ??
    null
  );
}

function measurableRect(elementId: string): DOMRect | null {
  const paintNode = rendererPaintNode(elementId);
  if (!paintNode) return null;
  const rect = paintNode.getBoundingClientRect();
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }
  return rect;
}

function sameOutlines(left: Outline[], right: Outline[]): boolean {
  return (
    left.length === right.length &&
    left.every((outline, index) => {
      const other = right[index];
      return (
        outline.id === other.id &&
        outline.left === other.left &&
        outline.top === other.top &&
        outline.width === other.width &&
        outline.height === other.height
      );
    })
  );
}

export interface SlideElementPickOverlayProps {
  scene: Extract<Scene, { type: 'slide' }>;
  onPick: (element: PPTElement) => void;
  onCancel: () => void;
}

export function SlideElementPickOverlay({ scene, onPick, onCancel }: SlideElementPickOverlayProps) {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [candidateIds, setCandidateIds] = useState<string[]>([]);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [showFallback, setShowFallback] = useState(false);
  const elementsById = useMemo(
    () => new Map(scene.content.canvas.elements.map((element) => [element.id, element])),
    [scene.content.canvas.elements],
  );

  const measureOutlines = useCallback((): Outline[] => {
    const overlay = overlayRef.current;
    if (!overlay) return [];
    const overlayRect = overlay.getBoundingClientRect();
    const next: Outline[] = [];
    for (const element of scene.content.canvas.elements) {
      const rect = measurableRect(element.id);
      if (!rect) continue;
      next.push({
        id: element.id,
        left: rect.left - overlayRect.left,
        top: rect.top - overlayRect.top,
        width: rect.width,
        height: rect.height,
      });
    }
    return next;
  }, [scene.content.canvas.elements]);

  const refreshOutlines = useCallback(() => {
    const next = measureOutlines();
    setOutlines((current) => (sameOutlines(current, next) ? current : next));
  }, [measureOutlines]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      refreshOutlines();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [refreshOutlines]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  const renderedIds = useMemo(() => new Set(outlines.map((outline) => outline.id)), [outlines]);
  const fallbackElements = useMemo(
    () =>
      scene.content.canvas.elements.filter(
        (element) => CANONICAL_ELEMENT_TYPES.has(element.type) && !renderedIds.has(element.id),
      ),
    [renderedIds, scene.content.canvas.elements],
  );

  const pickById = (id: string) => {
    const element = elementsById.get(id);
    if (element) onPick(element);
  };

  return (
    <div
      ref={overlayRef}
      data-testid="slide-element-pick-overlay"
      className="absolute inset-0 z-[109] cursor-crosshair touch-none"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setShowFallback(false);
        // Renderer hosts are not paint targets: New renderer hosts cover the full slide
        // with pointer-events:none, while Legacy hosts have no useful geometry. Re-resolve
        // and re-measure paint nodes for every click so zoom/transform cannot stale hit tests.
        const measured = measureOutlines();
        setOutlines((current) => (sameOutlines(current, measured) ? current : measured));
        const ids = [...scene.content.canvas.elements]
          .reverse()
          .filter((element) => {
            if (!CANONICAL_ELEMENT_TYPES.has(element.type)) return false;
            const rect = measurableRect(element.id);
            return Boolean(
              rect &&
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom,
            );
          })
          .map((element) => element.id);
        if (ids.length === 1) {
          pickById(ids[0]);
          return;
        }
        setCandidateIds(ids);
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuPosition({
          left: Math.max(8, Math.min(event.clientX - rect.left, rect.width - 220)),
          top: Math.max(8, Math.min(event.clientY - rect.top, rect.height - 180)),
        });
      }}
    >
      {outlines.map((outline) => (
        <div
          key={outline.id}
          className="absolute rounded-sm border border-violet-400/70 bg-violet-400/[0.04] pointer-events-none"
          style={{
            left: outline.left,
            top: outline.top,
            width: outline.width,
            height: outline.height,
          }}
        />
      ))}

      <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-gray-950/80 px-3 py-1.5 text-xs font-medium text-white shadow-lg pointer-events-none">
        {t('chat.elementReference.instruction')}
      </div>

      {fallbackElements.length > 0 && (
        <button
          type="button"
          className="absolute bottom-3 left-3 rounded-lg border border-violet-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-violet-700 shadow-lg dark:border-violet-700 dark:bg-gray-900/95 dark:text-violet-300"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setCandidateIds([]);
            setShowFallback((value) => !value);
          }}
        >
          {t('chat.elementReference.fallback', { count: fallbackElements.length })}
        </button>
      )}

      {(candidateIds.length > 1 || showFallback) && (
        <div
          role="menu"
          data-testid="slide-element-pick-candidates"
          className="absolute z-10 max-h-44 w-52 overflow-y-auto rounded-xl border border-gray-200 bg-white/95 p-1.5 shadow-2xl backdrop-blur dark:border-gray-700 dark:bg-gray-900/95"
          style={showFallback ? { left: 12, bottom: 48 } : menuPosition}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {(showFallback ? fallbackElements.map((element) => element.id) : candidateIds).map(
            (id) => {
              const element = elementsById.get(id);
              if (!element) return null;
              const presentation = getSlideElementPresentation(element, t);
              return (
                <button
                  type="button"
                  role="menuitem"
                  key={id}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-violet-50 dark:hover:bg-violet-950/40"
                  onClick={() => pickById(id)}
                >
                  <span className="shrink-0 font-semibold text-violet-600 dark:text-violet-400">
                    {presentation.typeLabel}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-gray-400">
                    ·
                  </span>
                  <span className="min-w-0 truncate text-gray-600 dark:text-gray-300">
                    {presentation.displaySummary}
                  </span>
                </button>
              );
            },
          )}
        </div>
      )}
    </div>
  );
}
