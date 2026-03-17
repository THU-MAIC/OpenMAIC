import { useEffect, type RefObject } from 'react';
import { useCanvasStore } from '@/lib/store';

export function useDrop(elementRef: RefObject<HTMLElement | null>) {
  const disableHotkeys = useCanvasStore.use.disableHotkeys();

  useEffect(() => {
    const element = elementRef.current;
    // Handle drop of elements/pages onto canvas
    const handleDrop = (e: DragEvent) => {
      if (!e.dataTransfer || e.dataTransfer.items.length === 0) return;
      if (disableHotkeys) return;

      const firstItem = e.dataTransfer.items[0];
      if (firstItem && firstItem.kind === 'string' && firstItem.type === 'text/plain') {
        firstItem.getAsString((_text) => {
          if (disableHotkeys) return;
          // TODO: implement createTextElement
        });
      }
    };

    const preventDefault = (e: DragEvent) => e.preventDefault();

    if (element) {
      element.addEventListener('drop', handleDrop);
    }

    document.addEventListener('dragleave', preventDefault);
    document.addEventListener('drop', preventDefault);
    document.addEventListener('dragenter', preventDefault);
    document.addEventListener('dragover', preventDefault);

    return () => {
      if (element) {
        element.removeEventListener('drop', handleDrop);
      }

      document.removeEventListener('dragleave', preventDefault);
      document.removeEventListener('drop', preventDefault);
      document.removeEventListener('dragenter', preventDefault);
      document.removeEventListener('dragover', preventDefault);
    };
  }, [elementRef, disableHotkeys]);
}
