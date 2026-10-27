/** Contain touch scrolling in a fixed page shell while retaining nested scrolling and zoom. */
export function installPageScrollBoundary(document: Document): () => void {
  let lastTouch: { x: number; y: number } | null = null;
  const start = (event: TouchEvent) => {
    lastTouch =
      event.touches.length === 1
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : null;
  };
  const move = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      lastTouch = null;
      return;
    }
    const previous = lastTouch;
    lastTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    if (!previous) return;
    const deltaX = lastTouch.x - previous.x;
    const deltaY = lastTouch.y - previous.y;
    const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
    const delta = horizontal ? deltaX : deltaY;
    if (!delta) return;
    let element = event.target instanceof Element ? event.target : null;
    while (element && element !== document.body && element !== document.documentElement) {
      const style = getComputedStyle(element);
      const remaining = horizontal
        ? element.scrollWidth - element.clientWidth
        : element.scrollHeight - element.clientHeight;
      if (/(auto|scroll)/.test(horizontal ? style.overflowX : style.overflowY) && remaining > 1) {
        // RTL scrollLeft is zero at the right edge and negative towards the left.
        const position = horizontal
          ? element.scrollLeft + (style.direction === 'rtl' ? remaining : 0)
          : element.scrollTop;
        if (delta < 0 ? position < remaining - 1 : position > 0) return;
      }
      element = element.parentElement;
    }
    if (event.cancelable) event.preventDefault();
  };
  document.addEventListener('touchstart', start, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  return () => {
    document.removeEventListener('touchstart', start);
    document.removeEventListener('touchmove', move);
  };
}
