'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { PercentageGeometry } from '../utils/geometry';
import type { ZoomEffectOptions } from '../types/effects';

export interface ZoomWrapperProps {
  children: ReactNode;
  zoom?: ZoomEffectOptions;
  geometry: PercentageGeometry | null;
}

export function ZoomWrapper({ children, zoom, geometry }: ZoomWrapperProps) {
  if (!zoom || !geometry) {
    return <>{children}</>;
  }

  const { scale } = zoom;
  const { centerX, centerY } = geometry;

  return (
    <motion.div
      initial={{ scale: 1 }}
      animate={{ scale }}
      exit={{ scale: 1 }}
      transition={{ type: 'spring', stiffness: 200, damping: 25 }}
      style={{
        width: '100%',
        height: '100%',
        transformOrigin: `${centerX}% ${centerY}%`,
      }}
    >
      {children}
    </motion.div>
  );
}
