'use client';

/**
 * The badges a course can end on. A table, so that an achievements system can add to
 * it later: what it looks like, what it is called and how much it moves.
 */
import { Check, Sprout } from 'lucide-react';
import type { ComponentType, CSSProperties } from 'react';
import type { BadgeId } from '@/lib/classroom/course-end';

export type BadgeMotion = 'full' | 'reduced' | 'none' | 'seal';

export interface BadgeArtProps {
  readonly pct?: number;
  readonly fullLabel: string;
}

export interface BadgeDefinition {
  readonly id: BadgeId;
  readonly Art: ComponentType<BadgeArtProps>;
  /** Under `classroomEnd.badges`. */
  readonly nameKey: string;
  /** Under `classroomEnd.comment`. */
  readonly commentKey: string;
  readonly motion: BadgeMotion;
}

interface Metal {
  rim: string;
  disc: string;
  ink: string;
  hi: string;
  lo: string;
}

const METAL: Record<Exclude<BadgeId, 'seal'>, Metal> & { seal: Metal } = {
  amethyst: {
    rim: 'conic-gradient(from 210deg,#fbf5ff,#cdb2fb,#6d28d9,#efe2ff,#a57cf3,#4c1d95,#e4d4ff,#8b5cf6,#fbf5ff)',
    disc: 'radial-gradient(circle at 34% 26%,#f6edff 0,#d4bdfb 34%,#a783ee 72%,#8a63dd 100%)',
    ink: '#3b1a78',
    hi: 'rgba(255,255,255,.65)',
    lo: 'rgba(40,10,90,.35)',
  },
  silver: {
    rim: 'conic-gradient(from 210deg,#fdfdff,#cfcde6,#77749e,#f4f3fc,#a9a7cd,#5e5c86,#e9e8f6,#8e8cb4,#fdfdff)',
    disc: 'radial-gradient(circle at 34% 26%,#fbfaff 0,#dedcf0 40%,#bab8d6 78%,#a4a2c6 100%)',
    ink: '#45426f',
    hi: 'rgba(255,255,255,.8)',
    lo: 'rgba(30,25,70,.28)',
  },
  seedling: {
    rim: 'conic-gradient(from 210deg,#e7e5f1,#c7c4da,#a09db9,#dedbea,#b4b1c9,#918ead,#d6d4e4,#a9a6c1,#e7e5f1)',
    disc: 'radial-gradient(circle at 34% 26%,#f1f0f7 0,#dad8e7 50%,#c7c5d9 100%)',
    ink: '#5d5a82',
    hi: 'rgba(255,255,255,.7)',
    lo: 'rgba(30,25,70,.18)',
  },
  seal: {
    rim: 'linear-gradient(145deg,#a78bfa,#7c3aed 45%,#5b21b6)',
    disc: 'radial-gradient(circle at 34% 26%,#9f7bf5 0,#7c3aed 55%,#6425c9 100%)',
    ink: '#fff',
    hi: 'rgba(255,255,255,.2)',
    lo: 'rgba(30,10,70,.4)',
  },
};

const metalStyle = (metal: Metal) =>
  ({
    '--ce-rim': metal.rim,
    '--ce-disc': metal.disc,
    '--ce-ink': metal.ink,
    '--ce-hi': metal.hi,
    '--ce-lo': metal.lo,
  }) as CSSProperties;

/** A scalloped edge, in the coin's own 124-unit box. */
function scallop(points: number, inner: number, outer: number, centre: number): string {
  const step = (Math.PI * 2) / points;
  let path = '';
  for (let i = 0; i < points; i++) {
    const a = i * step;
    if (i === 0) {
      path += `M${(centre + inner * Math.cos(a)).toFixed(2)} ${(centre + inner * Math.sin(a)).toFixed(2)}`;
    }
    const m = a + step / 2;
    const b = a + step;
    path += `Q${(centre + outer * Math.cos(m)).toFixed(2)} ${(centre + outer * Math.sin(m)).toFixed(2)} ${(centre + inner * Math.cos(b)).toFixed(2)} ${(centre + inner * Math.sin(b)).toFixed(2)}`;
  }
  return `${path}Z`;
}
const SEAL_EDGE = `path('${scallop(18, 56, 63, 62)}')`;

function Coin({
  metal,
  glyph,
  milled = true,
}: {
  metal: Metal;
  glyph: React.ReactNode;
  milled?: boolean;
}) {
  return (
    <div className="ce-coin" style={metalStyle(metal)}>
      <div className="ce-rim" />
      {milled ? <div className="ce-mill" /> : null}
      <div className="ce-disc" />
      <div className="ce-groove" />
      <div className="ce-glyph">{glyph}</div>
      <div className="ce-sheen" />
      <div className="ce-shine" />
    </div>
  );
}

function AmethystMedal({ fullLabel }: BadgeArtProps) {
  return <Coin metal={METAL.amethyst} glyph={<span className="ce-cjk">{fullLabel}</span>} />;
}

function SilverMedal({ pct }: BadgeArtProps) {
  return <Coin metal={METAL.silver} glyph={pct} />;
}

function SeedlingBadge() {
  return <Coin metal={METAL.seedling} glyph={<Sprout size={32} strokeWidth={1.9} aria-hidden />} />;
}

function CompletionSeal() {
  return (
    <div className="ce-seal" style={{ clipPath: SEAL_EDGE }}>
      <Coin
        metal={METAL.seal}
        milled={false}
        glyph={<Check size={44} strokeWidth={2.4} aria-hidden />}
      />
    </div>
  );
}

export const BADGES: Record<BadgeId, BadgeDefinition> = {
  amethyst: {
    id: 'amethyst',
    Art: AmethystMedal,
    nameKey: 'classroomEnd.badges.amethyst',
    commentKey: 'classroomEnd.comment.amethyst',
    motion: 'full',
  },
  silver: {
    id: 'silver',
    Art: SilverMedal,
    nameKey: 'classroomEnd.badges.silver',
    commentKey: 'classroomEnd.comment.silver',
    motion: 'reduced',
  },
  seedling: {
    id: 'seedling',
    Art: SeedlingBadge,
    nameKey: 'classroomEnd.badges.seedling',
    commentKey: 'classroomEnd.comment.seedling',
    motion: 'none',
  },
  seal: {
    id: 'seal',
    Art: CompletionSeal,
    nameKey: 'classroomEnd.badges.seal',
    commentKey: 'classroomEnd.comment.seal',
    motion: 'seal',
  },
};
