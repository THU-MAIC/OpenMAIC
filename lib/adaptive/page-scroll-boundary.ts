/** Contain touch scrolling in a fixed page shell while retaining nested scrolling and zoom. */
export function installPageScrollBoundary(document: Document): () => void {
  let lastY: number | null = null;
  const start = (event: TouchEvent) => {
    lastY = event.touches.length === 1 ? event.touches[0].clientY : null;
  };
  const move = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      lastY = null;
      return;
    }
    const y = event.touches[0].clientY;
    const delta = lastY === null ? 0 : y - lastY;
    lastY = y;
    if (!delta) return;
    let element = event.target instanceof Element ? event.target : null;
    while (element && element !== document.body && element !== document.documentElement) {
      const style = getComputedStyle(element);
      const remaining = element.scrollHeight - element.clientHeight;
      if (/(auto|scroll)/.test(style.overflowY) && remaining > 1) {
        if (delta < 0 ? element.scrollTop < remaining - 1 : element.scrollTop > 0) return;
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
