'use client';

import { createPortal } from 'react-dom';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { PPTElement } from '@openmaic/dsl';
import type { Selection } from '../../react/types';
import type { CanvasContextMenuLabels, CanvasContextMenuOptions } from '../types';

interface CanvasContextMenuProps extends CanvasContextMenuOptions {
  readonly children: ReactNode;
  readonly elements: readonly PPTElement[];
  readonly selection: Selection;
  readonly onSelectionChange: (selection: Selection) => void;
}

type MenuState =
  | { readonly kind: 'canvas' }
  | { readonly kind: 'locked'; readonly targetId: string }
  | {
      readonly kind: 'element';
      readonly targetId: string;
      readonly groupAction?: 'group' | 'ungroup';
    };

const DEFAULT_LABELS: CanvasContextMenuLabels = {
  horizontalAlignment: 'Horizontal alignment',
  verticalAlignment: 'Vertical alignment',
  selectAll: 'Select all',
  copy: 'Copy',
  cut: 'Cut',
  paste: 'Paste',
  unlock: 'Unlock',
  lock: 'Lock',
  delete: 'Delete',
  group: 'Group',
  ungroup: 'Ungroup',
  bringToFront: 'Bring to front',
  bringForward: 'Bring forward',
  sendToBack: 'Send to back',
  sendBackward: 'Send backward',
  alignLeft: 'Align left',
  alignCenter: 'Align center',
  alignRight: 'Align right',
  alignTop: 'Align top',
  alignMiddle: 'Align middle',
  alignBottom: 'Align bottom',
};

function groupMembers(elements: readonly PPTElement[], target: PPTElement): PPTElement[] {
  return target.groupId
    ? elements.filter((element) => element.groupId === target.groupId)
    : [target];
}

function selectionForTarget(
  elements: readonly PPTElement[],
  selection: Selection,
  targetId: string | null,
): Selection | null {
  if (!targetId) return null;
  const target = elements.find((element) => element.id === targetId);
  if (!target || target.lock) return null;
  const groupIds = groupMembers(elements, target).map((element) => element.id);
  if (
    selection.elementIds.includes(target.id) &&
    groupIds.every((id) => selection.elementIds.includes(id))
  ) {
    return null;
  }
  return { elementIds: groupIds, primaryId: target.id };
}

function getMenuState(
  elements: readonly PPTElement[],
  selection: Selection,
  targetId: string | null,
): MenuState {
  if (!targetId) return { kind: 'canvas' };
  const target = elements.find((element) => element.id === targetId);
  if (!target) return { kind: 'canvas' };
  if (target.lock) return { kind: 'locked', targetId };

  const nextSelection = selectionForTarget(elements, selection, targetId) ?? selection;
  const selected = elements.filter((element) => nextSelection.elementIds.includes(element.id));
  if (selected.length < 2) return { kind: 'element', targetId };
  const groupId = selected[0].groupId;
  const sameGroup = Boolean(groupId) && selected.every((element) => element.groupId === groupId);
  return { kind: 'element', targetId, groupAction: sameGroup ? 'ungroup' : 'group' };
}

function shortcut(label: string, value: string) {
  return (
    <>
      <span>{label}</span>
      <span className="maic-editing-ui-context-menu-shortcut">{value}</span>
    </>
  );
}

function MenuItem({
  children,
  destructive = false,
  onClick,
}: {
  readonly children: ReactNode;
  readonly destructive?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={
        destructive
          ? 'maic-editing-ui-context-menu-item is-destructive'
          : 'maic-editing-ui-context-menu-item'
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MenuSubmenu({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="maic-editing-ui-context-menu-submenu">
      <button type="button" className="maic-editing-ui-context-menu-item" aria-haspopup="menu">
        <span>{label}</span>
        <span aria-hidden="true">›</span>
      </button>
      <div className="maic-editing-ui-context-menu-submenu-content" role="menu">
        {children}
      </div>
    </div>
  );
}

export function CanvasContextMenu({
  children,
  elements,
  selection,
  onSelectionChange,
  labels: labelOverrides,
  onSelectAll,
  onCopy,
  onCut,
  onPaste,
  onUnlock,
  onLock,
  onDelete,
  onToggleGroup,
  onReorder,
  onAlign,
}: CanvasContextMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const labels = useMemo(() => ({ ...DEFAULT_LABELS, ...labelOverrides }), [labelOverrides]);
  const menu = useMemo(
    () => getMenuState(elements, selection, targetId),
    [elements, selection, targetId],
  );
  const isOpen = point !== null;

  const close = () => {
    setPoint(null);
    setPosition(null);
  };

  useLayoutEffect(() => {
    if (!point || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(point.left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(point.top, window.innerHeight - rect.height - 8)),
    });
  }, [menu, point]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.target as Element;
    const host = target.closest?.('[data-element-id], [data-context-element-id]');
    const nextTargetId =
      host?.getAttribute('data-element-id') ||
      host?.getAttribute('data-context-element-id') ||
      null;
    const nextSelection = selectionForTarget(elements, selection, nextTargetId);
    if (nextSelection) onSelectionChange(nextSelection);
    setTargetId(nextTargetId);
    setPosition(null);
    setPoint({ left: event.clientX, top: event.clientY });
  };

  const invoke = (callback: () => void | Promise<void>) => {
    void Promise.resolve(callback()).finally(close);
  };

  return (
    <div
      ref={rootRef}
      data-renderer-canvas-context-menu=""
      className="maic-editing-ui-context-menu-root"
      onContextMenuCapture={handleContextMenu}
    >
      {children}
      {isOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="maic-editing-ui-root maic-editing-ui-context-menu"
              role="menu"
              style={{
                left: `${position?.left ?? point.left}px`,
                opacity: position ? 1 : 0,
                position: 'fixed',
                top: `${position?.top ?? point.top}px`,
                zIndex: 'var(--maic-editing-ui-z-index, 80)',
              }}
            >
              {menu.kind === 'canvas' ? (
                <>
                  <MenuItem onClick={() => invoke(onPaste)}>
                    {shortcut(labels.paste, 'Ctrl + V')}
                  </MenuItem>
                  <div className="maic-editing-ui-context-menu-separator" role="separator" />
                  <MenuItem onClick={() => invoke(onSelectAll)}>
                    {shortcut(labels.selectAll, 'Ctrl + A')}
                  </MenuItem>
                </>
              ) : null}
              {menu.kind === 'locked' ? (
                <MenuItem onClick={() => invoke(() => onUnlock(menu.targetId))}>
                  {labels.unlock}
                </MenuItem>
              ) : null}
              {menu.kind === 'element' ? (
                <>
                  <MenuSubmenu label={labels.horizontalAlignment}>
                    <MenuItem onClick={() => invoke(() => onAlign('left'))}>
                      {labels.alignLeft}
                    </MenuItem>
                    <MenuItem onClick={() => invoke(() => onAlign('center'))}>
                      {labels.alignCenter}
                    </MenuItem>
                    <MenuItem onClick={() => invoke(() => onAlign('right'))}>
                      {labels.alignRight}
                    </MenuItem>
                  </MenuSubmenu>
                  <MenuSubmenu label={labels.verticalAlignment}>
                    <MenuItem onClick={() => invoke(() => onAlign('top'))}>
                      {labels.alignTop}
                    </MenuItem>
                    <MenuItem onClick={() => invoke(() => onAlign('middle'))}>
                      {labels.alignMiddle}
                    </MenuItem>
                    <MenuItem onClick={() => invoke(() => onAlign('bottom'))}>
                      {labels.alignBottom}
                    </MenuItem>
                  </MenuSubmenu>
                  <div className="maic-editing-ui-context-menu-separator" role="separator" />
                  <MenuSubmenu label={labels.bringToFront}>
                    <MenuItem onClick={() => invoke(() => onReorder(menu.targetId, 'front'))}>
                      {labels.bringToFront}
                    </MenuItem>
                    <MenuItem onClick={() => invoke(() => onReorder(menu.targetId, 'forward'))}>
                      {labels.bringForward}
                    </MenuItem>
                  </MenuSubmenu>
                  <MenuSubmenu label={labels.sendToBack}>
                    <MenuItem onClick={() => invoke(() => onReorder(menu.targetId, 'back'))}>
                      {labels.sendToBack}
                    </MenuItem>
                    <MenuItem onClick={() => invoke(() => onReorder(menu.targetId, 'backward'))}>
                      {labels.sendBackward}
                    </MenuItem>
                  </MenuSubmenu>
                  <div className="maic-editing-ui-context-menu-separator" role="separator" />
                  <MenuItem onClick={() => invoke(onCopy)}>
                    {shortcut(labels.copy, 'Ctrl + C')}
                  </MenuItem>
                  <MenuItem onClick={() => invoke(onCut)}>
                    {shortcut(labels.cut, 'Ctrl + X')}
                  </MenuItem>
                  <MenuItem onClick={() => invoke(onPaste)}>
                    {shortcut(labels.paste, 'Ctrl + V')}
                  </MenuItem>
                  <div className="maic-editing-ui-context-menu-separator" role="separator" />
                  {menu.groupAction ? (
                    <MenuItem onClick={() => invoke(onToggleGroup)}>
                      {shortcut(
                        menu.groupAction === 'group' ? labels.group : labels.ungroup,
                        'Ctrl + G',
                      )}
                    </MenuItem>
                  ) : null}
                  <MenuItem onClick={() => invoke(onSelectAll)}>
                    {shortcut(labels.selectAll, 'Ctrl + A')}
                  </MenuItem>
                  <MenuItem onClick={() => invoke(onLock)}>
                    {shortcut(labels.lock, 'Ctrl + L')}
                  </MenuItem>
                  <MenuItem destructive onClick={() => invoke(onDelete)}>
                    {shortcut(labels.delete, 'Delete')}
                  </MenuItem>
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
