import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useKeyboardStore } from '@/lib/store/keyboard';
import { useCanvasStore, useSceneSelector } from '@/lib/store';
import type { CreateCustomShapeData } from '@/lib/types/edit';
import type { SlideContent } from '@/lib/types/stage';
import type { SlideTheme } from '@/lib/types/slides';
import { toast } from 'sonner';

interface ShapeCreateCanvasProps {
  onCreated: (data: CreateCustomShapeData) => void;
}

export function ShapeCreateCanvas({ onCreated }: ShapeCreateCanvasProps) {
  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());
  const setCreatingCustomShapeState = useCanvasStore.use.setCreatingCustomShapeState();
  const theme = useSceneSelector<SlideContent, SlideTheme>((content) => content.canvas.theme);

  const shapeCanvasRef = useRef<HTMLDivElement>(null);
  const [isMouseDown, setIsMouseDown] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [mousePosition, setMousePosition] = useState<[number, number] | null>(null);
  const [points, setPoints] = useState<[number, number][]>([]);
  const [closed, setClosed] = useState(false);

  const close = useCallback(() => {
    setCreatingCustomShapeState(false);
  }, [setCreatingCustomShapeState]);

  const getCreateData = useCallback(
    (closeShape = true) => {
      const xList = points.map((item) => item[0]);
      const yList = points.map((item) => item[1]);
      const minX = Math.min(...xList);
      const minY = Math.min(...yList);
      const maxX = Math.max(...xList);
      const maxY = Math.max(...yList);

      const formatedPoints = points.map((point) => {
        return [point[0] - minX, point[1] - minY];
      });

      let pathStr = '';
      for (let i = 0; i < formatedPoints.length; i++) {
        const point = formatedPoints[i];
        if (i === 0) pathStr += `M ${point[0]} ${point[1]} `;
        else pathStr += `L ${point[0]} ${point[1]} `;
      }
      if (closeShape) pathStr += 'Z';

      const start: [number, number] = [minX + offset.x, minY + offset.y];
      const end: [number, number] = [maxX + offset.x, maxY + offset.y];
      const viewBox: [number, number] = [maxX - minX, maxY - minY];

      return {
        start,
        end,
        path: pathStr,
        viewBox,
      };
    },
    [points, offset],
  );

  const create = useCallback(() => {
    onCreated({
      ...getCreateData(false),
      fill: 'rgba(0, 0, 0, 0)',
      outline: {
        width: 2,
        color: theme.themeColors[0],
        style: 'solid',
      },
    });
    close();
  }, [onCreated, getCreateData, theme, close]);

  useEffect(() => {
    if (!shapeCanvasRef.current) return;
    const { x, y } = shapeCanvasRef.current.getBoundingClientRect();
    setOffset({ x, y });

    // Show instruction toast
    toast.info(
      'Click to draw any shape, close the path to finish, press ESC or right-click to cancel, press ENTER to finish early',
    );

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toUpperCase();
      if (key === 'ESCAPE') close();
      if (key === 'ENTER') create();
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [close, create]);

  const getPoint = (e: React.MouseEvent | MouseEvent, custom = false) => {
    let pageX = e.pageX - offset.x;
    let pageY = e.pageY - offset.y;

    if (custom) return { pageX, pageY };

    if (ctrlOrShiftKeyActive && points.length) {
      const [lastPointX, lastPointY] = points[points.length - 1];
      if (Math.abs(lastPointX - pageX) - Math.abs(lastPointY - pageY) > 0) {
        pageY = lastPointY;
      } else pageX = lastPointX;
    }
    return { pageX, pageY };
  };

  const updateMousePosition = (e: React.MouseEvent) => {
    if (isMouseDown) {
      const { pageX, pageY } = getPoint(e, true);
      setPoints([...points, [pageX, pageY]]);
      setMousePosition(null);
      return;
    }

    const { pageX, pageY } = getPoint(e);
    setMousePosition([pageX, pageY]);

    if (points.length >= 2) {
      const [firstPointX, firstPointY] = points[0];
      if (Math.abs(firstPointX - pageX) < 5 && Math.abs(firstPointY - pageY) < 5) {
        setClosed(true);
      } else setClosed(false);
    } else setClosed(false);
  };

  const path = useMemo(() => {
    let d = '';
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (i === 0) d += `M ${point[0]} ${point[1]} `;
      else d += `L ${point[0]} ${point[1]} `;
    }
    if (points.length && mousePosition) {
      d += `L ${mousePosition[0]} ${mousePosition[1]}`;
    }
    return d;
  }, [points, mousePosition]);

  const addPoint = (e: React.MouseEvent) => {
    const { pageX, pageY } = getPoint(e);
    setIsMouseDown(true);

    if (closed) {
      onCreated(getCreateData());
    } else {
      setPoints([...points, [pageX, pageY]]);
    }

    const handleMouseUp = () => {
      setIsMouseDown(false);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      ref={shapeCanvasRef}
      className="shape-create-canvas absolute top-0 left-0 w-full h-full z-[2] cursor-crosshair"
      onMouseDown={(e) => {
        e.stopPropagation();
        addPoint(e);
      }}
      onMouseMove={updateMousePosition}
      onContextMenu={(e) => {
        e.stopPropagation();
        e.preventDefault();
        close();
      }}
    >
      <svg className="w-full h-full overflow-visible">
        <path
          d={path}
          stroke="#d14424"
          fill={closed ? 'rgba(226, 83, 77, 0.15)' : 'none'}
          strokeWidth="2"
        />
      </svg>
    </div>
  );
}
