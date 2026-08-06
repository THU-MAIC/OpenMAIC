'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { InsertToolbarItem, InsertToolbarProps } from '../types';

const INSERT_BUTTON_STEP = 34;
const INSERT_TOOLBAR_SIZE = 48;
const INSERT_POPOVER_OFFSET = 44;

interface InsertToolbarInternalProps extends InsertToolbarProps {
  readonly onRailSizeChange?: (size: number) => void;
}

function InsertToolbarButton({
  item,
  onOpen,
  tooltipPlacement,
}: {
  readonly item: InsertToolbarItem;
  readonly onOpen: () => void;
  readonly tooltipPlacement: 'right' | 'bottom';
}) {
  const hasPopover = Boolean(item.renderPopover);

  return (
    <button
      type="button"
      className="maic-editing-ui-icon-button maic-editing-ui-insert-button maic-editing-ui-tooltip-button"
      aria-label={item.label}
      aria-pressed={typeof item.active === 'boolean' ? item.active : undefined}
      disabled={item.disabled}
      data-tooltip={item.tooltip ?? item.label}
      data-tooltip-placement={tooltipPlacement}
      title={item.tooltip ?? item.label}
      onClick={hasPopover ? onOpen : item.onInvoke}
    >
      {item.icon}
    </button>
  );
}

/**
 * Renderer-owned insert toolbar. Consumers provide product-specific actions
 * and optional popover content, keeping this package free of App dependencies.
 */
export function InsertToolbar({
  items,
  label = 'Insert',
  className,
  placement = 'left',
  onRailSizeChange,
}: InsertToolbarInternalProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const openItem = items.find((item) => item.id === openId) ?? null;
  const openItemIndex = openId ? items.findIndex((item) => item.id === openId) : -1;
  const popoverStyle: CSSProperties =
    placement === 'top'
      ? { left: `${Math.max(openItemIndex, 0) * INSERT_BUTTON_STEP}px` }
      : { top: `${Math.max(openItemIndex, 0) * INSERT_BUTTON_STEP}px` };

  useEffect(() => {
    if (!openId) return;
    const closeWhenOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenId(null);
    };
    const closeWhenEscaped = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenId(null);
    };
    document.addEventListener('pointerdown', closeWhenOutside);
    document.addEventListener('keydown', closeWhenEscaped);
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside);
      document.removeEventListener('keydown', closeWhenEscaped);
    };
  }, [openId]);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover || !onRailSizeChange) {
      onRailSizeChange?.(INSERT_TOOLBAR_SIZE);
      return;
    }

    const updateRailSize = () => {
      const rect = popover.getBoundingClientRect();
      const popoverSize = placement === 'top' ? rect.height : rect.width;
      onRailSizeChange(
        Math.max(INSERT_TOOLBAR_SIZE, Math.ceil(popoverSize) + INSERT_POPOVER_OFFSET),
      );
    };

    updateRailSize();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(updateRailSize);
    observer.observe(popover);
    return () => observer.disconnect();
  }, [onRailSizeChange, openId, placement]);

  if (items.length === 0) return null;

  return (
    <div
      ref={rootRef}
      className={['maic-editing-ui-root', 'maic-editing-ui-insert-toolbar', className]
        .filter(Boolean)
        .join(' ')}
      role="toolbar"
      aria-label={label}
      data-placement={placement}
      data-testid="renderer-insert-toolbar"
    >
      <div className="maic-editing-ui-insert-buttons">
        {items.map((item) => (
          <InsertToolbarButton
            key={item.id}
            item={item}
            onOpen={() => setOpenId((current) => (current === item.id ? null : item.id))}
            tooltipPlacement={placement === 'top' ? 'bottom' : 'right'}
          />
        ))}
      </div>
      {openItem?.renderPopover ? (
        <div
          ref={popoverRef}
          className="maic-editing-ui-insert-popover"
          role="dialog"
          aria-label={openItem.label}
          style={popoverStyle}
        >
          {openItem.renderPopover({ close: () => setOpenId(null) })}
        </div>
      ) : null}
    </div>
  );
}
