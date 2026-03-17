'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { PercentageGeometry } from '@/lib/types/action';

interface ZoomWrapperProps {
  children: ReactNode;
  zoomTarget: { elementId: string; scale: number } | null;
  geometry: PercentageGeometry | null;
}

/**
 * 缩放包装器组件
 *
 * 功能：
 * - 包裹整个画布，根据 zoomTarget 进行缩放
 * - 以元素中心为缩放原点
 * - 使用百分比坐标系统
 */
export function ZoomWrapper({ children, zoomTarget, geometry }: ZoomWrapperProps) {
  if (!zoomTarget || !geometry) {
    return <>{children}</>;
  }

  const { scale } = zoomTarget;
  const { centerX, centerY } = geometry;

  return (
    <motion.div
      className="w-full h-full"
      initial={{ scale: 1 }}
      animate={{ scale }}
      exit={{ scale: 1 }}
      transition={{
        type: 'spring',
        stiffness: 200,
        damping: 25,
      }}
      style={{
        transformOrigin: `${centerX}% ${centerY}%`,
      }}
    >
      {children}
    </motion.div>
  );
}
