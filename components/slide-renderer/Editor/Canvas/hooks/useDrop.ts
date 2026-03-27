import { useEffect, type RefObject } from 'react';
import { useCanvasStore } from '@/lib/store';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { escapeHtml } from '@/lib/utils/sanitize-html';
import type { PPTTextElement } from '@/lib/types/slides';
import { nanoid } from 'nanoid';

export function useDrop(elementRef: RefObject<HTMLElement | null>) {
  const disableHotkeys = useCanvasStore.use.disableHotkeys();
  const canvasScale = useCanvasStore.use.canvasScale();
  const { addElement } = useCanvasOperations();

  useEffect(() => {
    const element = elementRef.current;
    // Handle drop of elements/pages onto canvas
    const handleDrop = (e: DragEvent) => {
      if (!e.dataTransfer || e.dataTransfer.items.length === 0) return;
      if (disableHotkeys) return;

      const firstItem = e.dataTransfer.items[0];
      if (firstItem && firstItem.kind === 'string' && firstItem.type === 'text/plain') {
        firstItem.getAsString((text) => {
          if (disableHotkeys || !text.trim() || !element) return;

          const rect = element.getBoundingClientRect();
          const left = (e.clientX - rect.left) / canvasScale;
          const top = (e.clientY - rect.top) / canvasScale;

          const newElement: PPTTextElement = {
            id: nanoid(10),
            type: 'text',
            left,
            top,
            width: 300,
            height: 50,
            rotate: 0,
            content: `<p>${escapeHtml(text)}</p>`,
            defaultFontName: 'Microsoft YaHei',
            defaultColor: '#333333',
          };
          addElement(newElement);
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
  }, [elementRef, disableHotkeys, canvasScale, addElement]);
}
