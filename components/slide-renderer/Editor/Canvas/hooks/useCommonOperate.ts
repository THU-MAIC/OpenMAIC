import { useMemo } from 'react';
import { OperateResizeHandlers, OperateBorderLines } from '@/lib/types/edit';

export function useCommonOperate(width: number, height: number) {
  // Element resize handlers
  const resizeHandlers = useMemo(() => {
    return [
      { direction: OperateResizeHandlers.LEFT_TOP, style: {} },
      {
        direction: OperateResizeHandlers.TOP,
        style: { left: width / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.RIGHT_TOP,
        style: { left: width + 'px' },
      },
      {
        direction: OperateResizeHandlers.LEFT,
        style: { top: height / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.RIGHT,
        style: { left: width + 'px', top: height / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.LEFT_BOTTOM,
        style: { top: height + 'px' },
      },
      {
        direction: OperateResizeHandlers.BOTTOM,
        style: { left: width / 2 + 'px', top: height + 'px' },
      },
      {
        direction: OperateResizeHandlers.RIGHT_BOTTOM,
        style: { left: width + 'px', top: height + 'px' },
      },
    ];
  }, [width, height]);

  // Text element resize handlers
  const textElementResizeHandlers = useMemo(() => {
    return [
      {
        direction: OperateResizeHandlers.LEFT,
        style: { top: height / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.RIGHT,
        style: { left: width + 'px', top: height / 2 + 'px' },
      },
    ];
  }, [width, height]);

  const verticalTextElementResizeHandlers = useMemo(() => {
    return [
      {
        direction: OperateResizeHandlers.TOP,
        style: { left: width / 2 + 'px' },
      },
      {
        direction: OperateResizeHandlers.BOTTOM,
        style: { left: width / 2 + 'px', top: height + 'px' },
      },
    ];
  }, [width, height]);

  // Element selection border lines
  const borderLines = useMemo(() => {
    return [
      { type: OperateBorderLines.T, style: { width: width + 'px' } },
      {
        type: OperateBorderLines.B,
        style: { top: height + 'px', width: width + 'px' },
      },
      { type: OperateBorderLines.L, style: { height: height + 'px' } },
      {
        type: OperateBorderLines.R,
        style: { left: width + 'px', height: height + 'px' },
      },
    ];
  }, [width, height]);

  return {
    resizeHandlers,
    textElementResizeHandlers,
    verticalTextElementResizeHandlers,
    borderLines,
  };
}
