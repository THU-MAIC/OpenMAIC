import { useCallback } from 'react';
import { uniq } from 'lodash';
import { useCanvasStore } from '@/lib/store';
import { useKeyboardStore } from '@/lib/store/keyboard';
import type { PPTElement } from '@/lib/types/slides';

/**
 * Hook for handling element selection in Canvas
 * Supports single selection, multi-selection (Ctrl/Shift), and group selection
 */
export function useSelectElement(
  elementListRef: React.RefObject<PPTElement[]>,
  moveElement: (e: React.MouseEvent | React.TouchEvent, element: PPTElement) => void,
) {
  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  const handleElementId = useCanvasStore.use.handleElementId();
  const editorAreaFocus = useCanvasStore.use.editorAreaFocus();
  const setActiveElementIdList = useCanvasStore.use.setActiveElementIdList();
  const setHandleElementId = useCanvasStore.use.setHandleElementId();
  const setActiveGroupElementId = useCanvasStore.use.setActiveGroupElementId();
  const setEditorAreaFocus = useCanvasStore.use.setEditorAreaFocus();

  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

  // Select element
  // startMove indicates whether to enter move state after selection
  const selectElement = useCallback(
    (e: React.MouseEvent | React.TouchEvent, element: PPTElement, startMove = true) => {
      if (!editorAreaFocus) setEditorAreaFocus(true);

      // If the target element is not currently selected, set it as selected
      // If Ctrl or Shift is held, enter multi-select mode: add target to current selection; otherwise select only the target
      // If the target is a group member, also select the other members of that group
      if (!activeElementIdList.includes(element.id)) {
        let newActiveIdList: string[] = [];

        if (ctrlOrShiftKeyActive) {
          newActiveIdList = [...activeElementIdList, element.id];
        } else {
          newActiveIdList = [element.id];
        }

        if (element.groupId) {
          const groupMembersId: string[] = [];
          elementListRef.current.forEach((el: PPTElement) => {
            if (el.groupId === element.groupId) groupMembersId.push(el.id);
          });
          newActiveIdList = [...newActiveIdList, ...groupMembersId];
        }

        setActiveElementIdList(uniq(newActiveIdList));
        setHandleElementId(element.id);
      }

      // If the target element is already selected with Ctrl/Shift held, deselect it
      // Unless it's the last selected element, or the group it belongs to is the last selected group
      // If the target is a group member, also deselect other members of that group
      else if (ctrlOrShiftKeyActive) {
        let newActiveIdList: string[] = [];

        if (element.groupId) {
          const groupMembersId: string[] = [];
          elementListRef.current.forEach((el: PPTElement) => {
            if (el.groupId === element.groupId) groupMembersId.push(el.id);
          });
          newActiveIdList = activeElementIdList.filter((id) => !groupMembersId.includes(id));
        } else {
          newActiveIdList = activeElementIdList.filter((id) => id !== element.id);
        }

        if (newActiveIdList.length > 0) {
          setActiveElementIdList(newActiveIdList);
        }
      }

      // If the target is already selected but not the current handle element, make it the handle element
      else if (handleElementId !== element.id) {
        setHandleElementId(element.id);
      }

      // If the target is already the handle element, clicking again sets it as the active group element
      else if (activeGroupElementId !== element.id) {
        const startPageX =
          e.nativeEvent instanceof MouseEvent
            ? e.nativeEvent.pageX
            : 'changedTouches' in e
              ? e.changedTouches[0].pageX
              : 0;
        const startPageY =
          e.nativeEvent instanceof MouseEvent
            ? e.nativeEvent.pageY
            : 'changedTouches' in e
              ? e.changedTouches[0].pageY
              : 0;

        const target = e.target as HTMLElement;
        const handleMouseUp = (e: MouseEvent) => {
          const currentPageX = e.pageX;
          const currentPageY = e.pageY;

          if (startPageX === currentPageX && startPageY === currentPageY) {
            setActiveGroupElementId(element.id);
            target.onmouseup = null;
          }
        };

        target.onmouseup = handleMouseUp;
      }

      if (startMove) moveElement(e, element);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally excludes elementListRef (stable ref) to avoid infinite re-creation
    [
      editorAreaFocus,
      activeElementIdList,
      ctrlOrShiftKeyActive,
      handleElementId,
      activeGroupElementId,
      setEditorAreaFocus,
      setActiveElementIdList,
      setHandleElementId,
      setActiveGroupElementId,
      moveElement,
    ],
  );

  return {
    selectElement,
  };
}
