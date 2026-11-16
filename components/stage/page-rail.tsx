'use client';

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useReducedMotion } from 'motion/react';
import { ChevronRight, PanelLeftClose } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBrand, useIsDesktop } from '@/lib/brand/brand-context';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { useInWorkbenchPanel } from '@/lib/workbench/panel-context';

const MIN_WIDTH = 170;
const MAX_WIDTH = 400;

/** Collapsed with no other way back: just wide enough to hold the expand chevron. */
const HANDLE_WIDTH = 16;

/** A key pressed here is text being typed, not a shortcut. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true;
  return (
    target.closest(
      ['input', 'textarea', 'select', '[role="slider"]', 'input[type="range"]'].join(', '),
    ) !== null
  );
}

interface PageRailProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  /**
   * Collapsed, the list is reopened from the control bar under the canvas and takes
   * no width. A surface with no such bar keeps a slim handle instead.
   */
  readonly keepHandle?: boolean;
  readonly testId?: string;
  /** The page list. Stays mounted while collapsed, so it keeps its scroll. */
  readonly children: ReactNode;
}

/**
 * The classroom's page list frame, shared by Learn and Edit: its width, how it
 * collapses and resizes, and its header. What each mode lists inside it is its own.
 */
export function PageRail({
  collapsed,
  onCollapseChange,
  keepHandle = false,
  testId,
  children,
}: PageRailProps) {
  const { t } = useI18n();
  const router = useRouter();
  const brand = useBrand();
  const isDesktop = useIsDesktop();
  const inWorkbenchPanel = useInWorkbenchPanel();
  const prefersReducedMotion = useReducedMotion();
  const width = useSettingsStore((s) => s.sidebarWidth);
  const setWidth = useSettingsStore((s) => s.setSidebarWidth);

  // During a drag the width is written straight to the element and committed on
  // release, so the edge stays on the cursor without a render per move. Pointer
  // capture delivers the release even if the cursor has left the window.
  const railRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
    lastWidth: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleResizeStart = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: width,
      lastWidth: width,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);
  };

  const handleResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastWidth = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, drag.startWidth + e.clientX - drag.startX),
    );
    if (railRef.current) railRef.current.style.width = `${drag.lastWidth}px`;
  };

  const handleResizeEnd = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    setWidth(drag.lastWidth);
    dragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setDragging(false);
  };

  useEffect(
    () => () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [],
  );

  // `S` folds the list. It reads the rendered state rather than the store, so a
  // second classroom still mounted (a keep-alive tab) sets the same value instead
  // of toggling it back.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 's' && event.key !== 'S') return;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTextEntryTarget(event.target) || isTextEntryTarget(document.activeElement)) return;
      event.preventDefault();
      onCollapseChange(!collapsed);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed, onCollapseChange]);

  const collapsedWidth = keepHandle ? HANDLE_WIDTH : 0;

  return (
    <aside
      ref={railRef}
      data-testid={testId}
      data-collapsed={collapsed}
      style={{
        width: collapsed ? collapsedWidth : width,
        transition: dragging || prefersReducedMotion ? 'none' : 'width 0.3s ease',
      }}
      className="relative z-20 flex h-full shrink-0 flex-col border-r border-gray-100 bg-white/80 shadow-[2px_0_24px_rgba(0,0,0,0.02)] backdrop-blur-xl dark:border-gray-800 dark:bg-slate-900/80"
    >
      {collapsed ? null : (
        <div
          data-testid="page-rail-resize"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          className="group absolute right-0 top-0 bottom-0 z-50 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-purple-400/30 active:bg-purple-500/40 dark:hover:bg-purple-600/30 dark:active:bg-purple-500/40"
        >
          <div className="absolute right-0.5 top-1/2 h-8 w-0.5 -translate-y-1/2 rounded-full bg-gray-300 transition-colors group-hover:bg-purple-400 dark:bg-gray-600 dark:group-hover:bg-purple-500" />
        </div>
      )}

      {collapsed && keepHandle ? (
        <button
          type="button"
          data-testid="page-rail-expand"
          onClick={() => onCollapseChange(false)}
          aria-label={t('edit.nav.expand')}
          title={t('edit.nav.expand')}
          className="absolute inset-0 z-10 flex items-center justify-center text-gray-400 transition-colors hover:bg-gray-100/80 hover:text-gray-700 focus-visible:bg-gray-100/80 focus-visible:outline-none dark:text-gray-500 dark:hover:bg-gray-800/80 dark:hover:text-gray-200 dark:focus-visible:bg-gray-800/80"
        >
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </button>
      ) : null}

      <div className={cn('flex h-full w-full flex-col overflow-hidden', collapsed && 'hidden')}>
        {/* Hosted in the workbench, the shell already shows the brand, so the header
            holds only the collapse button and is no taller than it. */}
        <div
          className={cn(
            'relative mb-1 flex shrink-0 items-center px-3',
            inWorkbenchPanel ? 'mt-2 h-7' : 'mt-3 h-10',
          )}
        >
          {/* The Electron title bar shows the brand on a desktop build. */}
          {inWorkbenchPanel || isDesktop ? null : (
            <button
              type="button"
              onClick={() => router.push('/')}
              title={t('generation.backToHome')}
              className="-mx-1.5 -my-1 flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 transition-all duration-150 hover:bg-gray-100/80 active:scale-[0.97] dark:hover:bg-gray-800/60"
            >
              <img src={brand.logoSrc} alt={brand.productName} className="h-6 w-auto" />
            </button>
          )}
          <button
            type="button"
            data-testid="page-rail-collapse"
            onClick={() => onCollapseChange(true)}
            aria-label={t('edit.nav.collapse')}
            title={t('edit.nav.collapse')}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-100/80 text-gray-500 ring-1 ring-black/[0.04] transition-all duration-200 hover:bg-gray-200/90 hover:text-gray-700 active:scale-90 dark:bg-gray-800/80 dark:text-gray-400 dark:ring-white/[0.06] dark:hover:bg-gray-700/90 dark:hover:text-gray-200"
          >
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </aside>
  );
}
