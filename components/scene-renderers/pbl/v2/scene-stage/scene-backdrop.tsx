'use client';

/**
 * PBL v2 — Scene backdrop (SCENARIO ONLY, increment 5).
 *
 * Renders a deterministic, animated backdrop from the sanitized, LLM-authored
 * scene visual: a gradient (free-form palette) + softly-glowing, drifting
 * emoji motifs that the Planner chose to fit THIS project's roleplay stages.
 * No external assets, no network, no enumeration — so it renders identically
 * and instantly for any scenario, and the entrance animation replays whenever
 * the banner expands (never a static image). Purely cosmetic.
 */

import { motion } from 'motion/react';
import type { SanitizedSceneVisual } from './scene-types';

interface Props {
  readonly visual: SanitizedSceneVisual;
}

// Spread positions for up to 4 motifs (percent of the backdrop box).
const MOTIF_SLOTS = [
  { left: '20%', top: '34%', size: 52 },
  { left: '72%', top: '26%', size: 44 },
  { left: '50%', top: '54%', size: 40 },
  { left: '84%', top: '60%', size: 34 },
] as const;

export function SceneBackdrop({ visual }: Props) {
  const { bg1, bg2, accent, motifs } = visual;
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ background: `linear-gradient(160deg, ${bg1} 0%, ${bg2} 100%)` }}
    >
      {/* ambient glows */}
      <motion.div
        aria-hidden
        className="absolute -left-10 -top-12 h-44 w-44 rounded-full blur-3xl"
        style={{ background: accent }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.18 }}
        transition={{ duration: 0.7 }}
      />
      <motion.div
        aria-hidden
        className="absolute -right-12 top-4 h-40 w-40 rounded-full blur-3xl"
        style={{ background: accent }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.12 }}
        transition={{ duration: 0.7, delay: 0.1 }}
      />
      {/* ground gradient */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-1/3"
        style={{ background: 'linear-gradient(0deg,rgba(0,0,0,0.30),transparent)' }}
      />

      {/* emoji motifs — enter staggered, then drift gently forever */}
      {motifs.map((m, i) => {
        const slot = MOTIF_SLOTS[i] ?? MOTIF_SLOTS[MOTIF_SLOTS.length - 1];
        return (
          <motion.div
            key={`${i}-${m}`}
            aria-hidden
            className="pointer-events-none absolute select-none"
            style={{
              left: slot.left,
              top: slot.top,
              fontSize: slot.size,
              lineHeight: 1,
              filter: `drop-shadow(0 6px 18px rgba(0,0,0,0.45)) drop-shadow(0 0 14px ${accent}55)`,
            }}
            initial={{ opacity: 0, y: 16, scale: 0.6 }}
            animate={{
              opacity: 1,
              scale: 1,
              y: [0, -8, 0],
            }}
            transition={{
              opacity: { delay: 0.15 + i * 0.14, duration: 0.5 },
              scale: { delay: 0.15 + i * 0.14, duration: 0.5, ease: [0.22, 1, 0.36, 1] },
              y: {
                delay: 0.6 + i * 0.2,
                duration: 3.2 + i * 0.4,
                repeat: Infinity,
                ease: 'easeInOut',
              },
            }}
          >
            {m}
          </motion.div>
        );
      })}
    </div>
  );
}
