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
// 开课达人 create3 — stacked cards + plus
const StackPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7.5 12 4l8 3.5-8 3.5z" />
    <path d="m4 12 8 3.5 3-1.3" />
    <path d="M18 14.5v6M15 17.5h6" />
  </svg>
);
// 内容工厂 content100 — grid of scenes
const Grid = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="7" height="7" rx="1.2" />
    <rect x="14" y="3" width="7" height="7" rx="1.2" />
    <rect x="3" y="14" width="7" height="7" rx="1.2" />
    <rect x="14" y="14" width="7" height="7" rx="1.2" />
  </svg>
);
// 善始善终 finishAll — double check
const CheckAll = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 13.5 6 17.5 13.5 9" />
    <path d="M11.5 15.5 12.7 16.7 20.5 8" />
  </svg>
);
// 题海遨游 quiz10 — clipboard list
const Clipboard = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
    <path d="M9 10h6M9 14h4" />
  </svg>
);
// 百发百中 perfect3 — rosette medal
const Rosette = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="9" r="6" />
    <path d="m9 14-1.5 7L12 18.5 16.5 21 15 14" />
    <path d="M9.5 9 11 10.5 14.5 7" />
  </svg>
);
// 十万个为什么 qa10 — question bubble
const QuestionBubble = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 11.5a8 8 0 0 1-11.7 7L3 21l2.5-6.3A8 8 0 1 1 21 11.5z" />
    <path d="M9.7 9.5a2.4 2.4 0 0 1 4.3 1.5c0 1.5-2 1.8-2 3.3" />
    <path d="M12 17h.01" />
  </svg>
);
// 专注聆听 lecture5 — presentation board
const Presentation = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 3h20" />
    <path d="M4 3v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V3" />
    <path d="m8.5 21 3.5-4 3.5 4" />
  </svg>
);
// 各抒己见 discussion3 — two chat bubbles
const TwoBubbles = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4H12a1.5 1.5 0 0 1 1.5 1.5V10A1.5 1.5 0 0 1 12 11.5H6L3 14v-2.5A1.5 1.5 0 0 1 2 10z" />
    <path d="M8 15.5c.3 1.1 1.4 2 3 2h6l3 2.5V17.5a1.5 1.5 0 0 0 1-1.5v-3a1.5 1.5 0 0 0-1.5-1.5H16" />
  </svg>
);
// 妙语连珠 msg500 — message with many lines
const MessageLines = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12z" />
    <path d="M8 10h8M8 13.5h5" />
  </svg>
);
// 项目实战 pbl1 — wrench (project work)
const Wrench = (p: P) => (
  <svg {...base(p)}>
    <path d="M14.6 6.4a4 4 0 0 0-5.2 5.2l-6.1 6.1a1.5 1.5 0 0 0 0 2.1l.9.9a1.5 1.5 0 0 0 2.1 0l6.1-6.1a4 4 0 0 0 5.2-5.2l-2.6 2.6-2-2z" />
  </svg>
);
// 互动探索 interactive1 — click pointer
const Pointer = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 3.5 11 20l2.3-6.4L20 11.3z" />
    <path d="m14 14 5 5" />
  </svg>
);
// 全能体验 multimodal — four distinct shapes
const Shapes = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="5" r="2.6" />
    <rect x="16" y="9.4" width="5.2" height="5.2" rx="1" />
    <path d="M12 14.5 14.7 19.5H9.3z" />
    <rect x="2.8" y="9.4" width="5.2" height="5.2" rx="1" />
  </svg>
);

const BY_ID: Record<string, (p: P) => ReactElement> = {
  start: Rocket,
  create3: StackPlus,
  content100: Grid,
  finish1: Cap,
  finish3: Layers,
  finishAll: CheckAll,
  quiz1: Pencil,
  quiz10: Clipboard,
  perfect: Star,
  perfect3: Rosette,
  quiz80: Target,
  chat1: Bubble,
  chat20: Bubbles,
  qa10: QuestionBubble,
  lecture5: Presentation,
  discussion3: TwoBubbles,
  msg100: Megaphone,
  msg500: MessageLines,
  pbl1: Wrench,
  interactive1: Pointer,
  multimodal: Shapes,
};

export function AchievementEmblem({ id, ...p }: { id: string } & P) {
  const Cmp = BY_ID[id] ?? Star;
  return <Cmp {...p} />;
}
