import { useState, useRef, useEffect, useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import { useKeyboardStore } from '@/lib/store/keyboard';
import type { CreateElementSelectionData } from '@/lib/types/edit';

interface ElementCreateSelectionProps {
  onCreated: (data: CreateElementSelectionData) => void;
}

export function ElementCreateSelection({ onCreated }: ElementCreateSelectionProps) {
  const creatingElement = useCanvasStore.use.creatingElement();
  const setCreatingElement = useCanvasStore.use.setCreatingElement();
  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

  const [start, setStart] = useState<[number, number]>();
  const [end, setEnd] = useState<[number, number]>();
  const selectionRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!selectionRef.current) return;
    const { x, y } = selectionRef.current.getBoundingClientRect();
    setOffset({ x, y });
  }, []);

  // Mouse drag to create element: determine position and size
  // Get the start and end positions of the selection range
  const createSelection = (e: React.MouseEvent) => {
    let isMouseDown = true;

    const startPageX = e.pageX;
    const startPageY = e.pageY;
    setStart([startPageX, startPageY]);

    const handleMouseMove = (e: MouseEvent) => {
      if (!creatingElement || !isMouseDown) return;

      let currentPageX = e.pageX;
      let currentPageY = e.pageY;

      // When Ctrl or Shift is held:
      // For non-line elements, lock aspect ratio; for line elements, lock to horizontal or vertical direction
      if (ctrlOrShiftKeyActive) {
        const moveX = currentPageX - startPageX;
        const moveY = currentPageY - startPageY;

        // Horizontal and vertical drag distances; use the larger one as the base for computing the other
        const absX = Math.abs(moveX);
        const absY = Math.abs(moveY);

        if (creatingElement.type === 'shape') {
          // Check if dragging in reverse direction: top-left to bottom-right is forward, everything else is reverse
          const isOpposite = (moveY > 0 && moveX < 0) || (moveY < 0 && moveX > 0);

          if (absX > absY) {
            currentPageY = isOpposite ? startPageY - moveX : startPageY + moveX;
          } else {
            currentPageX = isOpposite ? startPageX - moveY : startPageX + moveY;
          }
        } else if (creatingElement.type === 'line') {
          if (absX > absY) currentPageY = startPageY;
          else currentPageX = startPageX;
        }
      }

      setEnd([currentPageX, currentPageY]);
    };

    const handleMouseUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      if (e.button === 2) {
        setTimeout(() => setCreatingElement(null), 0);
        return;
      }

      isMouseDown = false;

      const endPageX = e.pageX;
      const endPageY = e.pageY;

      const minSize = 30;

      if (
        creatingElement?.type === 'line' &&
        (Math.abs(endPageX - startPageX) >= minSize || Math.abs(endPageY - startPageY) >= minSize)
      ) {
        onCreated({
          start: [startPageX, startPageY],
          end: [endPageX, endPageY],
        });
      } else if (
        creatingElement?.type !== 'line' &&
        Math.abs(endPageX - startPageX) >= minSize &&
        Math.abs(endPageY - startPageY) >= minSize
      ) {
        onCreated({
          start: [startPageX, startPageY],
          end: [endPageX, endPageY],
        });
      } else {
        const defaultSize = 200;
        const minX = Math.min(endPageX, startPageX);
        const minY = Math.min(endPageY, startPageY);
        const maxX = Math.max(endPageX, startPageX);
        const maxY = Math.max(endPageY, startPageY);
        const offsetX = maxX - minX >= minSize ? maxX - minX : defaultSize;
        const offsetY = maxY - minY >= minSize ? maxY - minY : defaultSize;
        onCreated({
          start: [minX, minY],
          end: [minX + offsetX, minY + offsetY],
        });
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // Line drawing path data (only used when creating element type is line)
  const lineData = useMemo(() => {
    if (!start || !end) return null;
    if (!creatingElement || creatingElement.type !== 'line') return null;

    const [_startX, _startY] = start;
    const [_endX, _endY] = end;
    const minX = Math.min(_startX, _endX);
    const maxX = Math.max(_startX, _endX);
    const minY = Math.min(_startY, _endY);
    const maxY = Math.max(_startY, _endY);

    const svgWidth = maxX - minX >= 24 ? maxX - minX : 24;
    const svgHeight = maxY - minY >= 24 ? maxY - minY : 24;

    const startX = _startX === minX ? 0 : maxX - minX;
    const startY = _startY === minY ? 0 : maxY - minY;
    const endX = _endX === minX ? 0 : maxX - minX;
    const endY = _endY === minY ? 0 : maxY - minY;

    const path = `M${startX}, ${startY} L${endX}, ${endY}`;

    return {
      svgWidth,
      svgHeight,
      path,
    };
  }, [start, end, creatingElement]);

  // Calculate element position and size from the selection start and end positions
  const position = useMemo(() => {
    if (!start || !end) return {};

    const [startX, startY] = start;
    const [endX, endY] = end;
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    const minY = Math.min(startY, endY);
    const maxY = Math.max(startY, endY);

    const width = maxX - minX;
    const height = maxY - minY;

    return {
      left: minX - offset.x + 'px',
      top: minY - offset.y + 'px',
      width: width + 'px',
      height: height + 'px',
    };
  }, [start, end, offset]);

  return (
    <div
      ref={selectionRef}
      className="element-create-selection absolute top-0 left-0 w-full h-full z-[2] cursor-crosshair"
      onMouseDown={(e) => {
        e.stopPropagation();
        createSelection(e);
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      {start && end && (
        <div
          className={`selection absolute opacity-80 ${creatingElement?.type !== 'line' ? 'border border-primary' : ''}`}
          style={position}
        >
          {/* Line drawing area */}
          {creatingElement?.type === 'line' && lineData && (
            <svg className="overflow-visible" width={lineData.svgWidth} height={lineData.svgHeight}>
              <path d={lineData.path} stroke="#d14424" fill="none" strokeWidth="2" />
            </svg>
          )}
        </div>
      )}
    </div>
  );
}
