'use client';

/**
 * The medal a course ends on. A definition rather than bare markup, so that an
 * achievements system can add to it later.
 */
import { Sprout } from 'lucide-react';
import type { ComponentType, CSSProperties } from 'react';

export interface BadgeDefinition {
  readonly id: string;
  readonly Art: ComponentType;
}

function SeedlingMedal() {
  return (
    <div
      className="ce-coin"
      style={
        {
          '--ce-rim':
            'conic-gradient(from 210deg,#e7e5f1,#c7c4da,#a09db9,#dedbea,#b4b1c9,#918ead,#d6d4e4,#a9a6c1,#e7e5f1)',
          '--ce-disc': 'radial-gradient(circle at 34% 26%,#f1f0f7 0,#dad8e7 50%,#c7c5d9 100%)',
          '--ce-ink': '#5d5a82',
          '--ce-hi': 'rgba(255,255,255,.7)',
          '--ce-lo': 'rgba(30,25,70,.18)',
        } as CSSProperties
      }
    >
      <div className="ce-rim" />
      <div className="ce-mill" />
      <div className="ce-disc" />
      <div className="ce-groove" />
      <div className="ce-glyph">
        <Sprout size={32} strokeWidth={1.9} aria-hidden />
      </div>
      <div className="ce-sheen" />
    </div>
  );
}

export const BADGE: BadgeDefinition = { id: 'seedling', Art: SeedlingMedal };
