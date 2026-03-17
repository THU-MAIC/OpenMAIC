'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useKeyboardStore, useCanvasStore } from '@/lib/store';
import { KEYS } from '@/configs/hotkey';
import { OperateResizeHandlers } from '@/lib/types/edit';
import type { ImageClipedEmitData } from '@/lib/types/edit';
import type { ImageClipDataRange, ImageElementClip } from '@/lib/types/slides';

export interface ImageClipHandlerProps {
  src: string;
  clipPath: string;
  width: number;
  height: number;
  top: number;
  left: number;
  rotate: number;
  clipData?: ImageElementClip;
  onClip: (payload: ImageClipedEmitData | null) => void;
}

export function ImageClipHandler({
  src,
  clipPath,
  width,
  height,
  rotate,
  clipData,
  onClip,
}: ImageClipHandlerProps) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

  const [clipWrapperPositionStyle, setClipWrapperPositionStyle] = useState({
    top: '0',
    left: '0',
  });
  const [isSettingClipRange, setIsSettingClipRange] = useState(false);
  const [currentRange, setCurrentRange] = useState<ImageClipDataRange | null>(null);
  // Top image container position and size (clip highlight area)
  const [topImgWrapperPosition, setTopImgWrapperPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  });

  const wrapperRef = useRef<HTMLDivElement>(null);

  // Get clip area info (clip area's width/height ratio relative to the original image and its position within it)
  const getClipDataTransformInfo = useCallback(() => {
    const [start, end] = clipData
      ? clipData.range
      : [
          [0, 0],
          [100, 100],
        ];

    const widthScale = (end[0] - start[0]) / 100;
    const heightScale = (end[1] - start[1]) / 100;
    const left = start[0] / widthScale;
    const top = start[1] / heightScale;

    return { widthScale, heightScale, left, top };
  }, [clipData]);

  // Bottom image position and size (masked area image)
  const imgPosition = useMemo(() => {
    const { widthScale, heightScale, left, top } = getClipDataTransformInfo();
    return {
      left: -left,
      top: -top,
      width: 100 / widthScale,
      height: 100 / heightScale,
    };
  }, [getClipDataTransformInfo]);

  // Bottom image position and size style (masked area image)
  const bottomImgPositionStyle = useMemo(() => {
    return {
      top: imgPosition.top + '%',
      left: imgPosition.left + '%',
      width: imgPosition.width + '%',
      height: imgPosition.height + '%',
    };
  }, [imgPosition]);

  // Top image container position and size style (clip highlight area)
  const topImgWrapperPositionStyle = useMemo(() => {
    const { top, left, width, height } = topImgWrapperPosition;
    return {
      top: top + '%',
      left: left + '%',
      width: width + '%',
      height: height + '%',
    };
  }, [topImgWrapperPosition]);

  // Top image position and size style (clipped area image)
  const topImgPositionStyle = useMemo(() => {
    const bottomWidth = imgPosition.width;
    const bottomHeight = imgPosition.height;

    const { top, left, width, height } = topImgWrapperPosition;

    return {
      left: -left * (100 / width) + '%',
      top: -top * (100 / height) + '%',
      width: (bottomWidth / width) * 100 + '%',
      height: (bottomHeight / height) * 100 + '%',
    };
  }, [imgPosition, topImgWrapperPosition]);

  // Initialize clip position info
  const initClipPosition = useCallback(() => {
    const { left, top } = getClipDataTransformInfo();
    setTopImgWrapperPosition({
      left: left,
      top: top,
      width: 100,
      height: 100,
    });

    setClipWrapperPositionStyle({
      top: -top + '%',
      left: -left + '%',
    });
  }, [getClipDataTransformInfo]);

  // Perform clip: calculate the clipped image position/size and clip info, then emit the data
  const handleClip = useCallback(() => {
    if (isSettingClipRange) return;

    if (!currentRange) {
      onClip(null);
      return;
    }

    const { left, top } = getClipDataTransformInfo();

    const position = {
      left: ((topImgWrapperPosition.left - left) / 100) * width,
      top: ((topImgWrapperPosition.top - top) / 100) * height,
      width: ((topImgWrapperPosition.width - 100) / 100) * width,
      height: ((topImgWrapperPosition.height - 100) / 100) * height,
    };

    const clipedEmitData: ImageClipedEmitData = {
      range: currentRange,
      position,
    };
    onClip(clipedEmitData);
  }, [
    isSettingClipRange,
    currentRange,
    getClipDataTransformInfo,
    topImgWrapperPosition,
    width,
    height,
    onClip,
  ]);

  // Calculate and update clip area range data
  const updateRange = useCallback(() => {
    const retPosition = {
      left: parseInt(topImgPositionStyle.left),
      top: parseInt(topImgPositionStyle.top),
      width: parseInt(topImgPositionStyle.width),
      height: parseInt(topImgPositionStyle.height),
    };

    const widthScale = 100 / retPosition.width;
    const heightScale = 100 / retPosition.height;

    const start: [number, number] = [
      -retPosition.left * widthScale,
      -retPosition.top * heightScale,
    ];
    const end: [number, number] = [widthScale * 100 + start[0], heightScale * 100 + start[1]];

    setCurrentRange([start, end]);
  }, [topImgPositionStyle]);

  // Move clip area
  const moveClipRange = useCallback(
    (e: React.MouseEvent) => {
      setIsSettingClipRange(true);
      let isMouseDown = true;

      const startPageX = e.pageX;
      const startPageY = e.pageY;
      const bottomPosition = imgPosition;
      const originPosition = { ...topImgWrapperPosition };

      const handleMouseMove = (e: MouseEvent) => {
        if (!isMouseDown) return;

        const currentPageX = e.pageX;
        const currentPageY = e.pageY;

        const _moveX = (currentPageX - startPageX) / canvasScale;
        const _moveY = (currentPageY - startPageY) / canvasScale;

        const _moveL = Math.sqrt(_moveX * _moveX + _moveY * _moveY);
        const _moveLRotate = Math.atan2(_moveY, _moveX);

        const rotateRad = _moveLRotate - (rotate / 180) * Math.PI;

        const moveX = ((_moveL * Math.cos(rotateRad)) / width) * 100;
        const moveY = ((_moveL * Math.sin(rotateRad)) / height) * 100;

        let targetLeft = originPosition.left + moveX;
        let targetTop = originPosition.top + moveY;

        if (targetLeft < 0) targetLeft = 0;
        else if (targetLeft + originPosition.width > bottomPosition.width) {
          targetLeft = bottomPosition.width - originPosition.width;
        }
        if (targetTop < 0) targetTop = 0;
        else if (targetTop + originPosition.height > bottomPosition.height) {
          targetTop = bottomPosition.height - originPosition.height;
        }

        setTopImgWrapperPosition({
          ...topImgWrapperPosition,
          left: targetLeft,
          top: targetTop,
        });
      };

      const handleMouseUp = () => {
        isMouseDown = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);

        updateRange();

        setTimeout(() => {
          setIsSettingClipRange(false);
        }, 0);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [canvasScale, rotate, width, height, imgPosition, topImgWrapperPosition, updateRange],
  );

  // Scale clip area
  const scaleClipRange = useCallback(
    (e: React.MouseEvent, type: OperateResizeHandlers) => {
      e.stopPropagation();
      setIsSettingClipRange(true);
      let isMouseDown = true;

      const minWidth = (50 / width) * 100;
      const minHeight = (50 / height) * 100;

      const startPageX = e.pageX;
      const startPageY = e.pageY;
      const bottomPosition = imgPosition;
      const originPosition = { ...topImgWrapperPosition };

      const aspectRatio = topImgWrapperPosition.width / topImgWrapperPosition.height;

      const handleMouseMove = (e: MouseEvent) => {
        if (!isMouseDown) return;

        const currentPageX = e.pageX;
        const currentPageY = e.pageY;

        const _moveX = (currentPageX - startPageX) / canvasScale;
        const _moveY = (currentPageY - startPageY) / canvasScale;

        const _moveL = Math.sqrt(_moveX * _moveX + _moveY * _moveY);
        const _moveLRotate = Math.atan2(_moveY, _moveX);

        const rotateRad = _moveLRotate - (rotate / 180) * Math.PI;

        let moveX = ((_moveL * Math.cos(rotateRad)) / width) * 100;
        let moveY = ((_moveL * Math.sin(rotateRad)) / height) * 100;

        if (ctrlOrShiftKeyActive) {
          if (
            type === OperateResizeHandlers.RIGHT_BOTTOM ||
            type === OperateResizeHandlers.LEFT_TOP
          )
            moveY = moveX / aspectRatio;
          if (
            type === OperateResizeHandlers.LEFT_BOTTOM ||
            type === OperateResizeHandlers.RIGHT_TOP
          )
            moveY = -moveX / aspectRatio;
        }

        let targetLeft: number, targetTop: number, targetWidth: number, targetHeight: number;

        if (type === OperateResizeHandlers.LEFT_TOP) {
          if (originPosition.left + moveX < 0) {
            moveX = -originPosition.left;
          }
          if (originPosition.top + moveY < 0) {
            moveY = -originPosition.top;
          }
          if (originPosition.width - moveX < minWidth) {
            moveX = originPosition.width - minWidth;
          }
          if (originPosition.height - moveY < minHeight) {
            moveY = originPosition.height - minHeight;
          }
          targetWidth = originPosition.width - moveX;
          targetHeight = originPosition.height - moveY;
          targetLeft = originPosition.left + moveX;
          targetTop = originPosition.top + moveY;
        } else if (type === OperateResizeHandlers.RIGHT_TOP) {
          if (originPosition.left + originPosition.width + moveX > bottomPosition.width) {
            moveX = bottomPosition.width - (originPosition.left + originPosition.width);
          }
          if (originPosition.top + moveY < 0) {
            moveY = -originPosition.top;
          }
          if (originPosition.width + moveX < minWidth) {
            moveX = minWidth - originPosition.width;
          }
          if (originPosition.height - moveY < minHeight) {
            moveY = originPosition.height - minHeight;
          }
          targetWidth = originPosition.width + moveX;
          targetHeight = originPosition.height - moveY;
          targetLeft = originPosition.left;
          targetTop = originPosition.top + moveY;
        } else if (type === OperateResizeHandlers.LEFT_BOTTOM) {
          if (originPosition.left + moveX < 0) {
            moveX = -originPosition.left;
          }
          if (originPosition.top + originPosition.height + moveY > bottomPosition.height) {
            moveY = bottomPosition.height - (originPosition.top + originPosition.height);
          }
          if (originPosition.width - moveX < minWidth) {
            moveX = originPosition.width - minWidth;
          }
          if (originPosition.height + moveY < minHeight) {
            moveY = minHeight - originPosition.height;
          }
          targetWidth = originPosition.width - moveX;
          targetHeight = originPosition.height + moveY;
          targetLeft = originPosition.left + moveX;
          targetTop = originPosition.top;
        } else if (type === OperateResizeHandlers.RIGHT_BOTTOM) {
          if (originPosition.left + originPosition.width + moveX > bottomPosition.width) {
            moveX = bottomPosition.width - (originPosition.left + originPosition.width);
          }
          if (originPosition.top + originPosition.height + moveY > bottomPosition.height) {
            moveY = bottomPosition.height - (originPosition.top + originPosition.height);
          }
          if (originPosition.width + moveX < minWidth) {
            moveX = minWidth - originPosition.width;
          }
          if (originPosition.height + moveY < minHeight) {
            moveY = minHeight - originPosition.height;
          }
          targetWidth = originPosition.width + moveX;
          targetHeight = originPosition.height + moveY;
          targetLeft = originPosition.left;
          targetTop = originPosition.top;
        } else if (type === OperateResizeHandlers.TOP) {
          if (originPosition.top + moveY < 0) {
            moveY = -originPosition.top;
          }
          if (originPosition.height - moveY < minHeight) {
            moveY = originPosition.height - minHeight;
          }
          targetWidth = originPosition.width;
          targetHeight = originPosition.height - moveY;
          targetLeft = originPosition.left;
          targetTop = originPosition.top + moveY;
        } else if (type === OperateResizeHandlers.BOTTOM) {
          if (originPosition.top + originPosition.height + moveY > bottomPosition.height) {
            moveY = bottomPosition.height - (originPosition.top + originPosition.height);
          }
          if (originPosition.height + moveY < minHeight) {
            moveY = minHeight - originPosition.height;
          }
          targetWidth = originPosition.width;
          targetHeight = originPosition.height + moveY;
          targetLeft = originPosition.left;
          targetTop = originPosition.top;
        } else if (type === OperateResizeHandlers.LEFT) {
          if (originPosition.left + moveX < 0) {
            moveX = -originPosition.left;
          }
          if (originPosition.width - moveX < minWidth) {
            moveX = originPosition.width - minWidth;
          }
          targetWidth = originPosition.width - moveX;
          targetHeight = originPosition.height;
          targetLeft = originPosition.left + moveX;
          targetTop = originPosition.top;
        } else {
          if (originPosition.left + originPosition.width + moveX > bottomPosition.width) {
            moveX = bottomPosition.width - (originPosition.left + originPosition.width);
          }
          if (originPosition.width + moveX < minWidth) {
            moveX = minWidth - originPosition.width;
          }
          targetHeight = originPosition.height;
          targetWidth = originPosition.width + moveX;
          targetLeft = originPosition.left;
          targetTop = originPosition.top;
        }

        setTopImgWrapperPosition({
          left: targetLeft,
          top: targetTop,
          width: targetWidth,
          height: targetHeight,
        });
      };

      const handleMouseUp = () => {
        isMouseDown = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);

        updateRange();

        setTimeout(() => setIsSettingClipRange(false), 0);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [
      canvasScale,
      rotate,
      width,
      height,
      imgPosition,
      topImgWrapperPosition,
      ctrlOrShiftKeyActive,
      updateRange,
    ],
  );

  // Rotate class name
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

  const cornerPoint = [
    OperateResizeHandlers.LEFT_TOP,
    OperateResizeHandlers.RIGHT_TOP,
    OperateResizeHandlers.LEFT_BOTTOM,
    OperateResizeHandlers.RIGHT_BOTTOM,
  ];
  const edgePoints = [
    OperateResizeHandlers.TOP,
    OperateResizeHandlers.BOTTOM,
    OperateResizeHandlers.LEFT,
    OperateResizeHandlers.RIGHT,
  ];

  // Initialize on mount
  useEffect(() => {
    initClipPosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard listener: Enter to confirm clip
  useEffect(() => {
    const keyboardListener = (e: KeyboardEvent) => {
      const key = e.key.toUpperCase();
      if (key === KEYS.ENTER) handleClip();
    };

    document.addEventListener('keydown', keyboardListener);
    return () => {
      document.removeEventListener('keydown', keyboardListener);
    };
  }, [handleClip]);

  // Click outside listener
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        handleClip();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [handleClip]);

  return (
    <div
      ref={wrapperRef}
      className="image-clip-handler w-full h-full relative"
      style={clipWrapperPositionStyle}
    >
      <img
        className="bottom-img absolute top-0 left-0 w-full h-full opacity-50"
        src={src}
        draggable={false}
        alt=""
        style={bottomImgPositionStyle}
      />

      <div
        className="top-image-content absolute overflow-hidden"
        style={{
          ...topImgWrapperPositionStyle,
          clipPath,
        }}
      >
        <img
          className="top-img absolute w-full h-full"
          src={src}
          draggable={false}
          alt=""
          style={topImgPositionStyle}
        />
      </div>

      <div
        className="operate absolute w-full h-full top-0 left-0 cursor-move"
        style={topImgWrapperPositionStyle}
        onMouseDown={(e) => {
          e.stopPropagation();
          moveClipRange(e);
        }}
      >
        {cornerPoint.map((point) => (
          <div
            key={point}
            className={`clip-point ${point} ${rotateClassName}`}
            onMouseDown={(e) => scaleClipRange(e, point)}
          >
            <svg width="16" height="16" fill="#fff" stroke="#333">
              <path
                strokeWidth="0.3"
                shapeRendering="crispEdges"
                d="M 16 0 L 0 0 L 0 16 L 4 16 L 4 4 L 16 4 L 16 0 Z"
              />
            </svg>
          </div>
        ))}
        {edgePoints.map((point) => (
          <div
            key={point}
            className={`clip-point ${point} ${rotateClassName}`}
            onMouseDown={(e) => scaleClipRange(e, point)}
          >
            <svg width="16" height="16" fill="#fff" stroke="#333">
              <path strokeWidth="0.3" shapeRendering="crispEdges" d="M 16 0 L 0 0 L 0 4 L 16 4 Z" />
            </svg>
          </div>
        ))}
      </div>

      <style jsx>{`
        .clip-point {
          position: absolute;
          width: 16px;
          height: 16px;
        }

        .clip-point svg {
          overflow: visible;
        }

        .clip-point.left-top {
          left: 0;
          top: 0;
        }
        .clip-point.right-top {
          left: 100%;
          top: 0;
          transform: rotate(90deg);
          transform-origin: 0 0;
        }
        .clip-point.left-bottom {
          left: 0;
          top: 100%;
          transform: rotate(-90deg);
          transform-origin: 0 0;
        }
        .clip-point.right-bottom {
          left: 100%;
          top: 100%;
          transform: rotate(180deg);
          transform-origin: 0 0;
        }
        .clip-point.top {
          left: 50%;
          top: 0;
          margin-left: -8px;
        }
        .clip-point.bottom {
          left: 50%;
          bottom: 0;
          margin-left: -8px;
          transform: rotate(180deg);
        }
        .clip-point.left {
          left: 0;
          top: 50%;
          margin-top: -8px;
          transform: rotate(-90deg);
        }
        .clip-point.right {
          right: 0;
          top: 50%;
          margin-top: -8px;
          transform: rotate(90deg);
        }

        .clip-point.left-top.rotate-0,
        .clip-point.right-bottom.rotate-0,
        .clip-point.left.rotate-45,
        .clip-point.right.rotate-45,
        .clip-point.left-bottom.rotate-90,
        .clip-point.right-top.rotate-90,
        .clip-point.top.rotate-135,
        .clip-point.bottom.rotate-135 {
          cursor: nwse-resize;
        }
        .clip-point.top.rotate-0,
        .clip-point.bottom.rotate-0,
        .clip-point.left-top.rotate-45,
        .clip-point.right-bottom.rotate-45,
        .clip-point.left.rotate-90,
        .clip-point.right.rotate-90,
        .clip-point.left-bottom.rotate-135,
        .clip-point.right-top.rotate-135 {
          cursor: ns-resize;
        }
        .clip-point.left-bottom.rotate-0,
        .clip-point.right-top.rotate-0,
        .clip-point.top.rotate-45,
        .clip-point.bottom.rotate-45,
        .clip-point.left-top.rotate-90,
        .clip-point.right-bottom.rotate-90,
        .clip-point.left.rotate-135,
        .clip-point.right.rotate-135 {
          cursor: nesw-resize;
        }
        .clip-point.left.rotate-0,
        .clip-point.right.rotate-0,
        .clip-point.left-bottom.rotate-45,
        .clip-point.right-top.rotate-45,
        .clip-point.top.rotate-90,
        .clip-point.bottom.rotate-90,
        .clip-point.left-top.rotate-135,
        .clip-point.right-bottom.rotate-135 {
          cursor: ew-resize;
        }
      `}</style>
    </div>
  );
}
