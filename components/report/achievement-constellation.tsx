'use client';

import { useMemo } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useUserProfileStore } from '@/lib/store/user-profile';
import { ACH_GROUPS, ACH_CHAINS } from '@/lib/report/achievements';
import { AchievementEmblem } from './achievement-emblems';
import type { Achievement, AchGroup } from '@/lib/report/types';

// Radial skill-tree, laid out vertically (portrait) so it fits a narrow side
// column. Each progression chain (承接关系) is a straight radial spoke, one
// level per node. Width comes from arranging the spokes into two vertical fans
// (down + up) with the deepest chains centered on the vertical axis — not from
// stretching. Node spacing is set by STEP (a real distance), so "bigger" means
// genuinely farther-apart nodes. Connectors are curved with per-badge varied
// bow direction/size. The hub shows the learner's OpenMAIC avatar.
const CX = 170; // center of the 340×720 (portrait) viewBox
const CY = 360;
const HUB_R = 34; // center hub (avatar) radius
const R0 = 120; // radius of a chain's first (Lv.1) node
const STEP = 62; // distance between consecutive levels
const NODE_R = 15; // node radius
const FAN = 54; // half-span of each vertical fan (deg)
const CURVE = 0.18; // base connector bow (fraction of segment length)

const GROUP_COLOR: Record<AchGroup, string> = {
  course: '#7c3aed', // violet
  quiz: '#0ea5e9', // sky
  chat: '#10b981', // emerald
  explore: '#f59e0b', // amber
};
const DIM = '#94a3b8'; // neutral for unearned (reads on light + dark)

const rad = (deg: number) => (deg * Math.PI) / 180;

// Deterministic per-id hash → stable "randomness" without Math.random.
function hashId(s: string): number {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
  return x;
}

// Slot order for a fan of m spokes, center-most first (so the deepest chain,
// fed first, lands on the horizontal axis).
function centerOrder(m: number): number[] {
  const mid = (m - 1) / 2;
  return Array.from({ length: m }, (_, i) => i).sort(
    (a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b,
  );
}

interface PNode {
  a: Achievement;
  x: number;
  y: number;
  color: string;
}
interface Link {
  key: string;
  d: string;
  color: string;
  earned: boolean;
}

// A curved connector (quadratic bézier) trimmed to circle edges, bowed by a
// signed factor `k` (varies per badge) for irregular curvature.
function curve(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  pad1: number,
  pad2: number,
  k: number,
): string {
  const dx = bx - ax;
  const dy = by - ay;
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const sx = ax + ux * pad1;
  const sy = ay + uy * pad1;
  const ex = bx - ux * pad2;
  const ey = by - uy * pad2;
  const off = Math.hypot(ex - sx, ey - sy) * k;
  const cx = (sx + ex) / 2 - uy * off;
  const cy = (sy + ey) / 2 + ux * off;
  return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
}

export function AchievementConstellation({
  achievements,
  onSelect,
}: {
  achievements: Achievement[];
  onSelect: (a: Achievement) => void;
}) {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);

  const { nodes, links } = useMemo(() => {
    const byId = new Map(achievements.map((a) => [a.id, a]));

    // All chains, tagged with color + depth.
    const chains: { chain: string[]; color: string; depth: number; i: number }[] = [];
    for (const group of ACH_GROUPS) {
      for (const chain of ACH_CHAINS[group]) {
        chains.push({ chain, color: GROUP_COLOR[group], depth: chain.length, i: chains.length });
      }
    }

    // Deal chains onto two sides deepest-first so each side is depth-balanced
    // and the longest chains sit at the fan centers (horizontal axis).
    const sorted = [...chains].sort((a, b) => b.depth - a.depth || a.i - b.i);
    const sides: (typeof sorted)[] = [[], []];
    sorted.forEach((c, k) => sides[k % 2].push(c));

    const placed: { chain: string[]; color: string; base: number }[] = [];
    sides.forEach((sideChains, sideIdx) => {
      const center = sideIdx === 0 ? 90 : 270; // down / up (portrait fans)
      const m = sideChains.length;
      const order = centerOrder(m);
      sideChains.forEach((c, pos) => {
        const slot = order[pos];
        const tt = m <= 1 ? 0.5 : slot / (m - 1);
        placed.push({ chain: c.chain, color: c.color, base: center - FAN + tt * (2 * FAN) });
      });
    });

    const nodes: PNode[] = [];
    const links: Link[] = [];
    for (const { chain, color, base } of placed) {
      let prev: PNode | null = null;
      chain.forEach((id, lvl) => {
        const a = byId.get(id);
        if (!a) return;
        const r = R0 + lvl * STEP;
        const node: PNode = {
          a,
          x: CX + r * Math.cos(rad(base)),
          y: CY + r * Math.sin(rad(base)),
          color,
        };
        const from = prev ?? { x: CX, y: CY };
        const pad1 = prev ? NODE_R : HUB_R;
        const hv = hashId(id);
        const k = (hv & 1 ? 1 : -1) * CURVE * (0.5 + (hv % 100) / 100); // signed, 0.5–1.5×
        links.push({
          key: `k-${id}`,
          d: curve(from.x, from.y, node.x, node.y, pad1, NODE_R, k),
          color,
          earned: a.earned,
        });
        nodes.push(node);
        prev = node;
      });
    }
    return { nodes, links };
  }, [achievements]);

  return (
    <div className="flex flex-col items-center gap-4">
      <svg
        viewBox="0 0 340 720"
        className="mx-auto w-auto max-w-full h-[56vh] lg:h-[calc(100dvh-16rem)]"
        style={{ aspectRatio: '340 / 720' }}
        role="img"
        aria-label={t('learningReport.tabs.achievements')}
      >
        <defs>
          <clipPath id="hubAvatarClip">
            <circle cx={CX} cy={CY} r={HUB_R} />
          </clipPath>
        </defs>

        {/* connectors (drawn first, hidden behind opaque node backings) */}
        {links.map((ln) => (
          <path
            key={ln.key}
            d={ln.d}
            fill="none"
            stroke={ln.earned ? ln.color : DIM}
            strokeOpacity={ln.earned ? 0.5 : 0.2}
            strokeWidth={1.5}
          />
        ))}

        {/* nodes */}
        {nodes.map((node) => (
          <g
            key={node.a.id}
            transform={`translate(${node.x} ${node.y})`}
            onClick={() => onSelect(node.a)}
            className="cursor-pointer"
          >
            <title>{t(`learningReport.ach.${node.a.id}.title`)}</title>
            <circle r={NODE_R} className="fill-background" />
            <circle
              r={NODE_R}
              fill={node.a.earned ? node.color : DIM}
              fillOpacity={node.a.earned ? 0.16 : 0.06}
              stroke={node.a.earned ? node.color : DIM}
              strokeOpacity={node.a.earned ? 0.9 : 0.3}
              strokeWidth={1.5}
              className="transition-opacity hover:opacity-70"
            />
            <AchievementEmblem
              id={node.a.id}
              x={-9}
              y={-9}
              width={18}
              height={18}
              style={{ color: node.a.earned ? node.color : DIM, opacity: node.a.earned ? 1 : 0.55 }}
            />
          </g>
        ))}

        {/* center hub — learner avatar */}
        <circle cx={CX} cy={CY} r={HUB_R + 3} className="fill-background" />
        <image
          href={avatar}
          x={CX - HUB_R}
          y={CY - HUB_R}
          width={HUB_R * 2}
          height={HUB_R * 2}
          clipPath="url(#hubAvatarClip)"
          preserveAspectRatio="xMidYMid slice"
        />
        <circle
          cx={CX}
          cy={CY}
          r={HUB_R}
          fill="none"
          className="stroke-amber-400 dark:stroke-amber-500/50"
          strokeWidth={2.5}
        />
      </svg>

      {/* branch legend */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        {ACH_GROUPS.map((g) => (
          <span key={g} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: GROUP_COLOR[g] }} />
            {t(`learningReport.groups.${g}`)}
          </span>
        ))}
      </div>
    </div>
  );
}
