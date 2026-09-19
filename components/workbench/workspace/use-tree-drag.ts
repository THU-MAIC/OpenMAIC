'use client';

/**
 * Pointer-drag reordering for the navigation tree.
 *
 * Rows in the rail are ordinary buttons that also happen to be draggable, which
 * is the whole difficulty: a drag must not swallow the click that opens a
 * course, and a click must not be mistaken for a one-pixel drag. The rule here
 * is a 4px threshold — nothing is a drag until the pointer has actually
 * travelled — plus a one-shot capture-phase `click` swallower on the way up, so
 * releasing after a real drag never also opens what you were moving.
 *
 * Native HTML5 drag-and-drop is deliberately not used: it cannot render an
 * insertion line between two rows without a ghost image the OS controls, it
 * behaves differently per platform, and its drop targets fight the row buttons
 * underneath. Pointer events give the same gesture with a drop model we own —
 * hit-test whatever is under the pointer, split each row at its midpoint (see
 * `edgeFor`), and draw one hairline.
 *
 * Two drop shapes:
 *   - onto a ROW of the same kind → insert before/after it (reorder);
 *   - onto a CONTAINER row, dragging a course → file it into that container.
 *     An empty destination decodes to `undefined`, i.e. no folder at all, so a
 *     surface that renders an "unfiled" container gets filing and unfiling from
 *     the same gesture. The workspace rail files into folder rows only — its
 *     tree keeps unfiled courses as plain top-level rows.
 *
 * Escape cancels mid-drag, and a pointercancel (a system gesture taking over)
 * is a cancel too — never a silent commit to wherever the pointer happened to
 * be.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
/** Same public shape consumed by the data layer's reorder operation. */
export type DropTarget = { readonly before: string } | { readonly after: string };

const edgeFor = (clientY: number, rect: Pick<DOMRect, 'top' | 'height'>) =>
  clientY < rect.top + rect.height / 2 ? 'before' : 'after';

export type DragKind = 'course' | 'session';

/** Where the insertion hairline is drawn right now. */
export interface DropIndicator {
  readonly rowId: string;
  readonly edge: 'before' | 'after';
}

export interface TreeDrag {
  /** The row being dragged, or null when no drag is in flight. */
  readonly dragId: string | null;
  readonly dragKind: DragKind | null;
  readonly indicator: DropIndicator | null;
  /** The container row a course is hovering over. Empty string means no folder. */
  readonly folderTarget: string | null;
  /** Spread onto a draggable row's wrapper. */
  readonly rowProps: (kind: DragKind, id: string) => Record<string, unknown>;
  /** Spread onto a container row so a course can be filed there; no id unfiles. */
  readonly folderProps: (folderId?: string) => Record<string, unknown>;
}

const DRAG_THRESHOLD_PX = 4;

export function useTreeDrag({
  onReorder,
  onMoveToFolder,
}: {
  readonly onReorder: (kind: DragKind, dragId: string, target: DropTarget) => void;
  readonly onMoveToFolder: (courseId: string, folderId: string | undefined) => void;
}): TreeDrag {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragKind, setDragKind] = useState<DragKind | null>(null);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const [folderTarget, setFolderTarget] = useState<string | null>(null);

  // Everything the live gesture needs, off React state: a drag reads it on
  // every pointermove and must not depend on a render having happened.
  const gesture = useRef<{
    id: string;
    kind: DragKind;
    startX: number;
    startY: number;
    active: boolean;
    drop:
      | { kind: 'row'; target: DropTarget }
      | { kind: 'folder'; folderId: string | undefined }
      | null;
  } | null>(null);

  const reset = useCallback(() => {
    gesture.current = null;
    setDragId(null);
    setDragKind(null);
    setIndicator(null);
    setFolderTarget(null);
    document.documentElement.removeAttribute('data-ws-dragging');
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;

      if (!g.active) {
        const travelled = Math.abs(event.clientX - g.startX) + Math.abs(event.clientY - g.startY);
        if (travelled < DRAG_THRESHOLD_PX) return;
        g.active = true;
        setDragId(g.id);
        setDragKind(g.kind);
        // Stops text selecting and the cursor flickering as the pointer
        // travels over the rest of the tree — same trick the resize uses.
        document.documentElement.setAttribute('data-ws-dragging', 'true');
      }
      event.preventDefault();

      const under = document.elementFromPoint(event.clientX, event.clientY);
      const folderRow =
        g.kind === 'course' ? under?.closest<HTMLElement>('[data-ws-drop-folder]') : null;
      if (folderRow) {
        const folderTarget = folderRow.dataset.wsDropFolder ?? '';
        g.drop = { kind: 'folder', folderId: folderTarget || undefined };
        setFolderTarget(folderTarget);
        setIndicator(null);
        return;
      }

      const row = under?.closest<HTMLElement>(`[data-ws-drop-kind="${g.kind}"]`);
      const rowId = row?.dataset.wsDropId;
      if (!row || !rowId || rowId === g.id) {
        g.drop = null;
        setIndicator(null);
        setFolderTarget(null);
        return;
      }
      const edge = edgeFor(event.clientY, row.getBoundingClientRect());
      g.drop = { kind: 'row', target: edge === 'before' ? { before: rowId } : { after: rowId } };
      setIndicator({ rowId, edge });
      setFolderTarget(null);
    };

    const swallowNextClick = () => {
      const swallow = (event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      // A drag that ends outside any clickable target fires no click at all,
      // which would leave the swallower armed for the user's NEXT click.
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    };

    const onUp = () => {
      const g = gesture.current;
      if (!g) return;
      const { active, drop, id, kind } = g;
      reset();
      if (!active) return;
      swallowNextClick();
      if (!drop) return;
      if (drop.kind === 'folder') onMoveToFolder(id, drop.folderId);
      else onReorder(kind, id, drop.target);
    };

    const onCancel = () => {
      const wasActive = gesture.current?.active;
      reset();
      if (wasActive) swallowNextClick();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) onCancel();
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      document.documentElement.removeAttribute('data-ws-dragging');
    };
  }, [onMoveToFolder, onReorder, reset]);

  const rowProps = useCallback(
    (kind: DragKind, id: string) => ({
      'data-ws-drop-kind': kind,
      'data-ws-drop-id': id,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        // Primary button only, and never from inside a control that has its own
        // pointer semantics (the row's action menu).
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest('[data-ws-no-drag]')) return;
        gesture.current = {
          id,
          kind,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          drop: null,
        };
      },
    }),
    [],
  );

  const folderProps = useCallback(
    (folderId?: string) => ({ 'data-ws-drop-folder': folderId ?? '' }),
    [],
  );

  return { dragId, dragKind, indicator, folderTarget, rowProps, folderProps };
}
