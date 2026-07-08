// Per-achievement emblem icons — one distinct stroke-based SVG per completion
// achievement id, rendered inside the badge tile. Ported verbatim from the
// report platform's AchievementIcons.tsx (only the completion set; the
// cohort-ranked competition medals are not used here). Uses currentColor so it
// inherits tier/lock coloring from the tile.
import type { ReactElement, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (props: P) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...props,
});

// 启程 start
const Rocket = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
    <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </svg>
);
// 结课 finish1
const Cap = (p: P) => (
  <svg {...base(p)}>
    <path d="M22 10 12 5 2 10l10 5 10-5z" />
    <path d="M6 12v5c0 1 2.5 2.5 6 2.5s6-1.5 6-2.5v-5" />
    <path d="M22 10v6" />
  </svg>
);
// 学有所成 finish3
const Layers = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 2 2 7l10 5 10-5-10-5z" />
    <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
  </svg>
);
// 小试牛刀 quiz1
const Pencil = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);
// 满分达人 perfect / fallback
const Star = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.4l-5.81 3.06L7.3 13.99 2.6 9.41l6.5-.95z" />
  </svg>
);
// 稳定发挥 quiz80
const Target = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9.5" />
    <circle cx="12" cy="12" r="5.5" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);
// 破冰 chat1
const Bubble = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M8 14.5c1 1.3 2.4 2 4 2s3-.7 4-2" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </svg>
);
// 勤学好问 chat20
const Bubbles = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
    <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2" />
  </svg>
);
// 畅所欲言 msg100
const Megaphone = (p: P) => (
  <svg {...base(p)}>
    <path d="m3 11 15-5v12L3 14z" />
    <path d="M18 8a3 3 0 0 1 0 6" />
    <path d="M6 13.5V17a2 2 0 0 0 3.5 1.3" />
  </svg>
);

const BY_ID: Record<string, (p: P) => ReactElement> = {
  start: Rocket,
  finish1: Cap,
  finish3: Layers,
  quiz1: Pencil,
  perfect: Star,
  quiz80: Target,
  chat1: Bubble,
  chat20: Bubbles,
  msg100: Megaphone,
};

export function AchievementEmblem({ id, ...p }: { id: string } & P) {
  const Cmp = BY_ID[id] ?? Star;
  return <Cmp {...p} />;
}
