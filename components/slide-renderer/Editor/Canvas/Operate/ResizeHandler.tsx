import { useMemo } from 'react';
import type { OperateResizeHandlers } from '@/lib/types/edit';

interface ResizeHandlerProps {
  readonly type?: OperateResizeHandlers;
  readonly rotate?: number;
  readonly style?: React.CSSProperties;
  readonly className?: string;
  readonly onMouseDown?: (e: React.MouseEvent) => void;
}

export function ResizeHandler({
  type,
  rotate = 0,
  style,
  className,
  onMouseDown,
}: ResizeHandlerProps) {
  const rotateClassName = useMemo(() => {
    const prefix = 'rotate-';
    if (rotate > -22.5 && rotate <= 22.5) return prefix + '0';
    else if (rotate > 22.5 && rotate <= 67.5) return prefix + '45';
    else if (rotate > 67.5 && rotate <= 112.5) return prefix + '90';
    else if (rotate > 112.5 && rotate <= 157.5) return prefix + '135';
    else if (rotate > 157.5 || rotate <= -157.5) return prefix + '0';
    else if (rotate > -157.5 && rotate <= -112.5) return prefix + '45';
    else if (rotate > -112.5 && rotate <= -67.5) return prefix + '90';
    else if (rotate > -67.5 && rotate <= -22.5) return prefix + '135';
    return prefix + '0';
  }, [rotate]);

  // Map rotation and handler type to cursor style
  const cursorClass = useMemo(() => {
    const key = `${type}.${rotateClassName}`;
    const cursorMap: Record<string, string> = {
      // nwse-resize (northwest-southeast)
      'left-top.rotate-0': 'cursor-nwse-resize',
      'right-bottom.rotate-0': 'cursor-nwse-resize',
      'left.rotate-45': 'cursor-nwse-resize',
      'right.rotate-45': 'cursor-nwse-resize',
      'left-bottom.rotate-90': 'cursor-nwse-resize',
      'right-top.rotate-90': 'cursor-nwse-resize',
      'top.rotate-135': 'cursor-nwse-resize',
      'bottom.rotate-135': 'cursor-nwse-resize',

      // ns-resize (north-south)
      'top.rotate-0': 'cursor-ns-resize',
      'bottom.rotate-0': 'cursor-ns-resize',
      'left-top.rotate-45': 'cursor-ns-resize',
      'right-bottom.rotate-45': 'cursor-ns-resize',
      'left.rotate-90': 'cursor-ns-resize',
      'right.rotate-90': 'cursor-ns-resize',
      'left-bottom.rotate-135': 'cursor-ns-resize',
      'right-top.rotate-135': 'cursor-ns-resize',

      // nesw-resize (northeast-southwest)
      'left-bottom.rotate-0': 'cursor-nesw-resize',
      'right-top.rotate-0': 'cursor-nesw-resize',
      'top.rotate-45': 'cursor-nesw-resize',
      'bottom.rotate-45': 'cursor-nesw-resize',
      'left-top.rotate-90': 'cursor-nesw-resize',
      'right-bottom.rotate-90': 'cursor-nesw-resize',
      'left.rotate-135': 'cursor-nesw-resize',
      'right.rotate-135': 'cursor-nesw-resize',

      // ew-resize (east-west)
      'left.rotate-0': 'cursor-ew-resize',
      'right.rotate-0': 'cursor-ew-resize',
      'left-bottom.rotate-45': 'cursor-ew-resize',
      'right-top.rotate-45': 'cursor-ew-resize',
      'top.rotate-90': 'cursor-ew-resize',
      'bottom.rotate-90': 'cursor-ew-resize',
      'left-top.rotate-135': 'cursor-ew-resize',
      'right-bottom.rotate-135': 'cursor-ew-resize',
    };
    return cursorMap[key] || 'cursor-pointer';
  }, [type, rotateClassName]);

  return (
    <div
      className={`resize-handler absolute w-[10px] h-[10px] left-0 top-0 m-[-5px_0_0_-5px] border border-primary bg-white rounded-[1px] ${cursorClass} ${className || ''}`}
      style={style}
      onMouseDown={onMouseDown}
    />
  );
}
