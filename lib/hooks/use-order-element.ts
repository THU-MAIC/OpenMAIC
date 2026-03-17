import type { PPTElement } from '@/lib/types/slides';

export function useOrderElement() {
  /**
   * Get the z-order range of grouped elements
   * @param elementList All elements on the page
   * @param combineElementList Grouped elements list
   */
  const getCombineElementLevelRange = (
    elementList: PPTElement[],
    combineElementList: PPTElement[],
  ) => {
    return {
      minLevel: elementList.findIndex((_element) => _element.id === combineElementList[0].id),
      maxLevel: elementList.findIndex(
        (_element) => _element.id === combineElementList[combineElementList.length - 1].id,
      ),
    };
  };

  /**
   * Move up one layer
   * @param elementList All elements on the page
   * @param element The element being operated on
   */
  const moveUpElement = (elementList: PPTElement[], element: PPTElement) => {
    const copyOfElementList: PPTElement[] = JSON.parse(JSON.stringify(elementList));

    // If the element is a group member, all group members must be moved together
    if (element.groupId) {
      // Get all group members and their z-order range
      const combineElementList = copyOfElementList.filter(
        (_element) => _element.groupId === element.groupId,
      );
      const { minLevel, maxLevel } = getCombineElementLevelRange(elementList, combineElementList);

      // Already at the top level, cannot move further
      const nextElement = copyOfElementList[maxLevel + 1];
      const movedElementList = copyOfElementList.splice(minLevel, combineElementList.length);

      if (nextElement.groupId) {
        const nextCombineElementList = copyOfElementList.filter(
          (_element) => _element.groupId === nextElement.groupId,
        );
        copyOfElementList.splice(minLevel + nextCombineElementList.length, 0, ...movedElementList);
      } else copyOfElementList.splice(minLevel + 1, 0, ...movedElementList);
    }

    // If the element is not a group member
    else {
      // Get the element's z-level in the list
      const level = elementList.findIndex((item) => item.id === element.id);

      // Already at the top level, cannot move further
      if (level === elementList.length - 1) return;

      // Get the element above, remove this element from the list (cache removed element).
      // If the above element is in a group, insert above that group.
      // If the above element is not in any group, insert above that element.
      const nextElement = copyOfElementList[level + 1];
      const [movedElement] = copyOfElementList.splice(level, 1);
      if (nextElement.groupId) {
        const combineElementList = copyOfElementList.filter(
          (_element) => _element.groupId === nextElement.groupId,
        );
        copyOfElementList.splice(level + combineElementList.length, 0, movedElement);
      } else copyOfElementList.splice(level + 1, 0, movedElement);
    }

    return copyOfElementList;
  };

  /**
   * Move down one layer, same approach as move up
   * @param elementList All elements on the page
   * @param element The element being operated on
   */
  const moveDownElement = (elementList: PPTElement[], element: PPTElement) => {
    const copyOfElementList: PPTElement[] = JSON.parse(JSON.stringify(elementList));

    if (element.groupId) {
      const combineElementList = copyOfElementList.filter(
        (_element) => _element.groupId === element.groupId,
      );
      const { minLevel } = getCombineElementLevelRange(elementList, combineElementList);
      if (minLevel === 0) return;

      const prevElement = copyOfElementList[minLevel - 1];
      const movedElementList = copyOfElementList.splice(minLevel, combineElementList.length);

      if (prevElement.groupId) {
        const prevCombineElementList = copyOfElementList.filter(
          (_element) => _element.groupId === prevElement.groupId,
        );
        copyOfElementList.splice(minLevel - prevCombineElementList.length, 0, ...movedElementList);
      } else copyOfElementList.splice(minLevel - 1, 0, ...movedElementList);
    } else {
      const level = elementList.findIndex((item) => item.id === element.id);
      if (level === 0) return;

      const prevElement = copyOfElementList[level - 1];
      const movedElement = copyOfElementList.splice(level, 1)[0];

      if (prevElement.groupId) {
        const combineElementList = copyOfElementList.filter(
          (_element) => _element.groupId === prevElement.groupId,
        );
        copyOfElementList.splice(level - combineElementList.length, 0, movedElement);
      } else copyOfElementList.splice(level - 1, 0, movedElement);
    }

    return copyOfElementList;
  };

  /**
   * Bring to front
   * @param elementList All elements on the page
   * @param element The element being operated on
   */
  const moveTopElement = (elementList: PPTElement[], element: PPTElement) => {
    const copyOfElementList: PPTElement[] = JSON.parse(JSON.stringify(elementList));

    // If the element is a group member, all group members must be moved together
    if (element.groupId) {
      // Get all group members and their z-order range
      const combineElementList = copyOfElementList.filter(
        (_element) => _element.groupId === element.groupId,
      );
      const { minLevel, maxLevel } = getCombineElementLevelRange(elementList, combineElementList);

      // Already at the top level, cannot move further
      if (maxLevel === elementList.length - 1) return null;

      // Remove the group from the list, then append removed elements to the top
      const movedElementList = copyOfElementList.splice(minLevel, combineElementList.length);
      copyOfElementList.push(...movedElementList);
    }

    // If the element is not a group member
    else {
      // Get the element's z-level in the list
      const level = elementList.findIndex((item) => item.id === element.id);

      // Already at the top level, cannot move further
      if (level === elementList.length - 1) return null;

      // Remove the element from the list, then append it to the top
      copyOfElementList.splice(level, 1);
      copyOfElementList.push(element);
    }

    return copyOfElementList;
  };

  /**
   * Send to back, same approach as bring to front
   * @param elementList All elements on the page
   * @param element The element being operated on
   */
  const moveBottomElement = (elementList: PPTElement[], element: PPTElement) => {
    const copyOfElementList: PPTElement[] = JSON.parse(JSON.stringify(elementList));

    if (element.groupId) {
      const combineElementList = copyOfElementList.filter(
        (_element) => _element.groupId === element.groupId,
      );
      const { minLevel } = getCombineElementLevelRange(elementList, combineElementList);
      if (minLevel === 0) return;

      const movedElementList = copyOfElementList.splice(minLevel, combineElementList.length);
      copyOfElementList.unshift(...movedElementList);
    } else {
      const level = elementList.findIndex((item) => item.id === element.id);
      if (level === 0) return;

      copyOfElementList.splice(level, 1);
      copyOfElementList.unshift(element);
    }

    return copyOfElementList;
  };

  return {
    moveUpElement,
    moveDownElement,
    moveTopElement,
    moveBottomElement,
  };
}
