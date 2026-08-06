'use client';

import { useEffect, useRef, useState } from 'react';
import type { InsertToolbarItem, InsertToolbarProps } from '../types';

const INSERT_BUTTON_STEP = 34;

function InsertToolbarButton({
  item,
  onOpen,
}: {
  readonly item: InsertToolbarItem;
  readonly onOpen: () => void;
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
      data-tooltip-placement="right"
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
}: InsertToolbarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const openItem = items.find((item) => item.id === openId) ?? null;
  const openItemIndex = openId ? items.findIndex((item) => item.id === openId) : -1;

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

  if (items.length === 0) return null;

  return (
    <div
      ref={rootRef}
      className={['maic-editing-ui-root', 'maic-editing-ui-insert-toolbar', className]
        .filter(Boolean)
        .join(' ')}
      role="toolbar"
      aria-label={label}
      data-testid="renderer-insert-toolbar"
    >
      <div className="maic-editing-ui-insert-buttons">
        {items.map((item) => (
          <InsertToolbarButton
            key={item.id}
            item={item}
            onOpen={() => setOpenId((current) => (current === item.id ? null : item.id))}
          />
        ))}
      </div>
      {openItem?.renderPopover ? (
        <div
          className="maic-editing-ui-insert-popover"
          role="dialog"
          aria-label={openItem.label}
          style={{ top: `${Math.max(openItemIndex, 0) * INSERT_BUTTON_STEP}px` }}
        >
          {openItem.renderPopover({ close: () => setOpenId(null) })}
        </div>
      ) : null}
    </div>
  );
}
