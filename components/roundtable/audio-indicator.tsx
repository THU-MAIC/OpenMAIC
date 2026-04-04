'use client';

import { motion } from 'motion/react';

export type AudioIndicatorState = 'idle' | 'generating' | 'playing';

interface AudioIndicatorProps {
  state: AudioIndicatorState;
  agentColor?: string;
}

const BAR_COUNT = 4;

export function AudioIndicator({ state, agentColor = '#10b981' }: AudioIndicatorProps) {
  if (state === 'idle') return null;

  const color = state === 'generating' ? 'rgba(251, 191, 36, 0.7)' : agentColor;
  const cycleDuration = state === 'generating' ? 0.8 : 0.5;

  return (
    <span className="inline-flex items-end gap-[2px]" style={{ height: 12 }}>
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <motion.span
          key={i}
          style={{
            width: 2,
            borderRadius: 1,
            backgroundColor: color,
          }}
          animate={{
            height: [4, 10 + (i % 2) * 2, 4],
          }}
          transition={{
            duration: cycleDuration,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * (cycleDuration / BAR_COUNT),
          }}
        />
      ))}
    </span>
  );
}
